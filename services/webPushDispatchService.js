/**
 * Dispara Web Push em mensagens inbound relevantes (alinhado ao filtro do frontend / ownership).
 */
const supabase = require('../config/supabase')
const { isGroupConversation } = require('../helpers/conversaHelper')
const webPushService = require('./webPushService')

// Webhooks/sync podem atrasar alguns minutos; tolerância maior evita silenciar push válido por “mensagem velha”.
const MAX_MESSAGE_AGE_MS = 15 * 60 * 1000

function isInboundEligibleForPush(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (payload.fromMe === true) return false
  const d = String(payload.direcao || '').toLowerCase()
  if (d && d !== 'in' && d !== 'inbound' && d !== 'recebida') return false
  const autor = payload.autor_usuario_id
  if (autor != null && Number(autor) > 0) return false

  const tsRaw = payload.criado_em || payload.created_at || payload.timestamp
  if (tsRaw) {
    const ts = new Date(tsRaw).getTime()
    if (Number.isFinite(ts)) {
      const age = Date.now() - ts
      if (age > MAX_MESSAGE_AGE_MS) return false
      if (age < -120_000) return false
    }
  }

  return true
}

async function obterUsuarioIdsQuePodemVerConversa(company_id, conversa_id) {
  const m = require('../controllers/chatController')
  if (typeof m.obterUsuarioIdsQuePodemVerConversa !== 'function') return []
  return m.obterUsuarioIdsQuePodemVerConversa(company_id, conversa_id)
}

async function obterUsuarioIdsParaPushInbound(company_id, conversa_id) {
  const visiveis = await obterUsuarioIdsQuePodemVerConversa(company_id, conversa_id)
  const ids = [...new Set((visiveis || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))]
  if (ids.length === 0) return []

  const { data: conv } = await supabase
    .from('conversas')
    .select('status_atendimento, atendente_id, tipo, telefone')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()

  if (!conv) return []

  const isGroup = isGroupConversation(conv)
  if (isGroup) return ids

  const status = String(conv.status_atendimento || '').toLowerCase().trim()
  if (status === 'em_atendimento' || status === 'aguardando_cliente') {
    const aid = conv.atendente_id != null ? Number(conv.atendente_id) : null
    if (!aid) return []
    return ids.filter((uid) => uid === aid)
  }
  if (status === 'aberta') return ids

  return []
}

function absolutizeUrl(maybeRelative) {
  const s = String(maybeRelative || '').trim()
  if (!s) return ''
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  const base = String(process.env.APP_URL || '').replace(/\/+$/, '')
  if (!base) return s.startsWith('/') ? s : `/${s}`
  return `${base}${s.startsWith('/') ? s : `/${s}`}`
}

function buildPreview(payload) {
  const texto = String(payload?.texto || payload?.conteudo || '').trim()
  if (texto) return texto.slice(0, 140)
  const tipo = String(payload?.tipo || '').toLowerCase()
  const map = {
    imagem: '📷 Imagem',
    video: '🎬 Vídeo',
    sticker: '🎭 Figurinha',
    audio: '🎵 Áudio',
    voice: '🎵 Áudio',
    arquivo: '📎 Arquivo',
    location: '📍 Localização',
    contact: '👤 Contato',
  }
  return map[tipo] || 'Nova mensagem'
}

function buildPushPayloadJson({
  company_id,
  conversa_id,
  mensagem_id,
  contactName,
  messagePreview,
  avatarUrl,
}) {
  const openPath = `/atendimento?conversa=${encodeURIComponent(String(conversa_id))}`
  const absIcon = absolutizeUrl(avatarUrl) || absolutizeUrl('/brand/pwa-192.png')
  const body = {
    title: contactName || 'Nova mensagem',
    body: messagePreview || 'Nova mensagem',
    icon: absIcon,
    badge: absolutizeUrl('/brand/zaperp-favicon.svg'),
    tag: `zap-${String(mensagem_id)}`,
    renotify: false,
    priority: 'high',
    data: {
      company_id: Number(company_id),
      conversaId: String(conversa_id),
      messageId: String(mensagem_id),
      openUrl: openPath,
      url: openPath,
    },
  }
  return JSON.stringify(body)
}

