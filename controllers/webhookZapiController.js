/**
 * Webhook Z-API: recebe mensagens do Z-API (POST /webhooks/zapi).
 * TUDO que a Z-API enviar para esta URL deve chegar no sistema: texto, imagem, áudio,
 * vídeo, documento, figurinha, reação, localização, contato, PTV, templates, botões, listas.
 * Suporta conversas individuais e de GRUPO.
 * Espelhamento WhatsApp Web: mensagens enviadas pelo celular (fromMe) TAMBÉM são
 * persistidas e emitidas via WebSocket; idempotência por (conversa_id, whatsapp_id).
 */

const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { syncContactFromZapi } = require('../services/zapiSyncContact')
const { normalizePhoneBR, possiblePhonesBR, normalizeGroupIdForStorage } = require('../helpers/phoneHelper')
const { getCanonicalPhone, findOrCreateConversation, mergeConversasIntoCanonico } = require('../helpers/conversationSync')
const { incrementarUnreadParaConversa, marcarConversaComoLidaParaTodos } = require('./chatController')

const COMPANY_ID = Number(process.env.WEBHOOK_COMPANY_ID || 1)
const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'

// Buffer em memória das últimas 30 requisições webhook recebidas (diagnóstico)
const _webhookLog = []
function _logWebhook(entry) {
  _webhookLog.unshift({ ts: new Date().toISOString(), ...entry })
  if (_webhookLog.length > 30) _webhookLog.pop()
}

// Buffer separado para requisições REJEITADAS (token ausente/inválido) — diagnóstico de configuração
const _rejectedLog = []
function _logRejected(entry) {
  _rejectedLog.unshift({ ts: new Date().toISOString(), ...entry })
  if (_rejectedLog.length > 20) _rejectedLog.pop()
}
exports._logRejected = _logRejected

/** Detecta se o payload é de um grupo (remoteJid @g.us, isGroup ou tipo grupo). */
function isGroupPayload(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (payload.isGroup === true) return true
  const tipo = String(payload.tipo || payload.type || '').toLowerCase()
  if (tipo === 'grupo' || tipo === 'group') return true

  const candidates = [
    payload.key?.remoteJid,
    payload.remoteJid,
    payload.chat?.id,
    payload.chat?.remoteJid,
    payload.chatId,
    payload.phone,
    payload.groupId,
    payload.group?.id,
    payload.data?.remoteJid
  ].filter(Boolean).map((v) => String(v).trim())

  // 1) sinais explícitos
  if (candidates.some((c) => c.endsWith('@g.us') || c.includes('-group'))) return true

  // 2) ID numérico de grupo (120...) + presença de participante/autor é fortíssimo sinal de grupo
  const hasParticipant =
    !!payload.participantPhone ||
    !!payload.participant ||
    !!payload.author ||
    !!payload.key?.participant

  if (hasParticipant) {
    for (const c of candidates) {
      const d = String(c || '').replace(/\D/g, '')
      if (d.startsWith('120') && d.length >= 15) return true
    }
  }

  return false
}

/** Retorna identificador do grupo, quando houver. */
function pickGroupChatId(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const isGroupHint = payload.isGroup === true || ['grupo', 'group'].includes(String(payload.tipo || payload.type || '').toLowerCase())

  const candidates = [
    payload.key?.remoteJid,
    payload.remoteJid,
    payload.chat?.id,
    payload.chat?.remoteJid,
    payload.chatId,
    payload.phone,
    payload.groupId,
    payload.group?.id,
    payload.data?.remoteJid
  ]
    .filter((v) => v != null)
    .map((v) => String(v).trim())
    .filter(Boolean)

  for (const c of candidates) {
    if (c.endsWith('@g.us')) return c
  }

  // alguns providers mandam "...-group"
  for (const c of candidates) {
    if (c.includes('-group')) return c
  }

  // heurística: id de grupo costuma ser longo e começa com 120...
  if (isGroupHint || payload.participantPhone || payload.key?.participant) {
    for (const c of candidates) {
      const d = c.replace(/\D/g, '')
      if (d.startsWith('120') && d.length >= 15) return d
    }
  }

  return ''
}

function looksLikeBRPhoneDigits(digits) {
  const d = String(digits || '').replace(/\D/g, '')
  if (!d) return false
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return true
  // às vezes vem só DDD+numero (10/11) no payload
  if (d.length === 10 || d.length === 11) return true
  return false
}

/**
 * Resolve a chave de conversa a partir de um payload Z-API.
 *
 * Contrato Z-API (fonte: documentação oficial):
 *   - connectedPhone = MEU número (instância). NUNCA usar como destino de conversa.
 *   - phone          = "Número de telefone, ou do grupo que enviou a mensagem." = chave do chat.
 *     Para fromMe=true: phone ainda é o contato/grupo (não meu número).
 *   - isGroup        = true → grupo; participantPhone = remetente dentro do grupo.
 *   - @lid           = identificador interno do WhatsApp Multi-Device. NUNCA é phone real.
 *
 * @param {object} payload
 * @returns {{ key: string, isGroup: boolean, participantPhone: string, debugReason: string }}
 */
function resolveConversationKeyFromZapi(payload) {
  const clean    = (v) => (v == null ? '' : String(v).trim())
  const digits   = (v) => clean(v).replace(/\D/g, '')
  const tail11   = (v) => digits(v).slice(-11)
  const isLidJid = (v) => { const s = clean(v); return s.endsWith('@lid') || s.endsWith('@broadcast') }
  const isGrpJid = (v) => { const s = clean(v); return s.endsWith('@g.us') || s.includes('-group') }

  // ─── Grupo ───
  const isGroup = isGroupPayload(payload)
  if (isGroup) {
    const groupKey = pickGroupChatId(payload)
    const key = groupKey ? normalizeGroupIdForStorage(groupKey) : ''
    const participantPhone = digits(payload.participantPhone ?? payload.participant ?? payload.author ?? payload.key?.participant ?? '')
    return {
      key,
      isGroup: true,
      participantPhone,
      debugReason: key ? `group via pickGroupChatId (${groupKey})` : 'group but no groupChatId found — drop'
    }
  }

  // ─── Individual ───
  const fromMeHint = Boolean(payload.fromMe ?? payload.key?.fromMe)

  // Meu número: APENAS campos que identificam a INSTÂNCIA conectada.
  // NUNCA usar senderPhone para identificar "meu número":
  //   - fromMe=false: senderPhone É o cliente (remetente) — usá-lo como myDigits causa o sistema
  //     a identificar o cliente como "eu", descartando a mensagem inteira (phone → '').
  //   - fromMe=true: senderPhone pode ser o contato destinatário em algumas versões da Z-API.
  const myDigits =
    digits(payload.connectedPhone) ||
    digits(payload.ownerPhone)     ||
    digits(payload.instancePhone)  ||
    digits(payload.phoneNumber)    ||
    digits(payload.me?.phone)      ||
    ''

  if (!myDigits) {
    // Aviso diagnóstico: connectedPhone ausente é inofensivo (myTail = '' → isMyNumber sempre false),
    // mas registrar ajuda a identificar configurações da Z-API que não enviam connectedPhone.
    console.warn('[Z-API] resolveKey: connectedPhone ausente no payload — verifique a versão/configuração da instância Z-API. phone:', clean(payload.phone).slice(-8) || '(vazio)')
  }
  const myTail = myDigits ? tail11(myDigits) : ''
  const isMyNumber = (d) => myTail && d && tail11(d) === myTail

  // Extrai dígitos de um campo raw (JID, número puro ou formato misto)
  const extractDigits = (raw) => {
    if (!raw) return ''
    const s = clean(raw)
    if (!s || isLidJid(s) || isGrpJid(s)) return ''
    const d = s.includes('@') ? s.replace(/@[^@]+$/, '').replace(/\D/g, '') : digits(s)
    return (d && d.length >= 8) ? d : ''
  }

  // Normaliza candidato → telefone armazenável ou ''
  // skipMyNumber: usado no último recurso onde queremos log mas não usar meu número
  const normCandidate = (raw, { allowNonBR = false, skipMyNumber = true } = {}) => {
    const d = extractDigits(raw)
    if (!d) return ''
    if (!allowNonBR && !looksLikeBRPhoneDigits(d)) return ''
    if (skipMyNumber && isMyNumber(d)) return ''
    return normalizePhoneBR(d) || d
  }

  // ─── Fonte primária: payload.phone ───────────────────────────────────────────
  // Z-API contrato: phone = número do CHAT (contato ou grupo).
  // Para fromMe=true: phone é o DESTINATÁRIO (contato para quem você enviou).
  const phonePrimary = normCandidate(payload.phone)
  if (phonePrimary) {
    return { key: phonePrimary, isGroup: false, participantPhone: '', debugReason: 'from payload.phone (Z-API primary)' }
  }

  // ─── Fontes secundárias ───────────────────────────────────────────────────
  const fromMe = fromMeHint
  const fallbackSources = [
    [payload.key?.remoteJid,  'key.remoteJid'],
    [payload.remoteJid,       'remoteJid'],
    [payload.chatId,          'chatId'],
    [payload.chat?.id,        'chat.id'],
    // Para fromMe=true: recipiente é o contato
    ...(fromMe ? [
      [payload.to,             'to'],
      [payload.toPhone,        'toPhone'],
      [payload.recipientPhone, 'recipientPhone'],
      [payload.recipient,      'recipient'],
      [payload.destination,    'destination'],
      // senderPhone em fromMe=true pode ser o contato em algumas versões Z-API
      [payload.senderPhone,    'senderPhone (fromMe fallback)'],
    ] : [
      // Para fromMe=false: senderPhone = quem enviou (o contato)
      [payload.senderPhone,    'senderPhone'],
    ]),
  ]

  for (const [raw, fieldName] of fallbackSources) {
    const norm = normCandidate(raw)
    if (norm) {
      return { key: norm, isGroup: false, participantPhone: '', debugReason: `fallback ${fieldName}` }
    }
  }

  // ─── Último recurso: aceita número não-BR ────────────────────────────────
  const lastResortAll = [
    payload.phone, payload.key?.remoteJid, payload.chatId,
    payload.to, payload.toPhone, payload.recipientPhone,
    payload.senderPhone, payload.chat?.id,
  ]
  for (const raw of lastResortAll) {
    const norm = normCandidate(raw, { allowNonBR: true })
    if (norm) {
      return { key: norm, isGroup: false, participantPhone: '', debugReason: `last resort non-BR (${raw})` }
    }
  }

  // ─── LID (espelhamento: mensagem enviada pelo celular pode vir só com phone/chatLid @lid) ───
  // Z-API às vezes envia phone/chatLid como "280396956696801@lid" sem número real.
  // Usamos chave sintética "lid:XXXX" para encontrar/criar a mesma conversa e registrar a mensagem no front.
  const lidRaw = clean(payload.phone) || clean(payload.chatLid) || ''
  if (lidRaw.endsWith('@lid')) {
    const lidPart = lidRaw.replace(/@lid$/i, '').trim()
    if (lidPart) {
      return { key: `lid:${lidPart}`, isGroup: false, participantPhone: '', debugReason: 'from payload.phone/chatLid (@lid)' }
    }
  }

  // ─── Sem destino válido ───
  const candidateSummary = {
    phone: payload.phone,
    remoteJid: payload.key?.remoteJid ?? payload.remoteJid,
    chatId: payload.chatId,
    to: payload.to,
    connectedPhone: myDigits ? `...${myDigits.slice(-6)}` : null,
    fromMe,
  }
  return {
    key: '',
    isGroup: false,
    participantPhone: '',
    debugReason: `drop — no valid dest. candidates: ${JSON.stringify(candidateSummary)}`
  }
}

// pickBestPhone mantido apenas para retrocompatibilidade (wrapper do resolveConversationKeyFromZapi)
function pickBestPhone(payload, { fromMe } = {}) {
  const { key } = resolveConversationKeyFromZapi(payload)
  return key
}

