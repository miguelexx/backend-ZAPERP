const supabase = require('../config/supabase')
const { normalizePhoneBR } = require('../helpers/phoneHelper')
const { getOrCreateCliente, findOrCreateConversation } = require('../helpers/conversationSync')
const { getProvider } = require('./providers')
const { listWhatsappInstances } = require('./whatsappInstanceService')
const {
  schedulePersistInboundMediaIfNeeded,
  tipoQualificaPersistencia,
} = require('./inboundMediaPersistenceService')

const MSG_SELECT =
  'id, conversa_id, company_id, whatsapp_instance_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'

const MESSAGES_PER_CHAT = Math.min(1000, Math.max(1, Number(process.env.OLD_MESSAGES_SYNC_MESSAGES_PER_CHAT) || 1000))
const MAX_CHATS = Math.max(1, Number(process.env.OLD_MESSAGES_SYNC_MAX_CHATS) || 5000)
const CHAT_DELAY_MS = Math.max(0, Number(process.env.OLD_MESSAGES_SYNC_DELAY_MS) || 120)

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '')
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value != null && typeof value !== 'object' && String(value).trim()) return String(value).trim()
  }
  return ''
}

function chatIdFromChat(chat) {
  if (!chat || typeof chat !== 'object') return ''
  return firstString(
    chat.id,
    chat.chatId,
    chat.chat_id,
    chat.jid,
    chat.remoteJid,
    chat.phone,
    chat.number,
    chat.contact?.id,
    chat.contact?.jid
  )
}

function isGroupChatId(chatId) {
  const raw = String(chatId || '').trim()
  return raw.endsWith('@g.us') || /^\d{5,15}-\d{8,15}$/.test(raw)
}

function isSkippableChatId(chatId) {
  const raw = String(chatId || '').trim().toLowerCase()
  if (!raw) return true
  return raw.includes('@broadcast') || raw.includes('status@broadcast') || raw.includes('@newsletter') || raw.endsWith('@lid')
}

function phoneFromChatId(chatId) {
  const raw = String(chatId || '').trim()
  if (!raw) return ''
  if (isGroupChatId(raw)) return raw.endsWith('@g.us') ? raw : `${raw}@g.us`
  const digits = digitsOnly(raw.replace(/@c\.us$/i, '').replace(/@s\.whatsapp\.net$/i, ''))
  return normalizePhoneBR(digits) || digits
}

function nameFromChat(chat) {
  return firstString(
    chat?.name,
    chat?.formattedName,
    chat?.chatName,
    chat?.pushname,
    chat?.pushName,
    chat?.notify,
    chat?.short,
    chat?.contact?.name,
    chat?.contact?.pushname
  )
}

function photoFromChat(chat) {
  return firstString(
    chat?.imgUrl,
    chat?.photo,
    chat?.profilePicture,
    chat?.profilePictureUrl,
    chat?.avatar,
    chat?.contact?.imgUrl,
    chat?.contact?.photo
  )
}

function messageTimestampToIso(message) {
  let ts = message?.timestamp ?? message?.momment ?? message?.t ?? message?.time ?? message?.date ?? message?.created_at
  const num = Number(ts)
  if (Number.isFinite(num) && num > 0) {
    const ms = num < 1e12 ? num * 1000 : num
    const date = new Date(ms)
    if (!Number.isNaN(date.getTime()) && date.getFullYear() >= 2020) return date.toISOString()
  }
  const parsed = ts ? new Date(ts) : null
  if (parsed && !Number.isNaN(parsed.getTime()) && parsed.getFullYear() >= 2020) return parsed.toISOString()
  return new Date().toISOString()
}

function messageIdFrom(message) {
  return firstString(
    message?.messageId,
    message?.zaapId,
    message?.id,
    message?.msgId,
    message?.message_id,
    message?.key?.id
  )
}

function normalizeType(message) {
  let type = String(message?.type || message?.msgType || message?.messageType || 'text').toLowerCase()
  if (type === 'chat' || type === 'receivedcallback' || type === 'receivedcall') type = 'text'
  if (type === 'ptt') type = 'voice'
  if (message?.reaction && typeof message.reaction === 'object') type = 'reaction'
  if (message?.location && typeof message.location === 'object') type = 'location'
  if (message?.contact && typeof message.contact === 'object') type = 'contact'
  if (type === 'text') {
    if (message?.image || message?.imageUrl) type = 'image'
    else if (message?.audio || message?.audioUrl) type = 'audio'
    else if (message?.video || message?.videoUrl || message?.ptv) type = 'video'
    else if (message?.document || message?.documentUrl || message?.file) type = 'document'
    else if (message?.sticker || message?.stickerUrl) type = 'sticker'
  }
  return type
}

