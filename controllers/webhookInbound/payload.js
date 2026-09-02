/**
 * Funções PURAS de payload do webhook inbound (formato legado "zapi-like" do UltraMSG):
 * detecção de grupo, chave de conversa, extração de mensagem e desempacote de lote.
 * Extraído de controllers/webhookZapiController.js (Fase 1 da modularização — doc 24) sem alteração de comportamento.
 */

const { normalizePhoneBR, normalizeGroupIdForStorage } = require('../../helpers/phoneHelper')
const { parseVcardForContact } = require('../../helpers/vcardHelper')
const { resolvePeerPhone } = require('../../helpers/conversationKeyHelper')
const { inspectInboundOrigin } = require('./chatbotInboundGuard')

const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'

/** Detecta se o payload é de um grupo (remoteJid @g.us, isGroup ou tipo grupo). */
function isGroupPayload(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (payload.isGroup === true) return true
  // UltraMsg usa isGroupMsg em vez de isGroup
  if (payload.isGroupMsg === true) return true
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
    payload.data?.key?.remoteJid,
    // UltraMsg envia o group JID em payload.to / payload.data.to
    payload.to,
    payload.data?.to,
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
    payload.data?.key?.remoteJid,
    // UltraMsg envia o group JID em payload.to / payload.data.to
    payload.to,
    payload.data?.to,
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
    // UltraMsg usa payload.from / payload.data.from como JID do remetente dentro do grupo
    const participantPhone = digits(payload.participantPhone ?? payload.participant ?? payload.author ?? payload.key?.participant ?? payload.from ?? payload.data?.from ?? '')
    return {
      key,
      isGroup: true,
      participantPhone,
      debugReason: key ? `group via pickGroupChatId (${groupKey})` : 'group but no groupChatId found — drop'
    }
  }

  // Origem real do chat (Status / grupo em reação) — NUNCA o telefone do participant.
  const inboundOrigin = inspectInboundOrigin(payload)
  if (inboundOrigin.isStatusBroadcast) {
    return {
      key: '',
      isGroup: false,
      participantPhone: '',
      debugReason: 'status_broadcast — not a private chat',
    }
  }
  if (inboundOrigin.isGroup && inboundOrigin.groupChatId) {
    const participantPhone = digits(payload.participantPhone ?? payload.participant ?? payload.author ?? payload.key?.participant ?? payload.from ?? payload.data?.from ?? '')
    return {
      key: inboundOrigin.groupChatId,
      isGroup: true,
      participantPhone,
      debugReason: `group via chat origin (${inboundOrigin.groupJid}) — not participant phone`,
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
      [payload.key?.remoteJid,  'key.remoteJid'],
      [payload.remoteJid,       'remoteJid'],
      [payload.chat?.remoteJid, 'chat.remoteJid'],
      [payload.chatId,          'chatId'],
      [payload.chat?.id,        'chat.id'],
      [payload.to,             'to'],
      [payload.toPhone,        'toPhone'],
      [payload.recipientPhone, 'recipientPhone'],
      [payload.recipient,      'recipient'],
      [payload.destination,    'destination'],
      [payload.key?.participant, 'key.participant'],
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
  let ts = payload.timestamp ?? payload.momment ?? payload.t ?? payload.reaction?.time ?? Date.now()
  // Timestamp pode vir em segundos (ex: API histórico) ou ms. Valores antigos/inválidos geram data 1970.
  const tsNum = Number(ts)
  if (tsNum && tsNum < 1e12) ts = tsNum * 1000
  const dateFromTs = ts ? new Date(Number(ts)) : null
  if (!dateFromTs || dateFromTs.getFullYear() < 2020) ts = Date.now()

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
  // Fallback: texto bruto com vCard (ex: UltraMsg envia type=chat com body=vCard)
  if ((!type || type === 'text') && typeof rawMessage === 'string' && String(rawMessage).trim().includes('BEGIN:VCARD') && String(rawMessage).trim().includes('END:VCARD')) {
    type = 'contact'
    if (!payload.contact || typeof payload.contact !== 'object') {
      payload = { ...payload, contact: { vCard: String(rawMessage).trim(), displayName: null, formattedName: null } }
    }
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
  let locationUrl = payload.location?.url ?? payload.location?.thumbnailUrl ?? null
  // Se não tiver URL mas tiver lat/lng (ex: UltraMsg), monta link do Google Maps
  const loc = payload.location || {}
  if (!locationUrl && (loc.latitude != null || loc.lat != null) && (loc.longitude != null || loc.lng != null)) {
    const lat = Number(loc.latitude ?? loc.lat)
    const lng = Number(loc.longitude ?? loc.lng)
    if (!isNaN(lat) && !isNaN(lng)) locationUrl = `https://www.google.com/maps?q=${lat},${lng}`
  }

  // participantPhone: remetente dentro do grupo (só relevante para grupos; usamos o valor resolvido por resolveConversationKeyFromZapi + o bruto do payload como fallback)
  const participantPhoneRaw = partPhoneResolved ||
    String(payload.participantPhone ?? payload.participant ?? payload.author ?? payload.key?.participant ?? '').replace(/\D/g, '')
  // Doc Z-API: name = nome completo salvo no celular; chatName/short = abreviados. Priorizar name sempre.
  const fromMeForExtract = Boolean(payload.fromMe ?? payload.key?.fromMe)
  const senderName = fromMeForExtract
    ? (payload.name ?? payload.formattedName ?? payload.chatName ?? payload.chat?.name ?? payload.groupName ?? payload.short ?? payload.notifyName ?? payload.senderName ?? payload.displayName ?? payload.pushName ?? payload.sender?.name ?? null)
    : (payload.name ?? payload.formattedName ?? payload.short ?? payload.notifyName ?? payload.senderName ?? payload.chatName ?? payload.chat?.name ?? payload.displayName ?? payload.pushName ?? payload.sender?.name ?? null)
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
    const lat = loc.latitude ?? loc.lat
    const lng = loc.longitude ?? loc.lng
    const latNum = Number(lat)
    const lngNum = Number(lng)
    const hasValidCoords = lat != null && lng != null && !isNaN(latNum) && !isNaN(lngNum)
    const coordsFormatted = hasValidCoords ? `${Number(latNum).toFixed(5)}, ${Number(lngNum).toFixed(5)}` : ''
    texto = parts.length
      ? parts.join(' • ') + (coordsFormatted ? ` (${coordsFormatted})` : '')
      : (coordsFormatted || loc.url || '(localização)')
  } else if (type === 'contact') {
    const c = payload.contact || {}
    texto = (c.displayName && String(c.displayName).trim()) || (c.formattedName && String(c.formattedName).trim()) || (c.vCard && String(c.vCard).slice(0, 120)) || '(contato)'
  }

  // contactMeta: { nome, telefone, foto_perfil?, descricao_negocio? } para cartão de contato no frontend
  let contactMeta = null
  if (type === 'contact') {
    const c = payload.contact || {}
    const displayName = (c.displayName && String(c.displayName).trim()) || (c.formattedName && String(c.formattedName).trim()) || null
    const vcard = c.vCard || c.vcard || (typeof rawMessage === 'string' && rawMessage.includes('BEGIN:VCARD') ? rawMessage : null)
    const parsed = vcard ? parseVcardForContact(vcard) : { nome: null, telefone: null }
    const contactPhone = c.phone || c.telefone || parsed.telefone || (Array.isArray(c.fullContactData?.phoneNumbers) && c.fullContactData.phoneNumbers[0] ? String(c.fullContactData.phoneNumbers[0]).replace(/\D/g, '') : null)
    contactMeta = {
      nome: displayName || parsed.nome || texto || null,
      telefone: contactPhone || null,
      foto_perfil: (c.profilePicture || c.profilePictureUrl || c.photo) && String(c.profilePicture || c.profilePictureUrl || c.photo).startsWith('http') ? String(c.profilePicture || c.profilePictureUrl || c.photo).trim() : null
    }
    if (parsed.descricao_negocio) contactMeta.descricao_negocio = parsed.descricao_negocio
    if (!contactMeta.nome && !contactMeta.telefone) contactMeta = null
  }

  // locationMeta: { latitude, longitude, nome, endereco } — paridade com contact_meta
  let locationMeta = null
  if (type === 'location') {
    const loc = payload.location || {}
    const lat = Number(loc.latitude ?? loc.lat)
    const lng = Number(loc.longitude ?? loc.lng)
    if (!isNaN(lat) && !isNaN(lng)) {
      locationMeta = {
        latitude: lat,
        longitude: lng,
        nome: (loc.name && String(loc.name).trim()) || null,
        endereco: (loc.address && String(loc.address).trim()) || null
      }
    }
  }

  if (type === 'image' && imageUrl) {
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
    criado_em: (ts ? new Date(Number(ts)) : new Date()).toISOString(),
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
    chatPhoto: chatPhoto && String(chatPhoto).trim() ? String(chatPhoto).trim() : null,
    contactMeta,
    locationMeta
  }
}

/**
 * POST /webhooks/ultramsg — recebe callback principal de mensagem (entrada/saída). Suporta grupos e lote.
 */
/** Retorna array de payloads para processar (1 ou N mensagens).
 * Mescla campos de body (key, instanceId, etc.) quando payload vem de body.value/data —
 * Z-API pode enviar key.remoteJid no nível raiz com a mensagem em value/data. */
function getPayloads(body) {
  if (!body || typeof body !== 'object') return [{}]
  const merge = (parent, child) => {
    if (!child || typeof child !== 'object') return parent || {}
    const out = { ...parent, ...child }
    // key.remoteJid pode estar só em parent (Z-API envia mensagem em value, key no raiz)
    if (parent?.key && (!child?.key || !child.key?.remoteJid) && parent.key?.remoteJid) {
      out.key = { ...(child?.key || {}), ...parent.key }
    }
    return out
  }
  if (Array.isArray(body) && body.length > 0) return body
  if (body.data && Array.isArray(body.data) && body.data.length > 0) {
    return body.data.map((item) => merge(body, item))
  }
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return [merge(body, body.data)]
  }
  if (body.value && typeof body.value === 'object') {
    return [merge(body, body.value)]
  }
  if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages.map((item) => merge(body, item))
  }
  if (body.message && typeof body.message === 'object') {
    return [merge(body, body.message)]
  }
  return [body]
}

/** Extrai instanceId do payload (body) — mesma lógica do middleware. */
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

module.exports = {
  isGroupPayload,
  pickGroupChatId,
  looksLikeBRPhoneDigits,
  resolveConversationKeyFromZapi,
  extractMessage,
  getPayloads,
  _extractInstanceIdFromBody,
  hasDestFields,
}