function extractMessage(payload) {
  if (!payload || typeof payload !== 'object') {
    return { phone: '', texto: '(vazio)', fromMe: false, messageId: null, criado_em: new Date().toISOString(), type: 'text', imageUrl: null, documentUrl: null, audioUrl: null, videoUrl: null, stickerUrl: null, locationUrl: null, fileName: null, isGroup: false, isEdit: false, isNewsletter: false, waitingMessage: false, participantPhone: null, senderName: null, senderLid: null, nomeGrupo: null, senderPhoto: null, chatPhoto: null }
  }
  const fromMe = Boolean(payload.fromMe ?? payload.key?.fromMe)
  const isEdit        = Boolean(payload.isEdit)
  const isNewsletter  = Boolean(payload.isNewsletter)
  const waitingMessage = Boolean(payload.waitingMessage)
  const senderLid     = payload.senderLid ? String(payload.senderLid).trim() : null

  // Resolver chave de conversa usando resolveConversationKeyFromZapi (contrato Z-API).
  // - isGroup: true → grupo (key = id normalizado do grupo)
  // - isGroup: false → individual (key = telefone BR canônico do CONTATO, nunca do connectedPhone)
  const { key: phone, isGroup, participantPhone: partPhoneResolved, debugReason } = resolveConversationKeyFromZapi(payload)
  const messageId = payload.messageId ?? payload.id ?? payload.instanceId ?? payload.key?.id ?? null
  const ts = payload.timestamp ?? payload.momment ?? payload.t ?? payload.reaction?.time ?? Date.now()

  // Texto: Z-API envia text.message, template, botões, list, reação, localização, contato
  const rawMessage =
    payload.message ??
    payload.text?.message ??
    payload.body ??
    payload.hydratedTemplate?.message ??
    payload.buttonsResponseMessage?.message ??
    payload.listResponseMessage?.message ??
    ''
  let type = String(payload.type || payload.msgType || 'text').toLowerCase()
  if (type === 'receivedcallback' || type === 'receivedcall') type = 'text'

  // Reação (Z-API: reaction.value)
  if (payload.reaction && typeof payload.reaction === 'object') {
    type = 'reaction'
  }
  // Localização (Z-API: location.name, address, url, latitude, longitude)
  if (payload.location && typeof payload.location === 'object') {
    type = 'location'
  }
  // Contato (Z-API: contact.displayName, vCard)
  if (payload.contact && typeof payload.contact === 'object') {
    type = 'contact'
  }
  if (!type || type === 'text') {
    if (payload.image || payload.imageUrl) type = 'image'
    else if (payload.audio || payload.audioUrl) type = 'audio'
    else if (payload.video || payload.videoUrl || payload.ptv) type = 'video'
    else if (payload.document || payload.documentUrl) type = 'document'
    else if (payload.sticker || payload.stickerUrl) type = 'sticker'
  }

  let texto = String(rawMessage || '').trim()
  // URLs de mídia
  let imageUrl =
    payload.image?.imageUrl ??
    payload.image?.url ??
    payload.imageUrl ??
    payload.message?.image?.imageUrl ??
    payload.message?.image?.url ??
    payload.message?.imageUrl ??
    payload.image ??
    null
  if (imageUrl && typeof imageUrl === 'object') imageUrl = imageUrl.url ?? imageUrl.imageUrl ?? null
  let documentUrl =
    payload.document?.documentUrl ??
    payload.document?.url ??
    payload.documentUrl ??
    payload.message?.document?.documentUrl ??
    payload.message?.document?.url ??
    payload.message?.documentUrl ??
    null
  if (documentUrl && typeof documentUrl === 'object') documentUrl = documentUrl.url ?? documentUrl.documentUrl ?? null
  let fileName = payload.document?.fileName ?? payload.document?.title ?? payload.fileName ?? null
  // Áudio: diferentes formatos (Z-API pode mandar em payload.audio, payload.message.audio, ou fields diretos)
  let audioUrl =
    payload.audio?.audioUrl ??
    payload.audio?.url ??
    payload.audioUrl ??
    payload.message?.audio?.audioUrl ??
    payload.message?.audio?.url ??
    payload.message?.audioUrl ??
    null
  if (audioUrl && typeof audioUrl === 'object') audioUrl = audioUrl.url ?? audioUrl.audioUrl ?? null
  let videoUrl =
    payload.video?.videoUrl ??
    payload.video?.url ??
    payload.videoUrl ??
    payload.message?.video?.videoUrl ??
    payload.message?.video?.url ??
    payload.message?.videoUrl ??
    payload.ptv?.url ??
    null
  if (videoUrl && typeof videoUrl === 'object') videoUrl = videoUrl.url ?? videoUrl.videoUrl ?? null

  let stickerUrl =
    payload.sticker?.stickerUrl ??
    payload.sticker?.url ??
    payload.stickerUrl ??
    payload.message?.sticker?.stickerUrl ??
    payload.message?.sticker?.url ??
    payload.message?.stickerUrl ??
    null
  if (stickerUrl && typeof stickerUrl === 'object') stickerUrl = stickerUrl.url ?? stickerUrl.stickerUrl ?? null
  const locationUrl = payload.location?.url ?? payload.location?.thumbnailUrl ?? null

  // participantPhone: remetente dentro do grupo (só relevante para grupos; usamos o valor resolvido por resolveConversationKeyFromZapi + o bruto do payload como fallback)
  const participantPhoneRaw = partPhoneResolved ||
    String(payload.participantPhone ?? payload.participant ?? payload.author ?? payload.key?.participant ?? '').replace(/\D/g, '')
  const senderName = payload.senderName ?? payload.chatName ?? payload.sender?.name ?? payload.pushName ?? null
  const senderPhoto = payload.senderPhoto ?? payload.photo ?? payload.sender?.photo ?? null
  const chatPhoto = payload.chatPhoto ?? payload.groupPicture ?? payload.groupPhoto ?? null

  // Texto por tipo (TUDO que a Z-API envia vira registro legível no sistema)
  if (type === 'reaction') {
    const val = payload.reaction?.value ?? payload.reaction?.emoji ?? ''
    texto = val ? `Reação: ${String(val).trim()}` : 'Reação'
  } else if (type === 'location') {
    const loc = payload.location || {}
    const parts = [loc.name, loc.address].filter(Boolean).map(String).map(s => s.trim())
    // inclui coordenadas quando não há nome/endereço (campo oficial: latitude + longitude)
    const coords = (loc.latitude != null && loc.longitude != null)
      ? `${loc.latitude},${loc.longitude}`
      : ''
    texto = parts.length
      ? parts.join(' • ') + (coords ? ` (${coords})` : '')
      : (coords || loc.url || '(localização)')
  } else if (type === 'contact') {
    const c = payload.contact || {}
    texto = (c.displayName && String(c.displayName).trim()) || (c.formattedName && String(c.formattedName).trim()) || (c.vCard && String(c.vCard).slice(0, 120)) || '(contato)'
  } else if (type === 'image' && imageUrl) {
    texto = texto || (payload.image?.caption && String(payload.image.caption).trim()) || '(imagem)'
  } else if ((type === 'document' || type === 'file') && documentUrl) {
    texto = texto || fileName || '(arquivo)'
  } else if (type === 'audio') {
    texto = texto || '(áudio)'
  } else if (type === 'video' && videoUrl) {
    texto = texto || (payload.video?.caption && String(payload.video.caption).trim()) || (payload.ptv ? '(vídeo visualização única)' : '(vídeo)')
  } else if (type === 'sticker') {
    texto = texto || '(figurinha)'
  }
  if (!texto) texto = '(mídia)'

  // phone já foi resolvido por resolveConversationKeyFromZapi: é a chave canônica do chat.
  // Para grupos com id muito longo (>20 chars), normalizeGroupIdForStorage já truncou para dígitos.
  // Não há mais processamento adicional de LID/JID aqui.

  return {
    phone,      // chave canônica do chat (contato ou grupo) — nunca o nosso próprio número
    debugReason, // motivo de seleção (usado no log de debug abaixo)
    texto,
    fromMe,
    messageId,
    criado_em: ts ? new Date(Number(ts)).toISOString() : new Date().toISOString(),
    type,
    imageUrl,
    documentUrl,
    audioUrl,
    videoUrl,
    stickerUrl,
    locationUrl,
    fileName,
    isGroup,
    isEdit,
    isNewsletter,
    waitingMessage,
    participantPhone: participantPhoneRaw || null,
    senderName: senderName ? String(senderName).trim() : null,
    senderLid,
    nomeGrupo: (isGroup && (payload.chatName ?? payload.groupName ?? payload.subject)) ? String(payload.chatName ?? payload.groupName ?? payload.subject).trim() : null,
    senderPhoto: senderPhoto && String(senderPhoto).trim() ? String(senderPhoto).trim() : null,
    chatPhoto: chatPhoto && String(chatPhoto).trim() ? String(chatPhoto).trim() : null
  }
}

/**
 * POST /webhooks/zapi — recebe callback do Z-API (mensagem recebida ou enviada). Suporta grupos e lote.
 */
/** Retorna array de payloads para processar (1 ou N mensagens). */
function getPayloads(body) {
  if (!body || typeof body !== 'object') return [{}]
  if (Array.isArray(body) && body.length > 0) return body
  if (body.data && Array.isArray(body.data) && body.data.length > 0) return body.data
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) return [body.data]
  if (body.value && typeof body.value === 'object') return [body.value]
  if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) return body.messages
  if (body.message && typeof body.message === 'object') return [body.message]
  return [body]
}

/** Fallback para obter telefone do CONTATO em mensagens fromMe quando pickBestPhone retorna vazio.
 *  Não devolve LID nem número \"inventado\" – apenas telefones BR válidos.
 */
function getFallbackPhoneForFromMe(payload) {
  if (!payload || typeof payload !== 'object') return ''

  // 1) Tenta reaproveitar a mesma lógica de seleção principal
  const best = pickBestPhone(payload, { fromMe: true })
  if (best) return best

  // 2) Fallback extra: varre vários campos à procura de um número BR válido
  const candidates = [
    payload.to,
    payload.recipientPhone,
    payload.toPhone,
    payload.recipient,
    payload.destination,
    payload.key?.remoteJid,
    payload.remoteJid,
    payload.chatId,
    payload.chat?.id,
    payload.phone,
  ]

  for (const cand of candidates) {
    if (!cand) continue
    const s = String(cand).trim()
    if (!s) continue

    // Ignorar IDs internos (lid/broadcast)
    if (s.endsWith('@lid') || s.endsWith('@broadcast')) continue

    // Extrair dígitos do JID ou do valor cru
    const digits = s.includes('@')
      ? s.replace(/@[^@]+$/, '').replace(/\D/g, '')
      : s.replace(/\D/g, '')

    if (!looksLikeBRPhoneDigits(digits)) continue

    const norm = normalizePhoneBR(digits)
    if (norm) {
      console.log('[Z-API] getFallbackPhoneForFromMe → usando telefone BR:', norm)
      return norm
    }
  }

  console.warn('[Z-API] getFallbackPhoneForFromMe: nenhum telefone BR válido encontrado em fromMe.')
  return ''
}

/** GET /webhooks/zapi — teste de conectividade; retorna todas as URLs para configurar no painel Z-API. */
exports.testarZapi = (req, res) => {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
  const prefix = `${base}/webhooks/zapi`
  const urls = {
    mensagens: prefix,
    status: `${prefix}/status`,
    connection: `${prefix}/connection`,
    presence: `${prefix}/presence`
  }
  return res.status(200).json({
    ok: true,
    message: 'Configure no painel Z-API (Opções → Editar instância) cada webhook com a URL correspondente. Método: POST.',
    urls,
    webhooks: [
      { nome: 'Ao receber / Ao enviar', url: urls.mensagens, tipo: 'ReceivedCallback + DeliveryCallback' },
      { nome: 'Receber status da mensagem', url: urls.status, tipo: 'MessageStatusCallback (READ/RECEIVED/PLAYED)' },
      { nome: 'Ao conectar / Ao desconectar', url: urls.connection, tipo: 'connected / disconnected' },
      { nome: 'Status do chat (digitando)', url: urls.presence, tipo: 'PresenceChatCallback' }
    ]
  })
}

