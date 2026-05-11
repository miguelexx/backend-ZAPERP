const supabase = require('../config/supabase')
const { classifyIncomingPushToken } = require('../helpers/pushTokenFormat')

/** PushSubscription.toJSON() pode ultrapassar 4k em edge cases */
const MAX_TOKEN_LEN = 32768
const MAX_FIELD = 512

function normalizeStr(v, max) {
  const s = String(v ?? '').trim()
  if (s.length > max) return s.slice(0, max)
  return s
}

/** POST /api/push/tokens — Web Push (JSON PushSubscription) ou token FCM */
exports.upsertToken = async (req, res) => {
  try {
    const empresa_id = Number(req.user?.company_id)
    const usuario_id = Number(req.user?.id)

    if (!Number.isFinite(empresa_id) || empresa_id <= 0 || !Number.isFinite(usuario_id) || usuario_id <= 0) {
      return res.status(400).json({ error: 'Sessão inválida' })
    }

    const plataforma = normalizeStr(req.body?.plataforma, MAX_FIELD) || null
    const navegador = normalizeStr(req.body?.navegador, MAX_FIELD) || null
    const dispositivo = normalizeStr(req.body?.dispositivo, MAX_FIELD) || null

    const classified = classifyIncomingPushToken(req.body?.token)

    if (classified.kind === 'empty') {
      return res.status(400).json({ error: 'token obrigatório' })
    }

    if (classified.kind === 'invalid_json_shape') {
      return res.status(400).json({
        error:
          'token inválido: envie PushSubscription (objeto ou JSON string com endpoint e keys.p256dh/auth) ou token FCM',
      })
    }

    if (classified.kind === 'fcm' && (!classified.token || classified.token.length < 10)) {
      return res.status(400).json({ error: 'token FCM inválido' })
    }

    if (classified.kind === 'web_push') {
      const ua = String(req.headers['user-agent'] || '').slice(0, 512)
      const now = new Date().toISOString()
      const { error } = await supabase.from('push_subscriptions').upsert(
        {
          company_id: empresa_id,
          usuario_id,
          endpoint: classified.endpoint,
          p256dh: classified.p256dh,
          auth: classified.auth,
          user_agent: ua || null,
          updated_at: now,
        },
        { onConflict: 'endpoint' }
      )

      if (error) {
        console.warn('[push] upsert push_subscriptions (/api/push/tokens):', error.message || error)
        return res.status(500).json({ error: 'Não foi possível salvar a subscription' })
      }

      console.log('[push] subscription Web Push/VAPID salva', { empresa_id, usuario_id, plataforma, navegador })
      return res.json({ ok: true })
    }

    const token = classified.token
    const now = new Date().toISOString()
    const row = {
      empresa_id,
      usuario_id,
      token,
      plataforma,
      navegador,
      dispositivo,
      ativo: true,
      atualizado_em: now,
      ultimo_uso_em: now,
    }

    const { error } = await supabase.from('push_tokens').upsert(row, { onConflict: 'token' })

    if (error) {
      console.warn('[fcm] upsert push_tokens:', error.message || error)
      return res.status(500).json({ error: 'Não foi possível salvar o token' })
    }

    console.log('[fcm] token FCM salvo', { empresa_id, usuario_id, plataforma, navegador })
    return res.json({ ok: true })
  } catch (e) {
    console.warn('[push] upsertToken:', e?.message || e)
    return res.status(500).json({ error: 'Erro interno' })
  }
}

/** POST /api/push/tokens/logout — body | também aceita subscription JSON completa */
exports.logoutToken = async (req, res) => {
  try {
    const empresa_id = Number(req.user?.company_id)
    const usuario_id = Number(req.user?.id)

    if (!Number.isFinite(empresa_id) || empresa_id <= 0 || !Number.isFinite(usuario_id) || usuario_id <= 0) {
      return res.status(400).json({ error: 'Sessão inválida' })
    }

    const classified = classifyIncomingPushToken(req.body?.token)
    if (classified.kind === 'empty') {
      return res.status(400).json({ error: 'token obrigatório' })
    }

    const now = new Date().toISOString()
    let removedSubscription = false

    if (classified.kind === 'web_push') {
      const { error: delErr } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('company_id', empresa_id)
        .eq('usuario_id', usuario_id)
        .eq('endpoint', classified.endpoint)
      if (delErr) {
        console.warn('[push] logout push_subscriptions:', delErr.message || delErr)
      } else {
        removedSubscription = true
      }
    }

    let rowsPt = []
    let ptErr = null
    if (classified.kind === 'fcm' && classified.token && classified.token.length >= 10) {
      const r = await supabase
        .from('push_tokens')
        .update({ ativo: false, atualizado_em: now })
        .eq('empresa_id', empresa_id)
        .eq('usuario_id', usuario_id)
        .eq('token', classified.token)
        .select('id')
      rowsPt = r.data
      ptErr = r.error
    } else if (typeof req.body?.token === 'string' && classified.kind !== 'web_push') {
      const s = normalizeStr(req.body.token, MAX_TOKEN_LEN)
      if (s.length >= 10 && !s.trim().startsWith('{')) {
        const r = await supabase
          .from('push_tokens')
          .update({ ativo: false, atualizado_em: now })
          .eq('empresa_id', empresa_id)
          .eq('usuario_id', usuario_id)
          .eq('token', s)
          .select('id')
        rowsPt = r.data
        ptErr = r.error
      }
    }

    if (ptErr) {
      console.warn('[push] logout push_tokens:', ptErr.message || ptErr)
      return res.status(500).json({ error: 'Não foi possível desativar o token' })
    }

    const deactivatedFcm = (rowsPt || []).length

    console.log('[push] logout', {
      empresa_id,
      usuario_id,
      web_push_removida: removedSubscription,
      push_tokens_desativados: deactivatedFcm,
    })

    return res.json({ ok: true })
  } catch (e) {
    console.warn('[push] logoutToken:', e?.message || e)
    return res.status(500).json({ error: 'Erro interno' })
  }
}
