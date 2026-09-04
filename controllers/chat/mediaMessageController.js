/**
 * Envio de arquivos/mídia (upload multer): classificação, normalização (áudio/vídeo/imagem),
 * dedupe por client_temp_id, persistência, envio ao provider e realtime; suporta lote.
 * Extraído de controllers/chatController.js (Fase 7 da modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { getProvider } = require('../../services/providers')
const { tryMarkWaitingAfterHumanOutbound } = require('../../services/absenceFinalizationService')
const { empresaModoSimplesAtivo } = require('../../helpers/empresaModoSimplesFlag')
const { isRealWhatsAppId, isUltramsgNumericQueueId } = require('../../helpers/whatsappMessageIdHelper')
const { schedulePendingOutboundReconciliation } = require('../../services/pendingOutboundReconciliationService')
const { normalizeClientTempId, isMissingMensagemColumnError, isGenericMissingColumnError, isClientTempIdUniqueViolation } = require('../../services/chat/outbound/idempotencyHelpers')
const { parseAudioDuracaoSecFromBody, aplicarTipoForcadoSticker, inferirTipoArquivo, shouldAbortAudioAfterNormalize, shouldForceProviderUploadForMedia } = require('../../services/chat/media/mediaType')
const { resolveTelefoneFromLidSiblingConversation, resolveConversationWhatsappInstance, resolveConversationProvider } = require('../../services/chat/identity/conversationAddressService')
const { emitirConversaAtualizada, emitirEventoEmpresaConversa } = require('../../services/chat/realtime/chatRealtimeGateway')
const { normalizeAudioForUltraMsg, probeAudioDurationSec, normalizeVideoForUltraMsg, normalizeImageForWhatsapp } = require('../../services/chat/media/mediaNormalizers')
const { assertPodeEnviarMensagem } = require('../../services/chat/access/conversationPolicy')
const { getUsuarioParaEnvioCliente, enrichMensagemComAutorUsuario } = require('../../services/chat/presentation/messageAuthorEnrichment')
const { findMensagemByClientTempId, isDbDedupeUnavailable, markDbDedupeUnavailable, isAudioDuracaoSecColumnUnavailable, markAudioDuracaoSecColumnUnavailable } = require('../../services/chat/outbound/idempotencyService')
const { aplicarAguardandoClienteNoPayload, anexarAssumirNoPayloadLista, recalcularEMesclarModoSimples } = require('../../services/chat/outbound/modoSimplesOutbound')

const MAX_ARQUIVOS_LOTE_ENVIO = 30

const {
  parseClientTempIdsFromBody,
  buildArquivoApiResultRow,
} = require('../../helpers/arquivoUploadResponseHelper')

/** Evita processar o mesmo upload duas vezes quando multer recebe campos duplicados. */
function dedupeMulterFiles(files) {
  if (!Array.isArray(files) || files.length < 2) return files
  const seen = new Set()
  const out = []
  for (const f of files) {
    if (!f) continue
    const key = `${String(f.originalname || '')}|${Number(f.size) || 0}|${String(f.path || f.filename || '')}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/** Legenda enviada com foto/vídeo/documento — mesmo limite prático da UltraMsg */
const MAX_MEDIA_CAPTION_CHARS = 1024

/**
 * Uma unidade de upload após multer; conversa e telefone já validados.
 * @returns {Promise<{ ok: true, msg: object } | { ok: false, status: number, error: string }>}
 */
async function enviarArquivoProcessarUm(req, file, { company_id, user_id, conversa_id, telefoneParaEnvio, whatsappInstanceId = null, io, captionUsuario = '', clientTempId = null, permEnvio = null }) {
  const { extFromOriginalName, isBlockedRiskExtension, blockedUploadErrorMessage } = require('../../middleware/upload')
  clientTempId = normalizeClientTempId(clientTempId)
  if (clientTempId) {
    const existing = await findMensagemByClientTempId(
      company_id,
      conversa_id,
      clientTempId,
      'id, conversa_id, company_id, status, status_mensagem, whatsapp_id, client_temp_id, texto, tipo, url, nome_arquivo, criado_em'
    )
    if (existing?.id) {
      return { ok: true, msg: existing, deduplicated: true }
    }
  }

  let fileWork = file
  const extUpload = extFromOriginalName(fileWork?.originalname)
  if (isBlockedRiskExtension(extUpload)) {
    return { ok: false, status: 400, error: blockedUploadErrorMessage(extUpload) }
  }
  const avisoWhatsapp = null
  const tipo = aplicarTipoForcadoSticker(fileWork, inferirTipoArquivo(fileWork))
  if (tipo === 'audio' || tipo === 'voice') {
    let normalized
    try {
      normalized = await normalizeAudioForUltraMsg(fileWork, tipo)
    } catch (e) {
      // normalizeAudioForUltraMsg já captura falhas do ffmpeg; este catch é rede de segurança.
      normalized = {
        file: fileWork,
        converted: false,
        required: true,
        error: e?.message || 'Falha ao converter áudio',
      }
    }
    if (normalized?.converted && normalized?.file) {
      const beforeName = fileWork.originalname
      fileWork = normalized.file
      req.file = fileWork
      console.log('[ULTRAMSG][AUDIO] Áudio convertido para formato compatível antes do envio:', {
        tipo,
        from: beforeName,
        to: fileWork.originalname,
        mime: fileWork.mimetype,
      })
      // Guard de duração: confere se o OGG produzido é coerente com o tempo gravado.
      // Protege contra timestamp irregulares do WebM de celulares que causam OGG inflado ou truncado.
      if (tipo === 'voice') {
        const elapsedMs = Number(req?.body?.audio_elapsed_ms || 0)
        if (elapsedMs >= 1000) {
          const probedSec = await probeAudioDurationSec(fileWork.path)
          if (probedSec !== null) {
            const elapsedSec = elapsedMs / 1000
            const isInflated = probedSec > elapsedSec * 2 && (probedSec - elapsedSec) > 30
            const isTruncated = probedSec < elapsedSec * 0.6 && (elapsedSec - probedSec) > 3
            if (isInflated || isTruncated) {
              console.error('[AUDIO][GUARD] OGG com duração incoerente após transcode:', {
                probedSec, elapsedSec, isInflated, isTruncated,
              })
              try { require('fs').unlink(fileWork.path, () => {}) } catch {}
              return {
                ok: false,
                status: 422,
                error: 'Não foi possível processar o áudio. Grave novamente e tente enviar.',
              }
            }
          }
        }
      }
    } else if (shouldAbortAudioAfterNormalize(tipo, normalized)) {
      console.warn('[ULTRAMSG][AUDIO] Conversão obrigatória falhou; abortando envio:', {
        tipo,
        error: normalized?.error,
        original: fileWork?.originalname,
        mime: fileWork?.mimetype,
      })
      return {
        ok: false,
        status: 422,
        error:
          tipo === 'voice'
            ? 'Não foi possível converter o áudio de voz. Grave novamente e tente enviar.'
            : 'Não foi possível converter o áudio para um formato compatível com o WhatsApp.',
      }
    } else if (normalized?.error) {
      console.warn('[ULTRAMSG][AUDIO] Conversão/normalização indisponível:', normalized.error)
    }
  }
  if (tipo === 'video') {
    const normalizedVideo = await normalizeVideoForUltraMsg(fileWork, tipo)
    if (normalizedVideo?.converted && normalizedVideo?.file) {
      const beforeName = fileWork.originalname
      fileWork = normalizedVideo.file
      req.file = fileWork
      console.log('[ULTRAMSG][VIDEO] Video convertido para MP4 compativel antes do envio:', {
        from: beforeName,
        to: fileWork.originalname,
        mime: fileWork.mimetype,
        size: fileWork.size,
      })
    } else if (normalizedVideo?.required && normalizedVideo?.error) {
      console.warn('[ULTRAMSG][VIDEO] Conversao obrigatoria falhou; abortando envio:', {
        original: fileWork?.originalname,
        mime: fileWork?.mimetype,
        error: normalizedVideo.error,
      })
      try {
        if (fileWork?.path && require('fs').existsSync(fileWork.path)) require('fs').unlinkSync(fileWork.path)
      } catch (_) {}
      return {
        ok: false,
        status: 422,
        error: 'Não foi possível compactar o vídeo para envio. O arquivo original pode ter até 128 MB; tente reduzir a duração se o problema continuar.',
      }
    }
  }
  if (tipo === 'imagem') {
    try {
      const normalizedImage = await normalizeImageForWhatsapp(fileWork, tipo)
      if (normalizedImage?.converted && normalizedImage?.file) {
        const beforeName = fileWork.originalname
        fileWork = normalizedImage.file
        req.file = fileWork
        console.log('[ULTRAMSG][IMAGE] Imagem normalizada para JPEG compatível antes do envio:', {
          from: beforeName,
          to: fileWork.originalname,
          mime: fileWork.mimetype,
        })
      } else if (normalizedImage?.error) {
        console.warn('[ULTRAMSG][IMAGE] Normalização JPEG indisponível:', normalizedImage.error)
      }
    } catch (e) {
      console.warn('[ULTRAMSG][IMAGE] Falha ao normalizar imagem para JPEG:', e?.message || e)
    }
  }

  let captionUsuarioTrim =
    tipo === 'audio' || tipo === 'voice' || tipo === 'sticker'
      ? ''
      : String(captionUsuario || '').trim().slice(0, MAX_MEDIA_CAPTION_CHARS)

  const { textoMensagemMidiaParaBanco, captionWhatsappParaMidia } = require('../../helpers/midiaMensagemHelper')
  const textoMensagem = textoMensagemMidiaParaBanco({
    tipo,
    captionUsuarioTrim,
    originalname: fileWork.originalname,
  })

  const pathUrl = `/uploads/${fileWork.filename}`
  const audioDuracaoSec =
    (tipo === 'audio' || tipo === 'voice') && !isAudioDuracaoSecColumnUnavailable()
      ? parseAudioDuracaoSecFromBody(req?.body)
      : null

  const insertArquivoPayload = {
    conversa_id: Number(conversa_id),
    texto: textoMensagem,
    tipo,
    url: pathUrl,
    nome_arquivo: fileWork.originalname,
    direcao: "out",
    autor_usuario_id: user_id,
    company_id,
    // Explicito como nos demais envios: o despacho ao provedor ocorre depois do INSERT,
    // e a reconciliacao/reenvio so varre status pending|sending. Depender do default do
    // banco deixaria a midia invisivel para esse laco caso o default mude.
    status: 'pending',
    ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
    ...(clientTempId && !isDbDedupeUnavailable() ? { client_temp_id: clientTempId } : {}),
    ...(audioDuracaoSec != null ? { audio_duracao_sec: audioDuracaoSec } : {}),
  }

  let { data: msg, error } = await supabase.from("mensagens").insert(insertArquivoPayload).select().single()

  if (error && clientTempId && isClientTempIdUniqueViolation(error)) {
    const existing = await findMensagemByClientTempId(
      company_id,
      conversa_id,
      clientTempId,
      'id, conversa_id, company_id, status, status_mensagem, whatsapp_id, client_temp_id, texto, tipo, url, nome_arquivo, criado_em' +
        (isAudioDuracaoSecColumnUnavailable() ? '' : ', audio_duracao_sec')
    )
    if (existing?.id) {
      return { ok: true, msg: existing, deduplicated: true }
    }
  }

  // Coluna nova: tenta de novo sem ela antes de mexer em client_temp_id (evita falso positivo no "does not exist").
  if (
    error &&
    insertArquivoPayload.audio_duracao_sec != null &&
    (isMissingMensagemColumnError(error, 'audio_duracao_sec') || isGenericMissingColumnError(error))
  ) {
    markAudioDuracaoSecColumnUnavailable()
    delete insertArquivoPayload.audio_duracao_sec
    ;({ data: msg, error } = await supabase.from("mensagens").insert(insertArquivoPayload).select().single())
  }

  if (error && insertArquivoPayload.client_temp_id && (isMissingMensagemColumnError(error, 'client_temp_id') || isGenericMissingColumnError(error))) {
    markDbDedupeUnavailable()
    delete insertArquivoPayload.client_temp_id
    ;({ data: msg, error } = await supabase.from("mensagens").insert(insertArquivoPayload).select().single())
  }

  if (error) return { ok: false, status: 500, error: error.message }

    // Rollout R2 (empresa 1): espelha a mídia enviada para o Cloudflare R2 JÁ NO ENVIO, sem esperar
    // confirmação do provedor. A entrega ao WhatsApp usa a URL /uploads capturada abaixo (não a url
    // do banco), e o reenvio automático usa URL assinada do R2 — então isto não interfere no envio.
    // No-op para outras empresas / R2 desligado / tipo não-mídia.
    try {
      const { scheduleR2MirrorIfNeeded } = require('../../services/mediaR2MirrorService')
      scheduleR2MirrorIfNeeded({ supabase, io, company_id, mensagem_id: msg.id })
    } catch (_) { /* espelhamento é best-effort; nunca afeta o envio */ }

    const modoSimplesEnvio = await empresaModoSimplesAtivo(company_id).catch(() => false)
    const timestampAtividade = new Date().toISOString()

    const [waitingAfterOutbound, modoSimplesResult] = await Promise.all([
      modoSimplesEnvio
        ? Promise.resolve(null)
        : tryMarkWaitingAfterHumanOutbound({
            company_id,
            conversa_id: Number(conversa_id),
            texto: String(msg?.texto || '').trim(),
            criado_em: msg.criado_em,
            autor_usuario_id: Number(user_id),
            permitir_conteudo_sem_texto: true,
          }).catch(() => null),
      recalcularEMesclarModoSimples({
        company_id,
        conversa_id: Number(conversa_id),
        mensagemNova: msg,
        io: null,
      }).catch(() => null),
      supabase
        .from('conversas')
        .update({ lida: true, ultima_atividade: timestampAtividade })
        .eq('company_id', Number(company_id))
        .eq('id', Number(conversa_id)),
    ])

    // Emitir eventos para o frontend
    if (io) {
      const basePayload = {
        ...msg,
        conversa_id: msg.conversa_id ?? Number(conversa_id),
        status: msg.status || 'pending',
        status_mensagem: msg.status_mensagem || msg.status || 'pending',
        direcao: 'out',
        ...(clientTempId ? { client_temp_id: clientTempId } : {}),
        // Mesmo sem a coluna no banco, a bolha recebe a duração medida no upload.
        ...(audioDuracaoSec != null && msg.audio_duracao_sec == null
          ? { audio_duracao_sec: audioDuracaoSec }
          : {}),
      }
      const novaMsgPayload = await enrichMensagemComAutorUsuario(supabase, company_id, basePayload)
      emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', novaMsgPayload)
      
      const convPayload = anexarAssumirNoPayloadLista(aplicarAguardandoClienteNoPayload({
        id: Number(conversa_id),
        ultima_atividade: timestampAtividade,
        reordenar_suave: true,
      }, waitingAfterOutbound, {
        ...(modoSimplesResult?.conversa || {}),
        atendimento_modo_simples: modoSimplesEnvio,
        modo_simples_aguardando: modoSimplesResult?.modo_simples_aguardando ?? null,
      }), permEnvio)
      
      // Adicionar preview da última mensagem baseado no tipo
      if (msg.tipo === 'contact' && msg.contact_meta) {
        convPayload.ultima_mensagem_preview = {
          texto: msg.texto,
          criado_em: novaMsgPayload.criado_em,
          direcao: 'out',
          tipo: 'contact',
          contact_meta: msg.contact_meta,
        }
      } else if (msg.tipo === 'location' && (msg.location_meta || msg.url)) {
        convPayload.ultima_mensagem_preview = {
          texto: msg.texto,
          criado_em: novaMsgPayload.criado_em,
          direcao: 'out',
          tipo: 'location',
          ...(msg.location_meta ? { location_meta: msg.location_meta } : {}),
          ...(msg.url ? { url: msg.url } : {}),
        }
      } else {
        // Para outros tipos de mídia
        convPayload.ultima_mensagem_preview = {
          texto: msg.texto,
          criado_em: novaMsgPayload.criado_em,
          direcao: 'out',
          tipo: msg.tipo,
          ...(msg.url ? { url: msg.url } : {}),
          ...(msg.nome_arquivo ? { nome_arquivo: msg.nome_arquivo } : {}),
        }
      }
      
      emitirConversaAtualizada(io, company_id, conversa_id, convPayload, { skipAtualizarConversa: true })
    }

    const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, user_id)
    const instanceProvider = await resolveConversationProvider(company_id, whatsappInstanceId)
    const provider = getProvider({ provider: instanceProvider })
    const waCaption = captionWhatsappParaMidia({
      tipo,
      captionUsuarioTrim,
      usuarioNome,
    })
    const baseUrl = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/$/, '')
    const fullUrl = baseUrl ? `${baseUrl}${pathUrl}` : null
    const isLocalhost = /localhost|127\.0\.0\.1/i.test(baseUrl)
    // Para áudio/voice/video, prioriza sempre CDN da UltraMsg:
    // evita problemas de disponibilidade/headers em URLs próprias do backend
    // e melhora a reprodução no WhatsApp mobile e desktop.
    // O vídeo chega ao upload como MP4 H.264/AAC e o multipart informa video/mp4;
    // assim /messages/video não depende do APP_URL estar acessível naquele instante.
    const forceUploadMedia = shouldForceProviderUploadForMedia(tipo)

    const sendMediaWithUrl = (mediaUrl) => {
      const phone = telefoneParaEnvio
      const isAudioTipo = tipo === 'voice' || tipo === 'audio'
      const opts = {
        companyId: company_id,
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'atendimento_humano_midia',
        referenceId: `crm-${msg.id}`,
        returnDetails: true,
        ...(isAudioTipo ? { audioMeta: { originalName: fileWork.originalname, mimeType: fileWork.mimetype } } : {}),
      }
      const promise =
        tipo === 'voice' && provider.sendVoice
          ? provider.sendVoice(phone, mediaUrl, opts)
          : tipo === 'audio' && provider.sendAudio
          ? provider.sendAudio(phone, mediaUrl, opts)
          : tipo === 'sticker' && provider.sendSticker
            ? provider.sendSticker(phone, mediaUrl, { ...opts, stickerAuthor: 'ZapERP' })
            : tipo === 'imagem' && provider.sendImage
              ? provider.sendImage(phone, mediaUrl, waCaption, opts)
              : tipo === 'video' && provider.sendVideo
                ? provider.sendVideo(phone, mediaUrl, waCaption, { ...opts, returnDetails: true })
                : provider.sendFile
                  ? provider.sendFile(phone, mediaUrl, fileWork.originalname || '', {
                      ...opts,
                      caption: waCaption,
                      returnDetails: true,
                    })
                  : Promise.resolve({ ok: false, error: 'Envio de documento indisponível' })
      promise
        .then(async (result) => {
          const normalizedResult = typeof result === 'boolean'
            ? { ok: result, error: null, messageId: null }
            : (result || { ok: false, error: 'resultado_provider_vazio', messageId: null })
          const ok = normalizedResult.ok === true
          const waMessageId = normalizedResult?.messageId ? String(normalizedResult.messageId).trim() : null
          const hasTraceableMediaId = isRealWhatsAppId(waMessageId)
          const hasQueueMediaId = !!waMessageId && isUltramsgNumericQueueId(waMessageId)
          const nextStatus = ok ? (hasTraceableMediaId ? 'sent' : 'pending') : 'erro'
          const nextStatusMensagem = ok ? (hasTraceableMediaId ? 'sent' : 'sending') : 'erro'
          
          if (!ok) {
            console.warn('WhatsApp: falha ao enviar mídia', {
              phone: String(phone || '').slice(-12),
              tipo,
              mediaUrl: String(mediaUrl || '').slice(0, 180),
              erro: normalizedResult?.error || 'sem detalhes',
            })
          } else {
            console.log('✅ WhatsApp mídia enviada:', phone?.slice(-12), tipo, waMessageId ? `(${waMessageId})` : '')
          }
          
          // whatsapp_id só recebe ID real; queue ID numérico vai para provider_queue_id (reconciliação de ACK)
          await supabase
            .from('mensagens')
            .update({
              status: nextStatus,
              status_mensagem: nextStatusMensagem,
              ...(hasTraceableMediaId ? { whatsapp_id: waMessageId } : {}),
              ...(hasQueueMediaId ? { provider_queue_id: waMessageId } : {})
            })
            .eq('company_id', company_id)
            .eq('id', msg.id)

          const io2 = req.app?.get('io')
          if (io2) {
            const payload = {
              mensagem_id: msg.id,
              conversa_id: Number(conversa_id),
              status: nextStatus,
              status_mensagem: nextStatusMensagem,
              ...(hasTraceableMediaId ? { whatsapp_id: waMessageId } : {})
            }
            io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`).emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', payload)
          }

          if (ok && !hasTraceableMediaId) {
            schedulePendingOutboundReconciliation({
              companyId: company_id,
              mensagemId: msg.id,
              io: io2,
            })
          }

          // Rollout R2 (empresa 1): assim que a mídia enviada é confirmada (status sent),
          // espelha para o Cloudflare R2 na hora, sem esperar a varredura periódica.
          // No-op para outras empresas / R2 desligado. Mídia sem ID rastreável fica pending
          // e será espelhada pela varredura quando a reconciliação confirmar o envio.
          if (ok && hasTraceableMediaId) {
            try {
              const { scheduleR2MirrorIfNeeded } = require('../../services/mediaR2MirrorService')
              scheduleR2MirrorIfNeeded({ supabase, io: io2, company_id, mensagem_id: msg.id })
            } catch (_) { /* espelhamento é best-effort; nunca afeta o envio */ }
          }
        })
        .catch(async (e) => {
          console.error('WhatsApp enviar mídia (erro de rede/provider):', e?.message || e)
          await supabase.from('mensagens').update({ status: 'erro', status_mensagem: 'erro' }).eq('company_id', company_id).eq('id', msg.id)
          const io2 = req.app?.get('io')
          if (io2) {
            const payload = { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro', status_mensagem: 'erro' }
            io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`).emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', payload)
          }
        })
    }

    if (telefoneParaEnvio) {
      if (fullUrl && !isLocalhost && !forceUploadMedia) {
        setImmediate(() => sendMediaWithUrl(fullUrl))
      } else if ((!baseUrl || isLocalhost || forceUploadMedia) && fileWork.path) {
        if (provider?.uploadMedia) {
          setImmediate(async () => {
            try {
              const providerUploadFilename = tipo === 'video'
                ? (fileWork.filename || fileWork.originalname || 'video.mp4')
                : (fileWork.originalname || 'file')
              const result = await provider.uploadMedia(fileWork.path, providerUploadFilename, { companyId: company_id, whatsappInstanceId: whatsappInstanceId || undefined })
              if (result?.ok && result?.url) {
                console.log('[ULTRAMSG] Upload bem-sucedido, enviando mídia via CDN:', result.url.slice(0, 50) + '...')
                sendMediaWithUrl(result.url)
              } else {
                console.warn('[ULTRAMSG] Upload de mídia falhou:', {
                  ok: result?.ok,
                  error: result?.error,
                  filename: fileWork.originalname,
                  tipo,
                  forceUploadMedia
                })
                // Fallback seguro: se temos URL pública do backend, tenta enviar direto sem upload.
                if (tipo !== 'video' && fullUrl && !isLocalhost) {
                  console.warn('[ULTRAMSG] Tentando fallback com URL pública do backend após falha no upload.')
                  sendMediaWithUrl(fullUrl)
                } else {
                  console.warn('⚠️ UltraMsg uploadMedia falhou; mídia não enviada.', result?.error || '')
                  await supabase.from('mensagens').update({ status: 'erro', status_mensagem: 'erro' }).eq('company_id', company_id).eq('id', msg.id)
                  const io2 = req.app?.get('io')
                  if (io2) {
                    io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`).emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro', status_mensagem: 'erro' })
                  }
                }
              }
            } catch (e) {
              console.error('WhatsApp uploadMedia:', e)
              await supabase.from('mensagens').update({ status: 'erro', status_mensagem: 'erro' }).eq('company_id', company_id).eq('id', msg.id)
              const io2 = req.app?.get('io')
              if (io2) {
                io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`).emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro', status_mensagem: 'erro' })
              }
            }
          })
        } else if (!baseUrl && !forceUploadMedia) {
          console.warn('⚠️ APP_URL/BASE_URL não configurado; mídia não enviada ao WhatsApp.')
        } else {
          console.warn('⚠️ APP_URL é localhost e provider sem uploadMedia; mídia não enviada ao WhatsApp.')
        }
      } else if (!baseUrl) {
        console.warn('⚠️ APP_URL/BASE_URL não configurado; mídia não enviada ao WhatsApp.')
      }
    }

  // Não retornar mensagem completa no HTTP — evita duplicação (API + socket). Mensagem chega via nova_mensagem.
  return { ok: true, msg, aviso_whatsapp: avisoWhatsapp }
}

exports.enviarArquivo = async (req, res) => {
  try {
    const { id: conversa_id } = req.params
    const { company_id, id: user_id } = req.user
    const io = req.app.get('io')

    const filesRaw =
      req.files && Array.isArray(req.files) && req.files.length > 0
        ? req.files
        : req.file
          ? [req.file]
          : []
    const files = dedupeMulterFiles(filesRaw)

    if (!files.length) {
      const hint = 'Envie multipart/form-data com campo "file", "files" ou "audio" (múltiplos arquivos no mesmo pedido).'
      return res.status(400).json({ error: 'Arquivo não enviado. ' + hint })
    }

    if (files.length > MAX_ARQUIVOS_LOTE_ENVIO) {
      return res.status(400).json({ error: `Máximo ${MAX_ARQUIVOS_LOTE_ENVIO} arquivos por envio.` })
    }

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

    const { data: conversa } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, tipo, chat_lid, whatsapp_instance_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .single()

    if (!conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

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

    const tipoBody = String(req.body?.tipo || req.query?.tipo || '').toLowerCase().trim()
    const captionFromBody = String(req.body?.caption ?? req.body?.legenda ?? '')
      .trim()
      .slice(0, MAX_MEDIA_CAPTION_CHARS)
    const clientTempIds = parseClientTempIdsFromBody(req.body, files.length)
    const ids = []
    const results = []
    let avisoWhatsapp = null
    let hadFailure = false

    for (let i = 0; i < files.length; i++) {
      const raw = files[i]
      if (i === 0 && (tipoBody === 'sticker' || tipoBody === 'voice' || tipoBody === 'ptt' || tipoBody === 'video' || tipoBody === 'vídeo')) {
        raw.__tipoForcado = tipoBody === 'ptt' ? 'voice' : tipoBody
      }
      else if (raw.__tipoForcado) delete raw.__tipoForcado

      const perFileCaption = i === 0 ? captionFromBody : ''
      const clientTempId = clientTempIds[i] || null

      const r = await enviarArquivoProcessarUm(req, raw, {
        company_id,
        user_id,
        conversa_id,
        telefoneParaEnvio,
        whatsappInstanceId,
        io,
        captionUsuario: perFileCaption,
        clientTempId,
        permEnvio,
      })
      if (!r.ok) {
        hadFailure = true
        results.push({
          ok: false,
          client_temp_id: clientTempId,
          error: r.error || 'Falha ao enviar arquivo.',
          status: r.status || 400,
          index: i,
        })
        continue
      }
      ids.push(r.msg.id)
      const row = buildArquivoApiResultRow(
        { ...r.msg, conversa_id: r.msg.conversa_id ?? Number(conversa_id) },
        clientTempId
      )
      if (row) results.push(row)
      if (r.aviso_whatsapp) avisoWhatsapp = r.aviso_whatsapp
      if (i < files.length - 1) await new Promise((resolve) => setTimeout(resolve, 250))
    }

    if (!ids.length) {
      const firstErr = results.find((x) => x && x.ok === false)
      return res.status(firstErr?.status || 400).json({
        error: firstErr?.error || 'Nenhum arquivo foi enviado.',
        results,
        conversa_id: Number(conversa_id),
      })
    }

    const avisoPayload = avisoWhatsapp ? { aviso_whatsapp: avisoWhatsapp } : {}
    const basePayload = {
      ok: true,
      ids,
      id: ids[ids.length - 1],
      conversa_id: Number(conversa_id),
      count: ids.length,
      results,
      partial: hadFailure,
      ...avisoPayload,
    }

    if (ids.length === 1) {
      const only = results.find((x) => x?.ok) || null
      return res.json({
        ...basePayload,
        ...(only?.client_temp_id ? { client_temp_id: only.client_temp_id } : {}),
        ...(only?.tipo ? { tipo: only.tipo } : {}),
        ...(only?.url ? { url: only.url } : {}),
        ...(only?.nome_arquivo ? { nome_arquivo: only.nome_arquivo } : {}),
        ...(only?.texto != null ? { texto: only.texto } : {}),
      })
    }
    return res.json(basePayload)
  } catch (err) {
    console.error('Erro ao enviar arquivo:', err)
    return res.status(500).json({ error: 'Erro ao enviar arquivo' })
  }
}
