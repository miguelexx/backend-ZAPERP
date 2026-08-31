/**
 * Reenvio manual de mensagens (texto e mídia) que o provedor não confirmou.
 * Extraído de controllers/chatController.js (Fase 7 da modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { isRealWhatsAppId, isUltramsgNumericQueueId } = require('../../helpers/whatsappMessageIdHelper')
const { schedulePendingOutboundReconciliation } = require('../../services/pendingOutboundReconciliationService')
const { getProvider } = require('../../services/providers')
const {
  avaliarElegibilidadeReenvio,
  captionUsuarioDeMidiaPersistida,
} = require('../../services/chat/outbound/retryEligibility')
const {
  resolveConversationWhatsappInstance,
  resolverTelefoneEnvioDaConversa,
} = require('../../services/chat/identity/conversationAddressService')
const {
  getUsuarioParaEnvioCliente,
  textoParaEnvioWhatsapp,
} = require('../../services/chat/presentation/messageAuthorEnrichment')
const { resolveForwardMediaForProvider } = require('../../services/chat/outbound/forwardMediaResolver')

/** Lock local (por processo) para evitar reenvio duplicado concorrente da mesma mensagem. */
const _reenviosEmAndamento = new Set()

async function aplicarResultadoReenvio({ req, company_id, conversa_id, mensagem, result, tipoReenvio }) {
  const ok = typeof result === 'boolean' ? result : result?.ok === true
  const waMessageId =
    typeof result === 'object' && result?.messageId ? String(result.messageId).trim() : null
  const hasValidId = isRealWhatsAppId(waMessageId)
  const hasQueueId = !!waMessageId && isUltramsgNumericQueueId(waMessageId)
  const providerError =
    typeof result === 'object' ? result?.error || result?.blockedBy || null : null

  const patch = {
    status: ok ? (hasValidId ? 'sent' : 'pending') : 'erro',
    status_mensagem: ok ? (hasValidId ? 'sent' : 'sending') : 'failed',
    ...(hasValidId ? { whatsapp_id: waMessageId } : {}),
    ...(hasQueueId ? { provider_queue_id: waMessageId } : {}),
  }

  await supabase
    .from('mensagens')
    .update(patch)
    .eq('company_id', company_id)
    .eq('id', mensagem.id)

  const io = req.app?.get('io')
  if (io) {
    io.to(`empresa_${company_id}`)
      .to(`conversa_${conversa_id}`)
      .emit(io.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', {
        mensagem_id: mensagem.id,
        conversa_id: Number(conversa_id),
        status: patch.status,
        status_mensagem: patch.status_mensagem,
        ...(hasValidId ? { whatsapp_id: waMessageId } : {}),
      })
  }

  if (ok && !hasValidId) {
    schedulePendingOutboundReconciliation({ companyId: company_id, mensagemId: mensagem.id, io })
  }

  console.log(`[REENVIO_MANUAL] ${ok ? '✅ aceito' : '❌ recusado'}`, {
    company_id,
    conversa_id: Number(conversa_id),
    mensagem_id: mensagem.id,
    tipo: tipoReenvio,
    provider_message_id: waMessageId || null,
    status_final: patch.status,
    ...(ok ? {} : { erro: String(providerError || '').slice(0, 200) || 'desconhecido' }),
  })

  return {
    ok,
    mensagem: { ...mensagem, ...patch, conversa_id: Number(conversa_id) },
    error: ok ? null : String(providerError || '').slice(0, 300) || 'O WhatsApp não confirmou o envio.',
  }
}

/** Validação comum de rota + carga de mensagem/conversa para os dois tipos de reenvio. */
async function prepararReenvio(req, res) {
  const company_id = Number(req.user?.company_id)
  const conversa_id = Number(req.params?.id)
  const mensagem_id = Number(req.params?.mensagem_id ?? req.params?.mensagemId)

  if (!Number.isFinite(company_id) || company_id <= 0) {
    res.status(400).json({ error: 'company_id inválido na sessão' })
    return null
  }
  if (!Number.isSafeInteger(conversa_id) || conversa_id <= 0 || !Number.isSafeInteger(mensagem_id) || mensagem_id <= 0) {
    res.status(400).json({ error: 'Identificadores inválidos' })
    return null
  }

  const { data: mensagem, error: errMsg } = await supabase
    .from('mensagens')
    .select(
      'id, conversa_id, company_id, direcao, tipo, texto, url, nome_arquivo, status, status_mensagem, whatsapp_id, provider_queue_id, client_temp_id, criado_em, whatsapp_instance_id'
    )
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    .eq('id', mensagem_id)
    .maybeSingle()

  if (errMsg) {
    res.status(500).json({ error: 'Erro ao carregar mensagem' })
    return null
  }
  if (!mensagem) {
    res.status(404).json({ error: 'Mensagem não encontrada nesta conversa' })
    return null
  }

  const elegibilidade = avaliarElegibilidadeReenvio(mensagem)
  if (!elegibilidade.permitido) {
    if (elegibilidade.jaResolvida) {
      res.json({ ok: true, already_sent: true, motivo: elegibilidade.motivo, mensagem })
    } else {
      res.status(elegibilidade.httpStatus || 400).json({ error: elegibilidade.motivo, mensagem })
    }
    return null
  }

  const { data: conversa, error: errConv } = await supabase
    .from('conversas')
    .select('id, telefone, cliente_id, chat_lid, tipo, whatsapp_instance_id')
    .eq('company_id', company_id)
    .eq('id', conversa_id)
    .maybeSingle()

  if (errConv || !conversa) {
    res.status(404).json({ error: 'Conversa não encontrada' })
    return null
  }

  const whatsappInstanceId = await resolveConversationWhatsappInstance(company_id, conversa)
  const { telefone, erro: erroTelefone } = await resolverTelefoneEnvioDaConversa(
    company_id,
    conversa,
    whatsappInstanceId
  )
  if (!telefone) {
    res.status(400).json({ error: erroTelefone, mensagem })
    return null
  }

  return { company_id, conversa_id, mensagem_id, mensagem, conversa, whatsappInstanceId, telefone }
}

