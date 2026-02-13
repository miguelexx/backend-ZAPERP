/**
 * Webhook Z-API: recebe mensagens do Z-API (POST /webhooks/zapi).
 * TUDO que a Z-API enviar para esta URL deve chegar no sistema: texto, imagem, áudio,
 * vídeo, documento, figurinha, reação, localização, contato, PTV, templates, botões, listas.
 * Suporta conversas individuais e de GRUPO. Mensagens enviadas por nós (fromMe) não são
 * gravadas de novo (evita eco); apenas atualiza ultima_atividade.
 */

const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { syncContactFromZapi } = require('../services/zapiSyncContact')
const { normalizePhoneBR, possiblePhonesBR, normalizeGroupIdForStorage } = require('../helpers/phoneHelper')

const COMPANY_ID = Number(process.env.WEBHOOK_COMPANY_ID || 1)

function applyCompanyFilter(q, company_id) {
  const cid = Number(company_id) || 1
  if (cid === 1) return q.or('company_id.eq.1,company_id.is.null')
  return q.eq('company_id', cid)
}

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
 * Em alguns eventos (principalmente fromMe em multi-device), a Z-API pode preencher `chatId`/`phone`
 * com um identificador (ex.: "lid") que não é o telefone do contato.
 * Esta função escolhe o melhor candidato que realmente pareça um número/JID.
 */
function pickBestPhone(payload, { fromMe } = {}) {
  // Importante: NÃO usar senderName/chatName como candidato de telefone.
  // Em mensagens fromMe, `payload.phone`/`senderPhone` podem ser o NOSSO número (instância).
  const clean = (v) => (v == null ? '' : String(v).trim())
  const getDigits = (v) => clean(v).replace(/\D/g, '')
  const tail11 = (d) => String(d || '').replace(/\D/g, '').slice(-11)

  // tenta descobrir "meu" telefone para não confundir em fromMe=true
  const myDigits =
    getDigits(payload.senderPhone) ||
    getDigits(payload.ownerPhone) ||
    getDigits(payload.instancePhone) ||
    getDigits(payload.phoneNumber) ||
    getDigits(payload.me?.phone) ||
    ''
  const myTail = tail11(myDigits)

  // candidates mais prováveis do "chat" (destinatário) vêm primeiro
  const candidates = [
    payload.key?.remoteJid,
    payload.remoteJid,
    payload.chat?.id,
    payload.chatId,
    payload.to,
    payload.toPhone,
    payload.recipientPhone,
    payload.recipient,
    payload.destination,
    payload.phone,
    // campos de "from" só ajudam quando NÃO é fromMe
    ...(fromMe ? [] : [payload.senderPhone, payload.from, payload.author, payload.participantPhone, payload.participant]),
  ]
    .filter((v) => v != null)
    .map(clean)
    .filter(Boolean)

  for (const c of candidates) {
    // grupo: preserve o JID completo
    if (c.endsWith('@g.us')) return c

    const digits = c.replace(/\D/g, '')
    if (!looksLikeBRPhoneDigits(digits)) continue

    // fromMe: se o candidato bate com meu número (tail), ignore e tente o próximo
    if (fromMe && myTail && tail11(digits) === myTail) continue

    return digits
  }

  // Se nada parece telefone/JID real, não inventar (evita salvar IDs/timestamps como telefone)
  return ''
}