/** GET /webhooks/zapi/debug — diagnóstico completo: webhooks recebidos, rejeitados e configuração. */
exports.debugZapi = (req, res) => {
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '')
  const token = String(process.env.ZAPI_WEBHOOK_TOKEN || '').trim()
  const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : '(SEM TOKEN CONFIGURADO)'
  return res.status(200).json({
    ok: true,
    servidor: {
      app_url: appUrl || '(não definido)',
      zapi_instance_id: String(process.env.ZAPI_INSTANCE_ID || '').slice(0, 8) + '...',
      webhook_token_configurado: !!token,
      whatsapp_debug: WHATSAPP_DEBUG,
      company_id: COMPANY_ID,
    },
    urls_esperadas: {
      recebidas: `${appUrl}/webhooks/zapi${tokenSuffix}`,
      status:    `${appUrl}/webhooks/zapi/status${tokenSuffix}`,
      conexao:   `${appUrl}/webhooks/zapi/connection${tokenSuffix}`,
      presenca:  `${appUrl}/webhooks/zapi/presence${tokenSuffix}`,
    },
    diagnostico: {
      total_recebidos: _webhookLog.length,
      total_rejeitados: _rejectedLog.length,
      instrucao: 'Se total_rejeitados > 0, o Z-API está chamando URLs sem token. Verifique o painel Z-API e garanta que as URLs acima estão configuradas.',
    },
    ultimos_webhooks_recebidos: _webhookLog,
    ultimos_webhooks_rejeitados: _rejectedLog,
  })
}