function urlFrom(...values) {
  const value = firstString(...values)
  return value && /^https?:\/\//i.test(value) ? value : ''
}

function normalizeOldMessage(raw, { isGroup }) {
  if (!raw || typeof raw !== 'object') return null
  const whatsappId = messageIdFrom(raw)
  if (!whatsappId) return null

  const fromMe = Boolean(raw.fromMe ?? raw.key?.fromMe ?? raw.from_me)
  const type = normalizeType(raw)
  const rawMessage =
    raw.message?.body ??
    raw.message?.text ??
    raw.text?.message ??
    raw.body ??
    raw.caption ??
    raw.text ??
    raw.message ??
    ''

  let texto = typeof rawMessage === 'object' ? '' : String(rawMessage || '').trim()
  const imageUrl = urlFrom(raw.image?.imageUrl, raw.image?.url, raw.imageUrl, raw.message?.imageUrl, raw.image)
  const documentUrl = urlFrom(raw.document?.documentUrl, raw.document?.url, raw.documentUrl, raw.file?.url, raw.fileUrl)
  const audioUrl = urlFrom(raw.audio?.audioUrl, raw.audio?.url, raw.audioUrl, raw.message?.audioUrl)
  const videoUrl = urlFrom(raw.video?.videoUrl, raw.video?.url, raw.videoUrl, raw.ptv?.url)
  const stickerUrl = urlFrom(raw.sticker?.stickerUrl, raw.sticker?.url, raw.stickerUrl)
  let locationUrl = urlFrom(raw.location?.url, raw.location?.thumbnailUrl)

  if (type === 'reaction') {
    const val = raw.reaction?.value ?? raw.reaction?.emoji ?? ''
    texto = val ? `Reacao: ${String(val).trim()}` : 'Reacao'
  } else if (type === 'location') {
    const loc = raw.location || {}
    const lat = loc.latitude ?? loc.lat
    const lng = loc.longitude ?? loc.lng
    const latNum = Number(lat)
    const lngNum = Number(lng)
    if (!locationUrl && lat != null && lng != null && !Number.isNaN(latNum) && !Number.isNaN(lngNum)) {
      locationUrl = `https://www.google.com/maps?q=${latNum},${lngNum}`
    }
    const parts = [loc.name, loc.address].filter(Boolean).map((s) => String(s).trim())
    texto = parts.length ? parts.join(' - ') : (locationUrl || '(localizacao)')
  } else if (type === 'contact') {
    const contact = raw.contact || {}
    texto = firstString(contact.displayName, contact.formattedName, contact.name, contact.vCard, rawMessage) || '(contato)'
  }

  if (!texto) {
    if (imageUrl) texto = raw.caption || '(imagem)'
    else if (documentUrl) texto = raw.caption || '(arquivo)'
    else if (audioUrl) texto = '(audio)'
    else if (videoUrl) texto = raw.caption || '(video)'
    else if (stickerUrl) texto = '(sticker)'
    else texto = '(mensagem)'
  }

  const insert = {
    texto: String(texto || '').trim(),
    direcao: fromMe ? 'out' : 'in',
    whatsapp_id: String(whatsappId).trim(),
    criado_em: messageTimestampToIso(raw),
  }

  const fileName = firstString(raw.document?.fileName, raw.document?.title, raw.fileName, raw.filename, raw.file?.name)
  if (type === 'image' && imageUrl) {
    insert.tipo = 'imagem'
    insert.url = imageUrl
    insert.nome_arquivo = fileName || 'imagem.jpg'
  } else if ((type === 'document' || type === 'file') && documentUrl) {
    insert.tipo = 'arquivo'
    insert.url = documentUrl
    insert.nome_arquivo = fileName || 'arquivo'
  } else if ((type === 'audio' || type === 'voice') && audioUrl) {
    insert.tipo = type === 'voice' ? 'voice' : 'audio'
    insert.url = audioUrl
    insert.nome_arquivo = fileName || (type === 'voice' ? 'voice.ogg' : 'audio')
  } else if (type === 'video' && videoUrl) {
    insert.tipo = 'video'
    insert.url = videoUrl
    insert.nome_arquivo = fileName || 'video'
  } else if (type === 'sticker' && stickerUrl) {
    insert.tipo = 'sticker'
    insert.url = stickerUrl
    insert.nome_arquivo = fileName || 'sticker.webp'
  } else if (type === 'location') {
    insert.tipo = 'location'
    if (locationUrl) insert.url = locationUrl
    insert.nome_arquivo = 'localizacao'
    const loc = raw.location || {}
    if (loc.latitude != null || loc.lat != null || loc.longitude != null || loc.lng != null) {
      insert.location_meta = {
        latitude: loc.latitude ?? loc.lat ?? null,
        longitude: loc.longitude ?? loc.lng ?? null,
        name: loc.name ?? null,
        address: loc.address ?? null,
      }
    }
  } else if (type === 'contact') {
    insert.tipo = 'contact'
    const contact = raw.contact || {}
    insert.contact_meta = {
      nome: contact.displayName ?? contact.formattedName ?? contact.name ?? null,
      telefone: digitsOnly(contact.phone ?? contact.telephone ?? ''),
      vcard: contact.vCard ?? contact.vcard ?? null,
    }
  }

  if (isGroup && !fromMe) {
    const participant = digitsOnly(raw.participantPhone ?? raw.participant ?? raw.author ?? raw.key?.participant ?? '')
    if (participant) insert.remetente_telefone = normalizePhoneBR(participant) || participant
    const senderName = firstString(raw.senderName, raw.notifyName, raw.pushName, raw.sender?.name)
    if (senderName) insert.remetente_nome = senderName
  }

  return { insert, fromMe }
}

