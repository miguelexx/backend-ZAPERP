/**
 * Encaminhamento de mensagens (texto, mídia, contato, localização) para outra conversa.
 * Extraído de controllers/chatController.js (Fase 7 da modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { getProvider } = require('../../services/providers')
const { isRealWhatsAppId, isUltramsgNumericQueueId } = require('../../helpers/whatsappMessageIdHelper')
const { isInternalNoteRow } = require('../../helpers/internalNote')
const { normalizeForwardTipo } = require('../../services/chat/outbound/messageNormalizers')
const {
  getForwardMediaUrlCandidate,
  resolveForwardMediaForProvider,
} = require('../../services/chat/outbound/forwardMediaResolver')
const {
  enrichMensagemComAutorUsuario,
  getUsuarioParaEnvioCliente,
} = require('../../services/chat/presentation/messageAuthorEnrichment')
const {
  emitirEventoEmpresaConversa,
  emitirConversaAtualizada,
} = require('../../services/chat/realtime/chatRealtimeGateway')
const { assertPodeEnviarMensagem } = require('../../services/chat/access/conversationPolicy')
const {
  resolveConversationWhatsappInstance,
  resolveTelefoneFromLidSiblingConversation,
  resolveConversationProvider,
} = require('../../services/chat/identity/conversationAddressService')

const MAX_ENC_AMINHAR_LOTE = 30

/**
 * Normaliza `mensagem_id` ou `mensagem_ids` do body para uma lista ordenada de IDs (sem duplicados).
 * @param {Record<string, unknown>} body
 * @returns {number[]}
 */
function collectOrderedMessageIds(body) {
  const raw =
    Array.isArray(body?.mensagem_ids) && body.mensagem_ids.length > 0
      ? body.mensagem_ids
      : body?.mensagem_id != null && body?.mensagem_id !== ''
        ? [body.mensagem_id]
        : []
  const seen = new Set()
  const ordered = []
  for (const x of raw) {
    const n = Number(x)
    if (!Number.isFinite(n) || n <= 0) continue
    if (seen.has(n)) continue
    seen.add(n)
    ordered.push(n)
  }
  return ordered
}

/**
 * Encaminha uma mensagem já carregada para a conversa de destino (persistência + WhatsApp + socket).
 * @returns {Promise<{ ok: true, mensagem: object, enviado_whatsapp: boolean } | { ok: false, status: number, error: string }>}
 */