exports.receberZapi = async (req, res) => {
  try {
    const body = req.body || {}

    // Log SEMPRE — essencial para diagnóstico em produção
    const bodyPreview = {
      type:       body.type || body.event || '(vazio)',
      phone:      (body.phone || '(vazio)').toString().slice(-12),
      fromMe:     body.fromMe ?? body.key?.fromMe ?? '?',
      instanceId: body.instanceId != null ? String(body.instanceId).slice(0, 12) : '(vazio)',
      hasText:    !!(body.text?.message || body.message || body.body),
      hasMedia:   !!(body.image || body.audio || body.video || body.document || body.sticker),
      status:     body.status || body.ack || '(sem status)',
      ip:         req.ip || req.socket?.remoteAddress || '?'
    }
    console.log('[Z-API] ▶ webhook recebido:', JSON.stringify(bodyPreview))

    // Salva no buffer de diagnóstico (GET /webhooks/zapi/debug)
    // rawBody: sempre salvo (truncado em 600 chars) para permitir diagnóstico mesmo sem WHATSAPP_DEBUG
    _logWebhook({
      type:    bodyPreview.type,
      phone:   bodyPreview.phone,
      fromMe:  bodyPreview.fromMe,
      hasText: bodyPreview.hasText,
      hasMedia: bodyPreview.hasMedia,
      status:  bodyPreview.status,
      ip:      bodyPreview.ip,
      rawBody: JSON.stringify(body).slice(0, 600)
    })

    const payloads = getPayloads(body)
    let lastResult = { ok: true }

    for (const payload of payloads) {
      // Normaliza status Z-API para canônico interno
      // Observação: alguns callbacks chegam como ACK numérico (0..4).
      const normalizeZapiStatus = (raw) => {
        const s = String(raw ?? '').trim().toLowerCase()

        // ACK numérico (comum em callbacks): 0=pending,1=sent,2=delivered,3=read,4=played
        if (/^\d+$/.test(s)) {
          const n = Number(s)
          if (n <= 0) return 'pending'
          if (n === 1) return 'sent'
          if (n === 2) return 'delivered'
          if (n === 3) return 'read'
          if (n >= 4) return 'played'
        }

        if (s === 'received' || s === 'entregue') return 'delivered'
        if (s === 'delivered') return 'delivered'
        if (s === 'read' || s === 'seen' || s === 'visualizada' || s === 'lida') return 'read'
        if (s === 'played') return 'played'
        if (s === 'pending' || s === 'enviando') return 'pending'
        if (s === 'sent' || s === 'enviada' || s === 'enviado') return 'sent'
        if (s === 'failed' || s === 'error' || s === 'erro') return 'erro'
        return s || null
      }

      // Helper: emite status_mensagem via socket
      const emitStatusMsg = (msg, statusNorm) => {
        const io = req.app.get('io')
        if (io && msg) {
          // Uma única emissão para empresa + conversa (evita duplicidade quando o socket está nas duas rooms)
          io.to(`empresa_${msg.company_id}`)
            .to(`conversa_${msg.conversa_id}`)
            .emit('status_mensagem', { mensagem_id: msg.id, conversa_id: msg.conversa_id, status: statusNorm })
        }
      }

      // Helper: atualiza status no banco por whatsapp_id
      const updateStatusByWaId = async (waId, statusNorm) => {
        if (!waId || !statusNorm) return null
        const { data: msg } = await supabase
          .from('mensagens')
          .update({ status: statusNorm })
          .eq('company_id', COMPANY_ID)
          .eq('whatsapp_id', String(waId))
          .select('id, conversa_id, company_id')
          .maybeSingle()
        return msg || null
      }

      // payloadType: usa type > event como fonte primária de classificação.
      // payloadTypeOrStatus: fallback inclui o campo "status" para Z-API que envia tipo no campo status.
      const payloadType = String(payload?.type ?? payload?.event ?? '').toLowerCase()
      // Em alguns callbacks, o status vem em "ack" (número) em vez de "status" (string).
      const payloadStatusRaw =
        payload?.ack != null ? String(payload.ack).trim() : String(payload?.status ?? '').trim()
      const payloadTypeOrStatus = payloadType || payloadStatusRaw.toLowerCase()

      if (WHATSAPP_DEBUG) {
        const msgId = payload?.messageId ?? payload?.zaapId ?? payload?.id ?? payload?.key?.id
        console.log('[Z-API] webhook payload', {
          eventType: payloadType || '(vazio)',
          messageId: msgId ? String(msgId).slice(0, 32) : null,
          from: (payload?.senderPhone ?? payload?.from ?? payload?.phone ?? '').toString().slice(-14),
          to: (payload?.to ?? payload?.recipientPhone ?? '').toString().slice(-14),
          chatId: (payload?.chatId ?? payload?.key?.remoteJid ?? '').toString().slice(0, 36),
          fromMe: Boolean(payload?.fromMe ?? payload?.key?.fromMe),
          hasText: !!(payload?.text?.message ?? payload?.message ?? payload?.body)
        })
      }

      // ─── MessageStatusCallback: READ / RECEIVED / PLAYED (ticks ✓✓ e azul) ───
      // Z-API envia este tipo quando o destinatário recebe ou lê a mensagem.
      // Se o payload tiver conteúdo de mensagem (text.message, message, body), é ReceivedCallback — NÃO status.
      const payloadFromMe = Boolean(payload?.fromMe ?? payload?.key?.fromMe)
      const hasMessageContent =
        (payload?.text?.message != null && String(payload.text.message).trim() !== '') ||
        (payload?.message != null && String(payload.message).trim() !== '') ||
        (payload?.body != null && String(payload.body).trim() !== '') ||
        payload?.image != null || payload?.imageUrl != null ||
        payload?.audio != null || payload?.audioUrl != null ||
        payload?.video != null || payload?.videoUrl != null ||
        payload?.document != null || payload?.documentUrl != null ||
        payload?.sticker != null || payload?.stickerUrl != null ||
        // Tipos extras que a Z-API envia como ReceivedCallback sem campo de texto/mídia
        payload?.reaction != null ||
        payload?.location != null ||
        payload?.contact != null  ||
        payload?.ptv != null      ||
        // Mensagem enviada pelo celular (espelhamento): tratar como conteúdo para gravar no sistema
        (payloadFromMe && (payload?.messageId || payload?.zaapId || (Array.isArray(payload?.ids) && payload.ids.length > 0)))

      // isStatusCallback: SOMENTE quando o payload NÃO tem conteúdo de mensagem E o tipo é
      // explicitamente de status (MessageStatusCallback, ReadCallback, etc.) OU o status é
      // read/played (nunca "received" isolado, pois ReceivedCallback envia status="RECEIVED").
      // ATENÇÃO: "received" como status NÃO qualifica sozinho — ReceivedCallback também tem
      // status="RECEIVED" mas é uma mensagem real. Apenas "read" e "played" são exclusivos de status.
      const STATUS_ONLY_KEYWORDS = ['read', 'played']
      const isStatusCallback =
        !hasMessageContent &&
        (payloadType === 'messagestatuscallback' ||
          payloadType === 'message_status_callback' ||
          payloadType === 'readcallback' ||
          payloadType === 'read_callback' ||
          payloadType === 'receivedcallback_ack' ||
          (STATUS_ONLY_KEYWORDS.includes(payloadStatusRaw.toLowerCase()) && (payload?.messageId || payload?.zaapId)))

      // Log de pipeline — sempre visível, para rastrear o que chega e como é classificado
      console.log(`[Z-API] 🔍 pipeline: type="${payloadType || '(vazio)'}" status="${payloadStatusRaw || '(vazio)'}" fromMe=${payloadFromMe} hasContent=${hasMessageContent} isStatus=${isStatusCallback} phone=${String(payload?.phone || '').slice(-10) || '(vazio)'}`)

      if (isStatusCallback) {
        const msgId = payload?.messageId ?? payload?.zaapId ?? null
        if (!msgId) continue
        const statusNorm = normalizeZapiStatus(payloadStatusRaw)
        if (!statusNorm) continue

        const msg = await updateStatusByWaId(String(msgId), statusNorm)
        if (msg) {
          emitStatusMsg(msg, statusNorm)
          console.log(`✅ Z-API status ${statusNorm.toUpperCase()} → msg ${msg.id} (conversa ${msg.conversa_id})`)
          // Visualizou no celular (read/played): zera notificação de mensagem nova no sistema para todos
          if (statusNorm === 'read' || statusNorm === 'played') {
            await marcarConversaComoLidaParaTodos(COMPANY_ID, msg.conversa_id)
            const io = req.app.get('io')
            if (io) {
              io.to(`empresa_${COMPANY_ID}`).emit('atualizar_conversa', { id: msg.conversa_id })
              io.to(`empresa_${COMPANY_ID}`).emit('mensagens_lidas', { conversa_id: msg.conversa_id })
            }
          }
        } else {
          console.warn(`⚠️ Z-API status ${statusNorm.toUpperCase()} recebido mas messageId não encontrado: ${String(msgId).slice(0, 25)}`)
        }
        lastResult = { ok: true, statusUpdate: true, messageId: String(msgId), status: statusNorm }
        continue
      }

      // DeliveryCallback (on-message-send)
      // Regra:
      // - Se for apenas ACK/status (sem conteúdo e sem fromMe), trata como status e NÃO grava nova mensagem.
      // - Se vier de notifySentByMe (fromMe=true) COM messageId, tratamos como MENSAGEM:
      //   deixa cair no pipeline normal (extractMessage → findOrCreateConversation → insert).
      if (payloadTypeOrStatus === 'deliverycallback') {
        if (payloadFromMe && (hasMessageContent || payload?.messageId || payload?.zaapId)) {
          const delivMsgId = payload?.messageId ?? payload?.zaapId ?? null
          const hasRealContent =
            (payload?.text?.message != null && String(payload.text.message).trim() !== '') ||
            (payload?.message != null && String(payload.message).trim() !== '') ||
            (payload?.body != null && String(payload.body).trim() !== '') ||
            payload?.image != null || payload?.imageUrl != null ||
            payload?.audio != null || payload?.audioUrl != null ||
            payload?.video != null || payload?.videoUrl != null ||
            payload?.document != null || payload?.documentUrl != null ||
            payload?.sticker != null || payload?.stickerUrl != null

          console.log('[Z-API] DeliveryCallback fromMe:', {
            messageId: delivMsgId ? String(delivMsgId).slice(0, 32) : null,
            phone: (payload?.phone || '').toString().slice(-12),
            hasRealContent
          })

          // Otimização: se não tem conteúdo real, verificar se a mensagem já foi salva pelo
          // ReceivedCallback. Se sim, apenas atualizar status e emitir socket — evitar criar
          // placeholder desnecessário e re-executar todo o pipeline.
          if (!hasRealContent && delivMsgId) {
            const { data: existByWaId } = await supabase
              .from('mensagens')
              .update({ status: 'sent' })
              .eq('company_id', COMPANY_ID)
              .eq('whatsapp_id', String(delivMsgId))
              .select('id, conversa_id, company_id')
              .maybeSingle()
            if (existByWaId?.id) {
              const io = req.app.get('io')
              if (io) {
                io.to(`empresa_${existByWaId.company_id}`)
                  .to(`conversa_${existByWaId.conversa_id}`)
                  .emit('status_mensagem', { mensagem_id: existByWaId.id, conversa_id: existByWaId.conversa_id, status: 'sent' })
              }
              lastResult = { ok: true, delivery: true, fromMe: true, messageId: String(delivMsgId) }
              continue
            }
            // Mensagem ainda não existe → segue para pipeline para registrar (espelhamento)
          }
          // NÃO faz continue → segue para pipeline de mensagem abaixo.
        } else {
        const company_id = COMPANY_ID
        const phoneDestRaw = payload?.phone ?? payload?.to ?? payload?.destination ?? ''
        const phoneDest = normalizePhoneBR(phoneDestRaw) || String(phoneDestRaw || '').replace(/\D/g, '')
        const messageId = payload?.messageId ?? payload?.zaapId ?? null
        const errorText = payload?.error != null ? String(payload.error) : ''

        if (!messageId) {
          console.log('📦 Z-API DeliveryCallback (sem messageId):', phoneDest ? String(phoneDest).slice(-12) : '(sem phone)')
          continue
        }

        const statusNorm = errorText ? 'erro' : 'sent'

        // 1) tenta atualizar por whatsapp_id
        let { data: msg, error } = await supabase
          .from('mensagens')
          .update({ status: statusNorm })
          .eq('company_id', company_id)
          .eq('whatsapp_id', String(messageId))
          .select('id, conversa_id, company_id')
          .maybeSingle()

        // 2) se não achou, tenta reconciliar a última mensagem out sem whatsapp_id na conversa de destino
        if (!error && !msg && phoneDest) {
          try {
            const isGroup = String(phoneDest).startsWith('120')
            const phones = isGroup ? [phoneDest] : possiblePhonesBR(phoneDest)
            let qConv = supabase
              .from('conversas')
              .select('id')
              .eq('company_id', company_id)
              .neq('status_atendimento', 'fechada')
              .order('id', { ascending: false })
              .limit(3)
            if (phones.length > 0) qConv = qConv.in('telefone', phones)
            const { data: convs } = await qConv
            const convId = Array.isArray(convs) && convs[0]?.id ? convs[0].id : null

            if (convId) {
              const ts = Date.now()
              const fromIso = new Date(ts - 10 * 60 * 1000).toISOString()
              const toIso = new Date(ts + 10 * 60 * 1000).toISOString()
              const { data: cand } = await supabase
                .from('mensagens')
                .select('id, conversa_id, company_id')
                .eq('company_id', company_id)
                .eq('conversa_id', convId)
                .eq('direcao', 'out')
                .is('whatsapp_id', null)
                .gte('criado_em', fromIso)
                .lte('criado_em', toIso)
                .order('criado_em', { ascending: false })
                .order('id', { ascending: false })
                .limit(1)

              const picked = Array.isArray(cand) && cand[0] ? cand[0] : null
              if (picked?.id) {
                const patched = await supabase
                  .from('mensagens')
                  .update({ whatsapp_id: String(messageId), status: statusNorm })
                  .eq('company_id', company_id)
                  .eq('id', picked.id)
                  .select('id, conversa_id, company_id')
                  .maybeSingle()
                msg = patched.data || null
              }
            }
          } catch (_) {}
        }

        if (errorText) {
          console.warn('❌ Z-API DeliveryCallback erro:', String(phoneDest || '').slice(-12), String(errorText).slice(0, 220))
        }

        if (!error && msg) {
          const io = req.app.get('io')
          if (io) {
            io.to(`empresa_${msg.company_id}`)
              .to(`conversa_${msg.conversa_id}`)
              .emit('status_mensagem', { mensagem_id: msg.id, conversa_id: msg.conversa_id, status: statusNorm })
          }
        }

        lastResult = { ok: true, delivery: true, messageId: String(messageId) }
        continue
      }
      }

      const extracted = extractMessage(payload)
      let {
        phone,
        debugReason,
        texto,
        fromMe,
        messageId,
        criado_em,
        type,
        imageUrl,
        documentUrl,
        audioUrl,
        videoUrl,
        stickerUrl,
        locationUrl,
        fileName,
        isGroup,
        isEdit,
        isNewsletter,
        waitingMessage,
        participantPhone,
        senderName,
        senderLid: extractedSenderLid,
        nomeGrupo,
        senderPhoto,
        chatPhoto
      } = extracted

      // Newsletters (canais) não são conversas de atendimento — ignorar silenciosamente
      if (isNewsletter) {
        console.log('[Z-API] ⏭️ isNewsletter=true — newsletter ignorada:', phone || '(sem phone)')
        continue
      }

      // ── Log de resolução de chave — SEMPRE visível (crítico para diagnóstico) ──
      console.log('[Z-API] 📞 resolveKey:', {
        type: payload?.type ?? payload?.event ?? '(sem type)',
        fromMe,
        isGroup,
        phone_raw: (payload?.phone ?? '').toString().slice(-14) || '(vazio)',
        connectedPhone_tail: (payload?.connectedPhone ?? '').toString().slice(-6) || '(ausente)',
        resolvedKey: phone ? ('...' + String(phone).slice(-8)) : '❌ VAZIO → SERÁ DROPADO',
        messageId: messageId ? String(messageId).slice(0, 20) : null,
        reason: debugReason,
      })

      if (!phone) {
        // Log SEMPRE do payload completo para diagnóstico — crítico para entender o que Z-API envia
        console.warn('⚠️ [Z-API] DROPPED — phone não resolvido:', debugReason)
        console.warn('⚠️ [Z-API] DROPPED — payload completo (diagnóstico):', JSON.stringify({
          type: payload?.type,
          fromMe: payload?.fromMe,
          phone: payload?.phone,
          senderPhone: payload?.senderPhone,
          connectedPhone: payload?.connectedPhone,
          chatId: payload?.chatId,
          remoteJid: payload?.remoteJid,
          to: payload?.to,
          toPhone: payload?.toPhone,
          recipientPhone: payload?.recipientPhone,
          'key.remoteJid': payload?.key?.remoteJid,
          isGroup: payload?.isGroup,
          messageId: payload?.messageId,
          status: payload?.status,
        }))
        continue
      }

    const company_id = COMPANY_ID
    if (isGroup) {
      console.log('📩 Z-API [GRUPO]', phone, nomeGrupo || '', fromMe ? '(de mim)' : `(${senderName || participantPhone || 'participante'})`, texto?.slice(0, 50))
    } else {
      console.log('📩 Z-API mensagem recebida:', phone, fromMe ? '(enviada por nós)' : '(recebida)', texto?.slice(0, 50))
    }

    let cliente_id = null
    let pendingContactSync = null

    if (!isGroup) {
      // LID sintético (@lid): mensagem espelhada enviada pelo celular sem número real conhecido.
      // Chave "lid:XXXX" NÃO é um número de telefone → nunca criar/vincular cliente.
      // A conversa é registrada normalmente com cliente_id = null até o contato enviar uma msg real.
      const isLidKey = String(phone).startsWith('lid:')

      if (isLidKey) {
        console.log('[Z-API] LID key — conversa sem cliente vinculado (número real não disponível):', phone)
        // cliente_id permanece null — não inserir registro falso na tabela clientes
      } else {
        // ── 1) Buscar cliente por todas as variantes de número BR (12/13 dígitos) ──────────────
        // Garante que um contato com/sem "9" seja tratado como o mesmo cliente.
        const phones = possiblePhonesBR(phone)
        let cliQuery = supabase.from('clientes').select('id, telefone, nome')
        if (phones.length > 0) cliQuery = cliQuery.in('telefone', phones)
        else cliQuery = cliQuery.eq('telefone', phone)
        cliQuery = cliQuery.eq('company_id', company_id)
        const { data: cliRows, error: errCli } = await cliQuery.order('id', { ascending: true }).limit(5)
        const clienteExistente = Array.isArray(cliRows) && cliRows.length > 0 ? cliRows[0] : null

        if (errCli) {
          console.error('Erro ao buscar cliente Z-API:', errCli)
          return res.status(500).json({ error: 'Erro ao buscar cliente' })
        }

        if (clienteExistente?.id) {
          cliente_id = clienteExistente.id
          // Atualizar com dados do payload (nome/foto) sem poluir quando fromMe=true.
          const nomePayloadRaw = fromMe
            ? (payload.chatName ?? payload.chat?.name ?? null)
            : (payload.senderName ?? payload.chatName ?? payload.chat?.name ?? null)
          const nomePayload = nomePayloadRaw ? String(nomePayloadRaw).trim() : null
          const updates = {}
          // Salva número se nome estiver vazio (nunca gravar LID como nome)
          if (nomePayload) updates.nome = nomePayload
          else if (!clienteExistente.nome || !String(clienteExistente.nome).trim()) {
            // Usar o número formatado, não o phone bruto
            const numericDisplay = String(phone).replace(/\D/g, '')
            if (numericDisplay) updates.nome = numericDisplay
          }
          if (!fromMe && senderPhoto) updates.foto_perfil = senderPhoto
          if (Object.keys(updates).length > 0) {
            await supabase.from('clientes').update(updates).eq('company_id', company_id).eq('id', cliente_id)
          }
          pendingContactSync = { phone, cliente_id }
        } else {
          // ── 2) Tentar reaproveitar cadastro legado (número antigo sem DDI/9) ─────────────────
          // Ex.: "3499999999" no banco vs "5534999999999" no webhook → mesmo contato.
          if (phone) {
            try {
              const digits10 = String(phone).replace(/\D/g, '').slice(-10)
              if (digits10 && digits10.length === 10) {
                const { data: legacyRows } = await supabase
                  .from('clientes')
                  .select('id, telefone')
                  .eq('company_id', company_id)
                  .like('telefone', `%${digits10}`)
                  .order('id', { ascending: true })
                  .limit(1)
                const legacy = Array.isArray(legacyRows) && legacyRows[0] ? legacyRows[0] : null
                if (legacy?.id) {
                  cliente_id = legacy.id
                  pendingContactSync = { phone, cliente_id }
                }
              }
            } catch (_) { /* fallback silencioso */ }
          }

          // ── 3) Inserir novo cliente — SOMENTE com telefone BR válido ─────────────────────────
          if (!cliente_id) {
            // Validar: telefoneCanonico deve ser número BR real (12 ou 13 dígitos com 55)
            const telefoneCanonico = getCanonicalPhone(phone)
            // Dupla proteção: rejeitar qualquer coisa que não seja número BR ou grupo real
            const isTelefoneValido = telefoneCanonico &&
              !telefoneCanonico.startsWith('lid:') &&
              (
                (telefoneCanonico.startsWith('55') && (telefoneCanonico.length === 12 || telefoneCanonico.length === 13)) ||
                telefoneCanonico.endsWith('@g.us') ||
                (telefoneCanonico.startsWith('120') && telefoneCanonico.length >= 15)
              )

            if (!isTelefoneValido) {
              console.warn('[Z-API] ⚠️ Telefone inválido para criar cliente — descartando cliente:', phone, '→ telefoneCanonico:', telefoneCanonico)
              // cliente_id permanece null; mensagem ainda será registrada na conversa
            } else {
              const fromPayloadRaw = fromMe
                ? (payload.chatName ?? payload.chat?.name ?? null)
                : (payload.senderName ?? payload.chatName ?? payload.chat?.name ?? null)
              const fromPayload = fromPayloadRaw ? String(fromPayloadRaw).trim() : null

              const { data: novoCliente, error: errNovoCli } = await supabase
                .from('clientes')
                .insert({
                  telefone: telefoneCanonico,
                  nome: fromPayload || telefoneCanonico || null,
                  observacoes: null,
                  company_id,
                  ...(!fromMe && senderPhoto ? { foto_perfil: senderPhoto } : {})
                })
                .select('id')
                .single()

              if (errNovoCli) {
                const isDuplicate = String(errNovoCli.code || '') === '23505' ||
                  String(errNovoCli.message || '').includes('unique') ||
                  String(errNovoCli.message || '').includes('duplicate')

                if (isDuplicate) {
                  // Race condition ou UNIQUE violation: buscar o que já existe
                  const phones2 = possiblePhonesBR(telefoneCanonico)
                  let q2 = supabase.from('clientes').select('id')
                  if (phones2.length > 0) q2 = q2.in('telefone', phones2)
                  else q2 = q2.eq('telefone', telefoneCanonico)
                  q2 = q2.eq('company_id', company_id)
                  const found = await q2.order('id', { ascending: true }).limit(1)
                  if (Array.isArray(found.data) && found.data[0]?.id) {
                    cliente_id = found.data[0].id
                    pendingContactSync = { phone, cliente_id }
                  }
                } else if (String(errNovoCli.message || '').includes('pushname') || String(errNovoCli.message || '').includes('does not exist')) {
                  // Coluna opcional ausente: retry sem ela
                  const fallbackInsert = await supabase
                    .from('clientes')
                    .insert({ telefone: telefoneCanonico, nome: fromPayload || telefoneCanonico || null, company_id,
                      ...(!fromMe && senderPhoto ? { foto_perfil: senderPhoto } : {}) })
                    .select('id').single()
                  if (!fallbackInsert.error) cliente_id = fallbackInsert.data.id
                }

                if (!cliente_id) {
                  console.error('❌ Z-API Erro ao criar cliente:', errNovoCli?.code, errNovoCli?.message)
                  return res.status(500).json({ error: 'Erro ao criar cliente' })
                }
              } else {
                cliente_id = novoCliente.id
              }
              pendingContactSync = { phone, cliente_id }
            }
          }
        }
      }
    }

    // 2) Conversa — uma única conversa por contato; quando Z-API envia chatLid, unificar por chat_lid
    //    para que "recebido" (phone real) e "enviado pelo celular" (phone @lid) caiam no mesmo chat.
    let conversa_id = null
    let departamento_id = null
    let isNewConversation = false

    const lidRaw = String(payload?.chatLid ?? payload?.phone ?? '').trim()
    const lidPart = lidRaw.endsWith('@lid') ? lidRaw.replace(/@lid$/i, '').trim() : (phone.startsWith('lid:') ? phone.slice(4) : null)

    try {
      if (lidPart) {
        const { data: convByLid } = await supabase
          .from('conversas')
          .select('id, departamento_id, telefone')
          .eq('company_id', company_id)
          .eq('chat_lid', lidPart)
          .maybeSingle()

        const hasRealPhone = phone && !phone.startsWith('lid:')
        let convByPhone = null
        if (hasRealPhone) {
          const canonical = getCanonicalPhone(phone)
          const variants = canonical ? possiblePhonesBR(canonical) : []
          const list = variants.length > 0 ? variants : [phone]
          const { data: rows } = await supabase
            .from('conversas')
            .select('id, departamento_id, telefone')
            .eq('company_id', company_id)
            .in('telefone', list)
            .order('ultima_atividade', { ascending: false })
            .limit(1)
          convByPhone = Array.isArray(rows) && rows[0] ? rows[0] : null
        }

        if (convByLid && convByPhone && convByLid.id !== convByPhone.id) {
          await mergeConversasIntoCanonico(supabase, company_id, convByPhone.id, [convByLid.id])
          await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', convByPhone.id).eq('company_id', company_id)
          conversa_id = convByPhone.id
          departamento_id = convByPhone.departamento_id ?? null
          isNewConversation = false
          console.log('[Z-API] 🔗 Unificado por chat_lid: conv LID mesclada em conv telefone', { conversa_id, lidPart })
        } else if (convByLid) {
          if (hasRealPhone) {
            const canonical = getCanonicalPhone(phone)
            if (canonical) {
              await supabase.from('conversas').update({ telefone: canonical, chat_lid: lidPart }).eq('id', convByLid.id).eq('company_id', company_id)
            } else {
              await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', convByLid.id).eq('company_id', company_id)
            }
          } else {
            await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', convByLid.id).eq('company_id', company_id)
          }
          conversa_id = convByLid.id
          departamento_id = convByLid.departamento_id ?? null
          isNewConversation = false
        } else if (convByPhone) {
          await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', convByPhone.id).eq('company_id', company_id)
          conversa_id = convByPhone.id
          departamento_id = convByPhone.departamento_id ?? null
          isNewConversation = false
        }
      }

      if (conversa_id == null) {
        const syncResult = await findOrCreateConversation(supabase, {
          company_id,
          phone,
          cliente_id: isGroup ? null : cliente_id,
          isGroup,
          nomeGrupo,
          chatPhoto,
          logPrefix: `[Z-API fromMe=${fromMe}]`,
        })

        if (!syncResult) {
          console.error('[Z-API] findOrCreateConversation retornou null para phone:', phone)
          return res.status(500).json({ error: 'Não foi possível identificar conversa para o número' })
        }

        conversa_id = syncResult.conversa.id
        departamento_id = syncResult.conversa.departamento_id ?? null
        isNewConversation = syncResult.created

        if (lidPart) {
          await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', conversa_id).eq('company_id', company_id)
        }
      }

      // Atualiza foto do grupo quando disponível no payload
      if (isGroup && chatPhoto && !isNewConversation) {
        await supabase.from('conversas')
          .update({ foto_grupo: chatPhoto })
          .eq('id', conversa_id)
          .eq('company_id', company_id)
      }

      if (isNewConversation) {
        const io = req.app.get('io')
        if (io) {
          io.to(`empresa_${company_id}`).emit('nova_conversa', {
            id: conversa_id,
            telefone: getCanonicalPhone(phone) || phone,
            tipo: isGroup ? 'grupo' : 'cliente',
            nome_grupo: isGroup ? (nomeGrupo || null) : null,
            foto_grupo: isGroup ? (chatPhoto || null) : null,
            contato_nome: isGroup ? (nomeGrupo || phone || 'Grupo') : (senderName || payload?.chatName || phone || null),
            foto_perfil: isGroup ? null : (senderPhoto || payload?.photo || null),
            unread_count: 0,
            tags: [],
          })
        }
      }
    } catch (errConv) {
      console.error('[Z-API] ❌ Erro ao obter/criar conversa:', errConv?.message || errConv)
      return res.status(500).json({ error: 'Erro ao obter conversa' })
    }

    // 3) Salvar mensagem. TUDO que a Z-API envia (recebido, !fromMe) é gravado; sem messageId grava com whatsapp_id null.
    // Mensagens enviadas por nós (fromMe): não inserir — evita eco/duplicata.
    const whatsappIdStr = messageId ? String(messageId).trim() : null
    let mensagemSalva = null

    // fromMe: também persiste (você pediu "todas as mensagens"). O índice único por (conversa_id, whatsapp_id)
    // evita duplicatas quando o provider reenviar o mesmo evento.

    // Não gravar evento que virou só "(mídia)" sem mídia real — exceto fromMe (espelhamento: mensagem enviada pelo celular deve aparecer)
    const soPlaceholderMidia = texto === '(mídia)' && !imageUrl && !documentUrl && !audioUrl && !videoUrl && !stickerUrl && !locationUrl
    if (soPlaceholderMidia && !fromMe) {
      await supabase
        .from('conversas')
        .update({ ultima_atividade: new Date().toISOString() })
        .eq('id', conversa_id)
        .eq('company_id', company_id)
      return res.status(200).json({ ok: true, conversa_id, skip: 'placeholderMidia' })
    }
    if (soPlaceholderMidia && fromMe) texto = '(mensagem)' // espelhamento: mostrar algo no chat

    // Histórico do celular: ao criar uma conversa nova, buscar as últimas mensagens do chat na Z-API
    // e inserir no banco (sem duplicar pelo whatsapp_id).
    if (isNewConversation) {
      const provider = getProvider()
      if (provider && provider.getChatMessages && provider.isConfigured) {
        const convIdForHistory = conversa_id
        const phoneForHistory = phone
        const isGroupForHistory = isGroup
        setImmediate(async () => {
          try {
            const history = await provider.getChatMessages(phoneForHistory, 25, null).catch(() => [])
            if (!Array.isArray(history) || history.length === 0) return

            // Inserir do mais antigo para o mais novo (ordem natural).
            const ordered = history
              .map((m) => m)
              .sort((a, b) => Number(a?.momment || a?.timestamp || 0) - Number(b?.momment || b?.timestamp || 0))

            for (const m of ordered) {
              const p = { ...(m || {}), isGroup: isGroupForHistory, phone: phoneForHistory }
              const ex = extractMessage(p)
              const wId = ex.messageId ? String(ex.messageId).trim() : null
              if (!ex.texto) continue
              const placeholder = ex.texto === '(mídia)' && !ex.imageUrl && !ex.documentUrl && !ex.audioUrl && !ex.videoUrl && !ex.stickerUrl && !ex.locationUrl
              if (placeholder) continue

              // Evitar duplicar: se não tem whatsapp_id, pula (histórico sem id pode gerar duplicatas).
              if (!wId) continue

              const insertMsg = {
                conversa_id: convIdForHistory,
                texto: ex.texto,
                direcao: ex.fromMe ? 'out' : 'in',
                company_id,
                whatsapp_id: wId,
                criado_em: ex.criado_em
              }

              // Remetente em grupo (quando disponível)
              if (isGroupForHistory && !ex.fromMe) {
                if (ex.senderName) insertMsg.remetente_nome = ex.senderName
                if (ex.participantPhone) insertMsg.remetente_telefone = ex.participantPhone
              }

              // Mapear mídia
              if (ex.type === 'image' && ex.imageUrl) {
                insertMsg.tipo = 'imagem'
                insertMsg.url = ex.imageUrl
                insertMsg.nome_arquivo = ex.fileName || 'imagem.jpg'
              } else if ((ex.type === 'document' || ex.type === 'file') && ex.documentUrl) {
                insertMsg.tipo = 'arquivo'
                insertMsg.url = ex.documentUrl
                insertMsg.nome_arquivo = ex.fileName || 'arquivo'
              } else if (ex.type === 'audio' && ex.audioUrl) {
                insertMsg.tipo = 'audio'
                insertMsg.url = ex.audioUrl
                insertMsg.nome_arquivo = ex.fileName || 'audio'
              } else if (ex.type === 'video' && ex.videoUrl) {
                insertMsg.tipo = 'video'
                insertMsg.url = ex.videoUrl
                insertMsg.nome_arquivo = ex.fileName || 'video'
              } else if (ex.type === 'sticker' && ex.stickerUrl) {
                insertMsg.tipo = 'sticker'
                insertMsg.url = ex.stickerUrl
                insertMsg.nome_arquivo = ex.fileName || 'sticker.webp'
              } else if (ex.type === 'location' && ex.locationUrl) {
                insertMsg.tipo = 'texto'
                insertMsg.url = ex.locationUrl
                insertMsg.nome_arquivo = 'localização'
              }

              const { error: histErr } = await supabase.from('mensagens').insert(insertMsg)
              if (histErr && String(histErr.code || '') !== '23505') {
                // 23505 = duplicata pelo índice único; ignore.
                console.warn('⚠️ Histórico Z-API: falha ao inserir msg:', String(histErr.message || '').slice(0, 120))
              }
            }
          } catch (e) {
            console.warn('⚠️ Histórico Z-API: erro ao importar:', e?.message || e)
          }
        })
      }
    }

    // Idempotência: chave única (conversa_id, whatsapp_id) — reenvio do webhook não duplica
    if (whatsappIdStr) {
      const { data: existente } = await supabase
        .from('mensagens')
        .select('*')
        .eq('conversa_id', conversa_id)
        .eq('whatsapp_id', whatsappIdStr)
        .maybeSingle()
      if (existente) {
        // Se a mensagem salva tem texto placeholder (DeliveryCallback chegou antes do ReceivedCallback)
        // e o webhook atual traz conteúdo real → atualizar com o texto/mídia corretos.
        const savedTexto = String(existente.texto || '')
        const isPlaceholder = savedTexto === '(mensagem)' || savedTexto === '(mídia)'
        const textoReal = texto && texto !== '(mensagem)' && texto !== '(mídia)' ? texto : null
        if (isPlaceholder && textoReal) {
          const upFields = { texto: textoReal }
          if (imageUrl && !existente.url) { upFields.url = imageUrl; upFields.tipo = 'imagem' }
          else if (documentUrl && !existente.url) { upFields.url = documentUrl; upFields.tipo = 'arquivo' }
          else if (audioUrl && !existente.url) { upFields.url = audioUrl; upFields.tipo = 'audio' }
          else if (videoUrl && !existente.url) { upFields.url = videoUrl; upFields.tipo = 'video' }
          else if (stickerUrl && !existente.url) { upFields.url = stickerUrl; upFields.tipo = 'sticker' }
          try {
            const { data: updMsg } = await supabase
              .from('mensagens')
              .update(upFields)
              .eq('id', existente.id)
              .select('*')
              .single()
            mensagemSalva = updMsg || existente
            if (WHATSAPP_DEBUG) console.log('[Z-API] idempotência: placeholder atualizado com conteúdo real', existente.id)
          } catch (_) {
            mensagemSalva = existente
          }
        } else {
          mensagemSalva = existente
        }
      }
    }

    // ─── Reply/citação: extraído ANTES da reconciliação para que ambos os caminhos usem ───
    // Z-API usa "referencedMessage.messageId" como campo principal; outros formatos são fallbacks.
    let webhookReplyMeta = null
    {
      const refMsg = payload?.referencedMessage ?? payload?.quotedMsg ?? payload?.quoted ?? null
      const quotedIdRaw =
        payload?.referenceMessageId ??          // campo oficial Z-API ReceivedCallback
        payload?.referencedMessage?.messageId ??
        payload?.referencedMessage?.id ??
        payload?.quotedMsgId ??
        payload?.quotedMessageId ??
        payload?.quotedStanzaId ??
        payload?.contextInfo?.stanzaId ??
        payload?.contextInfo?.quotedStanzaId ??
        payload?.contextInfo?.quotedMessageId ??
        refMsg?.id ??
        refMsg?.messageId ??
        payload?.message?.contextInfo?.stanzaId ??
        payload?.message?.contextInfo?.quotedStanzaId ??
        null
      const quotedId = quotedIdRaw ? String(quotedIdRaw).trim() : null

      const refBodyFallback =
        String(
          payload?.referencedMessage?.body ??
          payload?.referencedMessage?.text?.message ??
          payload?.referencedMessage?.caption ??
          refMsg?.message ??
          refMsg?.body ??
          refMsg?.text?.message ??
          ''
        ).trim().slice(0, 180) || null

      const refFromMe = payload?.referencedMessage?.fromMe ?? refMsg?.fromMe ?? null

      if (quotedId) {
        try {
          const { data: quoted } = await supabase
            .from('mensagens')
            .select('texto, direcao, remetente_nome')
            .eq('company_id', company_id)
            .eq('conversa_id', conversa_id)
            .eq('whatsapp_id', quotedId)
            .maybeSingle()

          const snippet =
            String(quoted?.texto || '').trim().slice(0, 180) ||
            refBodyFallback ||
            'Mensagem'

          let name
          if (quoted) {
            name = quoted.direcao === 'out' ? 'Você' : (String(quoted.remetente_nome || '').trim() || 'Contato')
          } else {
            name = (refFromMe === true) ? 'Você' : 'Contato'
          }
          webhookReplyMeta = { name, snippet, ts: Date.now(), replyToId: quotedId }
        } catch (_) {
          webhookReplyMeta = { name: (refFromMe === true ? 'Você' : 'Mensagem'), snippet: refBodyFallback || 'Mensagem', ts: Date.now(), replyToId: quotedId }
        }
      }
    }

    // ✅ Anti-duplicação profissional (envio pelo sistema + eco do webhook fromMe):
    // Quando enviamos pelo CRM, a mensagem é inserida com whatsapp_id = null.
    // Em seguida o Z-API pode disparar webhook fromMe com whatsapp_id real.
    // Para não duplicar, tentamos "reconciliar" atualizando a mensagem recente do CRM com o whatsapp_id.
    if (!mensagemSalva && fromMe && whatsappIdStr) {
      try {
        const statusPayload = (payload.status && String(payload.status).toLowerCase()) || null

        // assinatura da mídia para bater com a mensagem enviada pelo sistema
        const urlSig =
          (type === 'image' && imageUrl) ? imageUrl :
          ((type === 'document' || type === 'file') && documentUrl) ? documentUrl :
          (type === 'audio' && audioUrl) ? audioUrl :
          (type === 'video' && videoUrl) ? videoUrl :
          (type === 'sticker' && stickerUrl) ? stickerUrl :
          (type === 'location' && locationUrl) ? locationUrl :
          null

        const tsMs = Date.parse(criado_em)
        const windowMs = 5 * 60 * 1000 // 5 min
        const fromIso = Number.isFinite(tsMs) ? new Date(tsMs - windowMs).toISOString() : null
        const toIso = Number.isFinite(tsMs) ? new Date(tsMs + windowMs).toISOString() : null

        let q = supabase
          .from('mensagens')
          .select('id, criado_em, texto, url, nome_arquivo, tipo, whatsapp_id, reply_meta')
          .eq('company_id', company_id)
          .eq('conversa_id', conversa_id)
          .eq('direcao', 'out')
          .is('whatsapp_id', null)
          .order('criado_em', { ascending: false })
          .order('id', { ascending: false })
          .limit(10)

        if (fromIso && toIso) q = q.gte('criado_em', fromIso).lte('criado_em', toIso)

        if (urlSig) q = q.eq('url', urlSig)
        else if (texto) q = q.eq('texto', texto)

        const { data: candidates } = await q
        const cand = Array.isArray(candidates) && candidates.length > 0 ? candidates[0] : null
        if (cand?.id) {
          const updates = { whatsapp_id: whatsappIdStr }
          if (statusPayload) updates.status = statusPayload
          // Aplica reply_meta se o webhook trouxe citação e o registro pendente não tem
          if (webhookReplyMeta && !cand.reply_meta) updates.reply_meta = webhookReplyMeta

          const { data: patched, error: patchErr } = await supabase
            .from('mensagens')
            .update(updates)
            .eq('company_id', company_id)
            .eq('id', cand.id)
            .select('*')
            .single()

          if (!patchErr && patched) {
            mensagemSalva = patched
          }
        }
      } catch (e) {
        console.warn('⚠️ fromMe reconcile: erro ao reconciliar:', e?.message || e)
      }
    }

    // isEdit: mensagem editada → atualizar texto da mensagem existente, não inserir nova
    if (!mensagemSalva && isEdit && whatsappIdStr) {
      try {
        const { data: editTarget } = await supabase
          .from('mensagens')
          .update({ texto })
          .eq('company_id', company_id)
          .eq('whatsapp_id', whatsappIdStr)
          .select('*')
          .maybeSingle()
        if (editTarget) {
          mensagemSalva = editTarget
          console.log(`✏️ Z-API isEdit: mensagem ${editTarget.id} atualizada (conversa ${conversa_id})`)
          const io = req.app.get('io')
          if (io) {
            io.to(`conversa_${conversa_id}`).to(`empresa_${company_id}`).emit('mensagem_editada', {
              id: editTarget.id,
              conversa_id,
              texto,
            })
          }
        }
      } catch (editErr) {
        console.warn('[Z-API] isEdit: erro ao atualizar mensagem:', editErr?.message)
      }
    }

    if (!mensagemSalva) {
      // waitingMessage: status inicial 'pending' enquanto a mensagem está em fila de envio
      const statusPayload = waitingMessage
        ? 'pending'
        : ((payload.status && String(payload.status).toLowerCase()) || null)
      const reply_meta = webhookReplyMeta || null

      const insertMsg = {
        conversa_id,
        texto,
        direcao: fromMe ? 'out' : 'in',
        company_id,
        whatsapp_id: whatsappIdStr || null,
        criado_em,
        ...(statusPayload ? { status: statusPayload } : {})
      }
      if (reply_meta) insertMsg.reply_meta = reply_meta
      if (isGroup && !fromMe) {
        // Grupo: salvar SEMPRE no grupo, e armazenar remetente (membro) na mensagem.
        const pNorm = participantPhone ? (normalizePhoneBR(participantPhone) || String(participantPhone).replace(/\D/g, '')) : ''
        if (pNorm) insertMsg.remetente_telefone = pNorm

        // Tenta resolver nome do membro pelo cadastro de clientes (contatos já sincronizados).
        let remetenteNomeFinal = senderName || pNorm || null
        if (pNorm) {
          try {
            const pPhones = possiblePhonesBR(pNorm)
            let qM = supabase.from('clientes').select('id, nome, pushname, telefone').order('id', { ascending: true }).limit(3)
            if (pPhones.length > 0) qM = qM.in('telefone', pPhones)
            else qM = qM.eq('telefone', pNorm)
            qM = qM.eq('company_id', company_id)
            const { data: rowsM } = await qM
            const ex = Array.isArray(rowsM) && rowsM.length > 0 ? rowsM[0] : null
            if (ex) {
              remetenteNomeFinal = ex.pushname || ex.nome || remetenteNomeFinal
            } else {
              // se não existe no banco, cria "contato mínimo" (sem conversa) para poder exibir nome depois
              if (pNorm) {
                const nomeMin = senderName ? String(senderName).trim() : pNorm
                const ins = await supabase.from('clientes').insert({ company_id, telefone: pNorm, nome: nomeMin }).select('id').maybeSingle()
                if (ins?.data?.id) {
                  // sync em background (nome/foto reais)
                  setImmediate(async () => {
                    try {
                      const sync = await syncContactFromZapi(pNorm).catch(() => null)
                      if (!sync) return
                      const up = {}
                      if (sync.nome) up.nome = sync.nome
                      if (sync.pushname) up.pushname = sync.pushname
                      if (sync.foto_perfil) up.foto_perfil = sync.foto_perfil
                      if (Object.keys(up).length > 0) await supabase.from('clientes').update(up).eq('id', ins.data.id)
                    } catch (_) {}
                  })
                }
              }
            }
          } catch (_) {}
        }
        if (remetenteNomeFinal) insertMsg.remetente_nome = String(remetenteNomeFinal).trim()
      }
      if (type === 'image' && imageUrl) {
        insertMsg.tipo = 'imagem'
        insertMsg.url = imageUrl
        insertMsg.nome_arquivo = fileName || 'imagem.jpg'
      } else if ((type === 'document' || type === 'file') && documentUrl) {
        insertMsg.tipo = 'arquivo'
        insertMsg.url = documentUrl
        insertMsg.nome_arquivo = fileName || 'arquivo'
      } else if (type === 'audio' && audioUrl) {
        insertMsg.tipo = 'audio'
        insertMsg.url = audioUrl
        insertMsg.nome_arquivo = fileName || 'audio'
      } else if (type === 'video' && videoUrl) {
        insertMsg.tipo = 'video'
        insertMsg.url = videoUrl
        insertMsg.nome_arquivo = fileName || 'video'
      } else if (type === 'sticker' && stickerUrl) {
        insertMsg.tipo = 'sticker'
        insertMsg.url = stickerUrl
        insertMsg.nome_arquivo = fileName || 'sticker.webp'
      } else if (type === 'location' && locationUrl) {
        insertMsg.tipo = 'texto'
        insertMsg.url = locationUrl
        insertMsg.nome_arquivo = 'localização'
      }
      // reaction, contact e qualquer outro tipo: já têm texto preenchido; tipo padrão é texto

      let { data: inserted, error: errMsg } = await supabase
        .from('mensagens')
        .insert(insertMsg)
        .select('*')
        .single()

      // Compatibilidade: se a coluna reply_meta não existir ainda, remove e tenta de novo
      if (errMsg && (String(errMsg.message || '').includes('reply_meta') || String(errMsg.message || '').includes('does not exist'))) {
        delete insertMsg.reply_meta
        const retryReply = await supabase.from('mensagens').insert(insertMsg).select('*').single()
        inserted = retryReply.data
        errMsg = retryReply.error
      }

      if (errMsg && (String(errMsg.message || '').includes('remetente_nome') || String(errMsg.message || '').includes('remetente_telefone') || String(errMsg.message || '').includes('does not exist'))) {
        delete insertMsg.remetente_nome
        delete insertMsg.remetente_telefone
        const retry = await supabase.from('mensagens').insert(insertMsg).select('*').single()
        inserted = retry.data
        errMsg = retry.error
      }
      if (errMsg) {
        if (String(errMsg.code || '') === '23505' || String(errMsg.message || '').includes('duplicate') || String(errMsg.message || '').includes('unique')) {
          const { data: existente } = await supabase.from('mensagens').select('*').eq('conversa_id', conversa_id).eq('whatsapp_id', whatsappIdStr).maybeSingle()
          mensagemSalva = existente
        } else {
          // Fallback: qualquer mensagem que chega TEM que ficar no sistema — tenta inserir com payload mínimo
          console.warn('⚠️ Z-API fallback insert após erro:', errMsg.message)
          let fallbackPayload = {
            conversa_id,
            texto: texto || '(mensagem)',
            direcao: fromMe ? 'out' : 'in',
            company_id,
            whatsapp_id: whatsappIdStr || null,
            criado_em
          }
          if (isGroup && senderName) fallbackPayload.remetente_nome = senderName
          if (isGroup && participantPhone) fallbackPayload.remetente_telefone = participantPhone
          let fallback = await supabase.from('mensagens').insert(fallbackPayload).select('*').single()
          if (fallback.error && (String(fallback.error.message || '').includes('remetente_nome') || String(fallback.error.message || '').includes('remetente_telefone'))) {
            delete fallbackPayload.remetente_nome
            delete fallbackPayload.remetente_telefone
            fallback = await supabase.from('mensagens').insert(fallbackPayload).select('*').single()
          }
          if (!fallback.error) {
            mensagemSalva = fallback.data
            console.log('✅ Mensagem salva (fallback):', mensagemSalva.id)
          } else {
            console.error('❌ Z-API Erro ao salvar mensagem:', errMsg?.code, errMsg?.message, errMsg?.details)
            return res.status(500).json({ error: 'Erro ao salvar mensagem' })
          }
        }
      } else {
        mensagemSalva = inserted
      }
    }

    if (mensagemSalva) {
      const { error: errUpdate } = await supabase
        .from('conversas')
        .update({ ultima_atividade: new Date().toISOString() })
        .eq('id', conversa_id)
        .eq('company_id', company_id)
      if (errUpdate && (String(errUpdate.message || '').includes('ultima_atividade') || String(errUpdate.code || '') === 'PGRST204')) {
        console.warn('⚠️ Atualização ultima_atividade ignorada (coluna ausente). Execute RUN_IN_SUPABASE.sql no Supabase.')
      }

      // CRM: atualiza último contato do cliente (apenas conversas individuais)
      try {
        if (!isGroup) {
          const { data: convRow } = await supabase
            .from('conversas')
            .select('cliente_id, tipo, telefone')
            .eq('company_id', company_id)
            .eq('id', conversa_id)
            .maybeSingle()
          const convIsGroup = String(convRow?.tipo || '').toLowerCase() === 'grupo' || String(convRow?.telefone || '').includes('@g.us')
          if (!convIsGroup && convRow?.cliente_id != null) {
            await supabase
              .from('clientes')
              .update({ ultimo_contato: mensagemSalva.criado_em || new Date().toISOString(), atualizado_em: new Date().toISOString() })
              .eq('company_id', company_id)
              .eq('id', Number(convRow.cliente_id))
          }
        }
      } catch (_) {}

      console.log('✅ Mensagem salva no sistema:', { conversa_id, mensagem_id: mensagemSalva.id, phone: phone?.slice(-6), direcao: fromMe ? 'out' : 'in' })
      if (fromMe) console.log('📤 Espelhamento: mensagem enviada pelo celular registrada no sistema')
    }

    // Mensagem de entrada: incrementa unread no banco para todos os usuários (igual WhatsApp; refetch da lista já vem com contador certo)
    if (!fromMe) {
      await incrementarUnreadParaConversa(company_id, conversa_id)
    }

    // 4) Realtime: nova_mensagem + atualizar_conversa — sempre para empresa (lista + chat em tempo real, espelho WhatsApp)
    const io = req.app.get('io')
    if (io && mensagemSalva) {
      const rooms = [`conversa_${conversa_id}`, `empresa_${company_id}`]
      if (departamento_id != null) rooms.push(`departamento_${departamento_id}`)
      // Status canônico para os ticks no frontend (sent, delivered, read, pending, erro, played)
      const rawStatus = (mensagemSalva.status_mensagem ?? mensagemSalva.status ?? '').toString().toLowerCase()
      const canon = rawStatus === 'enviada' || rawStatus === 'enviado' ? 'sent' : (rawStatus === 'entregue' || rawStatus === 'received' ? 'delivered' : (rawStatus || (fromMe ? 'sent' : 'delivered')))
      // Nota: renomeado de 'payload' para 'emitPayload' para evitar shadowing da variável de loop
      const emitPayload = {
        ...mensagemSalva,
        conversa_id: mensagemSalva.conversa_id ?? conversa_id,
        status: canon,
        status_mensagem: canon
      }
      io.to(rooms).emit('nova_mensagem', emitPayload)
      io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: conversa_id })
      io.to(`empresa_${company_id}`).emit('conversa_atualizada', { id: conversa_id })
      if (departamento_id != null) {
        io.to(`departamento_${departamento_id}`).emit('atualizar_conversa', { id: conversa_id })
        io.to(`departamento_${departamento_id}`).emit('conversa_atualizada', { id: conversa_id })
      }
    }

    if (pendingContactSync && io) {
      const { cliente_id: syncClienteId } = pendingContactSync
      const syncPhone = pendingContactSync.phone
      const convId = conversa_id
      setImmediate(() => {
        syncContactFromZapi(syncPhone)
          .then((synced) => {
            if (!synced) return null
            const up = {}
            // Se não houver nome na Z-API, salva o número.
            up.nome = (synced.nome && String(synced.nome).trim()) ? String(synced.nome).trim() : syncPhone
            if (synced.pushname !== undefined) up.pushname = synced.pushname
            if (synced.foto_perfil) up.foto_perfil = synced.foto_perfil
            if (Object.keys(up).length === 0) return null
            return supabase.from('clientes').update(up).eq('id', syncClienteId).eq('company_id', company_id)
          })
          .then((res) => {
            if (!res || res.error) return null
            return supabase.from('clientes').select('nome, pushname, telefone, foto_perfil').eq('id', syncClienteId).single()
          })
          .then((r) => {
            const data = r?.data
            if (data && io) {
              const displayName = data.pushname || data.nome || data.telefone || syncPhone
              console.log('✅ Contato sincronizado Z-API:', syncPhone?.slice(-6), displayName || '(sem nome)')
              io.to(`empresa_${company_id}`).emit('contato_atualizado', {
                conversa_id: convId,
                contato_nome: displayName,
                foto_perfil: data.foto_perfil
              })
            }
          })
          .catch((e) => {
            console.error('❌ Erro Z-API ao sincronizar contato:', syncPhone?.slice(-6), e?.message || e)
          })
      })
    }

    lastResult = { ok: true, conversa_id, mensagem_id: mensagemSalva?.id }
    }

    return res.status(200).json(lastResult)
  } catch (err) {
    console.error('Erro webhook Z-API:', err)
    return res.status(500).json({ error: 'Erro ao processar webhook' })
  }
}