async function selectExistingMessage(company_id, whatsapp_instance_id, whatsapp_id, allowLegacyNull = false) {
  let query = supabase
    .from('mensagens')
    .select('id')
    .eq('company_id', company_id)
    .eq('whatsapp_id', whatsapp_id)
    .limit(1)

  query = whatsapp_instance_id
    ? query.eq('whatsapp_instance_id', whatsapp_instance_id)
    : query.is('whatsapp_instance_id', null)

  const { data } = await query.maybeSingle()
  if (data?.id) return data

  if (whatsapp_instance_id && allowLegacyNull) {
    const { data: legacy } = await supabase
      .from('mensagens')
      .select('id')
      .eq('company_id', company_id)
      .eq('whatsapp_id', whatsapp_id)
      .is('whatsapp_instance_id', null)
      .limit(1)
      .maybeSingle()
    if (legacy?.id) return legacy
  }

  return null
}

async function createConversationForChat({ company_id, whatsapp_instance_id, whatsapp_instance_is_default, chat, chatId, isGroup }) {
  const phone = phoneFromChatId(chatId)
  if (!phone) return null

  const nome = nameFromChat(chat)
  const foto = photoFromChat(chat)
  let cliente_id = null

  if (!isGroup) {
    const cliente = await getOrCreateCliente(supabase, company_id, phone, {
      nome: nome || phone,
      nomeSource: 'old_messages_sync',
      pushname: nome || undefined,
      foto_perfil: foto || undefined,
    })
    cliente_id = cliente?.cliente_id || null
  }

  const found = await findOrCreateConversation(supabase, {
    company_id,
    phone,
    cliente_id,
    isGroup,
    nomeGrupo: isGroup ? (nome || phone) : null,
    chatPhoto: foto || null,
    whatsapp_instance_id,
    whatsapp_instance_is_default,
    logPrefix: '[oldMessagesSync]',
    initial_status_atendimento: 'fechada',
  })

  if (!found?.conversa?.id) return null

  if (found.created) {
    await supabase
      .from('conversas')
      .update({ lida: true, status_atendimento: 'fechada' })
      .eq('company_id', company_id)
      .eq('id', found.conversa.id)
  }

  return found
}

async function updateConversationActivity(company_id, conversa_id, current, lastImportedAt) {
  if (!lastImportedAt) return
  const currentTs = current ? new Date(current).getTime() : 0
  const nextTs = new Date(lastImportedAt).getTime()
  if (!Number.isFinite(nextTs) || nextTs <= currentTs) return
  await supabase
    .from('conversas')
    .update({ ultima_atividade: lastImportedAt })
    .eq('company_id', company_id)
    .eq('id', conversa_id)
}

