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
const zapiProvider = require('../services/providers/zapi')
const { syncContactFromZapi } = require('../services/zapiSyncContact')
const { getCompanyIdByInstanceId, getStatus } = require('../services/zapiIntegrationService')
const { resetOnConnected } = require('../services/zapiConnectGuardService')
const { normalizePhoneBR, possiblePhonesBR, normalizeGroupIdForStorage } = require('../helpers/phoneHelper')
const { getCanonicalPhone, getOrCreateCliente, findOrCreateConversation, mergeConversasIntoCanonico, mergeConversationLidToPhone } = require('../helpers/conversationSync')
const { chooseBestName } = require('../helpers/contactEnrichment')
const { resolvePeerPhone } = require('../helpers/conversationKeyHelper')
const { incrementarUnreadParaConversa } = require('./chatController')
const { processIncomingMessage: processChatbotTriage } = require('../services/chatbotTriageService')
const { processarOptOut } = require('../services/optOutService')
const { processarRegras } = require('../services/regrasAutomaticasService')
const { isEnabled, FLAGS } = require('../helpers/featureFlags')

// company_id NUNCA mais via ENV — resolvido por instanceId do payload em cada webhook
const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'

/** Log [ZAPI_CERT] uma linha por ação — só quando WHATSAPP_DEBUG=true (apenas dev). Sem token, sem conteúdo da msg. */
function logZapiCert(opts) {
  if (!WHATSAPP_DEBUG) return
  const ts = new Date().toISOString()
  const line = JSON.stringify({
    ts,
    companyId: opts.companyId ?? null,
    instanceId: opts.instanceId ? String(opts.instanceId).slice(0, 24) + (opts.instanceId.length > 24 ? '…' : '') : null,
    type: opts.type ?? null,
    fromMe: opts.fromMe ?? null,
    hasDest: opts.hasDest ?? null,
    phoneTail: opts.phoneTail ?? null,
    connectedTail: opts.connectedTail ?? null,
    messageId: opts.messageId ? String(opts.messageId).slice(0, 24) + (String(opts.messageId).length > 24 ? '…' : '') : null,
    resolvedKeyType: opts.resolvedKeyType ?? null,
    conversaId: opts.conversaId ?? null,
    action: opts.action ?? 'unknown'
  })
  console.log('[ZAPI_CERT]', line)
}

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
    payload.data?.remoteJid,
    payload.data?.key?.remoteJid
  ].filter(Boolean).map((v) => String(v).trim())

  // 1) Sinais explícitos: @g.us ou sufixo -group
  if (candidates.some((c) => c.endsWith('@g.us') || c.includes('-group'))) return true

  // 2) ID numérico de grupo (120...) + presença de participante/autor
  const hasParticipant =
    !!payload.participantPhone ||
    !!payload.participant ||
    !!payload.author ||
    !!payload.key?.participant

  if (hasParticipant) {
    for (const c of candidates) {
      const d = String(c || '').replace(/\D/g, '')
      if (d.startsWith('120') && d.length >= 15 && d.length <= 22) return true
    }
  }

  // 3) ID de grupo típico (120... 15-22 dígitos) — sem exigir participant.
  // Crítico para fromMe=true: ao enviar para grupo, Z-API pode mandar só phone="120..." sem participantPhone.
  for (const c of candidates) {
    const d = String(c || '').replace(/\D/g, '')
    if (d.startsWith('120') && d.length >= 15 && d.length <= 22) return true
  }

  return false
}