async function encaminharUmaMensagemParaConversa(ctx) {
  const {
    io,
    supabase,
    company_id,
    user_id,
    conversa_id,
    telefoneParaEnvio,
    whatsappInstanceId = null,
    provider,
    usuarioNome,
    mensagemOriginal,
    tipo_encaminhamento,
    timestamp,
  } = ctx

  const fail = (status, error) => ({ ok: false, status, error })
  const prefixoEncaminhado = '[Encaminhado]'

  let novaMensagem = null
  let resultadoEnvio = false

  const tipoOriginal = normalizeForwardTipo(mensagemOriginal.tipo)
  const mediaUrlOriginal = getForwardMediaUrlCandidate(mensagemOriginal)
  const temUrl = !!mediaUrlOriginal

  if (tipo_encaminhamento === 'texto' || (!temUrl && tipoOriginal === 'texto')) {
    const textoOriginal = mensagemOriginal.texto && !mensagemOriginal.texto.startsWith('[Encaminhado]')
      ? mensagemOriginal.texto
      : (mensagemOriginal.texto || '(mídia)')

    const textoParaWhatsApp = usuarioNome
      ? `${prefixoEncaminhado}\n${textoOriginal}\n— ${usuarioNome}`
      : `${prefixoEncaminhado}\n${textoOriginal}`

    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: textoOriginal,
      tipo: 'texto',
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio && provider.sendText) {
      resultadoEnvio = await provider.sendText(telefoneParaEnvio, textoParaWhatsApp, {
        companyId: company_id,
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'encaminhamento_atendimento',
      })
    }
  } else if (temUrl && (tipoOriginal === 'imagem' || tipoOriginal === 'video' || tipoOriginal === 'audio' || tipoOriginal === 'voice' || tipoOriginal === 'arquivo' || tipoOriginal === 'sticker')) {
    const baseUrl = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/$/, '')
    const resolvedMedia = await resolveForwardMediaForProvider({
      provider,
      mensagemOriginal: { ...mensagemOriginal, url: mediaUrlOriginal },
      company_id,
      whatsappInstanceId,
      baseUrl,
    })

    if (!resolvedMedia.ok || !resolvedMedia.url) {
      return fail(400, resolvedMedia.error || 'URL da mídia não pode ser resolvida para encaminhamento')
    }
    const mediaUrl = resolvedMedia.url

    const captionEncaminhado = usuarioNome ? `${prefixoEncaminhado} — ${usuarioNome}` : prefixoEncaminhado

    const textoPlaceholderPorTipo = {
      imagem: '(imagem)',
      video: '(vídeo)',
      audio: '(áudio)',
      voice: '(áudio de voz)',
      sticker: '(figurinha)',
      arquivo: mensagemOriginal.nome_arquivo || '(arquivo)',
    }
    const textoParaBanco = textoPlaceholderPorTipo[tipoOriginal] || mensagemOriginal.nome_arquivo || `(${tipoOriginal})`

    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: textoParaBanco,
      tipo: tipoOriginal,
      url: mediaUrlOriginal,
      nome_arquivo: mensagemOriginal.nome_arquivo,
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio) {
      const opts = {
        companyId: company_id,
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'encaminhamento_atendimento',
        returnDetails: true,
      }

      switch (tipoOriginal) {
        case 'imagem':
          if (provider.sendImage) {
            resultadoEnvio = await provider.sendImage(telefoneParaEnvio, mediaUrl, captionEncaminhado, opts)
          }
          break
        case 'video':
          if (provider.sendVideo) {
            resultadoEnvio = await provider.sendVideo(telefoneParaEnvio, mediaUrl, captionEncaminhado, opts)
          }
          break
        case 'audio':
          if (provider.sendAudio) {
            resultadoEnvio = await provider.sendAudio(telefoneParaEnvio, mediaUrl, opts)
          }
          break
        case 'voice':
          if (provider.sendVoice) {
            resultadoEnvio = await provider.sendVoice(telefoneParaEnvio, mediaUrl, opts)
          } else if (provider.sendAudio) {
            resultadoEnvio = await provider.sendAudio(telefoneParaEnvio, mediaUrl, opts)
          }
          break
        case 'sticker':
          if (provider.sendSticker) {
            resultadoEnvio = await provider.sendSticker(telefoneParaEnvio, mediaUrl, opts)
          }
          break
        default:
          if (provider.sendFile) {
            resultadoEnvio = await provider.sendFile(telefoneParaEnvio, mediaUrl, mensagemOriginal.nome_arquivo || 'arquivo', { ...opts, caption: captionEncaminhado })
          }
      }
    }
  } else if (tipoOriginal === 'contact') {
    let contactMeta = mensagemOriginal.contact_meta
    if (!contactMeta || typeof contactMeta !== 'object') {
      contactMeta = null
    }

    const contactName = contactMeta?.nome || contactMeta?.name || mensagemOriginal.texto || 'Contato'
    const contactPhoneRaw = String(contactMeta?.telefone || contactMeta?.phone || '').replace(/\D/g, '')
    const contactPhone = contactPhoneRaw || null

    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: contactName,
      tipo: 'contact',
      contact_meta: contactMeta || { nome: contactName },
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio && provider.sendContact && contactPhone) {
      resultadoEnvio = await provider.sendContact(
        telefoneParaEnvio,
        contactName,
        contactPhone,
        {
          companyId: company_id,
          conversaId: conversa_id,
          whatsappInstanceId: whatsappInstanceId || undefined,
          sendOrigin: 'encaminhamento_atendimento',
        },
      )
    } else if (telefoneParaEnvio && provider.sendText && !contactPhone) {
      const textoContato = `${prefixoEncaminhado}\n${contactName}`
      resultadoEnvio = await provider.sendText(telefoneParaEnvio, textoContato, {
        companyId: company_id,
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'encaminhamento_atendimento',
      })
    }
  } else if (tipoOriginal === 'location' && mensagemOriginal.location_meta) {
    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: `${prefixoEncaminhado}\n${mensagemOriginal.texto}`,
      tipo: 'location',
      url: mensagemOriginal.url,
      location_meta: mensagemOriginal.location_meta,
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio && provider.sendLocation && mensagemOriginal.location_meta) {
      const { latitude, longitude, nome, endereco } = mensagemOriginal.location_meta
      const addressParaCliente = usuarioNome
        ? `${usuarioNome} — ${[nome, endereco].filter(Boolean).join('\n') || `${latitude},${longitude}`}`
        : [nome, endereco].filter(Boolean).join('\n') || `${latitude},${longitude}`

      resultadoEnvio = await provider.sendLocation(telefoneParaEnvio, {
        address: addressParaCliente,
        lat: latitude,
        lng: longitude,
      }, {
        companyId: company_id,
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'encaminhamento_atendimento',
      })
    }
  } else {
    const textoFallback = mensagemOriginal.texto || '(mídia não suportada para encaminhamento)'
    const textoEncaminhado = `${prefixoEncaminhado}\n${textoFallback}`
    const textoComUsuario = usuarioNome ? `${textoEncaminhado}\n— ${usuarioNome}` : textoEncaminhado

    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: textoEncaminhado,
      tipo: 'texto',
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio && provider.sendText) {
      resultadoEnvio = await provider.sendText(telefoneParaEnvio, textoComUsuario, {
        companyId: company_id,
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'encaminhamento_atendimento',
      })
    }
  }

  const ok = resultadoEnvio === true || resultadoEnvio?.ok === true
  const waMessageId = (typeof resultadoEnvio === 'object' && resultadoEnvio?.messageId)
    ? String(resultadoEnvio.messageId).trim() : null
  const hasTraceableForwardId = isRealWhatsAppId(waMessageId)
  const hasQueueForwardId = !!waMessageId && isUltramsgNumericQueueId(waMessageId)
  const nextStatus = ok ? (hasTraceableForwardId ? 'sent' : 'pending') : 'erro'
  const nextStatusMensagem = ok ? (hasTraceableForwardId ? 'sent' : 'sending') : 'erro'

  await supabase
    .from('mensagens')
    .update({
      status: nextStatus,
      status_mensagem: nextStatusMensagem,
      ...(hasTraceableForwardId ? { whatsapp_id: waMessageId } : {}),
      ...(hasQueueForwardId ? { provider_queue_id: waMessageId } : {}),
    })
    .eq('company_id', company_id)
    .eq('id', novaMensagem.id)

  await supabase
    .from('conversas')
    .update({ lida: true, ultima_atividade: timestamp })
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))

  if (io) {
    const msgParaEmissao = {
      ...novaMensagem,
      status: nextStatus,
      status_mensagem: nextStatusMensagem,
      whatsapp_id: hasTraceableForwardId ? waMessageId : null,
      encaminhado: true,
    }
    const payload = await enrichMensagemComAutorUsuario(supabase, company_id, msgParaEmissao)
    emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', payload)

    const convPayload = { id: Number(conversa_id) }
    emitirConversaAtualizada(io, company_id, conversa_id, convPayload)
  }

  return {
    ok: true,
    mensagem: {
      ...novaMensagem,
      status: nextStatus,
      status_mensagem: nextStatusMensagem,
      whatsapp_id: hasTraceableForwardId ? waMessageId : null,
      encaminhado: true,
    },
    enviado_whatsapp: ok,
  }
}