function prepareRawMessages(rawMessages, { isGroup }) {
  const ordered = Array.isArray(rawMessages)
    ? [...rawMessages].sort((a, b) => new Date(messageTimestampToIso(a)).getTime() - new Date(messageTimestampToIso(b)).getTime())
    : []

  const prepared = []
  let invalidSkipped = 0
  for (const raw of ordered) {
    const normalized = normalizeOldMessage(raw, { isGroup })
    if (!normalized?.insert?.whatsapp_id || !normalized.insert.texto) {
      invalidSkipped += 1
      continue
    }
    prepared.push(normalized)
  }

  return { ordered, prepared, invalidSkipped }
}

async function hasAnyNewMessage(company_id, whatsapp_instance_id, prepared, allowLegacyNull) {
  for (const normalized of prepared || []) {
    const exists = await selectExistingMessage(
      company_id,
      whatsapp_instance_id,
      normalized.insert.whatsapp_id,
      allowLegacyNull === true
    )
    if (!exists?.id) return true
  }
  return false
}

async function insertPreparedMessagesForConversation(ctx) {
  const {
    company_id,
    whatsapp_instance_id,
    whatsapp_instance_is_default,
    conversa,
    prepared,
    messagesFetched,
    initialMessagesSkipped = 0,
    io,
    shouldCancel,
  } = ctx

  const isCancelled = async () => shouldCancel ? await shouldCancel() : false
  let messagesInserted = 0
  let messagesSkipped = initialMessagesSkipped
  let lastImportedAt = null

  for (const normalized of prepared || []) {
    if (await isCancelled()) {
      await updateConversationActivity(company_id, conversa.id, conversa.ultima_atividade, lastImportedAt)
      return {
        cancelled: true,
        messagesFetched,
        messagesInserted,
        messagesSkipped,
      }
    }

    const exists = await selectExistingMessage(
      company_id,
      whatsapp_instance_id,
      normalized.insert.whatsapp_id,
      whatsapp_instance_is_default === true
    )
    if (exists?.id) {
      messagesSkipped += 1
      continue
    }

    const insertMsg = {
      ...normalized.insert,
      conversa_id: conversa.id,
      company_id,
      ...(whatsapp_instance_id ? { whatsapp_instance_id } : {}),
    }

    const { data: inserted, error } = await supabase
      .from('mensagens')
      .insert(insertMsg)
      .select(MSG_SELECT)
      .single()

    if (error) {
      if (String(error.code || '') === '23505' || /duplicate|unique/i.test(String(error.message || ''))) {
        messagesSkipped += 1
        continue
      }
      throw error
    }

    messagesInserted += 1
    lastImportedAt = insertMsg.criado_em

    if (inserted?.id && inserted.url && String(inserted.url).startsWith('https://') && tipoQualificaPersistencia(inserted.tipo)) {
      schedulePersistInboundMediaIfNeeded({
        supabase,
        io,
        company_id,
        mensagem_id: inserted.id,
        fromMe: !!normalized.fromMe,
        departamento_id: null,
      })
    }
  }

  await updateConversationActivity(company_id, conversa.id, conversa.ultima_atividade, lastImportedAt)

  return {
    messagesFetched,
    messagesInserted,
    messagesSkipped,
  }
}