/** Retorna identificador do grupo, quando houver. */
function pickGroupChatId(payload) {
  if (!payload || typeof payload !== 'object') return ''

  const candidates = [
    payload.key?.remoteJid,
    payload.remoteJid,
    payload.chat?.id,
    payload.chat?.remoteJid,
    payload.chatId,
    payload.phone,
    payload.groupId,
    payload.group?.id,
    payload.data?.remoteJid,
    payload.data?.key?.remoteJid
  ]
    .filter((v) => v != null)
    .map((v) => String(v).trim())
    .filter(Boolean)

  // 1) Formato canônico @g.us
  for (const c of candidates) {
    if (c.endsWith('@g.us')) return c
  }

  // 2) Alguns providers mandam "...-group"
  for (const c of candidates) {
    if (c.includes('-group')) return c
  }

  // 3) ID numérico 120... (15-22 dígitos) — heurística WhatsApp. Inclui fromMe (envio para grupo).
  for (const c of candidates) {
    const d = c.replace(/\D/g, '')
    if (d.startsWith('120') && d.length >= 15 && d.length <= 22) return d
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

  // ─── Quando fromMe=true: DESTINO da mensagem (contato que recebeu) ─────────────────────────
  // CRÍTICO: NUNCA usar connectedPhone. Usar resolvePeerPhone (centralizado) para máxima confiabilidade.
  const fromMe = fromMeHint
  if (fromMe) {
    const { peerPhone, source } = resolvePeerPhone(payload)
    if (peerPhone) {
      if (WHATSAPP_DEBUG) {
        console.log('[Z-API] resolveKey fromMe:', { peerPhone: peerPhone.slice(-6), source })
      }
      return { key: peerPhone, isGroup: false, participantPhone: '', debugReason: `fromMe ${source}` }
    }
    const destinationSources = [
      [payload.to,             'to'],
      [payload.toPhone,        'toPhone'],
      [payload.recipientPhone, 'recipientPhone'],
      [payload.recipient,      'recipient'],
      [payload.destination,    'destination'],
      [payload.key?.remoteJid,  'key.remoteJid'],
      [payload.key?.participant, 'key.participant'],
      [payload.remoteJid,       'remoteJid'],
      [payload.chatId,          'chatId'],
      [payload.chat?.id,        'chat.id'],
      [payload.chat?.remoteJid, 'chat.remoteJid'],
      [payload.data?.key?.remoteJid, 'data.key.remoteJid'],
      [payload.data?.remoteJid, 'data.remoteJid'],
      [payload.data?.chatId,    'data.chatId'],
      [payload.data?.to,        'data.to'],
      [payload.data?.toPhone,   'data.toPhone'],
      [payload.data?.recipientPhone, 'data.recipientPhone'],
      [payload.value?.to,       'value.to'],
      [payload.value?.toPhone,  'value.toPhone'],
      [payload.value?.recipientPhone, 'value.recipientPhone'],
      [payload.value?.key?.remoteJid, 'value.key.remoteJid'],
      [payload.value?.remoteJid, 'value.remoteJid'],
      [payload.message?.key?.remoteJid, 'message.key.remoteJid'],
      [payload.referencedMessage?.phone, 'referencedMessage.phone'],
      [payload.reaction?.referencedMessage?.phone, 'reaction.referencedMessage.phone'],
      [payload.senderPhone,    'senderPhone (fromMe)'],
    ]
    for (const [raw, fieldName] of destinationSources) {
      const norm = normCandidate(raw)
      if (norm) {
        return { key: norm, isGroup: false, participantPhone: '', debugReason: `fromMe destination ${fieldName}` }
      }
    }
  }

  // ─── Fonte primária: payload.phone (SOMENTE quando for número real, NUNCA quando for @lid) ───
  // Z-API envia "phone": "5544999999999" (número real) OU "phone": "24601656598766@lid" (LID interno).
  // Para fromMe=false: phone = remetente (contato). Para fromMe=true: já tentamos destino acima.
  const phoneRaw = clean(payload.phone)
  const phoneIsLid = phoneRaw && (phoneRaw.endsWith('@lid') || phoneRaw.endsWith('@broadcast'))
  const phonePrimary = !phoneIsLid ? normCandidate(payload.phone) : ''
  if (phonePrimary) {
    return { key: phonePrimary, isGroup: false, participantPhone: '', debugReason: 'from payload.phone (Z-API primary)' }
  }

  // ─── Fontes secundárias (quando fromMe já tentamos destino acima) ─────────────────────────
  const fallbackSources = [
    [payload.key?.remoteJid,  'key.remoteJid'],
    [payload.remoteJid,       'remoteJid'],
    [payload.chatId,          'chatId'],
    [payload.chat?.id,        'chat.id'],
    ...(fromMe ? [] : [[payload.senderPhone, 'senderPhone']]),
  ]

  for (const [raw, fieldName] of fallbackSources) {
    const norm = normCandidate(raw)
    if (norm) {
      return { key: norm, isGroup: false, participantPhone: '', debugReason: `fallback ${fieldName}` }
    }
  }

  // ─── Último recurso: aceita número não-BR ────────────────────────────────
  const lastResortAll = [
    payload.to, payload.toPhone, payload.recipientPhone, payload.recipient,
    payload.destination, payload.phone, payload.key?.remoteJid, payload.key?.participant,
    payload.remoteJid, payload.chatId, payload.chat?.id, payload.senderPhone,
    payload.data?.key?.remoteJid, payload.data?.remoteJid, payload.data?.to,
    payload.data?.toPhone, payload.data?.recipientPhone,
    payload.value?.to, payload.value?.toPhone, payload.value?.recipientPhone,
    payload.value?.key?.remoteJid, payload.value?.remoteJid,
    payload.message?.key?.remoteJid, payload.referencedMessage?.phone,
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
  // Inclui payload.data e payload.value para payloads encapsulados
  const lidRaw = clean(payload.phone) || clean(payload.chatLid) || clean(payload.data?.phone) || clean(payload.value?.phone) || ''
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
  // Doc Z-API: messageId e zaapId = identificador da mensagem (ReceivedCallback e DeliveryCallback)
  const messageId = payload.messageId ?? payload.zaapId ?? payload.id ?? payload.instanceId ?? payload.key?.id ?? null
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
  // Doc Z-API: when fromMe=true, "sender" is us; nome/foto do CONTATO (destino) vêm de chatName/chat/photo
  // Prioridade para nome salvo no celular: name (completo) > short (primeiro nome) > notifyName > senderName > chatName > ...
  const fromMeForExtract = Boolean(payload.fromMe ?? payload.key?.fromMe)
  const senderName = fromMeForExtract
    ? (payload.chatName ?? payload.chat?.name ?? payload.groupName ?? payload.name ?? payload.short ?? payload.notifyName ?? payload.senderName ?? payload.displayName ?? payload.pushName ?? payload.formattedName ?? payload.sender?.name ?? null)
    : (payload.name ?? payload.short ?? payload.notifyName ?? payload.senderName ?? payload.chatName ?? payload.chat?.name ?? payload.displayName ?? payload.pushName ?? payload.formattedName ?? payload.sender?.name ?? null)
  const senderPhoto = fromMeForExtract
    ? (payload.chatPhoto ?? payload.chat?.photo ?? payload.senderPhoto ?? payload.photo ?? payload.profilePicture ?? payload.sender?.photo ?? payload.profilePictureUrl ?? null)
    : (payload.senderPhoto ?? payload.photo ?? payload.profilePicture ?? payload.sender?.photo ?? payload.profilePictureUrl ?? null)
  // Para grupos, a Z-API costuma enviar a foto do grupo apenas em `photo`.
  // Usamos chatPhoto/groupPicture/groupPhoto e, como fallback quando isGroup, o campo photo.
  const chatPhoto =
    payload.chatPhoto ??
    payload.groupPicture ??
    payload.groupPhoto ??
    (payload.isGroup ? payload.photo ?? null : null)

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

  // Heurística: se for texto puro com URL http/https, marcamos como tipo "link"
  // para o frontend poder exibir estilo preview/clicável.
  if (type === 'text' && texto && /(https?:\/\/\S+)/i.test(texto)) {
    type = 'link'
  }

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

/** GET /webhooks/zapi/health — health check para configurar no painel Z-API. Sempre 200. */
exports.healthZapi = (req, res) => res.status(200).json({ ok: true })

/** GET /webhooks/zapi — teste de conectividade; retorna todas as URLs para configurar no painel Z-API. */
exports.testarZapi = (req, res) => {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
  const prefix = `${base}/webhooks/zapi`
  const urls = {
    health: `${prefix}/health`,
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
/** Segurança: NUNCA retorna o valor real do token na resposta (evita vazamento em logs/cache). */
exports.debugZapi = (req, res) => {
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '')
  const token = String(process.env.ZAPI_WEBHOOK_TOKEN || '').trim()
  const tokenSuffix = token ? '?token=***' : '(SEM TOKEN CONFIGURADO)'
  return res.status(200).json({
    ok: true,
    servidor: {
      app_url: appUrl || '(não definido)',
      zapi_instance_id: '(multi-tenant via empresa_zapi)',
      webhook_token_configurado: !!token,
      whatsapp_debug: WHATSAPP_DEBUG,
      company_id: '(multi-tenant por instanceId)',
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
      instrucao: 'POST /webhooks/zapi* não exige token. Validação por instanceId + empresa_zapi. Se webhook retorna ignored:instance_not_mapped, adicione instance_id em empresa_zapi.',
    },
    ultimos_webhooks_recebidos: _webhookLog,
    ultimos_webhooks_rejeitados: _rejectedLog,
  })
}

/** Log seguro (sem tokens/conteúdo sensível) — diagnóstico end-to-end webhook. Nunca logar tokens nem URL com /token/ */
function _logWebhookSafe(entry) {
  const safe = { ts: new Date().toISOString(), received: true, ...entry }
  console.log('[Z-API-WEBHOOK]', JSON.stringify(safe))
}

/** Extrai instanceId do payload (body) Z-API — mesma lógica do middleware */
function _extractInstanceIdFromBody(body) {
  if (!body || typeof body !== 'object') return ''
  const v = body.instanceId ?? body.instance_id ?? body.instance?.id ?? body.instance
  if (v == null) return ''
  if (typeof v === 'object' && v != null && typeof v.id === 'string') return String(v.id).trim()
  if (typeof v === 'object' && v != null && v.instance_id != null) return String(v.instance_id).trim()
  return String(v).trim()
}

/** Verifica se o payload tem campos de destino (to, remoteJid, etc.). Para fromMe, destino = contato que recebeu. */
function hasDestFields(payload) {
  if (!payload || typeof payload !== 'object') return false
  const dest = [
    payload.to, payload.toPhone, payload.recipientPhone, payload.recipient,
    payload.destination, payload.key?.remoteJid, payload.remoteJid,
    payload.chatId, payload.chat?.id, payload.chat?.remoteJid, payload.participant
  ]
  return dest.some(v => v != null && String(v).trim() !== '')
}

/** Handler principal: roteia por path ou payload.type — só executa quando req.zapiContext.company_id existe. */
function _routeByEvent(path, body) {
  const p = String(path || '')
  const t = String(body?.type ?? body?.event ?? body?.tipo ?? '').toLowerCase()
  if (p === '/status' || p === '/statusht' || p.endsWith('/status')) return 'status'
  if (p === '/connection' || p.endsWith('/connection')) return 'connection'
  if (p === '/disconnected' || p.endsWith('/disconnected')) return 'connection'
  if (p === '/presence' || p.endsWith('/presence')) return 'presence'
  if (t === 'connectedcallback' || t === 'connected') return 'connection'
  if (t === 'disconnectedcallback' || t === 'disconnected') return 'connection'
  if (t === 'messagestatuscallback' || t === 'readcallback' || t === 'read' || t === 'delivered' || t === 'ack') return 'status'
  if (t === 'presencechcallback' || t === 'presence') return 'presence'
  return 'message' // ReceivedCallback, DeliveryCallback, default
}

/**
 * Handler unificado: aceita QUALQUER evento da Z-API e roteia pelo payload.type.
 * req.zapiContext já preenchido pelo middleware resolveWebhookZapi.
 */
async function handleWebhookZapi(req, res) {
  try {
    const ctx = req.zapiContext
    if (!ctx || ctx.company_id == null) {
      return res.status(200).json({ ok: true })
    }
    const route = _routeByEvent(req.path, req.body)
    const fn = {
      message: () => exports.receberZapi(req, res),
      status: () => exports.statusZapi(req, res),
      connection: () => exports.connectionZapi(req, res),
      presence: () => exports.presenceZapi(req, res)
    }[route] || (() => exports.receberZapi(req, res))
    await fn()
  } catch (e) {
    console.error('[handleWebhookZapi]', e?.message || e)
    return res.status(200).json({ ok: true })
  }
}

exports.handleWebhookZapi = handleWebhookZapi

exports.receberZapi = async (req, res) => {
  try {
    const body = req.body || {}
    // 1) Resolver instanceId e company_id — SEMPRE explícito, NUNCA depender do DEFAULT do banco
    const instanceIdRaw = _extractInstanceIdFromBody(body) || req.zapiContext?.instanceId || ''
    const instanceId = instanceIdRaw ? String(instanceIdRaw).trim() : ''
    let company_id = req.zapiContext?.company_id
    if (company_id == null && instanceId) {
      company_id = await getCompanyIdByInstanceId(instanceId)
    }
    if (!instanceId || company_id == null) {
      _logWebhookSafe({ instanceId: instanceId ? instanceId.slice(0, 24) + (instanceId.length > 24 ? '…' : '') : '(empty)', companyId: 'not_mapped', type: body.type || body.event || 'unknown', ignored: 'instance_not_mapped' })
      return res.status(200).json({ ok: true, ignored: 'instance_not_mapped' })
    }

    // 2) Log DEV uma linha — diagnóstico sem vazar tokens
    const firstPayload = getPayloads(body)[0] || body
    const msgId = firstPayload?.messageId ?? firstPayload?.zaapId ?? firstPayload?.id ?? ''
    const phoneTail = (firstPayload?.phone || '').toString().trim().slice(-10)
    console.log('[ZAPI_WEBHOOK]', JSON.stringify({
      instanceId: instanceId.slice(0, 20) + (instanceId.length > 20 ? '…' : ''),
      companyId: company_id,
      type: body.type || body.event || firstPayload?.type || 'unknown',
      messageId: msgId ? String(msgId).slice(0, 20) + (String(msgId).length > 20 ? '…' : '') : null,
      phone: phoneTail ? '…' + phoneTail : null,
      fromMe: firstPayload?.fromMe ?? firstPayload?.key?.fromMe ?? null
    }))

    // Salva no buffer de diagnóstico (GET /webhooks/zapi/debug)
    _logWebhook({
      type: body.type || body.event || 'unknown',
      phone: (body.phone || '').toString().slice(-12),
      fromMe: body.fromMe ?? body.key?.fromMe,
      hasText: !!(body.text?.message || body.message || body.body),
      hasMedia: !!(body.image || body.audio || body.video || body.document || body.sticker),
      status: body.status || body.ack,
      ip: req.ip || req.socket?.remoteAddress || '?',
      rawBody: JSON.stringify(body).slice(0, 600)
    })

    // Callback específico de atualização de foto de grupo:
    // docs: { "groupId": "...", "groupPhoto": "https://..." }
    // Quando vier sem campos de mensagem/phone, tratamos direto aqui.
    const rawGroupId = body.groupId != null ? String(body.groupId).trim() : ''
    const rawGroupPhoto = body.groupPhoto != null ? String(body.groupPhoto).trim() : ''
    const hasOnlyGroupPhotoPayload =
      rawGroupId &&
      rawGroupPhoto &&
      !body.phone &&
      !body.text &&
      !body.message &&
      !body.body &&
      !body.image &&
      !body.audio &&
      !body.video &&
      !body.document &&
      !body.sticker

    if (hasOnlyGroupPhotoPayload) {
      const groupIdForStorage = normalizeGroupIdForStorage(rawGroupId) || rawGroupId
      try {
        const { data, error } = await supabase
          .from('conversas')
          .update({ foto_grupo: rawGroupPhoto })
          .eq('company_id', company_id)
          .in('telefone', [groupIdForStorage, rawGroupId])
          .select('id')

        if (error) {
          console.error('[Z-API] ❌ Erro ao atualizar foto de grupo via callback groupPhoto:', error)
          return res.status(500).json({ error: 'Erro ao atualizar foto de grupo' })
        }

        const updatedCount = Array.isArray(data) ? data.length : 0
        console.log('[Z-API] ✅ Foto de grupo atualizada via callback groupPhoto:', {
          groupId: rawGroupId,
          storedId: groupIdForStorage,
          updated: updatedCount
        })

        // Emite atualização de conversa para atualizar avatar no front
        if (updatedCount > 0) {
          const io = req.app.get('io')
          if (io) {
            for (const row of data) {
              io.to(`empresa_${company_id}`).emit('conversa_atualizada', {
                id: row.id,
                foto_grupo: rawGroupPhoto
              })
            }
          }
        }

        return res.status(200).json({ ok: true, updated: updatedCount })
      } catch (e) {
        console.error('[Z-API] ❌ Exceção ao processar callback groupPhoto:', e?.message || e)
        return res.status(500).json({ error: 'Erro ao processar callback de foto de grupo' })
      }
    }

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
        if (s === 'read' || s === 'read_by_me' || s === 'seen' || s === 'visualizada' || s === 'lida') return 'read'
        if (s === 'played') return 'played'
        if (s === 'pending' || s === 'enviando') return 'pending'
        if (s === 'sent' || s === 'enviada' || s === 'enviado') return 'sent'
        if (s === 'failed' || s === 'error' || s === 'erro') return 'erro'
        return s || null
      }

      // Helper: emite status_mensagem via socket (empresa + conversa + usuario do autor para garantir tempo real)
      const emitStatusMsg = (msg, statusNorm, whatsappId = null) => {
        const io = req.app.get('io')
        if (io && msg) {
          const payload = {
            mensagem_id: msg.id,
            conversa_id: msg.conversa_id,
            status: statusNorm,
            ...(msg.whatsapp_id ? { whatsapp_id: msg.whatsapp_id } : {}),
            ...(whatsappId ? { whatsapp_id: whatsappId } : {})
          }
          let chain = io.to(`empresa_${msg.company_id}`).to(`conversa_${msg.conversa_id}`)
          if (msg.autor_usuario_id != null) chain = chain.to(`usuario_${msg.autor_usuario_id}`)
          chain.emit('status_mensagem', payload)
        }
      }

      // Helper: atualiza status no banco por whatsapp_id (retorna msg com whatsapp_id e autor_usuario_id para emit)
      const updateStatusByWaId = async (waId, statusNorm) => {
        if (!waId || !statusNorm) return null
        const waIdStr = String(waId)
        const { data: msg } = await supabase
          .from('mensagens')
          .update({ status: statusNorm })
          .eq('company_id', company_id)
          .eq('whatsapp_id', waIdStr)
          .select('id, conversa_id, company_id, whatsapp_id, autor_usuario_id')
          .maybeSingle()
        if (msg) msg.whatsapp_id = msg.whatsapp_id || waIdStr
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
      // Z-API pode enviar mídia em payload.message.* (objeto aninhado) sem text.message.
      // Ex.: ReceivedCallback em grupo com imagem vem sem payload.text, mas payload.message.image existe.
      const hasMessageContent =
        (payload?.text?.message != null && String(payload.text.message).trim() !== '') ||
        (payload?.message != null && typeof payload.message === 'string' && String(payload.message).trim() !== '') ||
        (payload?.body != null && String(payload.body).trim() !== '') ||
        payload?.image != null || payload?.imageUrl != null ||
        payload?.audio != null || payload?.audioUrl != null ||
        payload?.video != null || payload?.videoUrl != null ||
        payload?.document != null || payload?.documentUrl != null ||
        payload?.sticker != null || payload?.stickerUrl != null ||
        // Mídia aninhada em payload.message (Z-API grupos, callbacks variados)
        payload?.message?.image != null || payload?.message?.imageUrl != null ||
        payload?.message?.audio != null || payload?.message?.audioUrl != null ||
        payload?.message?.video != null || payload?.message?.videoUrl != null ||
        payload?.message?.document != null || payload?.message?.documentUrl != null ||
        payload?.message?.sticker != null || payload?.message?.stickerUrl != null ||
        payload?.message?.ptv != null || payload?.message?.location != null || payload?.message?.contact != null ||
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

        // Mesclagem LID→PHONE quando payload traz ambos (MessageStatusCallback)
        const lidStatus = String(payload?.phone ?? payload?.chatLid ?? '').trim()
        const lidPartStatus = lidStatus.endsWith('@lid') ? lidStatus.replace(/@lid$/i, '').trim() : ''
        const { peerPhone: peerStatus } = resolvePeerPhone(payload)
        const canonicalStatus = peerStatus || (payload?.to || payload?.recipientPhone ? getCanonicalPhone(payload.to || payload.recipientPhone) : null)
        if (lidPartStatus && canonicalStatus) {
          try {
            const io = req.app.get('io')
            await mergeConversationLidToPhone(supabase, company_id, lidPartStatus, canonicalStatus, { io })
            logZapiCert({
              companyId: company_id,
              instanceId,
              type: payloadType,
              fromMe: payloadFromMe,
              hasDest: hasDestFields(payload),
              phoneTail: canonicalStatus?.slice(-6) || null,
              connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
              messageId: String(msgId),
              resolvedKeyType: 'lid→phone',
              conversaId: null,
              action: 'merged_lid_phone'
            })
          } catch (_) {}
        }

        const msg = await updateStatusByWaId(String(msgId), statusNorm)
        if (msg) {
          emitStatusMsg(msg, statusNorm, String(msgId))
          console.log(`✅ Z-API status ${statusNorm.toUpperCase()} → msg ${msg.id} (conversa ${msg.conversa_id})`)
          logZapiCert({
            companyId: company_id,
            instanceId,
            type: payloadType,
            fromMe: payloadFromMe,
            hasDest: hasDestFields(payload),
            phoneTail: (payload?.phone ?? '').toString().slice(-6) || null,
            connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
            messageId: String(msgId),
            conversaId: msg.conversa_id,
            action: 'updated_status'
          })
          // IMPORTANTE: read/played = o CONTATO visualizou NOSSA mensagem (ticks ✓✓).
          // Isso NÃO significa que nós (atendentes) visualizamos a conversa no CRM.
          // Unread só deve ser zerado quando abrimos o chat (detalharChat → marcarComoLidaPorUsuario).
          // NÃO chamar marcarConversaComoLidaParaTodos aqui — zeraria incorretamente as bolhas.
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
            (payload?.message != null && typeof payload.message === 'string' && String(payload.message).trim() !== '') ||
            (payload?.body != null && String(payload.body).trim() !== '') ||
            payload?.image != null || payload?.imageUrl != null ||
            payload?.audio != null || payload?.audioUrl != null ||
            payload?.video != null || payload?.videoUrl != null ||
            payload?.document != null || payload?.documentUrl != null ||
            payload?.sticker != null || payload?.stickerUrl != null ||
            payload?.message?.image != null || payload?.message?.imageUrl != null ||
            payload?.message?.audio != null || payload?.message?.audioUrl != null ||
            payload?.message?.video != null || payload?.message?.videoUrl != null ||
            payload?.message?.document != null || payload?.message?.documentUrl != null ||
            payload?.message?.sticker != null || payload?.message?.stickerUrl != null ||
            payload?.message?.ptv != null || payload?.message?.location != null || payload?.message?.contact != null

          console.log('[Z-API] DeliveryCallback fromMe:', {
            messageId: delivMsgId ? String(delivMsgId).slice(0, 32) : null,
            phone: (payload?.phone || '').toString().slice(-12),
            hasRealContent
          })

          // Regra: DeliveryCallback SEM conteúdo = APENAS status. Nunca inserir mensagem.
          // Se a mensagem já existe (CRM enviou antes), atualiza status. Se não existe, ignora (não criar placeholder).
          if (!hasRealContent && delivMsgId) {
            const { data: existByWaId } = await supabase
              .from('mensagens')
              .update({ status: 'sent' })
              .eq('company_id', company_id)
              .eq('whatsapp_id', String(delivMsgId))
              .select('id, conversa_id, company_id, autor_usuario_id')
              .maybeSingle()
              if (existByWaId?.id) {
              const io = req.app.get('io')
              if (io) {
                const payload = {
                  mensagem_id: existByWaId.id,
                  conversa_id: existByWaId.conversa_id,
                  status: 'sent',
                  whatsapp_id: String(delivMsgId)
                }
                let chain = io.to(`empresa_${existByWaId.company_id}`).to(`conversa_${existByWaId.conversa_id}`)
                if (existByWaId.autor_usuario_id != null) chain = chain.to(`usuario_${existByWaId.autor_usuario_id}`)
                chain.emit('status_mensagem', payload)
              }
              logZapiCert({
                companyId: company_id,
                instanceId,
                type: 'deliverycallback',
                fromMe: true,
                hasDest: false,
                phoneTail: (payload?.phone ?? '').toString().slice(-6) || null,
                connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
                messageId: String(delivMsgId),
                conversaId: existByWaId.conversa_id,
                action: 'updated_status'
              })
              lastResult = { ok: true, delivery: true, fromMe: true, messageId: String(delivMsgId) }
              continue
            }
            lastResult = { ok: true, delivery: true, fromMe: true, messageId: String(delivMsgId), skip: 'no_content_no_insert' }
            continue
          }
          // NÃO faz continue → segue para pipeline de mensagem abaixo.
        } else {
        // Mesma prioridade de resolvePeerPhone: to, recipientPhone, toPhone, key.remoteJid, data.*, value.*, etc.
        const { peerPhone: peerDeliv } = resolvePeerPhone(payload)
        const phoneDestCandidates = [
          payload?.to, payload?.toPhone, payload?.recipientPhone, payload?.recipient,
          payload?.destination, payload?.key?.remoteJid, payload?.key?.participant,
          payload?.remoteJid, payload?.chatId, payload?.data?.to, payload?.data?.toPhone,
          payload?.data?.recipientPhone, payload?.data?.key?.remoteJid, payload?.data?.remoteJid,
          payload?.value?.to, payload?.value?.toPhone, payload?.value?.recipientPhone,
          payload?.value?.key?.remoteJid, payload?.value?.remoteJid,
          payload?.phone,
        ]
        const phoneDestRaw = phoneDestCandidates.find(v => v != null && String(v).trim() !== '') ?? ''
        const phoneDest = peerDeliv || (normalizePhoneBR(phoneDestRaw) || String(phoneDestRaw || '').replace(/\D/g, ''))
        const messageId = payload?.messageId ?? payload?.zaapId ?? null
        const errorText = payload?.error != null ? String(payload.error) : ''

        if (!messageId) {
          console.log('📦 Z-API DeliveryCallback (sem messageId):', phoneDest ? String(phoneDest).slice(-12) : '(sem phone)')
          continue
        }

        const statusNorm = errorText ? 'erro' : 'sent'

        // 1) tenta atualizar por whatsapp_id (inclui autor_usuario_id para emit ao remetente)
        let { data: msg, error } = await supabase
          .from('mensagens')
          .update({ status: statusNorm })
          .eq('company_id', company_id)
          .eq('whatsapp_id', String(messageId))
          .select('id, conversa_id, company_id, autor_usuario_id')
          .maybeSingle()

        // 1.1) Mesclagem LID→PHONE: sempre que temos chatLid + canonicalPhone no payload
        const lidFromPayload = String(payload?.phone ?? payload?.chatLid ?? payload?.chat?.id ?? payload?.data?.phone ?? payload?.value?.phone ?? '').trim()
        const lidPartDeliv = lidFromPayload.endsWith('@lid') ? lidFromPayload.replace(/@lid$/i, '').trim() : ''
        const canonicalDeliv = peerDeliv || (phoneDest && !String(phoneDest).startsWith('120') ? getCanonicalPhone(phoneDest) : null)
        if (lidPartDeliv && canonicalDeliv) {
          try {
            const io = req.app.get('io')
            // DeliveryCallback: NÃO enriquecer nome/foto — apenas merge LID→PHONE (evita regressão de nome)
            const mergeRes = await mergeConversationLidToPhone(supabase, company_id, lidPartDeliv, canonicalDeliv, { io })
            if (mergeRes.merged && msg && mergeRes.conversa_id) msg = { ...msg, conversa_id: mergeRes.conversa_id }
            if (mergeRes.merged) {
              logZapiCert({
                companyId: company_id,
                instanceId,
                type: 'deliverycallback',
                fromMe: payloadFromMe,
                hasDest: hasDestFields(payload),
                phoneTail: canonicalDeliv?.slice(-6) || null,
                connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
                messageId: String(messageId),
                resolvedKeyType: 'lid→phone',
                conversaId: mergeRes.conversa_id ?? null,
                action: 'merged_lid_phone'
              })
            }
          } catch (e) {
            console.warn('[Z-API] DeliveryCallback mergeConversationLidToPhone:', e?.message || e)
          }
        }

        // 1.2) Se achou a mensagem e temos phoneDest real, tentar corrigir conversa com telefone LID → telefone real (atualização simples, não merge).
        if (!error && msg && phoneDest) {
          try {
            const { data: convRow } = await supabase
              .from('conversas')
              .select('id, telefone, cliente_id')
              .eq('company_id', company_id)
              .eq('id', msg.conversa_id)
              .maybeSingle()
            const canonical = getCanonicalPhone(phoneDest)
            if (convRow && canonical) {
              const telAtual = convRow.telefone ? String(convRow.telefone).trim() : ''
              const isLidTel = telAtual.toLowerCase().startsWith('lid:')
              const isGroupDest = String(phoneDest).startsWith('120')
              if ((!telAtual || isLidTel) && !isGroupDest) {
                // DeliveryCallback: NÃO enriquecer nome — apenas vincular cliente (evita regressão)
                const { cliente_id: cid } = await getOrCreateCliente(supabase, company_id, canonical, {})
                await supabase
                  .from('conversas')
                  .update({ telefone: canonical, ...(cid ? { cliente_id: cid } : {}) })
                  .eq('company_id', company_id)
                  .eq('id', convRow.id)
                const io = req.app.get('io')
                if (io) {
                  io.to(`empresa_${company_id}`).emit('conversa_atualizada', { id: convRow.id, telefone: canonical, ...(cid ? { cliente_id: cid } : {}) })
                }
              } else if ((!telAtual || isLidTel) && isGroupDest) {
                await supabase
                  .from('conversas')
                  .update({ telefone: canonical })
                  .eq('company_id', company_id)
                  .eq('id', convRow.id)
                const io = req.app.get('io')
                if (io) {
                  io.to(`empresa_${company_id}`).emit('conversa_atualizada', { id: convRow.id, telefone: canonical })
                }
              }
            }
          } catch (e) {
            console.warn('[Z-API] DeliveryCallback: falha ao atualizar telefone da conversa:', e?.message || e)
          }
        }

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
            const payload = {
              mensagem_id: msg.id,
              conversa_id: msg.conversa_id,
              status: statusNorm,
              whatsapp_id: String(messageId)
            }
            let chain = io.to(`empresa_${msg.company_id}`).to(`conversa_${msg.conversa_id}`)
            if (msg.autor_usuario_id != null) chain = chain.to(`usuario_${msg.autor_usuario_id}`)
            chain.emit('status_mensagem', payload)
          }
          logZapiCert({
            companyId: company_id,
            instanceId,
            type: 'deliverycallback',
            fromMe: payloadFromMe,
            hasDest: hasDestFields(payload),
            phoneTail: (phoneDest || '').toString().slice(-6) || null,
            connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
            messageId: String(messageId),
            conversaId: msg.conversa_id,
            action: 'updated_status'
          })
        }

        lastResult = { ok: true, delivery: true, messageId: String(messageId) }
        continue
      }
      }

      // ─── Caso especial: fromMe=true, phone=connectedPhone, sem destino (self-echo) ───
      // Evita DROPPED; reconcilia por messageId → atualiza status apenas, nunca criar conversa.
      const _digits = (v) => String(v ?? '').replace(/\D/g, '')
      const _tail11 = (d) => (d && d.length >= 11) ? d.slice(-11) : (d || '')
      const fromMeSelf = Boolean(payload?.fromMe ?? payload?.key?.fromMe)
      const phoneRaw = (payload?.phone ?? '').toString().trim()
      const connectedRaw = (payload?.connectedPhone ?? payload?.ownerPhone ?? payload?.instancePhone ?? payload?.phoneNumber ?? payload?.me?.phone ?? '').toString().trim()
      const phoneDig = _digits(phoneRaw)
      const connectedDig = _digits(connectedRaw)
      const phonesMatch = phoneDig && connectedDig && _tail11(phoneDig) === _tail11(connectedDig)

      if (fromMeSelf && phonesMatch && !hasDestFields(payload)) {
        const msgId = payload?.messageId ?? payload?.zaapId ?? payload?.id ?? payload?.key?.id ?? null
        const statusRaw = payload?.ack != null ? String(payload.ack).trim() : String(payload?.status ?? '').trim()
        const statusNorm = statusRaw ? normalizeZapiStatus(statusRaw) : null
        console.log('[ZAPI_WEBHOOK]', JSON.stringify({ companyIdResolved: company_id, messageId: msgId ? String(msgId).slice(0, 20) : null, status: statusNorm, note: 'self_echo' }))
        if (msgId) {
          const { data: existing } = await supabase
            .from('mensagens')
            .select('id, conversa_id, company_id, whatsapp_id')
            .eq('company_id', company_id)
            .eq('whatsapp_id', String(msgId))
            .maybeSingle()
          if (existing) {
            if (statusNorm) {
              const updated = await updateStatusByWaId(String(msgId), statusNorm)
              if (updated) emitStatusMsg(updated, statusNorm, String(msgId))
            }
            logZapiCert({
              companyId: company_id,
              instanceId,
              type: payload?.type ?? payload?.event ?? 'receivedcallback',
              fromMe: true,
              hasDest: false,
              phoneTail: phoneDig?.slice(-6) || null,
              connectedTail: connectedDig?.slice(-6) || null,
              messageId: String(msgId),
              resolvedKeyType: 'self_echo',
              conversaId: existing.conversa_id,
              action: 'self_echo_status_update'
            })
            lastResult = { ok: true, handled: 'fromMe_self_echo_status' }
            continue
          }
        }
        logZapiCert({
          companyId: company_id,
          instanceId,
          type: payload?.type ?? payload?.event ?? 'receivedcallback',
          fromMe: true,
          hasDest: false,
          phoneTail: phoneDig?.slice(-6) || null,
          connectedTail: connectedDig?.slice(-6) || null,
          messageId: String(msgId),
          resolvedKeyType: 'self_echo',
          conversaId: null,
          action: 'self_echo_ignored_no_match'
        })
        lastResult = { ok: true, ignored: 'fromMe_self_echo_no_match' }
        continue
      }

      const extracted = extractMessage(payload)
      // Reações (reaction) não devem aparecer como mensagens no histórico do CRM.
      // Deixamos a reação ser tratada apenas no app WhatsApp (ícone na própria mensagem),
      // portanto ignoramos payloads cujo tipo final seja "reaction".
      if (extracted && extracted.type === 'reaction') {
        console.log('[Z-API] 🔁 reaction callback recebido — ignorando como mensagem (sem histórico separado)')
        lastResult = { ok: true, skip: 'reaction' }
        continue
      }

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
        logZapiCert({
          companyId: company_id,
          instanceId,
          type: payload?.type ?? payload?.event ?? 'receivedcallback',
          fromMe,
          hasDest: hasDestFields(payload),
          phoneTail: (payload?.phone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
          connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
          messageId: messageId ? String(messageId) : null,
          resolvedKeyType: debugReason ?? 'drop',
          conversaId: null,
          action: 'dropped_invalid_payload'
        })
        // Log SEMPRE do payload completo para diagnóstico — crítico para entender o que Z-API envia
        console.warn('⚠️ [Z-API] DROPPED — phone não resolvido:', debugReason)
        const droppedMeta = {
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
          'key.participant': payload?.key?.participant,
          isGroup: payload?.isGroup,
          messageId: payload?.messageId,
          status: payload?.status,
        }
        if (WHATSAPP_DEBUG && (payload?.data != null || payload?.key != null || payload?.value != null)) {
          droppedMeta.data = payload?.data
          droppedMeta.key = payload?.key
          droppedMeta.value = payload?.value
        }
        console.warn('⚠️ [Z-API] DROPPED — payload completo (diagnóstico):', JSON.stringify(droppedMeta))
        continue
      }

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
      const isLidKey = String(phone).startsWith('lid:')

      if (isLidKey) {
        console.log('[Z-API] LID key — conversa sem cliente vinculado (número real não disponível):', phone)
      } else {
        const nomePayloadRaw = fromMe
          ? (payload.chatName ?? payload.chat?.name ?? payload.groupName ?? payload.name ?? payload.short ?? payload.notifyName ?? payload.senderName ?? payload.displayName ?? payload.pushName ?? null)
          : (payload.name ?? payload.short ?? payload.notifyName ?? payload.senderName ?? payload.chatName ?? payload.chat?.name ?? payload.displayName ?? payload.pushName ?? null)
        const nomePayload = nomePayloadRaw ? String(nomePayloadRaw).trim() : null
        const pushnameRaw = payload.notifyName ?? payload.pushName ?? payload.notify ?? nomePayloadRaw
        const pushnamePayload = pushnameRaw ? String(pushnameRaw).trim() : null
        const nomeSource = fromMe ? 'chatName' : 'senderName'
        const { cliente_id: cid } = await getOrCreateCliente(supabase, company_id, phone, {
          nome: nomePayload,
          nomeSource,
          fromMe,
          pushname: pushnamePayload || undefined,
          foto_perfil: senderPhoto || undefined
        })
        cliente_id = cid
        if (cliente_id) pendingContactSync = { phone, cliente_id }
        // Pipeline NUNCA aborta por cliente: mesmo sem cliente_id, mensagem e socket seguem
      }
    }

    // 2) Conversa — uma única conversa por contato; quando Z-API envia chatLid/senderLid, unificar por chat_lid
    //    para que "recebido" (phone real) e "enviado pelo celular" (phone @lid) caiam no mesmo chat.
    //    Sempre priorizar número real (phone) do payload; LID só para vincular/atualizar.
    let conversa_id = null
    let departamento_id = null
    let isNewConversation = false

    const lidFromPhone = String(payload?.chatLid ?? payload?.phone ?? payload?.chat?.id ?? payload?.key?.remoteJid ?? '').trim()
    const lidFromSender = String(payload?.senderLid ?? '').trim()
    const lidRaw = lidFromPhone.endsWith('@lid') ? lidFromPhone : (lidFromSender.endsWith('@lid') ? lidFromSender : '')
    const lidPart = lidRaw ? lidRaw.replace(/@lid$/i, '').trim() : (phone.startsWith('lid:') ? phone.slice(4) : null)

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

      // Vincular conversa ao cliente quando obtido via LID ou conversa existente sem cliente_id
      if (!isGroup && conversa_id && cliente_id) {
        const { data: convRow } = await supabase
          .from('conversas')
          .select('cliente_id')
          .eq('id', conversa_id)
          .eq('company_id', company_id)
          .maybeSingle()
        if (convRow && convRow.cliente_id == null) {
          await supabase.from('conversas').update({ cliente_id }).eq('id', conversa_id).eq('company_id', company_id)
          console.log('[Z-API] Conversa vinculada ao cliente', { conversa_id, cliente_id })
        }
      }

      // Cache nome/foto do contato — chooseBestName evita regressão (nunca substituir nome bom por pior)
      if (!isGroup && conversa_id && (senderName || senderPhoto)) {
        const { data: convAtual } = await supabase
          .from('conversas')
          .select('nome_contato_cache, foto_perfil_contato_cache')
          .eq('id', conversa_id)
          .eq('company_id', company_id)
          .maybeSingle()
        const cacheUpdates = {}
        const cacheSource = fromMe ? 'chatName' : 'senderName'
        const telefoneTail = String(phone).replace(/\D/g, '').slice(-6) || null
        if (senderName && String(senderName).trim()) {
          const { name: bestNome } = chooseBestName(
            convAtual?.nome_contato_cache,
            String(senderName).trim(),
            cacheSource,
            { fromMe, company_id, telefoneTail }
          )
          if (bestNome && bestNome !== (convAtual?.nome_contato_cache || '')) cacheUpdates.nome_contato_cache = bestNome
        }
        const fotoCacheVazia = !convAtual?.foto_perfil_contato_cache || !String(convAtual.foto_perfil_contato_cache).trim()
        if (fotoCacheVazia && senderPhoto && String(senderPhoto).trim()) cacheUpdates.foto_perfil_contato_cache = String(senderPhoto).trim()
        if (Object.keys(cacheUpdates).length > 0) {
          await supabase.from('conversas')
            .update(cacheUpdates)
            .eq('id', conversa_id)
            .eq('company_id', company_id)
        }
      }

      if (isNewConversation) {
        const io = req.app.get('io')
        if (io) {
          // Unread: mensagem recebida (!fromMe) = 1; mensagem enviada por nós (fromMe) = 0
          const unreadInicial = fromMe ? 0 : 1
          // LID: enviar telefone: null e telefone_lid: true para frontend não exibir lid:xxx; permite atualização via conversa_atualizada
          const isLidPhone = !isGroup && phone && String(phone).trim().toLowerCase().startsWith('lid:')
          const telefoneForEmit = isLidPhone ? null : (getCanonicalPhone(phone) || phone)
          io.to(`empresa_${company_id}`).emit('nova_conversa', {
            id: conversa_id,
            telefone: telefoneForEmit,
            ...(isLidPhone ? { telefone_lid: true } : {}),
            tipo: isGroup ? 'grupo' : 'cliente',
            nome_grupo: isGroup ? (nomeGrupo || null) : null,
            foto_grupo: isGroup ? (chatPhoto || null) : null,
            contato_nome: isGroup ? (nomeGrupo || phone || 'Grupo') : (senderName || payload?.chatName || phone || null),
            foto_perfil: isGroup ? null : (senderPhoto || payload?.photo || null),
            unread_count: unreadInicial,
            tags: [],
          })
        }
      }
    } catch (errConv) {
      console.error('[Z-API] ❌ Erro ao obter/criar conversa:', errConv?.message || errConv)
      return res.status(500).json({ error: 'Erro ao obter conversa' })
    }

    // 2.5) Chatbot de triagem (Z-API): mensagem do cliente, conversa sem departamento → menu ou processar opção
    // APENAS contatos (não grupos). Telefone deve ser enviável (não lid:).
    let phoneParaChatbot = phone
    if (phone && String(phone).startsWith('lid:')) {
      const { data: convRow } = await supabase
        .from('conversas')
        .select('telefone')
        .eq('id', conversa_id)
        .eq('company_id', company_id)
        .maybeSingle()
      const telefoneConv = convRow?.telefone
      if (telefoneConv && !String(telefoneConv).startsWith('lid:')) {
        phoneParaChatbot = telefoneConv
        console.log('[Z-API] 🤖 Chatbot: usando telefone da conversa (payload tinha LID):', telefoneConv?.slice(-8))
      } else {
        console.log('[Z-API] 🤖 Chatbot: ignorado — phone é LID e conversa não tem número real para envio')
        phoneParaChatbot = null
      }
    }
    // Human takeover: não processar chatbot se atendente já assumiu a conversa
    let atendente_id = null
    if (!fromMe && !isGroup && departamento_id == null && phoneParaChatbot) {
      const { data: convEstado } = await supabase
        .from('conversas')
        .select('atendente_id')
        .eq('id', conversa_id)
        .eq('company_id', company_id)
        .maybeSingle()
      atendente_id = convEstado?.atendente_id ?? null
    }
    if (!fromMe && !isGroup && departamento_id == null && atendente_id == null && phoneParaChatbot) {
      try {
        const sendMessage = async (ph, msg, o = {}) => {
          const r = await zapiProvider.sendText(ph, msg, { companyId: company_id, conversaId: conversa_id, ...o })
          return { ok: !!r?.ok, messageId: r?.messageId || null }
        }
        let skipChatbot = false

        // Opt-out (complementar): PARAR, SAIR, DESCADASTRAR — antes do chatbot
        if (isEnabled(FLAGS.FEATURE_OPT_OUT_WEBHOOK)) {
          const optResult = await processarOptOut({
            supabase,
            company_id,
            cliente_id: cliente_id || null,
            telefone: phoneParaChatbot,
            texto: texto || '',
          })
          if (optResult.isOptOut && optResult.mensagemConfirmacao) {
            await sendMessage(phoneParaChatbot, optResult.mensagemConfirmacao, {})
            skipChatbot = true
          }
        }

        // Regras automáticas (complementar): palavra-chave → resposta — antes do chatbot
        if (!skipChatbot && isEnabled(FLAGS.FEATURE_REGRA_AUTO_WEBHOOK)) {
          const regrasResult = await processarRegras({
            supabase,
            company_id,
            conversa_id,
            texto: texto || '',
            telefone: phoneParaChatbot,
            sendMessage,
          })
          if (regrasResult.matched) skipChatbot = true
        }

        if (!skipChatbot) {
          console.log('[Z-API] 🤖 Chatbot: processando mensagem', { company_id, conversa_id, phoneTail: String(phoneParaChatbot).slice(-8) })
          const result = await processChatbotTriage({
            company_id,
            conversa_id,
            telefone: phoneParaChatbot,
            texto: texto || '',
            supabase,
            sendMessage,
            opts: { companyId: company_id },
          })
          if (result?.handled && result?.departamento_id != null) {
            departamento_id = result.departamento_id
            console.log('[Z-API] 🤖 Chatbot: conversa direcionada para departamento', departamento_id)
          }
        }
      } catch (errChatbot) {
        console.warn('[Z-API] Chatbot triagem:', errChatbot?.message || errChatbot)
      }
    }

    // 3) Salvar mensagem. TUDO que a Z-API envia (recebido, !fromMe) é gravado; sem messageId grava com whatsapp_id null.
    // Mensagens enviadas por nós (fromMe): não inserir — evita eco/duplicata.
    const whatsappIdStr = messageId ? String(messageId).trim() : null
    let mensagemSalva = null
    /** true apenas quando inserimos nova mensagem; false quando idempotência ou reconciliação (CRM já emitiu nova_mensagem) */
    let mensagemFoiInseridaPeloWebhook = false

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
            const history = await provider.getChatMessages(phoneForHistory, 25, null, { companyId: company_id }).catch(() => [])
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

    // Idempotência: chave única (company_id, whatsapp_id) — reenvio do webhook não duplica
    if (whatsappIdStr) {
      const { data: existente } = await supabase
        .from('mensagens')
        .select('*')
        .eq('company_id', company_id)
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
        payload?.context?.messageId ??          // Z-API context (algumas versões)
        payload?.context?.id ??
        payload?.contextInfo?.stanzaId ??
        payload?.contextInfo?.quotedStanzaId ??
        payload?.contextInfo?.quotedMessageId ??
        refMsg?.id ??
        refMsg?.messageId ??
        payload?.message?.contextInfo?.stanzaId ??
        payload?.message?.contextInfo?.quotedStanzaId ??
        payload?.message?.context?.messageId ??
        payload?.message?.context?.id ??
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

        const { data: candidates } = await q
        let cand = null
        if (Array.isArray(candidates) && candidates.length > 0) {
          if (urlSig) {
            cand = candidates[0]
          } else if (texto) {
            const textoNorm = String(texto || '').trim()
            // Match exato primeiro; fallback case-insensitive (evita "Oi" vs "oi" duplicar)
            cand = candidates.find((c) => {
              const t = String(c.texto || '').trim()
              return t === textoNorm || t.toLowerCase() === textoNorm.toLowerCase()
            }) || null
          } else {
            cand = candidates[0]
          }
        }
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
              remetenteNomeFinal = ex.nome || ex.pushname || remetenteNomeFinal
            } else {
              // se não existe no banco, usa getOrCreateCliente para evitar duplicata (mesmo contato 12 vs 13 dígitos)
              if (pNorm) {
                const nomeMin = senderName ? String(senderName).trim() : pNorm
                const { cliente_id: cidGrupo } = await getOrCreateCliente(supabase, company_id, pNorm, {
                  nome: nomeMin,
                  nomeSource: 'grupo_sender',
                  pushname: senderName ? String(senderName).trim() : undefined,
                })
                if (cidGrupo) {
                  // sync em background (nome/foto reais) — chooseBestName evita regressão
                  setImmediate(async () => {
                    try {
                      const { data: current } = await supabase.from('clientes').select('nome, pushname, foto_perfil').eq('id', cidGrupo).maybeSingle()
                      const sync = await syncContactFromZapi(pNorm, company_id).catch(() => null)
                      if (!sync) return
                      const up = {}
                      const telefoneTail = String(pNorm).replace(/\D/g, '').slice(-6) || null
                      const { name: bestNome } = chooseBestName(current?.nome, sync.nome, 'syncZapi', { fromMe: false, company_id, telefoneTail })
                      if (bestNome && bestNome !== (current?.nome || '')) up.nome = bestNome
                      if (!current?.pushname && sync.pushname) up.pushname = sync.pushname
                      if (!current?.foto_perfil && sync.foto_perfil) up.foto_perfil = sync.foto_perfil
                      if (Object.keys(up).length > 0) await supabase.from('clientes').update(up).eq('id', cidGrupo)
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
          const { data: existente } = await supabase.from('mensagens').select('*').eq('company_id', company_id).eq('whatsapp_id', whatsappIdStr).maybeSingle()
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
            mensagemFoiInseridaPeloWebhook = true
            console.log('✅ Mensagem salva (fallback):', mensagemSalva.id)
          } else {
            console.error('❌ Z-API Erro ao salvar mensagem:', errMsg?.code, errMsg?.message, errMsg?.details)
            return res.status(500).json({ error: 'Erro ao salvar mensagem' })
          }
        }
      } else {
        mensagemSalva = inserted
        mensagemFoiInseridaPeloWebhook = true
      }
    }

    if (mensagemSalva) {
      // Usar conversa_id da mensagem quando idempotência retornou existente de outra conversa
      const convIdForUpdate = mensagemSalva.conversa_id ?? conversa_id
      const { error: errUpdate } = await supabase
        .from('conversas')
        .update({ ultima_atividade: new Date().toISOString() })
        .eq('id', convIdForUpdate)
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
            .eq('id', convIdForUpdate)
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
      logZapiCert({
        companyId: company_id,
        instanceId,
        type: payload?.type ?? payload?.event ?? 'receivedcallback',
        fromMe,
        hasDest: hasDestFields(payload),
        phoneTail: phone?.slice(-6) || null,
        connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
        messageId: mensagemSalva?.whatsapp_id ? String(mensagemSalva.whatsapp_id) : null,
        resolvedKeyType: debugReason ?? null,
        conversaId: conversa_id ?? mensagemSalva?.conversa_id,
        action: 'inserted_message'
      })
    }

    // Mensagem de entrada: incrementa unread no banco para todos os usuários (igual WhatsApp; refetch da lista já vem com contador certo)
    const convIdForEmit = mensagemSalva?.conversa_id ?? conversa_id
    if (!fromMe) {
      await incrementarUnreadParaConversa(company_id, convIdForEmit)
    }

    // 4) Realtime: nova_mensagem + atualizar_conversa + conversa_atualizada (igual WhatsApp Web)
    // IMPORTANTE: só emite nova_mensagem quando a mensagem foi INSERIDA pelo webhook.
    // Quando idempotência ou reconciliação (msg enviada pelo CRM), o chatController já emitiu — evita duplicata.
    const io = req.app.get('io')
    if (io && mensagemSalva) {
      const rooms = [`conversa_${convIdForEmit}`, `empresa_${company_id}`]
      if (departamento_id != null) rooms.push(`departamento_${departamento_id}`)
      // Status canônico para os ticks no frontend (sent, delivered, read, pending, erro, played)
      const rawStatus = (mensagemSalva.status_mensagem ?? mensagemSalva.status ?? '').toString().toLowerCase()
      const canon = rawStatus === 'enviada' || rawStatus === 'enviado' ? 'sent' : (rawStatus === 'entregue' || rawStatus === 'received' ? 'delivered' : (rawStatus || (fromMe ? 'sent' : 'delivered')))
      const emitPayload = {
        ...mensagemSalva,
        conversa_id: mensagemSalva.conversa_id ?? convIdForEmit,
        status: canon,
        status_mensagem: canon
      }
      if (mensagemFoiInseridaPeloWebhook) {
        io.to(rooms).emit('nova_mensagem', emitPayload)
      } else {
        // Reconciliada/idempotência: emite apenas status_mensagem para atualizar ticks (evita duplicar bolha)
        const statusPayload = {
          mensagem_id: mensagemSalva.id,
          conversa_id: convIdForEmit,
          status: canon,
          whatsapp_id: mensagemSalva.whatsapp_id || null
        }
        let chain = io.to(`empresa_${company_id}`).to(`conversa_${convIdForEmit}`)
        if (mensagemSalva.autor_usuario_id != null) chain = chain.to(`usuario_${mensagemSalva.autor_usuario_id}`)
        chain.emit('status_mensagem', statusPayload)
      }
      io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: convIdForEmit })
      // conversa_atualizada enriquecida: ultima_atividade, nome/foto cache (frontend atualiza lista lateral)
      // Sempre incluir nome quando disponível (cache ou cliente) — evita frontend sobrescrever com vazio
      const { data: convRow } = await supabase
        .from('conversas')
        .select('id, ultima_atividade, nome_contato_cache, foto_perfil_contato_cache, telefone, cliente_id, departamento_id')
        .eq('id', convIdForEmit)
        .eq('company_id', company_id)
        .maybeSingle()
      let contatoNome = convRow?.nome_contato_cache ? String(convRow.nome_contato_cache).trim() : null
      let fotoPerfil = convRow?.foto_perfil_contato_cache ? String(convRow.foto_perfil_contato_cache).trim() : null
      if ((!contatoNome || !fotoPerfil) && convRow?.cliente_id && !isGroup) {
        const { data: cli } = await supabase
          .from('clientes')
          .select('nome, pushname, foto_perfil')
          .eq('id', convRow.cliente_id)
          .eq('company_id', company_id)
          .maybeSingle()
        if (cli && !contatoNome) contatoNome = (cli.nome || cli.pushname || '').trim() || null
        if (cli?.foto_perfil && !fotoPerfil) fotoPerfil = String(cli.foto_perfil).trim()
      }
      const depId = departamento_id ?? convRow?.departamento_id ?? null
      const convPayload = {
        id: convIdForEmit,
        ultima_atividade: convRow?.ultima_atividade ?? new Date().toISOString(),
        telefone: convRow?.telefone ?? null,
        ...(depId != null ? { departamento_id: depId } : {}),
        ...(contatoNome ? { nome_contato_cache: contatoNome, contato_nome: contatoNome } : {}),
        ...(fotoPerfil ? { foto_perfil_contato_cache: fotoPerfil, foto_perfil: fotoPerfil } : {}),
        ...(mensagemFoiInseridaPeloWebhook && !fromMe ? { tem_novas_mensagens: true, lida: false } : {})
      }
      io.to(`empresa_${company_id}`).emit('conversa_atualizada', convPayload)
      if (depId != null) {
        io.to(`departamento_${depId}`).emit('atualizar_conversa', { id: convIdForEmit })
        io.to(`departamento_${depId}`).emit('conversa_atualizada', convPayload)
      }
    }

    if (pendingContactSync && io) {
      const { cliente_id: syncClienteId } = pendingContactSync
      const syncPhone = pendingContactSync.phone
      const convId = convIdForEmit
      // Usar Promise em vez de setImmediate para permitir .catch (setImmediate não retorna Promise)
      Promise.resolve().then(async () => {
        try {
          const { data: current } = await supabase.from('clientes').select('nome, pushname, foto_perfil').eq('id', syncClienteId).eq('company_id', company_id).maybeSingle()
          const synced = await syncContactFromZapi(syncPhone, company_id).catch(() => null)
          if (!synced) return null
          const up = {}
          const telefoneTail = String(syncPhone).replace(/\D/g, '').slice(-6) || null
          const { name: bestNome } = chooseBestName(current?.nome, synced?.nome, 'syncZapi', { fromMe: false, company_id, telefoneTail })
          if (bestNome && bestNome !== (current?.nome || '')) up.nome = bestNome
          else if (!current?.nome || !String(current.nome).trim()) up.nome = (synced.nome && String(synced.nome).trim()) ? String(synced.nome).trim() : syncPhone
          const pushnameVazio = !current?.pushname || !String(current.pushname).trim()
          const fotoVazia = !current?.foto_perfil || !String(current.foto_perfil).trim()
          if (pushnameVazio && synced.pushname !== undefined) up.pushname = synced.pushname
          if (fotoVazia && synced.foto_perfil) up.foto_perfil = synced.foto_perfil
          if (Object.keys(up).length === 0) return null
          const res = await supabase.from('clientes').update(up).eq('id', syncClienteId).eq('company_id', company_id)
          if (res.error) return
          const r = await supabase.from('clientes').select('nome, pushname, telefone, foto_perfil').eq('id', syncClienteId).single()
          const data = r?.data
          if (data && io) {
            const displayName = data.nome || data.pushname || data.telefone || syncPhone
            console.log('✅ Contato sincronizado Z-API:', syncPhone?.slice(-6), displayName || '(sem nome)')
            io.to(`empresa_${company_id}`).emit('contato_atualizado', {
              conversa_id: convId,
              contato_nome: displayName,
              telefone: data.telefone || syncPhone,
              foto_perfil: data.foto_perfil
            })
          }
        } catch (e) {
          console.error('❌ Erro Z-API ao sincronizar contato:', syncPhone?.slice(-6), e?.message || e)
        }
      }).catch(() => {})
    }

    lastResult = { ok: true, conversa_id: convIdForEmit, mensagem_id: mensagemSalva?.id }
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
    if ((req.path || '').includes('statusht')) {
      console.log('[Z-API] alias_hit: /statusht -> handler status (ticks ✓✓)')
    }
    const body = req.body || {}
    let company_id = req.zapiContext?.company_id
    if (company_id == null) {
      const instanceIdRaw = (body?.instanceId ?? body?.instance_id ?? body?.instance ?? '').toString().trim()
      company_id = instanceIdRaw ? await getCompanyIdByInstanceId(instanceIdRaw) : null
      const instanceIdResolved = instanceIdRaw ? instanceIdRaw.slice(0, 24) + (instanceIdRaw.length > 24 ? '…' : '') : '(empty)'
      _logWebhookSafe({ eventType: 'MessageStatusCallback', instanceId: instanceIdResolved, companyIdResolved: company_id != null ? company_id : 'not_mapped' })
      if (company_id == null) return res.status(200).json({ ok: true })
    }

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

    // Fallback: deriva company_id da mensagem (whatsapp_id) quando instanceId ausente
    if (company_id == null && idsToProcess.length > 0) {
      const { data: msgRow } = await supabase.from('mensagens').select('company_id').eq('whatsapp_id', idsToProcess[0]).limit(1).maybeSingle()
      company_id = msgRow?.company_id ?? null
    }
    if (company_id == null) {
      if (body?.instanceId) console.log('[Z-API] status: instance not mapped:', String(body.instanceId).slice(0, 16) + '…')
      return res.status(200).json({ ok: true })
    }
    const io = req.app.get('io')
    let updated = 0

    for (const messageId of idsToProcess) {
      if (!messageId) continue
      const idStr = String(messageId)

      // Grupos: WhatsApp não envia read receipts confiáveis — cap em delivered
      let effectiveStatus = statusNorm
      if (statusNorm === 'read' || statusNorm === 'played') {
        const { data: msgForConv } = await supabase
          .from('mensagens')
          .select('conversa_id')
          .eq('company_id', company_id)
          .eq('whatsapp_id', idStr)
          .maybeSingle()
        if (msgForConv?.conversa_id) {
          const { data: conv } = await supabase
            .from('conversas')
            .select('tipo, telefone')
            .eq('id', msgForConv.conversa_id)
            .eq('company_id', company_id)
            .maybeSingle()
          const isGroup = conv?.tipo === 'grupo' || (conv?.telefone && String(conv.telefone).endsWith('@g.us'))
          if (isGroup) effectiveStatus = 'delivered'
        }
      }

      // 1) Atualiza por (company_id, whatsapp_id) — match exato (inclui autor_usuario_id para emit ao remetente)
      let { data: msg } = await supabase
        .from('mensagens')
        .update({ status: effectiveStatus })
        .eq('company_id', company_id)
        .eq('whatsapp_id', idStr)
        .select('id, conversa_id, company_id, autor_usuario_id')
        .maybeSingle()

      // 2) Fallback: Z-API às vezes trunca o ID no status callback.
      //    Tenta prefixo (primeiros 20 chars) ainda dentro do company_id (sem cross-tenant).
      if (!msg && idStr.length >= 20) {
        const prefix = idStr.slice(0, 20)
        const { data: prefixRows } = await supabase
          .from('mensagens')
          .select('id, conversa_id, company_id, autor_usuario_id, whatsapp_id')
          .eq('company_id', company_id)
          .ilike('whatsapp_id', `${prefix}%`)
          .order('id', { ascending: false })
          .limit(1)
        const candidate = Array.isArray(prefixRows) && prefixRows[0] ? prefixRows[0] : null
        if (candidate?.id) {
          const { data: patched } = await supabase
            .from('mensagens')
            .update({ status: effectiveStatus })
            .eq('company_id', company_id)
            .eq('id', candidate.id)
            .select('id, conversa_id, company_id, autor_usuario_id')
            .maybeSingle()
          msg = patched || null
        }
      }

      if (msg) {
        updated++
        if (io) {
          const payload = {
            mensagem_id: msg.id,
            conversa_id: msg.conversa_id,
            status: effectiveStatus,
            whatsapp_id: idStr
          }
          // Emite para empresa, conversa E usuario do autor (garante atualização em tempo real para quem enviou)
          let chain = io.to(`empresa_${msg.company_id}`).to(`conversa_${msg.conversa_id}`)
          if (msg.autor_usuario_id != null) chain = chain.to(`usuario_${msg.autor_usuario_id}`)
          chain.emit('status_mensagem', payload)
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
    let company_id = req.zapiContext?.company_id
    if (company_id == null) {
      const incomingInstanceId = (payload?.instanceId ?? payload?.instance_id ?? payload?.instance ?? '').toString().trim()
      company_id = incomingInstanceId ? await getCompanyIdByInstanceId(incomingInstanceId) : null
      const instanceIdResolved = incomingInstanceId ? incomingInstanceId.slice(0, 24) + (incomingInstanceId.length > 24 ? '…' : '') : '(empty)'
      _logWebhookSafe({ eventType: payload?.event ?? payload?.type ?? 'connection', instanceId: instanceIdResolved, companyIdResolved: company_id != null ? company_id : 'not_mapped' })
      if (company_id == null) return res.status(200).json({ ok: true })
    }

    const type = String(payload?.type ?? payload?.event ?? payload?.status ?? '').toLowerCase()
    const connected = payload?.connected === true || type.includes('connected')

    if (connected && company_id) {
      await resetOnConnected(company_id)
    }

    // Ao conectar: dispara sync em background (espelho do WhatsApp: nomes + (se possível) fotos)
    if (connected) {
      setImmediate(async () => {
        const io = req.app.get('io')
        const provider = getProvider()
        if (!provider || !provider.isConfigured) return

        // Aguarda instância Z-API estabilizar (evita "You need to be connected" em massa)
        await new Promise(r => setTimeout(r, 10000))

        // ─── Auto-configuração dos webhooks Z-API ───
        // Registra automaticamente as URLs de callback (mensagens + status) na instância Z-API.
        // Garante que READ/RECEIVED cheguem mesmo sem configuração manual no painel.
        const appUrl = process.env.APP_URL || ''
        if (appUrl && provider.configureWebhooks) {
          try {
            await provider.configureWebhooks(appUrl, { companyId: company_id })
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
          const pageSize = 250
          const maxPages = 120
          let page = 1
          let total = 0
          let atualizados = 0
          let criados = 0
          let fotosAtualizadas = 0

          while (page <= maxPages) {
            const contacts = await provider.getContacts(page, pageSize, { companyId: company_id })
            if (!Array.isArray(contacts) || contacts.length === 0) break

            for (const c of contacts) {
              const rawPhone = String(c.phone || '').trim()
              let phone = normalizePhoneBR(rawPhone)
              if (!phone) {
                const digits = rawPhone.replace(/\D/g, '')
                if (digits.length >= 10 && digits.length <= 15) phone = digits
              }
              if (!phone) continue
              total++

              const nome = (c.name || c.short || c.notify || c.vname || '').trim() || null
              const pushname = (c.notify || '').trim() || null

              const phones = possiblePhonesBR(phone)
              let q = supabase.from('clientes').select('id, telefone, nome').eq('company_id', company_id)
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

              // Nome: só Z-API sync e webhook podem atualizar. Sem nome → fallback com número.
              const nomeFinal = nome && String(nome).trim() ? nome : phone

              if (existente?.id) {
                const updates = {}
                if (nome && String(nome).trim()) {
                  const { name: bestNome } = chooseBestName(existente.nome, String(nome).trim(), 'syncZapi', { fromMe: false, company_id, telefoneTail: String(phone || '').replace(/\D/g, '').slice(-6) })
                  if (bestNome && bestNome !== (existente.nome || '')) updates.nome = bestNome
                }
                if (!updates.nome && (!existente.nome || !String(existente.nome).trim())) updates.nome = phone
                if (pushname != null && String(pushname).trim()) updates.pushname = String(pushname).trim()
                if (Object.keys(updates).length > 0) {
                  let upd = await supabase.from('clientes').update(updates).eq('id', existente.id).eq('company_id', company_id)
                  if (upd.error && String(upd.error.message || '').includes('pushname')) {
                    delete updates.pushname
                    if (Object.keys(updates).length > 0) upd = await supabase.from('clientes').update(updates).eq('id', existente.id).eq('company_id', company_id)
                  }
                  if (!upd.error) atualizados++
                }
              } else {
                const { cliente_id: cid } = await getOrCreateCliente(supabase, company_id, phone, {
                  nome: nomeFinal || phone,
                  nomeSource: 'syncZapi',
                  pushname: pushname || undefined
                })
                if (cid) criados++
              }
            }

            if (contacts.length < pageSize) break
            page++
          }

          console.log('✅ Z-API sync de contatos finalizado:', { total, criados, atualizados })

          // Fotos: tenta completar para os que estão sem foto (limitado para não travar o webhook)
          // Só executa se Z-API estiver realmente conectada (evita centenas de 400 "not connected")
          if (provider.getProfilePicture) {
            const statusResult = await getStatus(company_id)
            if (!statusResult?.connected) {
              console.warn('⏭️ Z-API: pulando sync de fotos (instância ainda não conectada). Use Configurações > Sincronizar fotos depois.')
            } else {
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
                  const url = await provider.getProfilePicture(tel, { companyId: company_id })
                  if (url && String(url).trim().startsWith('http')) {
                    const { error: updErr } = await supabase
                      .from('clientes')
                      .update({ foto_perfil: String(url).trim() })
                      .eq('id', cl.id)
                      .eq('company_id', company_id)
                    if (!updErr) fotosAtualizadas++
                  }
                } catch (e) {
                  if (e?.code === 'ZAPI_NOT_CONNECTED') {
                    console.warn('⏭️ Z-API: sync de fotos interrompido (instância desconectada). Use Configurações > Sincronizar fotos quando estiver conectado.')
                    break
                  }
                  // ignora outros (pode estar sem foto/privacidade)
                }
                await new Promise(r => setTimeout(r, 220))
              }
              if (fotosAtualizadas > 0) console.log('🖼️ Z-API: fotos atualizadas (parcial):', fotosAtualizadas)
            }
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
    let company_id = req.zapiContext?.company_id
    if (company_id == null) {
      const instanceId = (body.instanceId ?? body.instance_id ?? body.instance ?? '').toString().trim()
      company_id = instanceId ? await getCompanyIdByInstanceId(instanceId) : null
      const instanceIdResolved = instanceId ? instanceId.slice(0, 24) + (instanceId.length > 24 ? '…' : '') : '(empty)'
      _logWebhookSafe({ eventType: 'PresenceChatCallback', instanceId: instanceIdResolved, companyIdResolved: company_id != null ? company_id : 'not_mapped' })
      if (company_id == null) return res.status(200).json({ ok: true })
    }
    const phoneRaw = body.phone ? String(body.phone).trim() : ''
    const status = body.status ? String(body.status).trim().toUpperCase() : ''
    const lastSeen = body.lastSeen ?? body.last_seen ?? null

    if (phoneRaw && status) {
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
