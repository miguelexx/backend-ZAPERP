/**
 * Presença do contato (online / visto por último) — Whapi.
 * GET /chats/:id/presenca — atendente autenticado com permissão de ver a conversa.
 * Assina (subscribePresence) e lê (getPresence). UltraMSG → 501.
 */

const supabase = require('../../config/supabase')
const { getProvider } = require('../../services/providers')
const { assertPermissaoConversa } = require('../../services/chat/access/conversationPolicy')
const { isGroupConversation } = require('../../helpers/conversaHelper')
const {
  resolveConversationWhatsappInstance,
  resolveConversationProvider,
} = require('../../services/chat/identity/conversationAddressService')

const perCompanyBuckets = new Map()

function checkCompanyRate(companyId, key, windowMs, max) {
  if (!companyId) return true
  const now = Date.now()
  const k = `${companyId}:${key}`
  let bucket = perCompanyBuckets.get(k)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs }
    perCompanyBuckets.set(k, bucket)
  }
  if (bucket.count >= max) return false
  bucket.count += 1
  return true
}

exports.obterPresencaConversa = async (req, res) => {
  try {
    const company_id = req.user?.company_id
    const user_id = req.user?.id
    if (!company_id || !user_id) return res.status(401).json({ error: 'Não autenticado' })

    const conversa_id = Number(req.params?.id)
    if (!Number.isFinite(conversa_id) || conversa_id <= 0) {
      return res.status(400).json({ error: 'conversa_id inválido' })
    }

    if (!checkCompanyRate(company_id, `chat-presence:${conversa_id}`, 60_000, 30)) {
      return res.status(429).json({
        error: 'Muitas consultas de presença, tente novamente em instantes.',
        retryAfterSeconds: 60,
      })
    }

    const perm = await assertPermissaoConversa({
      company_id,
      conversa_id,
      user_id,
      role: req.user?.perfil,
      user_dep_ids: req.user?.departamento_ids,
    })
    if (!perm.ok) return res.status(perm.status || 403).json({ error: perm.error || 'Sem permissão' })

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, tipo, chat_lid, whatsapp_instance_id, cliente_id')
      .eq('company_id', Number(company_id))
      .eq('id', conversa_id)
      .maybeSingle()

    if (errConv) return res.status(500).json({ error: errConv.message })
    if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada' })

    if (isGroupConversation(conversa)) {
      return res.status(400).json({ error: 'Presença não disponível para grupos.' })
    }

    const entry = String(conversa.telefone || '').trim()
    if (!entry || entry.toLowerCase().startsWith('lid:')) {
      return res.status(400).json({ error: 'Número do contato indisponível para presença.' })
    }

    const whatsappInstanceId = await resolveConversationWhatsappInstance(company_id, conversa)
    const instanceProvider = await resolveConversationProvider(company_id, whatsappInstanceId)
    if (instanceProvider !== 'whapi') {
      return res.status(501).json({
        error: 'Presença disponível apenas em canais Whapi.',
        provider: instanceProvider || 'ultramsg',
      })
    }

    const provider = getProvider({ provider: 'whapi' })
    if (!provider?.subscribePresence || !provider?.getPresence) {
      return res.status(501).json({ error: 'Presença não suportada neste provedor.' })
    }

    const opts = { companyId: company_id, whatsappInstanceId }
    if (req.query?.subscribe !== 'false') {
      await provider.subscribePresence(entry, opts)
    }
    const r = await provider.getPresence(entry, opts)
    if (!r.ok) {
      return res.status(502).json({ error: r.error || 'Erro ao ler presença', provider: 'whapi' })
    }

    return res.json({
      provider: 'whapi',
      conversa_id,
      status: r.status || null,
      last_seen: r.lastSeen ?? null,
      entry_id: r.entryId || null,
    })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno ao ler presença' })
  }
}