/**
 * POST /webhooks/zapi/status — status da mensagem (entrega/leitura) para ticks ✓✓.
 * Z-API envia: status (SENT|RECEIVED|READ|READ_BY_ME|PLAYED) e ids (array de IDs).
 * Também aceita: messageId, zaapId, id (formato antigo).
 */
exports.statusZapi = async (req, res) => {
  try {
    const body = req.body || {}
    // Z-API oficial usa "ids" (array); fallback para messageId, zaapId, id
    const idsRaw = body?.ids
    const messageIds = Array.isArray(idsRaw) && idsRaw.length > 0
      ? idsRaw.map((id) => (id != null ? String(id).trim() : '')).filter(Boolean)
      : []
    const singleId = body?.messageId ?? body?.zaapId ?? body?.id ?? (messageIds.length > 0 ? messageIds[0] : null)
    const idsToProcess = messageIds.length > 0 ? messageIds : (singleId ? [String(singleId).trim()] : [])

    const rawStatus =
      body?.ack != null ? String(body.ack).trim().toLowerCase() : String(body?.status ?? '').trim().toLowerCase()

    // Debug: log toda requisição recebida em /webhooks/zapi/status
    console.log('[DEBUG] /webhooks/zapi/status recebido:', {
      ids: idsToProcess.length ? idsToProcess.slice(0, 3).map((id) => id.slice(0, 24) + (id.length > 24 ? '…' : '')) : null,
      statusBruto: body?.status ?? body?.ack ?? '(vazio)',
      ack: body?.ack,
      erro: body?.error != null ? String(body.error).slice(0, 100) : null
    })

    if (idsToProcess.length === 0) {
      console.log('[DEBUG] /webhooks/zapi/status: sem messageId nem ids, ignorando.')
      return res.status(200).json({ ok: true })
    }

    const statusNorm = (() => {
      if (/^\d+$/.test(rawStatus)) {
        const n = Number(rawStatus)
        if (n <= 0) return 'pending'
        if (n === 1) return 'sent'
        if (n === 2) return 'delivered'
        if (n === 3) return 'read'
        if (n >= 4) return 'played'
      }
      return (
        rawStatus === 'received' || rawStatus === 'entregue' ? 'delivered' :
        rawStatus === 'delivered' ? 'delivered' :
        rawStatus === 'read' || rawStatus === 'read_by_me' || rawStatus === 'seen' || rawStatus === 'visualizada' || rawStatus === 'lida' ? 'read' :
        rawStatus === 'played' ? 'played' :
        rawStatus === 'pending' || rawStatus === 'enviando' ? 'pending' :
        rawStatus === 'sent' || rawStatus === 'enviada' || rawStatus === 'enviado' ? 'sent' :
        rawStatus === 'erro' || rawStatus === 'error' || rawStatus === 'failed' ? 'erro' :
        (rawStatus || null)
      )
    })()

    if (!statusNorm) {
      console.log('[DEBUG] /webhooks/zapi/status: status não mapeado, ignorando. rawStatus=', rawStatus || '(vazio)')
      return res.status(200).json({ ok: true })
    }

    const company_id = COMPANY_ID
    const io = req.app.get('io')
    let updated = 0

    for (const messageId of idsToProcess) {
      if (!messageId) continue
      const idStr = String(messageId)

      // 1) Atualiza por (company_id, whatsapp_id) — match exato
      let { data: msg } = await supabase
        .from('mensagens')
        .update({ status: statusNorm })
        .eq('company_id', company_id)
        .eq('whatsapp_id', idStr)
        .select('id, conversa_id, company_id')
        .maybeSingle()

      // 2) Fallback: Z-API às vezes trunca o ID no status callback.
      //    Tenta prefixo (primeiros 20 chars) ainda dentro do company_id (sem cross-tenant).
      if (!msg && idStr.length >= 20) {
        const prefix = idStr.slice(0, 20)
        const { data: prefixRows } = await supabase
          .from('mensagens')
          .select('id, conversa_id, company_id, whatsapp_id')
          .eq('company_id', company_id)
          .ilike('whatsapp_id', `${prefix}%`)
          .order('id', { ascending: false })
          .limit(1)
        const candidate = Array.isArray(prefixRows) && prefixRows[0] ? prefixRows[0] : null
        if (candidate?.id) {
          const { data: patched } = await supabase
            .from('mensagens')
            .update({ status: statusNorm })
            .eq('company_id', company_id)
            .eq('id', candidate.id)
            .select('id, conversa_id, company_id')
            .maybeSingle()
          msg = patched || null
        }
      }

      if (msg) {
        updated++
        if (io) {
          const payload = { mensagem_id: msg.id, conversa_id: msg.conversa_id, status: statusNorm }
          io.to(`empresa_${msg.company_id}`).to(`conversa_${msg.conversa_id}`).emit('status_mensagem', payload)
        }
        console.log('[DEBUG] /webhooks/zapi/status resultado:', { status: statusNorm, mensagem_id: msg.id, conversa_id: msg.conversa_id, whatsapp_id: idStr.slice(0, 20) + '…' })
      } else {
        console.log('[Z-API] Status', statusNorm, 'para id', idStr.slice(0, 20) + '… — mensagem não encontrada no banco (ignorado)')
      }
    }

    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('[DEBUG] /webhooks/zapi/status ERRO:', e?.message || e)
    return res.status(200).json({ ok: true })
  }
}