/**
 * Encaminha uma ou várias mensagens (texto ou mídia) para outra conversa.
 * Body: `mensagem_id` (único, compatível) ou `mensagem_ids` (array, ordem preservada).
 */
exports.encaminharMensagem = async (req, res) => {
  try {
    const { id: conversa_id } = req.params
    const { company_id, id: user_id } = req.user
    const { tipo_encaminhamento = 'auto' } = req.body

    const orderedIds = collectOrderedMessageIds(req.body)
    if (!orderedIds.length) {
      return res.status(400).json({ error: 'mensagem_id ou mensagem_ids é obrigatório' })
    }
    if (orderedIds.length > MAX_ENC_AMINHAR_LOTE) {
      return res.status(400).json({ error: `No máximo ${MAX_ENC_AMINHAR_LOTE} mensagens por encaminhamento` })
    }

    const io = req.app.get('io')
    const permEnvio = await assertPodeEnviarMensagem({
      company_id,
      conversa_id,
      user_id,
      role: req.user?.perfil,
      user_dep_ids: req.user?.departamento_ids,
      autoAssumirAoEnviar: true,
      io,
    })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const { data: mensagensRows, error: errMsg } = await supabase
      .from('mensagens')
      .select('id, texto, tipo, direcao, url, nome_arquivo, contact_meta, location_meta, conversa_id')
      .eq('company_id', company_id)
      .in('id', orderedIds)

    if (errMsg) {
      return res.status(500).json({ error: errMsg.message })
    }

    const byId = new Map((mensagensRows || []).map((m) => [Number(m.id), m]))
    const missing = orderedIds.filter((id) => !byId.has(id))
    if (missing.length) {
      return res.status(404).json({ error: `Mensagem(ns) não encontrada(s): ${missing.join(', ')}` })
    }

    // Notas internas não existem no WhatsApp — não podem ser encaminhadas
    const notasInternas = orderedIds.filter((id) => isInternalNoteRow(byId.get(id)))
    if (notasInternas.length > 0) {
      return res.status(400).json({ error: 'Notas internas não podem ser encaminhadas (não existem no WhatsApp)' })
    }

    // Buscar conversa de destino
    const { data: conversa } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, tipo, chat_lid, whatsapp_instance_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .single()

    if (!conversa) {
      return res.status(404).json({ error: 'Conversa de destino não encontrada' })
    }

    // Resolver telefone real quando conversa tem apenas LID
    const whatsappInstanceId = await resolveConversationWhatsappInstance(company_id, conversa)
    let telefoneParaEnvio = conversa.telefone || ''
    if (telefoneParaEnvio && String(telefoneParaEnvio).trim().toLowerCase().startsWith('lid:')) {
      if (conversa.cliente_id) {
        const { data: cli } = await supabase.from('clientes').select('telefone').eq('id', conversa.cliente_id).eq('company_id', company_id).maybeSingle()
        if (cli?.telefone && !String(cli.telefone).startsWith('lid:')) telefoneParaEnvio = cli.telefone
      }
      if (telefoneParaEnvio.startsWith('lid:') && conversa.chat_lid) {
        const telSibling = await resolveTelefoneFromLidSiblingConversation(company_id, conversa, whatsappInstanceId)
        if (telSibling) telefoneParaEnvio = telSibling
      }
      if (telefoneParaEnvio.startsWith('lid:')) {
        return res.status(400).json({ error: 'Número do contato indisponível (conversa por LID). Aguarde o contato enviar uma mensagem ou sincronize os contatos.' })
      }
    }

    const instanceProvider = await resolveConversationProvider(company_id, whatsappInstanceId)
    const provider = getProvider({ provider: instanceProvider })
    if (!provider) {
      return res.status(500).json({ error: 'Provider WhatsApp não configurado' })
    }

    const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, user_id)

    const resultados = []
    for (let i = 0; i < orderedIds.length; i++) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 400))
      }
      const r = await encaminharUmaMensagemParaConversa({
        io,
        supabase,
        company_id,
        user_id,
        conversa_id,
        telefoneParaEnvio,
        whatsappInstanceId,
        provider,
        usuarioNome,
        mensagemOriginal: byId.get(orderedIds[i]),
        tipo_encaminhamento,
        timestamp: new Date(Date.now() + i * 50).toISOString(),
      })
      if (!r.ok) {
        resultados.push({ mensagem_id: orderedIds[i], ok: false, error: r.error, status: r.status })
        continue
      }
      resultados.push({
        mensagem_id: orderedIds[i],
        ok: true,
        mensagem: r.mensagem,
        enviado_whatsapp: r.enviado_whatsapp,
      })
    }

    if (orderedIds.length === 1) {
      const s0 = resultados[0]
      if (!s0.ok) {
        return res.status(s0.status || 500).json({ error: s0.error })
      }
      return res.json({
        success: true,
        mensagem: s0.mensagem,
        enviado_whatsapp: s0.enviado_whatsapp,
      })
    }

    return res.json({
      success: resultados.every((x) => x.ok),
      encaminhamentos: resultados,
      total: resultados.length,
    })

  } catch (error) {
    console.error('Erro ao encaminhar mensagem:', error)
    return res.status(500).json({ error: 'Erro ao encaminhar mensagem' })
  }
}