async function importMessagesForChat(ctx) {
  const { company_id, whatsapp_instance_id, whatsapp_instance_is_default, provider, chat, io } = ctx
  const shouldCancel = typeof ctx.shouldCancel === 'function' ? ctx.shouldCancel : null
  const cancelResult = {
    skippedChat: false,
    cancelled: true,
    messagesFetched: 0,
    messagesInserted: 0,
    messagesSkipped: 0,
  }
  const isCancelled = async () => shouldCancel ? await shouldCancel() : false
  const chatId = chatIdFromChat(chat)
  if (isSkippableChatId(chatId)) return { skippedChat: true, messagesFetched: 0, messagesInserted: 0, messagesSkipped: 0 }
  if (await isCancelled()) return cancelResult

  const isGroup = isGroupChatId(chatId)
  const rawMessages = await provider.getChatMessages(chatId, MESSAGES_PER_CHAT, null, {
    companyId: company_id,
    whatsappInstanceId: whatsapp_instance_id || undefined,
  }).catch(() => [])
  const { ordered, prepared, invalidSkipped } = prepareRawMessages(rawMessages, { isGroup })
  if (ordered.length === 0 || prepared.length === 0) {
    return { skippedChat: true, messagesFetched: ordered.length, messagesInserted: 0, messagesSkipped: invalidSkipped }
  }
  if (await isCancelled()) return cancelResult

  const hasNew = await hasAnyNewMessage(company_id, whatsapp_instance_id, prepared, whatsapp_instance_is_default === true)
  if (!hasNew) {
    return { skippedChat: true, messagesFetched: ordered.length, messagesInserted: 0, messagesSkipped: invalidSkipped + prepared.length }
  }

  const found = await createConversationForChat({
    company_id,
    whatsapp_instance_id,
    whatsapp_instance_is_default,
    chat,
    chatId,
    isGroup,
  })
  if (!found?.conversa?.id) return { skippedChat: true, messagesFetched: ordered.length, messagesInserted: 0, messagesSkipped: invalidSkipped }
  if (await isCancelled()) return cancelResult

  const insertedStats = await insertPreparedMessagesForConversation({
    company_id,
    whatsapp_instance_id,
    whatsapp_instance_is_default,
    conversa: found.conversa,
    prepared,
    messagesFetched: ordered.length,
    initialMessagesSkipped: invalidSkipped,
    io,
    shouldCancel,
  })

  return {
    skippedChat: false,
    cancelled: insertedStats.cancelled === true,
    conversationCreated: !!found.created,
    messagesFetched: insertedStats.messagesFetched || 0,
    messagesInserted: insertedStats.messagesInserted || 0,
    messagesSkipped: insertedStats.messagesSkipped || 0,
  }
}

async function syncOldMessagesForCompany(company_id, opts = {}) {
  const provider = getProvider()
  const shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : null
  const isCancelled = async () => shouldCancel ? await shouldCancel() : false
  if (!provider?.getChats || !provider?.getChatMessages) {
    return { ok: false, error: 'Provider nao suporta leitura de chats/mensagens.' }
  }

  const instancesResult = await listWhatsappInstances(company_id)
  if (instancesResult.error) return { ok: false, error: instancesResult.error }
  const instances = (instancesResult.instances || []).filter((instance) => instance && instance.ativo !== false)

  const stats = {
    ok: true,
    messagesPerChat: MESSAGES_PER_CHAT,
    maxChats: MAX_CHATS,
    instancesProcessed: 0,
    chatsFetched: 0,
    chatsProcessed: 0,
    chatsSkipped: 0,
    conversationsCreated: 0,
    messagesFetched: 0,
    messagesInserted: 0,
    messagesSkipped: 0,
    errors: [],
  }

  if (instances.length === 0) {
    return { ...stats, ok: false, error: 'Nenhuma instancia WhatsApp ativa encontrada.' }
  }

  const io = opts.io || null
  const markCancelled = () => ({
    ...stats,
    ok: false,
    cancelled: true,
    error: 'Sincronizacao de mensagens antigas cancelada.',
  })

  for (const instance of instances) {
    if (await isCancelled()) return markCancelled()

    const whatsappInstanceId = instance.id || null
    const chats = await provider.getChats({
      companyId: company_id,
      whatsappInstanceId: whatsappInstanceId || undefined,
    }).catch((e) => {
      stats.errors.push(`Falha ao listar chats: ${String(e?.message || e).slice(0, 120)}`)
      return []
    })

    stats.instancesProcessed += 1
    stats.chatsFetched += Array.isArray(chats) ? chats.length : 0

    for (const chat of (Array.isArray(chats) ? chats.slice(0, MAX_CHATS) : [])) {
      if (await isCancelled()) return markCancelled()

      try {
        const result = await importMessagesForChat({
          company_id,
          whatsapp_instance_id: whatsappInstanceId,
          whatsapp_instance_is_default: instance.is_default === true,
          provider,
          chat,
          io,
          shouldCancel,
        })
        if (result.skippedChat) stats.chatsSkipped += 1
        else stats.chatsProcessed += 1
        if (result.conversationCreated) stats.conversationsCreated += 1
        stats.messagesFetched += result.messagesFetched || 0
        stats.messagesInserted += result.messagesInserted || 0
        stats.messagesSkipped += result.messagesSkipped || 0
        if (result.cancelled) return markCancelled()
      } catch (e) {
        stats.errors.push(String(e?.message || e).slice(0, 120))
      }
      if (await isCancelled()) return markCancelled()
      await sleep(CHAT_DELAY_MS)
    }
  }

  return stats
}