function extractMessage(payload) {
  if (!payload || typeof payload !== 'object') {
    return { phone: '', texto: '(vazio)', fromMe: false, messageId: null, criado_em: new Date().toISOString(), type: 'text', imageUrl: null, documentUrl: null, audioUrl: null, videoUrl: null, stickerUrl: null, locationUrl: null, fileName: null, isGroup: false, participantPhone: null, senderName: null, nomeGrupo: null, senderPhoto: null, chatPhoto: null }
  }
  const fromMe = Boolean(payload.fromMe ?? payload.key?.fromMe)
  // Grupo x individual: se for grupo, a chave da conversa é SEMPRE o id do grupo (nunca o participante).
  const isGroup = isGroupPayload(payload)
  const groupChatId = isGroup ? pickGroupChatId(payload) : ''
  const phone = isGroup ? groupChatId : pickBestPhone(payload, { fromMe })
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

  const participantPhone = payload.participantPhone ?? payload.participant ?? payload.author ?? payload.key?.participant ?? null
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
    texto = parts.length ? parts.join(' • ') : (loc.url || '(localização)')
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

  return {
    // IMPORTANTE:
    // - Em alguns bancos, conversas.telefone é varchar(20). IDs de grupo como "120363...-group" estouram esse limite.
    // - Para garantir que TODAS as mensagens entrem no sistema, normalizamos grupos para apenas dígitos.
    // Se o payload indicou grupo mas não conseguimos achar o ID do grupo, NÃO roteia para privado.
    phone: isGroup ? (groupChatId ? normalizeGroupIdForStorage(groupChatId) : '') : normalizePhoneBR(phone),
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
    participantPhone: participantPhone ? String(participantPhone).replace(/\D/g, '') : null,
    senderName: senderName ? String(senderName).trim() : null,
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
  return [body]
}

/** GET /webhooks/zapi — teste de conectividade; mostra a URL que deve ser configurada no painel Z-API. */
exports.testarZapi = (req, res) => {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`
  const url = `${base.replace(/\/$/, '')}/webhooks/zapi`
  return res.status(200).json({
    ok: true,
    message: 'Configure no painel Z-API (Opções → Editar instância) o webhook "Recebido" com a URL abaixo.',
    url,
    metodo: 'POST'
  })
}

exports.receberZapi = async (req, res) => {
  try {
    const body = req.body || {}
    console.log('[Z-API] Webhook chamado:', body.type || '(sem type)', 'phone=' + (body.phone || '(vazio)'), 'fromMe=' + body.fromMe, 'isGroup=' + body.isGroup)

    const payloads = getPayloads(body)
    let lastResult = { ok: true }

    for (const payload of payloads) {
      // DeliveryCallback (on-message-send): retorno do envio, não é uma mensagem para salvar.
      const payloadType = String(payload?.type ?? payload?.event ?? payload?.status ?? '').toLowerCase()
      if (payloadType === 'deliverycallback') {
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
            io.to(`empresa_${msg.company_id}`).emit('status_mensagem', { mensagem_id: msg.id, conversa_id: msg.conversa_id, status: statusNorm })
            io.to(`conversa_${msg.conversa_id}`).emit('status_mensagem', { mensagem_id: msg.id, conversa_id: msg.conversa_id, status: statusNorm })
          }
        }

        lastResult = { ok: true, delivery: true, messageId: String(messageId) }
        continue
      }

      const extracted = extractMessage(payload)
      const {
        phone,
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
        participantPhone,
        senderName,
        nomeGrupo,
        senderPhoto,
        chatPhoto
      } = extracted

      if (!phone) {
        console.warn('⚠️ Z-API webhook: Sem phone no payload. Keys:', Object.keys(payload || {}).join(', '))
        continue
      }
      if (!isGroup) {
        const d = String(phone || '').replace(/\D/g, '')
        if (!(d.startsWith('55') && (d.length === 12 || d.length === 13))) {
          console.warn('⚠️ Z-API webhook: phone não parece BR (possível LID). Usado=', phone, 'keys=', Object.keys(payload || {}).slice(0, 12).join(','))
        }
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
      // 1) Cliente só para conversa individual (cria se não existir)
      const phones = possiblePhonesBR(phone)
      let cliQuery = supabase.from('clientes').select('id, telefone, nome')
      if (phones.length > 0) cliQuery = cliQuery.in('telefone', phones)
      else cliQuery = cliQuery.eq('telefone', phone)
      cliQuery = applyCompanyFilter(cliQuery, company_id)
      const { data: cliRows, error: errCli } = await cliQuery.order('id', { ascending: true }).limit(5)
      const clienteExistente = Array.isArray(cliRows) && cliRows.length > 0 ? cliRows[0] : null

      if (errCli) {
        console.error('Erro ao buscar cliente Z-API:', errCli)
        return res.status(500).json({ error: 'Erro ao buscar cliente' })
      }

      if (clienteExistente?.id) {
        cliente_id = clienteExistente.id
        // Atualizar imediatamente com dados do payload (nome/foto) SEM poluir contatos quando fromMe=true.
        // - fromMe=false: senderName/chatName tendem a ser o nome do contato.
        // - fromMe=true: senderName costuma ser o NOSSO nome; priorizar chatName (nome do chat) e nunca sobrescrever foto com senderPhoto.
        const nomePayloadRaw = fromMe
          ? (payload.chatName ?? payload.chat?.name ?? null)
          : (payload.senderName ?? payload.chatName ?? payload.chat?.name ?? null)
        const nomePayload = nomePayloadRaw ? String(nomePayloadRaw).trim() : null
        const updates = {}
        // Se não veio nome, salva o número (somente se estiver vazio no banco) para evitar nome NULL.
        if (nomePayload) updates.nome = nomePayload
        else if (!clienteExistente.nome || !String(clienteExistente.nome).trim()) updates.nome = phone
        if (!fromMe && senderPhoto) updates.foto_perfil = senderPhoto
        if (Object.keys(updates).length > 0) {
          // update por id (id é globalmente único) — permite também company_id null (empresa 1)
          await supabase.from('clientes').update(updates).eq('id', cliente_id)
        }
        // Sync Z-API em background (será emitido após salvar mensagem, com conversa_id)
        pendingContactSync = { phone, cliente_id }
      } else {
        // Novo cliente: inserir já com dados do payload; sync em background depois
        const fromPayloadRaw = fromMe
          ? (payload.chatName ?? payload.chat?.name ?? null)
          : (payload.senderName ?? payload.chatName ?? payload.chat?.name ?? null)
        const fromPayload = fromPayloadRaw ? String(fromPayloadRaw).trim() : null

        const { data: novoCliente, error: errNovoCli } = await supabase
          .from('clientes')
          .insert({
            telefone: phone,
            nome: fromPayload || phone || null,
            observacoes: null,
            company_id,
            ...(!fromMe && senderPhoto ? { foto_perfil: senderPhoto } : {})
          })
          .select('id')
          .single()

        if (errNovoCli) {
          // Se bateu UNIQUE (cliente já existe), apenas busca e segue (evita 500 em webhook)
          const isDuplicate = String(errNovoCli.code || '') === '23505' || String(errNovoCli.message || '').includes('unique') || String(errNovoCli.message || '').includes('duplicate')
          if (isDuplicate) {
            const phones2 = possiblePhonesBR(phone)
            let q2 = supabase.from('clientes').select('id')
            if (phones2.length > 0) q2 = q2.in('telefone', phones2)
            else q2 = q2.eq('telefone', phone)
            q2 = applyCompanyFilter(q2, company_id)
            const found = await q2.order('id', { ascending: true }).limit(1)
            if (Array.isArray(found.data) && found.data[0]?.id) {
              cliente_id = found.data[0].id
              pendingContactSync = { phone, cliente_id }
              // continua o fluxo sem erro
            }
          }

          const isPushnameColumn = String(errNovoCli.message || '').includes('pushname') || String(errNovoCli.message || '').includes('does not exist')
          if (isPushnameColumn) {
            const fallbackInsert = await supabase
              .from('clientes')
              .insert({
                telefone: phone,
                nome: fromPayload || phone || null,
                observacoes: null,
                company_id,
                ...(!fromMe && senderPhoto ? { foto_perfil: senderPhoto } : {})
              })
              .select('id')
              .single()
            if (!fallbackInsert.error) cliente_id = fallbackInsert.data.id
          }
          if (!cliente_id) {
            console.error('Erro ao criar cliente Z-API:', errNovoCli)
            return res.status(500).json({ error: 'Erro ao criar cliente' })
          }
        } else {
          cliente_id = novoCliente.id
        }
        pendingContactSync = { phone, cliente_id: cliente_id }
      }
    }

    // 2) Conversa (busca aberta ou cria). Grupos: por telefone (remoteJid), tipo grupo, cliente_id null
    let conversa_id = null
    let departamento_id = null
    const convPhones = !isGroup ? possiblePhonesBR(phone) : []
    let conversaQuery = supabase
      .from('conversas')
      .select('id, departamento_id, telefone')
      .eq('company_id', company_id)
      .neq('status_atendimento', 'fechada')
      .order('id', { ascending: false })
      .limit(5)

    // Evita conversas duplicadas por variação 12/13 dígitos (com/sem 9 após DDD)
    if (isGroup) {
      conversaQuery = conversaQuery.eq('telefone', phone)
    } else if (convPhones.length > 0) {
      conversaQuery = conversaQuery.in('telefone', convPhones)
    } else {
      conversaQuery = conversaQuery.eq('telefone', phone)
    }

    if (!isGroup) conversaQuery.eq('cliente_id', cliente_id)
    const { data: conversasAbertas, error: errConv } = await conversaQuery

    if (errConv) {
      console.error('Erro ao buscar conversa Z-API:', errConv)
      return res.status(500).json({ error: 'Erro ao buscar conversa' })
    }

    let isNewConversation = false
    if (conversasAbertas && conversasAbertas.length > 0) {
      // Se houver MAIS DE UMA conversa aberta para o mesmo cliente (variação 12/13 dígitos),
      // unificar tudo numa conversa só (profissional: 1 chat por contato).
      if (!isGroup && Array.isArray(conversasAbertas) && conversasAbertas.length > 1) {
        const canonical = conversasAbertas[0] // mais recente (order id desc)
        const others = conversasAbertas.slice(1)
        const otherIds = others.map((c) => c.id).filter(Boolean)
        if (canonical?.id && otherIds.length > 0) {
          try {
            // 1) Mover dependências para a conversa canônica
            await supabase.from('mensagens').update({ conversa_id: canonical.id }).in('conversa_id', otherIds)
            await supabase.from('conversa_tags').update({ conversa_id: canonical.id }).in('conversa_id', otherIds)
            await supabase.from('atendimentos').update({ conversa_id: canonical.id }).in('conversa_id', otherIds)
            await supabase.from('historico_atendimentos').update({ conversa_id: canonical.id }).in('conversa_id', otherIds)
            await supabase.from('conversa_unreads').update({ conversa_id: canonical.id }).in('conversa_id', otherIds)

            // 2) Apagar conversas antigas (se falhar por FK/perm, fecha para não aparecer)
            const del = await supabase.from('conversas').delete().in('id', otherIds).eq('company_id', company_id)
            if (del.error) {
              await supabase
                .from('conversas')
                .update({ status_atendimento: 'fechada', lida: true })
                .in('id', otherIds)
                .eq('company_id', company_id)
            }
            console.log('🧹 Conversas unificadas (12/13 dígitos):', { canonical: canonical.id, merged: otherIds.length })
          } catch (e) {
            console.warn('⚠️ Falha ao unificar conversas duplicadas:', e?.message || e)
          }
        }
      }

      // Preferir conversa cujo telefone bate exatamente com o phone do evento; senão pega a mais recente
      const picked =
        (!isGroup && convPhones.length > 0
          ? (conversasAbertas.find((c) => String(c.telefone || '') === String(phone)) || conversasAbertas[0])
          : conversasAbertas[0])
      conversa_id = picked.id
      departamento_id = picked.departamento_id ?? null
      // Atualiza foto do grupo quando disponível no payload
      if (isGroup && chatPhoto) {
        await supabase
          .from('conversas')
          .update({ foto_grupo: chatPhoto })
          .eq('id', conversa_id)
          .eq('company_id', company_id)
      }
    } else {
      const insertConv = {
        telefone: phone,
        lida: false,
        status_atendimento: 'aberta',
        company_id,
        ultima_atividade: new Date().toISOString()
      }
      if (isGroup) {
        insertConv.tipo = 'grupo'
        insertConv.nome_grupo = nomeGrupo || null
        insertConv.cliente_id = null
        if (chatPhoto) insertConv.foto_grupo = chatPhoto
      } else {
        insertConv.cliente_id = cliente_id
      }
      let { data: novaConversa, error: errNovaConv } = await supabase
        .from('conversas')
        .insert(insertConv)
        .select('id, departamento_id')
        .single()

      if (errNovaConv) {
        const missingColumn = String(errNovaConv.message || '').includes('ultima_atividade') || String(errNovaConv.code || '') === 'PGRST204'
        let isDuplicate = String(errNovaConv.code || '') === '23505' || String(errNovaConv.message || '').includes('unique') || String(errNovaConv.message || '').includes('duplicate')

        if (missingColumn) {
          delete insertConv.ultima_atividade
          const retry = await supabase.from('conversas').insert(insertConv).select('id, departamento_id').single()
          if (retry.error && String(retry.error.code || '') !== '23505') {
            console.error('Erro ao criar conversa Z-API (retry):', retry.error)
            return res.status(500).json({ error: 'Erro ao criar conversa' })
          }
          if (!retry.error) {
            novaConversa = retry.data
            errNovaConv = null
          } else {
            isDuplicate = true
          }
          if (errNovaConv && !isDuplicate) console.warn('⚠️ Coluna ultima_atividade não existe em conversas. Execute backend/supabase/RUN_IN_SUPABASE.sql no Supabase.')
        }
        if (isDuplicate || (errNovaConv && (String(errNovaConv.code || '') === '23505'))) {
          let q = supabase
            .from('conversas')
            .select('id, departamento_id')
            .eq('company_id', company_id)
            .neq('status_atendimento', 'fechada')
            .order('id', { ascending: false })
            .limit(1)
          if (isGroup) q = q.eq('telefone', phone)
          else if (convPhones.length > 0) q = q.in('telefone', convPhones)
          else q = q.eq('telefone', phone)
          if (!isGroup) q = q.eq('cliente_id', cliente_id)
          const { data: existenteConv } = await q.maybeSingle()
          if (existenteConv) {
            novaConversa = existenteConv
            errNovaConv = null
          }
        }
        if (errNovaConv) {
          console.error('Erro ao criar conversa Z-API:', errNovaConv)
          return res.status(500).json({ error: 'Erro ao criar conversa' })
        }
      }
      conversa_id = novaConversa.id
      departamento_id = novaConversa.departamento_id ?? null
      isNewConversation = true

      const io = req.app.get('io')
      if (io) {
        const payload = {
          id: conversa_id,
          telefone: phone,
          tipo: isGroup ? 'grupo' : 'cliente',
          nome_grupo: isGroup ? (nomeGrupo || null) : null,
          foto_grupo: isGroup ? (chatPhoto || null) : null,
          contato_nome: isGroup ? (nomeGrupo || phone || 'Grupo') : (senderName || phone || null),
          foto_perfil: isGroup ? null : (senderPhoto || null),
          unread_count: 0,
          tags: []
        }
        io.to(`empresa_${company_id}`).emit('nova_conversa', payload)
      }
    }

    // 3) Salvar mensagem. TUDO que a Z-API envia (recebido, !fromMe) é gravado; sem messageId grava com whatsapp_id null.
    // Mensagens enviadas por nós (fromMe): não inserir — evita eco/duplicata.
    const whatsappIdStr = messageId ? String(messageId).trim() : null
    let mensagemSalva = null

    // fromMe: também persiste (você pediu "todas as mensagens"). O índice único por (conversa_id, whatsapp_id)
    // evita duplicatas quando o provider reenviar o mesmo evento.

    // Não gravar evento que virou só "(mídia)" sem mídia real (ex.: eco/confirmação ao enviar msg pelo CRM)
    const soPlaceholderMidia = texto === '(mídia)' && !imageUrl && !documentUrl && !audioUrl && !videoUrl && !stickerUrl && !locationUrl
    if (soPlaceholderMidia) {
      await supabase
        .from('conversas')
        .update({ ultima_atividade: new Date().toISOString() })
        .eq('id', conversa_id)
        .eq('company_id', company_id)
      return res.status(200).json({ ok: true, conversa_id, skip: 'placeholderMidia' })
    }

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

    if (whatsappIdStr) {
      const { data: existente } = await supabase
        .from('mensagens')
        .select('*')
        .eq('conversa_id', conversa_id)
        .eq('whatsapp_id', whatsappIdStr)
        .maybeSingle()
      if (existente) {
        mensagemSalva = existente
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
          .select('id, criado_em, texto, url, nome_arquivo, tipo, whatsapp_id')
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

    if (!mensagemSalva) {
      const statusPayload = (payload.status && String(payload.status).toLowerCase()) || null

      // Reply/citação (Z-API) — tenta capturar o ID da mensagem citada (quando existir)
      // Z-API pode variar o formato: quotedMsgId, quotedStanzaId, contextInfo.stanzaId etc.
      const quotedIdRaw =
        payload?.quotedMsgId ??
        payload?.quotedMessageId ??
        payload?.quotedStanzaId ??
        payload?.contextInfo?.stanzaId ??
        payload?.contextInfo?.quotedStanzaId ??
        payload?.contextInfo?.quotedMessageId ??
        payload?.quotedMsg?.id ??
        payload?.quotedMsg?.messageId ??
        payload?.quoted?.id ??
        payload?.message?.contextInfo?.stanzaId ??
        payload?.message?.contextInfo?.quotedStanzaId ??
        null
      const quotedId = quotedIdRaw ? String(quotedIdRaw).trim() : null

      let reply_meta = null
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
            String(payload?.quotedMsg?.message || payload?.quotedMsg?.body || payload?.quotedMsg?.text?.message || '').trim().slice(0, 180) ||
            'Mensagem'
          const name =
            quoted?.direcao === 'out'
              ? 'Você'
              : (String(quoted?.remetente_nome || '').trim() || 'Contato')
          reply_meta = { name, snippet, ts: Date.now(), replyToId: quotedId }
        } catch (_) {
          reply_meta = { name: 'Mensagem', snippet: 'Mensagem', ts: Date.now(), replyToId: quotedId }
        }
      }

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
            qM = applyCompanyFilter(qM, company_id)
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
            direcao: 'in',
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
            console.error('Erro ao salvar mensagem Z-API:', errMsg)
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
      console.log('✅ Mensagem salva no sistema:', { conversa_id, mensagem_id: mensagemSalva.id, phone: phone?.slice(-6), direcao: fromMe ? 'out' : 'in' })
    }

    // 4) Realtime: nova_mensagem + contato_atualizado quando sync Z-API terminar
    const io = req.app.get('io')
    if (io && mensagemSalva) {
      io.to(`empresa_${company_id}`).emit('nova_mensagem', mensagemSalva)
      io.to(`conversa_${conversa_id}`).emit('nova_mensagem', mensagemSalva)
      io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: conversa_id })
      if (departamento_id != null) {
        io.to(`departamento_${departamento_id}`).emit('nova_mensagem', mensagemSalva)
        io.to(`departamento_${departamento_id}`).emit('atualizar_conversa', { id: conversa_id })
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
          .then(({ data } = {}) => {
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
 * Payload esperado: messageId, status (PENDING|SENT|RECEIVED|READ|PLAYED).
 */
exports.statusZapi = async (req, res) => {
  try {
    const { messageId, status } = req.body || {}
    if (!messageId) return res.status(200).json({ ok: true })
    const raw = String(status || '').trim().toLowerCase()
    // Normaliza para estados canônicos
    const statusNorm =
      raw === 'received' ? 'delivered' :
      raw === 'entregue' ? 'delivered' :
      raw === 'delivered' ? 'delivered' :
      raw === 'read' || raw === 'seen' || raw === 'visualizada' ? 'read' :
      raw === 'played' ? 'played' :
      raw === 'pending' || raw === 'enviando' ? 'pending' :
      raw === 'sent' || raw === 'enviada' || raw === 'enviado' ? 'sent' :
      raw === 'erro' || raw === 'error' || raw === 'failed' ? 'erro' :
      (raw || 'sent')
    const { data: msg, error } = await supabase
      .from('mensagens')
      .update({ status: statusNorm || 'enviada' })
      .eq('whatsapp_id', String(messageId))
      .select('id, conversa_id, company_id')
      .maybeSingle()
    if (!error && msg) {
      const io = req.app.get('io')
      if (io) {
        io.to(`empresa_${msg.company_id}`).emit('status_mensagem', { mensagem_id: msg.id, conversa_id: msg.conversa_id, status: statusNorm })
        io.to(`conversa_${msg.conversa_id}`).emit('status_mensagem', { mensagem_id: msg.id, conversa_id: msg.conversa_id, status: statusNorm })
      }
    }
    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('Erro webhook Z-API status:', e)
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
        const provider = getProvider()
        if (!provider || !provider.getContacts || !provider.isConfigured) return

        try {
          console.log('🔄 Z-API: iniciando sync de contatos (on connected)...')
          const pageSize = 100
          let page = 1
          let total = 0
          let atualizados = 0
          let criados = 0

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
            let fotosAtualizadas = 0
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
 * POST /webhooks/zapi/presence — presença do chat (digitando, online). Responde 200.
 */
exports.presenceZapi = async (req, res) => {
  try {
    return res.status(200).json({ ok: true })
  } catch (e) {
    return res.status(200).json({ ok: true })
  }
}