/**
 * POST /webhooks/zapi/connection — ao conectar/desconectar a instância.
 * Payload: evento (connected/disconnected) ou similar; apenas responde 200 e loga.
 */
exports.connectionZapi = async (req, res) => {
  try {
    const payload = req.body || {}
    console.log('🔌 Z-API connection:', payload?.event ?? payload?.status ?? payload)

    const expectedInstanceId = String(process.env.ZAPI_INSTANCE_ID || '').trim()
    const incomingInstanceId = payload?.instanceId != null ? String(payload.instanceId).trim() : ''
    if (expectedInstanceId && incomingInstanceId && incomingInstanceId !== expectedInstanceId) {
      console.warn('⚠️ Z-API connection: instanceId diferente do .env; ignorando sync.', incomingInstanceId)
      return res.status(200).json({ ok: true })
    }

    const type = String(payload?.type ?? payload?.event ?? payload?.status ?? '').toLowerCase()
    const connected = payload?.connected === true || type.includes('connected')

    // Ao conectar: dispara sync em background (espelho do WhatsApp: nomes + (se possível) fotos)
    if (connected) {
      setImmediate(async () => {
        const company_id = COMPANY_ID
        const io = req.app.get('io')
        const provider = getProvider()
        if (!provider || !provider.isConfigured) return

        // ─── Auto-configuração dos webhooks Z-API ───
        // Registra automaticamente as URLs de callback (mensagens + status) na instância Z-API.
        // Garante que READ/RECEIVED cheguem mesmo sem configuração manual no painel.
        const appUrl = process.env.APP_URL || ''
        if (appUrl && provider.configureWebhooks) {
          try {
            await provider.configureWebhooks(appUrl)
          } catch (e) {
            console.warn('⚠️ Z-API: erro ao configurar webhooks automaticamente:', e.message)
          }
        }

        if (!provider.getContacts) return

        try {
          // ✅ respeita preferências da empresa (auto sync contatos)
          let autoSync = true
          try {
            const { data: emp, error: errEmp } = await supabase
              .from('empresas')
              .select('zapi_auto_sync_contatos')
              .eq('id', company_id)
              .maybeSingle()
            if (errEmp) {
              // compat: coluna pode não existir ainda
              const msg = String(errEmp.message || '')
              if (!msg.includes('zapi_auto_sync_contatos') && !msg.includes('does not exist')) {
                console.warn('⚠️ Z-API: erro ao ler preferência auto-sync:', errEmp.message)
              }
            } else if (emp && emp.zapi_auto_sync_contatos === false) {
              autoSync = false
            }
          } catch (_) {
            // ignora (mantém padrão true)
          }
          if (!autoSync) {
            console.log('⏭️ Z-API: auto-sync de contatos desativado (empresa).')
            return
          }

          console.log('🔄 Z-API: iniciando sync de contatos (on connected)...')
          const pageSize = 100
          let page = 1
          let total = 0
          let atualizados = 0
          let criados = 0
          let fotosAtualizadas = 0

          while (true) {
            const contacts = await provider.getContacts(page, pageSize)
            if (!Array.isArray(contacts) || contacts.length === 0) break

            for (const c of contacts) {
              const rawPhone = String(c.phone || '').trim()
              const phone = normalizePhoneBR(rawPhone) || rawPhone.replace(/\D/g, '').trim()
              if (!phone) continue
              total++

              const nome = (c.name || c.short || c.notify || c.vname || '').trim() || null
              const pushname = (c.notify || '').trim() || null

              const phones = possiblePhonesBR(phone)
              let q = supabase.from('clientes').select('id, telefone').eq('company_id', company_id)
              if (phones.length > 0) q = q.in('telefone', phones)
              else q = q.eq('telefone', phone)

              const found = await q.order('id', { ascending: true }).limit(10)
              const rows = Array.isArray(found.data) ? found.data : []
              const existente = rows.find(r => String(r.telefone || '') === phone) || rows[0] || null

              // Mesclar duplicatas simples (com/sem 9 após DDD)
              if (existente?.id && rows.length > 1) {
                const canonId = existente.id
                const dupIds = rows.map(r => r.id).filter(id => id !== canonId)
                if (dupIds.length > 0) {
                  await supabase.from('conversas').update({ cliente_id: canonId }).in('cliente_id', dupIds)
                  await supabase.from('clientes').delete().in('id', dupIds)
                }
              }

              if (existente?.id) {
                const updates = {}
                if (nome != null) updates.nome = nome
                if (pushname != null) updates.pushname = pushname
                if (Object.keys(updates).length > 0) {
                  let upd = await supabase.from('clientes').update(updates).eq('id', existente.id).eq('company_id', company_id)
                  if (upd.error && String(upd.error.message || '').includes('pushname')) {
                    delete updates.pushname
                    if (Object.keys(updates).length > 0) upd = await supabase.from('clientes').update(updates).eq('id', existente.id).eq('company_id', company_id)
                  }
                  if (!upd.error) atualizados++
                }
              } else {
                let ins = await supabase.from('clientes').insert({
                  company_id,
                  telefone: phone,
                  nome: nome || null,
                  pushname: pushname || undefined
                })
                if (ins.error && String(ins.error.message || '').includes('pushname')) {
                  ins = await supabase.from('clientes').insert({
                    company_id,
                    telefone: phone,
                    nome: nome || null
                  })
                }
                if (!ins.error) criados++
              }
            }

            if (contacts.length < pageSize) break
            page++
          }

          console.log('✅ Z-API sync de contatos finalizado:', { total, criados, atualizados })

          // Fotos: tenta completar para os que estão sem foto (limitado para não travar o webhook)
          if (provider.getProfilePicture) {
            const { data: semFoto } = await supabase
              .from('clientes')
              .select('id, telefone')
              .eq('company_id', company_id)
              .or('foto_perfil.is.null,foto_perfil.eq.')
              .limit(150)

            const list = Array.isArray(semFoto) ? semFoto : []
            fotosAtualizadas = 0
            for (const cl of list) {
              const tel = String(cl.telefone || '').trim()
              if (!tel) continue
              try {
                const url = await provider.getProfilePicture(tel)
                if (url && String(url).trim().startsWith('http')) {
                  const { error: updErr } = await supabase
                    .from('clientes')
                    .update({ foto_perfil: String(url).trim() })
                    .eq('id', cl.id)
                    .eq('company_id', company_id)
                  if (!updErr) fotosAtualizadas++
                }
              } catch (_) {
                // ignora (pode estar sem foto/privacidade)
              }
              await new Promise(r => setTimeout(r, 220))
            }
            if (fotosAtualizadas > 0) console.log('🖼️ Z-API: fotos atualizadas (parcial):', fotosAtualizadas)
          }

          // Notifica o front (Configurações → Clientes) para atualizar lista automaticamente
          if (io) {
            io.to(`empresa_${company_id}`).emit('zapi_sync_contatos', {
              ok: true,
              total_contatos: total,
              criados,
              atualizados,
              fotos_atualizadas: fotosAtualizadas
            })
          }
        } catch (e) {
          console.error('❌ Z-API sync on connected falhou:', e?.message || e)
        }
      })
    }

    return res.status(200).json({ ok: true })
  } catch (e) {
    return res.status(200).json({ ok: true })
  }
}