async function resolveOldMessagesWhatsappInstanceId(company_id, conversa) {
  const current = Number(conversa?.whatsapp_instance_id)
  if (Number.isFinite(current) && current > 0) return current
  const instancesResult = await listWhatsappInstances(company_id)
  if (instancesResult.error) return null
  const instances = (instancesResult.instances || []).filter((instance) => instance && instance.ativo !== false)
  const preferred = instances.find((instance) => instance.is_default === true) || instances[0] || null
  const id = Number(preferred?.id)
  return Number.isFinite(id) && id > 0 ? id : null
}

function resolveChatIdForConversation(conversa) {
  const telefone = String(conversa?.telefone || '').trim()
  const cliente = Array.isArray(conversa?.clientes) ? conversa.clientes[0] : conversa?.clientes
  const clienteTelefone = String(cliente?.telefone || '').trim()
  if (telefone && !telefone.toLowerCase().startsWith('lid:')) return telefone
  if (clienteTelefone && !clienteTelefone.toLowerCase().startsWith('lid:')) return clienteTelefone
  return ''
}

async function syncOldMessagesForConversation(company_id, conversa_id, opts = {}) {
  const provider = getProvider()
  if (!provider?.getChatMessages) {
    return { ok: false, error: 'Provider nao suporta leitura de mensagens do chat.' }
  }

  const { data: conversa, error } = await supabase
    .from('conversas')
    .select(`
      id,
      company_id,
      telefone,
      whatsapp_instance_id,
      ultima_atividade,
      tipo,
      nome_grupo,
      clientes!conversas_cliente_fk ( id, telefone, company_id )
    `)
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!conversa?.id) return { ok: false, error: 'Conversa nao encontrada.' }
  if (conversa.tipo === 'grupo' || isGroupChatId(conversa.telefone)) {
    return { ok: false, error: 'Use esta acao apenas em conversas individuais.' }
  }

  const chatId = resolveChatIdForConversation(conversa)
  if (!chatId) {
    return { ok: false, error: 'Conversa sem telefone valido para buscar historico.' }
  }

  const whatsappInstanceId = await resolveOldMessagesWhatsappInstanceId(company_id, conversa)
  const rawMessages = await provider.getChatMessages(chatId, MESSAGES_PER_CHAT, null, {
    companyId: company_id,
    whatsappInstanceId: whatsappInstanceId || undefined,
  }).catch(() => [])

  const { ordered, prepared, invalidSkipped } = prepareRawMessages(rawMessages, { isGroup: false })
  if (ordered.length === 0 || prepared.length === 0) {
    return {
      ok: true,
      conversa_id: Number(conversa.id),
      messagesPerChat: MESSAGES_PER_CHAT,
      messagesFetched: ordered.length,
      messagesInserted: 0,
      messagesSkipped: invalidSkipped,
      empty: true,
      message: 'Nenhuma mensagem antiga encontrada para este contato.',
    }
  }

  const insertedStats = await insertPreparedMessagesForConversation({
    company_id,
    whatsapp_instance_id: whatsappInstanceId,
    whatsapp_instance_is_default: !conversa.whatsapp_instance_id && !!whatsappInstanceId,
    conversa,
    prepared,
    messagesFetched: ordered.length,
    initialMessagesSkipped: invalidSkipped,
    io: opts.io || null,
    shouldCancel: null,
  })

  return {
    ok: true,
    conversa_id: Number(conversa.id),
    messagesPerChat: MESSAGES_PER_CHAT,
    messagesFetched: insertedStats.messagesFetched || 0,
    messagesInserted: insertedStats.messagesInserted || 0,
    messagesSkipped: insertedStats.messagesSkipped || 0,
    empty: (insertedStats.messagesInserted || 0) === 0,
    message: (insertedStats.messagesInserted || 0) > 0
      ? 'Mensagens antigas carregadas para este contato.'
      : 'Nenhuma mensagem antiga encontrada para este contato.',
  }
}

module.exports = {
  syncOldMessagesForCompany,
  syncOldMessagesForConversation,
  normalizeOldMessage,
}