async function tryInsertDeliveryLog(mensagem_id, usuario_id, company_id) {
  const mid = String(mensagem_id || '').trim()
  const uid = Number(usuario_id)
  const cid = Number(company_id)
  if (!mid || !Number.isFinite(uid) || uid <= 0) return false

  const { error } = await supabase.from('push_inbound_delivery_log').insert({
    mensagem_id: mid,
    usuario_id: uid,
    company_id: cid,
  })

  if (!error) return true
  if (String(error.code || '') === '23505') return false
  // Falha transitória (rede, timeout): não bloquear o envio do push — dedupe é otimização, não deve silenciar alertas no mobile.
  console.warn('[web-push] delivery_log insert (push continua):', error.message || error)
  return true
}

async function fetchSubscriptionsForUser(company_id, usuario_id) {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('company_id', Number(company_id))
    .eq('usuario_id', Number(usuario_id))

  if (error) {
    console.warn('[web-push] fetch subscriptions:', error.message || error)
    return []
  }
  return data || []
}

async function resolveContactLabel(company_id, conversa_id, payload) {
  const nomeMsg =
    (payload?.chatName && String(payload.chatName).trim()) ||
    (payload?.senderName && String(payload.senderName).trim()) ||
    ''
  if (nomeMsg && nomeMsg.toLowerCase() !== 'name') return nomeMsg

  const { data: conv } = await supabase
    .from('conversas')
    .select('nome_grupo, nome_contato_cache, tipo, telefone')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()

  if (!conv) return 'Nova mensagem'
  if (isGroupConversation(conv)) {
    const g = String(conv.nome_grupo || '').trim()
    return g || 'Grupo'
  }
  const n = String(conv.nome_contato_cache || '').trim()
  return n || 'Nova mensagem'
}

async function resolveAvatarUrl(company_id, conversa_id, payload) {
  const fromPayload =
    (payload?.senderPhoto && String(payload.senderPhoto).trim().startsWith('http') && String(payload.senderPhoto).trim()) ||
    (payload?.photo && String(payload.photo).trim().startsWith('http') && String(payload.photo).trim()) ||
    ''

  if (fromPayload) return fromPayload

  const { data: conv } = await supabase
    .from('conversas')
    .select('foto_grupo, foto_perfil_contato_cache')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()

  if (!conv) return ''
  const fg = conv.foto_grupo ? String(conv.foto_grupo).trim() : ''
  const fp = conv.foto_perfil_contato_cache ? String(conv.foto_perfil_contato_cache).trim() : ''
  return fg || fp || ''
}

/**
 * @param {object} opts
 * @param {number} opts.company_id
 * @param {number|string} opts.conversa_id
 * @param {string} opts.eventName
 * @param {object} opts.payload
 */
async function maybeDispatchInboundWebPush(opts) {
  const company_id = Number(opts?.company_id)
  const conversa_id = Number(opts?.conversa_id)
  const eventName = String(opts?.eventName || '').toLowerCase()
  const payload = opts?.payload

  if (!Number.isFinite(company_id) || company_id <= 0) return
  if (!Number.isFinite(conversa_id) || conversa_id <= 0) return
  if (eventName !== 'nova_mensagem') return
  if (!isInboundEligibleForPush(payload)) return

  if (!webPushService.ensureVapidConfigured()) return

  const mensagem_id = payload?.id ?? payload?.mensagem_id
  if (mensagem_id == null || mensagem_id === '') return

  const targetUsers = await obterUsuarioIdsParaPushInbound(company_id, conversa_id)
  if (targetUsers.length === 0) return

  const contactName = await resolveContactLabel(company_id, conversa_id, payload)
  const avatarUrl = await resolveAvatarUrl(company_id, conversa_id, payload)
  const preview = buildPreview(payload)

  const jsonPayload = buildPushPayloadJson({
    company_id,
    conversa_id,
    mensagem_id,
    contactName,
    messagePreview: preview,
    avatarUrl,
  })

  for (const usuario_id of targetUsers) {
    const inserted = await tryInsertDeliveryLog(mensagem_id, usuario_id, company_id)
    if (!inserted) continue

    const rows = await fetchSubscriptionsForUser(company_id, usuario_id)
    for (const row of rows) {
      const sub = webPushService.subscriptionFromRow(row)
      if (!sub) continue
      await webPushService.sendToSubscription(sub, jsonPayload)
    }
  }
}

function scheduleInboundWebPush(company_id, conversa_id, eventName, payload) {
  const ev = String(eventName || '').toLowerCase()
  if (ev !== 'nova_mensagem') return
  setImmediate(() => {
    maybeDispatchInboundWebPush({
      company_id,
      conversa_id,
      eventName: ev,
      payload,
    }).catch((e) => console.warn('[web-push] dispatch:', e?.message || e))
  })
}

module.exports = {
  maybeDispatchInboundWebPush,
  scheduleInboundWebPush,
}
