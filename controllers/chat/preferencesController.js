/**
 * Preferências da lista por conversa (silenciar/fixar/favoritar).
 * Extraído de controllers/chatController.js (modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { getProvider } = require('../../services/providers')
const {
  resolveConversationWhatsappInstance,
  resolveConversationProvider,
} = require('../../services/chat/identity/conversationAddressService')
const { emitirParaUsuario } = require('../../services/chat/realtime/chatRealtimeGateway')
const { assertPermissaoConversa } = require('../../services/chat/access/conversationPolicy')

const MUTE_ESPELHO_MS = 365 * 24 * 60 * 60 * 1000 // ~1 ano: "silenciado" no app até desmutar

/**
 * Espelha fixar/silenciar no WhatsApp do número conectado (best-effort, só Whapi tem patchChat).
 * Atenção: as prefs do ZapERP são POR-ATENDENTE, mas o WhatsApp é COMPARTILHADO — o app reflete
 * a última ação de qualquer atendente. Nunca lança: não pode quebrar o salvamento da preferência.
 */
async function espelharPrefsNoWhatsapp(company_id, conversa_id, { changedPin, fixada, changedMute, silenciada }) {
  try {
    if (!changedPin && !changedMute) return
    const { data: conv } = await supabase
      .from('conversas')
      .select('id, tipo, telefone, whatsapp_instance_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()
    const telefone = String(conv?.telefone || '').trim()
    if (!conv || !telefone || telefone.toLowerCase().startsWith('lid:')) return

    const instanceId = conv.whatsapp_instance_id
      ? await resolveConversationWhatsappInstance(company_id, conv)
      : null
    const instanceProvider = await resolveConversationProvider(company_id, instanceId)
    const provider = getProvider({ provider: instanceProvider })
    if (typeof provider?.patchChat !== 'function') return

    const changes = {}
    if (changedPin) changes.pin = !!fixada
    if (changedMute) changes.mute_until = silenciada ? Date.now() + MUTE_ESPELHO_MS : 0
    await provider.patchChat(telefone, changes, {
      companyId: company_id,
      ...(instanceId ? { whatsappInstanceId: instanceId } : {}),
    })
  } catch (e) {
    console.warn('[patchConversaPrefs] espelhar pin/mute no WhatsApp falhou:', e?.message || e)
  }
}

exports.patchConversaPrefs = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids } = req.user
    const io = req.app.get('io')
    const conversa_id = Number(req.params.id)
    if (!Number.isFinite(conversa_id) || conversa_id <= 0) {
      return res.status(400).json({ error: 'ID da conversa inválido' })
    }
    const perm = await assertPermissaoConversa({
      company_id,
      conversa_id,
      user_id,
      role: perfil,
      user_dep_ids: departamento_ids,
    })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    const body = req.body && typeof req.body === 'object' ? req.body : {}
    if (
      body.silenciada === undefined &&
      body.fixada === undefined &&
      body.favorita === undefined
    ) {
      return res.status(400).json({ error: 'Envie silenciada, fixada e/ou favorita (boolean).' })
    }

    const { data: existing } = await supabase
      .from('conversa_usuario_prefs')
      .select('silenciada, fixada, favorita, fixada_em')
      .eq('company_id', Number(company_id))
      .eq('usuario_id', Number(user_id))
      .eq('conversa_id', conversa_id)
      .maybeSingle()

    let silenciada = !!(existing && existing.silenciada)
    let favorita = !!(existing && existing.favorita)
    let fixada = !!(existing && existing.fixada)
    let fixada_em = existing && existing.fixada_em != null ? existing.fixada_em : null
    if (body.silenciada !== undefined) silenciada = !!body.silenciada
    if (body.favorita !== undefined) favorita = !!body.favorita
    if (body.fixada !== undefined) {
      fixada = !!body.fixada
      fixada_em = fixada ? new Date().toISOString() : null
    }

    const row = {
      company_id: Number(company_id),
      usuario_id: Number(user_id),
      conversa_id,
      silenciada,
      fixada,
      favorita,
      fixada_em,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('conversa_usuario_prefs')
      .upsert(row, { onConflict: 'company_id,usuario_id,conversa_id' })
      .select('conversa_id, silenciada, fixada, favorita, fixada_em')
      .single()

    if (error) {
      if (String(error.message || '').includes('conversa_usuario_prefs') || String(error.code || '') === '42P01') {
        return res.status(503).json({ error: 'Aplique a migration conversa_usuario_prefs no Supabase e tente novamente.' })
      }
      console.error('[chatController] conversa_prefs', error?.message)
      return res.status(500).json({ error: 'Erro interno' })
    }

    // Espelha fixar/silenciar no WhatsApp do número (best-effort; não bloqueia a resposta).
    await espelharPrefsNoWhatsapp(company_id, conversa_id, {
      changedPin: body.fixada !== undefined,
      fixada,
      changedMute: body.silenciada !== undefined,
      silenciada,
    })

    if (io) {
      emitirParaUsuario(io, user_id, 'conversa_prefs_atualizada', {
        conversa_id,
        silenciada: !!data?.silenciada,
        fixada: !!data?.fixada,
        favorita: !!data?.favorita,
        fixada_em: data?.fixada_em ?? null,
      })
    }

    return res.json({
      ok: true,
      conversa_id,
      silenciada: !!data?.silenciada,
      fixada: !!data?.fixada,
      favorita: !!data?.favorita,
      fixada_em: data?.fixada_em ?? null,
    })
  } catch (err) {
    console.error('[patchConversaPrefs]', err)
    return res.status(500).json({ error: 'Erro ao salvar preferências da conversa' })
  }
}