/**
 * POST /webhooks/zapi/presence — PresenceChatCallback (digitando, online, gravando).
 * Payload Z-API: type, phone, status (UNAVAILABLE|AVAILABLE|COMPOSING|RECORDING|PAUSED), lastSeen, instanceId.
 */
exports.presenceZapi = async (req, res) => {
  try {
    const body = req.body || {}
    const phoneRaw = body.phone ? String(body.phone).trim() : ''
    const status = body.status ? String(body.status).trim().toUpperCase() : ''
    const lastSeen = body.lastSeen != null ? body.lastSeen : null

    if (phoneRaw && status) {
      const company_id = COMPANY_ID
      const phones = possiblePhonesBR(phoneRaw)
      let q = supabase
        .from('conversas')
        .select('id')
        .eq('company_id', company_id)
        .limit(1)
      if (phones.length > 0) q = q.in('telefone', phones)
      else q = q.eq('telefone', normalizePhoneBR(phoneRaw) || phoneRaw.replace(/\D/g, ''))
      const { data: rows } = await q
      const conversa_id = Array.isArray(rows) && rows[0]?.id ? rows[0].id : null
      const io = req.app.get('io')
      if (io && conversa_id) {
        io.to(`empresa_${company_id}`)
          .to(`conversa_${conversa_id}`)
          .emit('presence', { conversa_id, phone: phoneRaw, status, lastSeen })
      }
    }
    return res.status(200).json({ ok: true })
  } catch (e) {
    return res.status(200).json({ ok: true })
  }
}