exports.reenviarTextoMensagem = async (req, res) => {
  let lockKey = null
  try {
    const ctx = await prepararReenvio(req, res)
    if (!ctx) return

    const { company_id, conversa_id, mensagem, whatsappInstanceId, telefone } = ctx

    const texto = String(mensagem.texto || '').trim()
    if (!texto) {
      return res.status(400).json({ error: 'Mensagem sem texto para reenviar', mensagem })
    }

    lockKey = `${company_id}:${mensagem.id}`
    if (_reenviosEmAndamento.has(lockKey)) {
      return res.status(409).json({ error: 'Já existe um reenvio em andamento para esta mensagem.', mensagem })
    }
    _reenviosEmAndamento.add(lockKey)

    const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, req.user?.id)
    const provider = getProvider()
    if (!provider?.sendText) {
      return res.status(503).json({ error: 'Envio de texto indisponível no provedor.', mensagem })
    }

    const result = await provider.sendText(telefone, textoParaEnvioWhatsapp(texto, usuarioNome), {
      companyId: company_id,
      conversaId: conversa_id,
      whatsappInstanceId: whatsappInstanceId || undefined,
      referenceId: `crm-${mensagem.id}`,
      sendOrigin: 'atendimento_humano_reenvio',
    })

    const aplicado = await aplicarResultadoReenvio({
      req,
      company_id,
      conversa_id,
      mensagem,
      result,
      tipoReenvio: 'texto',
    })

    return res.json(aplicado)
  } catch (err) {
    console.error('[REENVIO_MANUAL] erro inesperado (texto):', err?.message || err)
    return res.status(500).json({ ok: false, error: 'Erro interno ao reenviar mensagem' })
  } finally {
    if (lockKey) _reenviosEmAndamento.delete(lockKey)
  }
}

exports.reenviarMidiaMensagem = async (req, res) => {
  let lockKey = null
  try {
    const ctx = await prepararReenvio(req, res)
    if (!ctx) return

    const { company_id, conversa_id, mensagem, whatsappInstanceId, telefone } = ctx

    if (!String(mensagem.url || '').trim()) {
      return res.status(400).json({ error: 'Mensagem sem arquivo para reenviar', mensagem })
    }

    lockKey = `${company_id}:${mensagem.id}`
    if (_reenviosEmAndamento.has(lockKey)) {
      return res.status(409).json({ error: 'Já existe um reenvio em andamento para esta mensagem.', mensagem })
    }
    _reenviosEmAndamento.add(lockKey)

    const provider = getProvider()
    const baseUrl = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/$/, '')
    const midia = await resolveForwardMediaForProvider({
      provider,
      mensagemOriginal: mensagem,
      company_id,
      whatsappInstanceId,
      baseUrl,
    })
    if (!midia.ok) {
      const aplicado = await aplicarResultadoReenvio({
        req,
        company_id,
        conversa_id,
        mensagem,
        result: { ok: false, error: midia.error },
        tipoReenvio: 'midia',
      })
      return res.json(aplicado)
    }

    const { captionWhatsappParaMidia } = require('../../helpers/midiaMensagemHelper')
    const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, req.user?.id)
    const tipo = String(mensagem.tipo || '').toLowerCase().trim()
    const waCaption = captionWhatsappParaMidia({
      tipo,
      captionUsuarioTrim: captionUsuarioDeMidiaPersistida(mensagem),
      usuarioNome,
    })
    const opts = {
      companyId: company_id,
      conversaId: conversa_id,
      whatsappInstanceId: whatsappInstanceId || undefined,
      sendOrigin: 'atendimento_humano_reenvio_midia',
      referenceId: `crm-${mensagem.id}`,
      returnDetails: true,
    }

    const nomeArquivo = mensagem.nome_arquivo || 'arquivo'
    const result =
      tipo === 'voice' && provider.sendVoice
        ? await provider.sendVoice(telefone, midia.url, opts)
        : tipo === 'audio' && provider.sendAudio
          ? await provider.sendAudio(telefone, midia.url, opts)
          : tipo === 'sticker' && provider.sendSticker
            ? await provider.sendSticker(telefone, midia.url, { ...opts, stickerAuthor: 'ZapERP' })
            : tipo === 'imagem' && provider.sendImage
              ? await provider.sendImage(telefone, midia.url, waCaption, opts)
              : (tipo === 'video' || tipo === 'vídeo') && provider.sendVideo
                ? await provider.sendVideo(telefone, midia.url, waCaption, opts)
                : provider.sendFile
                  ? await provider.sendFile(telefone, midia.url, nomeArquivo, { ...opts, caption: waCaption })
                  : { ok: false, error: 'Envio de mídia indisponível no provedor.' }

    const aplicado = await aplicarResultadoReenvio({
      req,
      company_id,
      conversa_id,
      mensagem,
      result,
      tipoReenvio: `midia:${tipo || 'arquivo'}`,
    })

    return res.json(aplicado)
  } catch (err) {
    console.error('[REENVIO_MANUAL] erro inesperado (mídia):', err?.message || err)
    return res.status(500).json({ ok: false, error: 'Erro interno ao reenviar mídia' })
  } finally {
    if (lockKey) _reenviosEmAndamento.delete(lockKey)
  }
}
