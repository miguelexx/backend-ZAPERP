/**
 * Processamento central de webhooks WhatsApp (UltraMSG na entrada atual).
 * O ficheiro mantém o nome histórico `webhookZapiController`; funções como `receberZapi`/`statusZapi` são o núcleo interno
 * após normalização em `webhookUltramsgController`. Não implica provider Z-API público.
 * @see ../docs/reference/ADR-LEGACY-NAMING.md
 *
 * Usado pelo webhookUltramsgController: UltraMSG normaliza payload e delega para este controlador.
 * Suporta: texto, imagem, áudio,
 * vídeo, documento, figurinha, reação, localização, contato, PTV, templates, botões, listas.
 * Suporta conversas individuais e de GRUPO.
 * Espelhamento WhatsApp Web: mensagens enviadas pelo celular (fromMe) TAMBÉM são
 * persistidas e emitidas via WebSocket; idempotência por (conversa_id, whatsapp_id).
 */

const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { syncUltraMsgContact } = require('../services/ultramsgSyncContact')
// getCompanyIdByInstanceId / getWhatsappInstanceByProviderInstanceId: agora só em webhookInbound/instanceResolve.js.
const { getStatus } = require('../services/ultramsgIntegrationService')
const { normalizePhoneBR, possiblePhonesBR } = require('../helpers/phoneHelper')
// extrairNomePrefixoTexto: usado no caminho fromMe self-echo (linhas ~1758/2010). O import se perdeu
// na modularização fase 1-4 (commit c9cf02d) — sem ele o eco fromMe estourava 500 (ReferenceError).
const { extrairNomePrefixoTexto } = require('../helpers/mensagemAtendenteNomeHelper')
const { getCanonicalPhone, getOrCreateCliente, findOrCreateConversation, mergeConversasIntoCanonico, mergeConversationLidToPhone } = require('../helpers/conversationSync')
// crmSync.syncLead: movido para controllers/webhookInbound/crmLeadInbound.js.
const { chooseBestName, isBadName, getDisplayName } = require('../helpers/contactEnrichment')
const { clienteTemNomeProtegido } = require('../helpers/clienteNomeProtecao')
const { selectClienteNomeFoto } = require('../helpers/clienteNomeColunas')
const { parseVcardForContact } = require('../helpers/vcardHelper')
const { resolvePeerPhone } = require('../helpers/conversationKeyHelper')
const { incrementarUnreadParaConversa, emitirParaUsuariosQuePodemVerConversa } = require('./chatController')
const { emitirMudancaSetorRealtime, setorRealtimeMudou } = require('../services/chat/realtime/chatRealtimeGateway')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../helpers/timestampApiCompat')
const { scheduleInboundWebPush } = require('../services/webPushDispatchService')
const {
  schedulePersistInboundMediaIfNeeded,
  tipoQualificaPersistencia,
} = require('../services/inboundMediaPersistenceService')
const {
  scheduleInboundMediaBackfill,
} = require('../services/inboundMediaBackfillService')

const {
  processIncomingMessage: processChatbotTriage,
  logBotAction,
} = require('../services/chatbotTriageService')
const { emitBotMensagemRealtime, emitReaberturaSemSetorRealtime } = require('../helpers/chatbotRealtimeEmitter')
const { clearReabertaFaltaInteracao } = require('../helpers/reabertaFaltaInteracaoHelper')
const { processarOptOut } = require('../services/optOutService')
const { processarRegras } = require('../services/regrasAutomaticasService')
const {
  loadChatbotTriageMergeAndAbsence,
  tryMarkWaitingAfterHumanOutbound,
  clearWaitingForClient,
  fetchLastAbsenceEncerramentoSnap,
  resolveReopenAssignmentAfterAbsence,
} = require('../services/absenceFinalizationService')
// aplicarModoSimplesNoPayload: movido para controllers/webhookInbound/realtimePayload.js.
const {
  recalcularStatusPorUltimaMensagem,
} = require('../services/atendimentoModoSimplesService')
const { isEnabled, FLAGS } = require('../helpers/featureFlags')
const {
  isMissingAguardandoCampanhaColumn,
  devePularChatbotPorCampanha,
} = require('../helpers/disparoConversaOrigem')
const { consumirPrimeiraRespostaCampanha } = require('../services/disparoConversaOrigemService')
const { parseNota, tentarRegistrarAvaliacao } = require('../services/avaliacaoService')
const {
  isUltramsgNumericQueueId,
  parseCrmReferenceMensagemId,
  isReconcilablePendingWhatsappId,
  areEquivalentWhatsAppIds,
  extractPhoneDigitsFromWhatsappMessageId,
} = require('../helpers/whatsappMessageIdHelper')
const {
  STATUS_RANK,
  normalizeRawAckStatus,
  normalizeMessageAckStatus,
  canonStatusForEmit,
  statusRank,
} = require('../helpers/messageStatusHelper')

// company_id NUNCA mais via ENV — resolvido por instanceId do payload em cada webhook
const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'
// Seleção enxuta para evitar payload desnecessário em caminhos quentes de webhook.
// IMPORTANTE: não depender de colunas opcionais para manter compatibilidade com bancos legados.
const WEBHOOK_MSG_SELECT = 'id, conversa_id, company_id, whatsapp_instance_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'

// Ordem de progresso dos ticks de status. Usado em statusZapi para evitar que um ack atrasado
// (ex.: "delivered" chegando depois de "read") regrida visualmente o status já persistido.
// STATUS_RANK importado de messageStatusHelper (inclui sending=0).

// whatsappIdLookup movido para controllers/webhookInbound/whatsappIdLookup.js (Fase 2 — doc 24).
const {
  isTraceableWhatsappMessageId,
  isRemoteMediaUrl,
  isLocalUploadMediaUrl,
  preserveMediaFieldsOnWebhookFallback,
  applyWhatsappInstanceFilter,
  applyWhatsappInstanceFilterOrLegacy,
  logAmbiguousWhatsappId,
  selectSingleMensagemByWhatsappId,
  updateSingleMensagemByWhatsappId,
  selectSingleMensagemByWhatsappIdRelaxed,
  patchMensagemStatusById,
} = require('./webhookInbound/whatsappIdLookup')

// fromMeReconcile+mediaMatch movidos para controllers/webhookInbound/fromMeReconcile.js (Fase 2 - doc 24).
const {
  normalizeMediaFileNameForMatch,
  normalizeMediaBaseNameForMatch,
  mediaFamilyForStorageTipo,
  whatsappIdCompativelParaReconcile,
  filterRowsForFromMeReconcile,
  findPendingOutboundByAckPhone,
  getCrmReferenceIdFromPayload,
  tryReconcileFromMeByCrmReferenceId,
  mapWebhookTypeToStorageTipo,
  findFromMeOutboundMediaCandidate,
} = require('./webhookInbound/fromMeReconcile')

// reopenPolicy movido para controllers/webhookInbound/reopenPolicy.js (Fase 1 — doc 24).
const { normalizeReopenText, shouldReopenFinishedConversation } = require('./webhookInbound/reopenPolicy')

// Log helpers movidos para controllers/webhookInbound/log.js (Fase 4 — doc 24).
const { logZapiCert, _logWebhook, _logWebhookSafe } = require('./webhookInbound/log')
// Helpers de origem "disparo" a partir do inbound → controllers/webhookInbound/disparoInbound.js.
const { mensagemInseridaEhPrimeiraDisparoWhatsappExterno, conversaTemAlgumaMensagemInbound, scheduleInboundDisparoHooks } = require('./webhookInbound/disparoInbound')
// Import de histórico do celular ao abrir conversa nova → controllers/webhookInbound/historyImport.js.
const { scheduleNewConversationHistoryImport } = require('./webhookInbound/historyImport')
// Captura de lead no CRM a partir do inbound → controllers/webhookInbound/crmLeadInbound.js.
const { scheduleInboundLeadCapture } = require('./webhookInbound/crmLeadInbound')
// Resolução do remetente (membro) em grupos → controllers/webhookInbound/groupSender.js.
const { resolveGroupSenderFields } = require('./webhookInbound/groupSender')
// Construção pura dos payloads de realtime (conversa_atualizada + nova_mensagem) → webhookInbound/realtimePayload.js.
const { buildConversaAtualizadaPayload, buildNovaMensagemPayload } = require('./webhookInbound/realtimePayload')
// Persistência da mensagem inbound (mapeamento puro + insert/retries/23505) → webhookInbound/persistMensagem.js.
const { applyInboundMediaFields, persistInboundMensagemRow, resolveEditedMensagemRow } = require('./webhookInbound/persistMensagem')
// Reconciliação de eco fromMe no fluxo received → controllers/webhookInbound/fromMeReceivedReconcile.js.
const { reconcileFromMeInReceived } = require('./webhookInbound/fromMeReceivedReconcile')
// Reply/citação (reply_meta) do payload → controllers/webhookInbound/replyMeta.js.
const { buildWebhookReplyMeta } = require('./webhookInbound/replyMeta')
// Status ACK (resolução pura + update por whatsapp_id) → controllers/webhookInbound/statusApply.js.
const { resolveEffectiveStatus, applyAckStatusByWaId } = require('./webhookInbound/statusApply')
// Resolução de tenant (empresa/instância) do topo do receberZapi → controllers/webhookInbound/instanceResolve.js.
const { resolveInboundTenant } = require('./webhookInbound/instanceResolve')
// Callback de foto de grupo (payload só { groupId, groupPhoto }) → controllers/webhookInbound/groupPhoto.js.
const { handleGroupPhotoOnlyPayload } = require('./webhookInbound/groupPhoto')

// Funções puras de payload movidas para controllers/webhookInbound/payload.js (Fase 1/4 — doc 24).
const { isGroupPayload, pickGroupChatId, looksLikeBRPhoneDigits, resolveConversationKeyFromZapi, extractMessage, getPayloads, hasDestFields } = require('./webhookInbound/payload')
const { shouldTriggerChatbotForInbound, inspectInboundOrigin } = require('./webhookInbound/chatbotInboundGuard')


exports.receberZapi = async (req, res) => {
  try {
    const body = req.body || {}
    // 1) Resolver instanceId e company_id — SEMPRE explícito, NUNCA do body (instanceResolve.js).
    const _tenant = await resolveInboundTenant(req)
    if (_tenant.ignored) return res.status(_tenant.ignored.status).json(_tenant.ignored.body)
    const { instanceId } = _tenant
    let company_id = _tenant.company_id
    let whatsapp_instance_id = _tenant.whatsapp_instance_id
    let whatsapp_instance_is_default = _tenant.whatsapp_instance_is_default

    // 2) Log DEV uma linha — diagnóstico sem vazar tokens
    const firstPayload = getPayloads(body)[0] || body
    const msgId = firstPayload?.messageId ?? firstPayload?.zaapId ?? firstPayload?.id ?? ''
    const phoneTail = (firstPayload?.phone || '').toString().trim().slice(-10)
    console.log('[ULTRAMSG_WEBHOOK]', JSON.stringify({
      instanceId: instanceId.slice(0, 20) + (instanceId.length > 20 ? '…' : ''),
      companyId: company_id,
      type: body.type || body.event || firstPayload?.type || 'unknown',
      messageId: msgId ? String(msgId).slice(0, 20) + (String(msgId).length > 20 ? '…' : '') : null,
      phone: phoneTail ? '…' + phoneTail : null,
      fromMe: firstPayload?.fromMe ?? firstPayload?.key?.fromMe ?? null
    }))

    // Salva no buffer de diagnóstico (GET /webhooks/ultramsg/debug)
    _logWebhook({
      type: body.type || body.event || 'unknown',
      phone: (body.phone || '').toString().slice(-12),
      fromMe: body.fromMe ?? body.key?.fromMe,
      hasText: !!(body.text?.message || body.message || body.body),
      hasMedia: !!(body.image || body.audio || body.video || body.document || body.sticker),
      status: body.status || body.ack,
      ip: req.ip || req.socket?.remoteAddress || '?',
      rawBody: WHATSAPP_DEBUG ? JSON.stringify(body).slice(0, 600) : undefined
    })

    // Callback específico de atualização de foto de grupo (payload só { groupId, groupPhoto })
    // → controllers/webhookInbound/groupPhoto.js. Responde a HTTP e encerra quando trata o caso.
    if (await handleGroupPhotoOnlyPayload(req, res, company_id)) return

    const payloads = getPayloads(body)
    let lastResult = { ok: true }

    let separarMensagensDisparadasEmpresa = false
    try {
      const { data: empCfgRow, error: empCfgErr } = await supabase
        .from('empresas')
        .select('separar_mensagens_disparadas')
        .eq('id', company_id)
        .maybeSingle()
      if (!empCfgErr && empCfgRow) separarMensagensDisparadasEmpresa = !!empCfgRow.separar_mensagens_disparadas
    } catch (_) {
      separarMensagensDisparadasEmpresa = false
    }

    for (const payload of payloads) {
      // Normaliza status Z-API / UltraMSG para canônico interno (inclui device→delivered, server→sent)
      const normalizeZapiStatus = (raw) => normalizeRawAckStatus(raw)

      // Helper: emite status_mensagem via socket (empresa + conversa + usuario do autor para garantir tempo real)
      const emitStatusMsg = (msg, statusNorm, whatsappId = null) => {
        const io = req.app.get('io')
        if (io && msg) {
          const payload = {
            mensagem_id: msg.id,
            conversa_id: msg.conversa_id,
            status: statusNorm,
            status_mensagem: statusNorm,
            ...(msg.whatsapp_id ? { whatsapp_id: msg.whatsapp_id } : {}),
            ...(whatsappId ? { whatsapp_id: whatsappId } : {})
          }
          let chain = io.to(`empresa_${msg.company_id}`).to(`conversa_${msg.conversa_id}`)
          if (msg.autor_usuario_id != null) chain = chain.to(`usuario_${msg.autor_usuario_id}`)
          chain.emit('status_mensagem', payload)
        }
      }

      // Atualiza status por whatsapp_id sem regressão de ACK → controllers/webhookInbound/statusApply.js.
      // Binding fino: fixa supabase + tenant do payload; call-sites continuam (waId, statusNorm, opts).
      const updateStatusByWaId = (waId, statusNorm, opts = {}) =>
        applyAckStatusByWaId(supabase, { company_id, whatsapp_instance_id }, waId, statusNorm, opts)

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
      console.log(`[ULTRAMSG] 🔍 pipeline: type="${payloadType || '(vazio)'}" status="${payloadStatusRaw || '(vazio)'}" fromMe=${payloadFromMe} hasContent=${hasMessageContent} isStatus=${isStatusCallback} phone=${String(payload?.phone || '').slice(-10) || '(vazio)'}`)

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
            await mergeConversationLidToPhone(supabase, company_id, lidPartStatus, canonicalStatus, { io, whatsapp_instance_id })
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
        const effectiveStatus = msg?._effective_status || statusNorm
        if (msg) {
          emitStatusMsg(msg, effectiveStatus, String(msgId))
          console.log(`✅ Z-API status ${effectiveStatus.toUpperCase()} → msg ${msg.id} (conversa ${msg.conversa_id})`)
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
        lastResult = { ok: true, statusUpdate: true, messageId: String(msgId), status: effectiveStatus }
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
            const existByWaId = await updateStatusByWaId(String(delivMsgId), 'sent', {
              context: 'deliverycallback.fromMe.no_content',
            })
            if (existByWaId?.id) {
              const effectiveStatus = existByWaId._effective_status || 'sent'
              const io = req.app.get('io')
              if (io) {
                const statusEventPayload = {
                  mensagem_id: existByWaId.id,
                  conversa_id: existByWaId.conversa_id,
                  status: effectiveStatus,
                  status_mensagem: effectiveStatus,
                  whatsapp_id: String(delivMsgId)
                }
                let chain = io.to(`empresa_${existByWaId.company_id}`).to(`conversa_${existByWaId.conversa_id}`)
                if (existByWaId.autor_usuario_id != null) chain = chain.to(`usuario_${existByWaId.autor_usuario_id}`)
                chain.emit('status_mensagem', statusEventPayload)
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
        const statusUpdate = await updateStatusByWaId(String(messageId), statusNorm, {
          returnResult: true,
          context: 'deliverycallback.status',
        })
        let msg = statusUpdate.data || null
        let error = statusUpdate.error || null
        let statusForEmit = statusUpdate.effectiveStatus || statusNorm

        // 1.1) Mesclagem LID→PHONE: sempre que temos chatLid + canonicalPhone no payload
        const lidFromPayload = String(payload?.phone ?? payload?.chatLid ?? payload?.chat?.id ?? payload?.data?.phone ?? payload?.value?.phone ?? '').trim()
        const lidPartDeliv = lidFromPayload.endsWith('@lid') ? lidFromPayload.replace(/@lid$/i, '').trim() : ''
        const canonicalDeliv = peerDeliv || (phoneDest && !String(phoneDest).startsWith('120') ? getCanonicalPhone(phoneDest) : null)
        if (lidPartDeliv && canonicalDeliv) {
          try {
            const io = req.app.get('io')
            // DeliveryCallback: NÃO enriquecer nome/foto — apenas merge LID→PHONE (evita regressão de nome)
            const mergeRes = await mergeConversationLidToPhone(supabase, company_id, lidPartDeliv, canonicalDeliv, { io, whatsapp_instance_id })
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
        // CRÍTICO: preservar nome_contato_cache e foto — nunca sobrescrever com vazio (evita contato sumir da lista).
        if (!error && msg && phoneDest) {
          try {
            const { data: convRow } = await supabase
              .from('conversas')
              .select('id, telefone, cliente_id, nome_contato_cache, foto_perfil_contato_cache')
              .eq('company_id', company_id)
              .eq('id', msg.conversa_id)
              .maybeSingle()
            const canonical = getCanonicalPhone(phoneDest)
            if (convRow && canonical) {
              const telAtual = convRow.telefone ? String(convRow.telefone).trim() : ''
              const isLidTel = telAtual.toLowerCase().startsWith('lid:')
              const isGroupDest = String(phoneDest).startsWith('120')
              const nomeCache = convRow.nome_contato_cache ? String(convRow.nome_contato_cache).trim() : null
              const fotoCache = convRow.foto_perfil_contato_cache ? String(convRow.foto_perfil_contato_cache).trim() : null
              if ((!telAtual || isLidTel) && !isGroupDest) {
                // DeliveryCallback: passar nome/foto existentes para getOrCreateCliente (evita criar cliente com nome=número)
                const { cliente_id: cid } = await getOrCreateCliente(supabase, company_id, canonical, {
                  nome: nomeCache || undefined,
                  nomeSource: 'chatName',
                  foto_perfil: fotoCache || undefined
                })
                await supabase
                  .from('conversas')
                  .update({ telefone: canonical, ...(cid ? { cliente_id: cid } : {}) })
                  .eq('company_id', company_id)
                  .eq('id', convRow.id)
                const io = req.app.get('io')
                if (io) {
                  // Sempre incluir nome/foto no emit para não sobrescrever com vazio no frontend
                  const emitPayload = {
                    id: convRow.id,
                    telefone: canonical,
                    ...(cid ? { cliente_id: cid } : {})
                  }
                  if (nomeCache) {
                    emitPayload.nome_contato_cache = nomeCache
                    emitPayload.contato_nome = nomeCache
                  }
                  if (fotoCache) {
                    emitPayload.foto_perfil_contato_cache = fotoCache
                    emitPayload.foto_perfil = fotoCache
                  }
                  await emitirParaUsuariosQuePodemVerConversa(io, company_id, convRow.id, 'conversa_atualizada', emitPayload)
                }
              } else if ((!telAtual || isLidTel) && isGroupDest) {
                await supabase
                  .from('conversas')
                  .update({ telefone: canonical })
                  .eq('company_id', company_id)
                  .eq('id', convRow.id)
                const io = req.app.get('io')
                if (io) {
                  const emitPayload = { id: convRow.id, telefone: canonical }
                  if (nomeCache) { emitPayload.nome_contato_cache = nomeCache; emitPayload.contato_nome = nomeCache }
                  if (fotoCache) { emitPayload.foto_perfil_contato_cache = fotoCache; emitPayload.foto_perfil = fotoCache }
                  await emitirParaUsuariosQuePodemVerConversa(io, company_id, convRow.id, 'conversa_atualizada', emitPayload)
                }
              }
            }
          } catch (e) {
            console.warn('[Z-API] DeliveryCallback: falha ao atualizar telefone da conversa:', e?.message || e)
          }
        }

        // 2) se não achou, prioriza referenceId CRM quando o provedor envia esse vínculo.
        if (!error && !msg) {
          const byReference = await tryReconcileFromMeByCrmReferenceId(supabase, {
            company_id,
            conversa_id: null,
            whatsapp_instance_id,
            payload,
            whatsappIdStr: String(messageId),
            statusPayload: statusNorm,
          })
          if (byReference?.id) {
            msg = byReference
            statusForEmit = byReference.status || byReference.status_mensagem || statusForEmit
          }
        }

        // 3) se não achou, tenta reconciliar mensagem out sem whatsapp_id na conversa de destino.
        // Só aplica quando houver exatamente uma candidata; com duas ou mais, o ACK é ambíguo.
        if (!error && !msg && phoneDest) {
          try {
            const isGroup = String(phoneDest).startsWith('120')
            const phones = isGroup ? [phoneDest] : possiblePhonesBR(phoneDest)
            let qConv = supabase
              .from('conversas')
              .select('id, whatsapp_instance_id')
              .eq('company_id', company_id)
              .neq('status_atendimento', 'fechada')
              .order('id', { ascending: false })
              .limit(3)
            qConv = applyWhatsappInstanceFilterOrLegacy(qConv, whatsapp_instance_id)
            if (phones.length > 0) qConv = qConv.in('telefone', phones)
            const { data: convs } = await qConv
            const convId = Array.isArray(convs) && convs[0]?.id ? convs[0].id : null

            if (convId) {
              const ts = Date.now()
              const fromIso = new Date(ts - 5 * 60 * 1000).toISOString()
              const toIso = new Date(ts + 5 * 60 * 1000).toISOString()
              let candQuery = supabase
                .from('mensagens')
                .select('id, conversa_id, company_id, autor_usuario_id, status, status_mensagem')
                .eq('company_id', company_id)
                .eq('conversa_id', convId)
                .eq('direcao', 'out')
                .is('whatsapp_id', null)
                .gte('criado_em', fromIso)
                .lte('criado_em', toIso)
                .order('criado_em', { ascending: false })
                .order('id', { ascending: false })
                .limit(2)
              candQuery = applyWhatsappInstanceFilterOrLegacy(candQuery, whatsapp_instance_id)
              const { data: candRows } = await candQuery

              const candidates = Array.isArray(candRows) ? candRows : []
              const picked = candidates.length === 1 ? candidates[0] : null
              if (!picked && candidates.length > 1) {
                console.warn('[Z-API] DeliveryCallback fallback ambíguo; ACK ignorado para evitar associar mensagem errada', {
                  company_id,
                  conversa_id: convId,
                  messageId: String(messageId).slice(0, 24),
                  count: candidates.length,
                })
              }
              if (picked?.id) {
                const currentStatus = picked.status || picked.status_mensagem || 'pending'
                const effectiveStatus = resolveEffectiveStatus(currentStatus, statusNorm)
                const patched = await patchMensagemStatusById(supabase, {
                  company_id,
                  mensagem_id: picked.id,
                  effectiveStatus,
                  whatsapp_id: String(messageId),
                  select: 'id, conversa_id, company_id, autor_usuario_id, status, status_mensagem, whatsapp_id',
                })
                msg = patched.data || null
                statusForEmit = effectiveStatus
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
              status: statusForEmit,
              status_mensagem: statusForEmit,
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

        lastResult = { ok: true, delivery: true, messageId: String(messageId), status: statusForEmit }
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
        console.log('[ULTRAMSG_WEBHOOK]', JSON.stringify({ companyIdResolved: company_id, messageId: msgId ? String(msgId).slice(0, 20) : null, status: statusNorm, note: 'self_echo' }))
        if (msgId) {
          const { data: existing } = await selectSingleMensagemByWhatsappId(supabase, {
            company_id,
            whatsapp_id: String(msgId),
            whatsapp_instance_id,
            select: 'id, conversa_id, company_id, whatsapp_id',
            context: 'self_echo',
          })
          if (existing) {
            if (statusNorm) {
              const updated = await updateStatusByWaId(String(msgId), statusNorm)
              if (updated) emitStatusMsg(updated, updated._effective_status || statusNorm, String(msgId))
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
        chatPhoto,
        contactMeta,
        locationMeta
      } = extracted

      // Newsletters (canais) e Status/broadcast não são conversas de atendimento — ignorar silenciosamente
      if (isNewsletter) {
        console.log('[Z-API] ⏭️ isNewsletter=true — newsletter ignorada:', phone || '(sem phone)')
        continue
      }
      const inboundOrigin = inspectInboundOrigin(payload)
      if (inboundOrigin.isStatusBroadcast) {
        console.log('[ULTRAMSG] ⏭️ status/broadcast — não é conversa privada (chatbot não dispara)', {
          fromMe,
          type,
          phoneTail: phone ? String(phone).slice(-8) : null,
        })
        lastResult = { ok: true, ignored: 'status_broadcast' }
        continue
      }

      // ── Log de resolução de chave — SEMPRE visível (crítico para diagnóstico) ──
      console.log('[ULTRAMSG] 📞 resolveKey:', {
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
      console.log('📩 ULTRAMSG mensagem recebida:', phone, fromMe ? '(enviada por nós)' : '(recebida)', texto?.slice(0, 50))
    }

    let cliente_id = null
    let pendingContactSync = null
    let nomeParaCache = null // Nome resolvido (syncUltramsg ou payload) para atualizar cache da conversa
    let nomeSourceParaCache = null
    let clienteNomeProtegido = false
    let clienteNomeAtual = null

    if (!isGroup) {
      // LID sintético (@lid): mensagem espelhada enviada pelo celular sem número real conhecido.
      // Chave "lid:XXXX" NÃO é um número de telefone → nunca criar/vincular cliente.
      const isLidKey = String(phone).startsWith('lid:')

      if (isLidKey) {
        console.log('[Z-API] LID key — conversa sem cliente vinculado (número real não disponível):', phone)
      } else {
        const nomePayloadRaw = fromMe
          ? (payload.name ?? payload.formattedName ?? payload.chatName ?? payload.chat?.name ?? payload.groupName ?? payload.short ?? payload.notifyName ?? payload.senderName ?? payload.displayName ?? payload.pushName ?? null)
          : (payload.name ?? payload.formattedName ?? payload.short ?? payload.notifyName ?? payload.senderName ?? payload.chatName ?? payload.chat?.name ?? payload.displayName ?? payload.pushName ?? null)
        let nomePayload = nomePayloadRaw ? String(nomePayloadRaw).trim() : null
        let nomeSource = (payload.name && String(payload.name).trim()) ? 'name' : (fromMe ? 'chatName' : 'senderName')

        // Sincroniza nome/foto: UltraMsg webhook NUNCA traz profile picture — usar GET /contacts/image.
        // Passar chatId (ex. payload.chatId = data.from) quando disponível para chamada correta à API.
        if (phone) {
          const syncChatId = !isGroup && payload.chatId && String(payload.chatId).trim().endsWith('@c.us')
            ? String(payload.chatId).trim()
            : phone
          const syncTimeoutMs = fromMe ? 6000 : 5000
          const syncOpts = { skipCache: true }
          if (fromMe) syncOpts.skipCache = true
          senderPhoto = null
          try {
            const syncResult = await Promise.race([
              syncUltraMsgContact(syncChatId, company_id, syncOpts),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), syncTimeoutMs))
            ])
            // syncUltraMsgContact pode retornar telefone como fallback quando API não tem nome — ignorar e usar pushname do payload
            const syncNome = syncResult?.nome ? String(syncResult.nome).trim() : null
            if (syncNome && !isBadName(syncNome)) {
              nomePayload = syncNome
              nomeSource = 'syncUltramsg'
              nomeParaCache = nomePayload
              nomeSourceParaCache = 'syncUltramsg'
            }
            // Foto de perfil só vem de GET /contacts/image — o webhook UltraMSG não traz.
            const syncFoto = syncResult?.foto_perfil && String(syncResult.foto_perfil).trim()
            if (syncFoto && syncFoto.startsWith('http')) senderPhoto = syncFoto
          } catch (_) {
            // fallback: usa nome do payload (senderName/chatName) — SOMENTE quando !fromMe (payload traz pushname do contato)
            // Quando fromMe: payload traz NOSSO nome — nunca usar como nome do contato
          }
        }
        // Quando fromMe: nome do payload é do remetente (nós) — só usar nome vindo do sync (destinatário)
        if (nomePayload && !nomeParaCache && !fromMe) {
          nomeParaCache = nomePayload
          nomeSourceParaCache = nomeSource
        }

        const pushnameRaw = payload.notifyName ?? payload.pushName ?? payload.notify ?? nomePayloadRaw
        const pushnamePayload = pushnameRaw ? String(pushnameRaw).trim() : null
        const createdCli = await getOrCreateCliente(supabase, company_id, phone, {
          nome: nomePayload,
          nomeSource,
          fromMe,
          pushname: pushnamePayload || undefined,
          foto_perfil: senderPhoto || undefined
        })
        cliente_id = createdCli?.cliente_id || null
        clienteNomeProtegido = createdCli?.nome_protegido === true
        clienteNomeAtual = createdCli?.nome || null
        if (clienteNomeProtegido && clienteNomeAtual) {
          nomeParaCache = clienteNomeAtual
        }
        if (cliente_id) {
          const chatIdForSync = !isGroup && payload.chatId && String(payload.chatId).trim().endsWith('@c.us')
            ? String(payload.chatId).trim()
            : (payload.key?.remoteJid && String(payload.key.remoteJid).trim().endsWith('@c.us') ? String(payload.key.remoteJid).trim() : null)
          pendingContactSync = { phone, cliente_id, chatId: chatIdForSync || phone }
        }
        // Pipeline NUNCA aborta por cliente: mesmo sem cliente_id, mensagem e socket seguem
      }
    }

    // 2) Conversa — uma única conversa por contato; quando Z-API envia chatLid/senderLid, unificar por chat_lid
    //    para que "recebido" (phone real) e "enviado pelo celular" (phone @lid) caiam no mesmo chat.
    //    Sempre priorizar número real (phone) do payload; LID só para vincular/atualizar.
    let conversa_id = null
    let departamento_id = null
    let departamentoIdAntesRealtime = null
    let setorRealtimeJaEmitido = false
    let isNewConversation = false

    const lidFromPhone = String(payload?.chatLid ?? payload?.phone ?? payload?.chat?.id ?? payload?.key?.remoteJid ?? '').trim()
    const lidFromSender = String(payload?.senderLid ?? '').trim()
    const lidRaw = lidFromPhone.endsWith('@lid') ? lidFromPhone : (lidFromSender.endsWith('@lid') ? lidFromSender : '')
    const lidPart = lidRaw ? lidRaw.replace(/@lid$/i, '').trim() : (phone.startsWith('lid:') ? phone.slice(4) : null)

    try {
      if (lidPart) {
        const { data: convByLidRows } = await supabase
          .from('conversas')
          .select('id, departamento_id, telefone, whatsapp_instance_id')
          .eq('company_id', company_id)
          .eq('chat_lid', lidPart)
          .order('ultima_atividade', { ascending: false })
          .limit(20)
        const convByLid = (Array.isArray(convByLidRows) ? convByLidRows : []).find((row) =>
          !whatsapp_instance_id ||
          Number(row?.whatsapp_instance_id) === Number(whatsapp_instance_id) ||
          (whatsapp_instance_is_default && row?.whatsapp_instance_id == null)
        ) || null

        const hasRealPhone = phone && !phone.startsWith('lid:')
        let convByPhone = null
        if (hasRealPhone) {
          const canonical = getCanonicalPhone(phone)
          const variants = canonical ? possiblePhonesBR(canonical) : []
          const list = variants.length > 0 ? variants : [phone]
          const { data: rows } = await supabase
            .from('conversas')
            .select('id, departamento_id, telefone, whatsapp_instance_id')
            .eq('company_id', company_id)
            .in('telefone', list)
            .order('ultima_atividade', { ascending: false })
            .limit(20)
          convByPhone = (Array.isArray(rows) ? rows : []).find((row) =>
            !whatsapp_instance_id ||
            Number(row?.whatsapp_instance_id) === Number(whatsapp_instance_id) ||
            (whatsapp_instance_is_default && row?.whatsapp_instance_id == null)
          ) || null
        }

        if (convByLid && convByPhone && convByLid.id !== convByPhone.id) {
          await mergeConversasIntoCanonico(supabase, company_id, convByPhone.id, [convByLid.id], {
            io: req.app.get('io'),
          })
          await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', convByPhone.id).eq('company_id', company_id)
          conversa_id = convByPhone.id
          departamento_id = convByPhone.departamento_id ?? null
          isNewConversation = false
          console.log('[Z-API] 🔗 Unificado por chat_lid: conv LID mesclada em conv telefone', { conversa_id, lidPart })
        } else if (convByLid && hasRealPhone) {
          // Temos número real + conv com chat_lid: atualizar telefone se estava lid e usar.
          const canonical = getCanonicalPhone(phone)
          if (canonical) {
            await supabase.from('conversas').update({ telefone: canonical, chat_lid: lidPart }).eq('id', convByLid.id).eq('company_id', company_id)
          } else {
            await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', convByLid.id).eq('company_id', company_id)
          }
          conversa_id = convByLid.id
          departamento_id = convByLid.departamento_id ?? null
          isNewConversation = false
        } else if (convByLid && !hasRealPhone) {
          // LID-only (contato enviou, Z-API mandou só @lid): usar conversa existente com esse chat_lid.
          // Evita duplicar: quando fromMe criou conv com telefone real + chat_lid, mensagem do contato cai na mesma.
          conversa_id = convByLid.id
          departamento_id = convByLid.departamento_id ?? null
          isNewConversation = false
          console.log('[Z-API] 🔗 LID-only: reutilizando conv existente por chat_lid', { conversa_id, lidPart })
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
          chatLid: lidPart || null,
          whatsapp_instance_id,
          whatsapp_instance_is_default,
          logPrefix: `[Z-API fromMe=${fromMe}]`,
          // Sempre aberta ao criar; mensagem_disparada só após insert se for 1ª msg e WhatsApp externo (sem autor).
          initial_status_atendimento: 'aberta',
          io: req.app.get('io'),
        })

        if (!syncResult) {
          console.error('[Z-API] findOrCreateConversation retornou null para phone:', phone)
          // IMPORTANTE: payload é 1 de N num lote (ver getPayloads) — abortar a requisição aqui
          // descartaria as demais mensagens do lote. Pula só esta e segue para a próxima.
          lastResult = { ok: false, error: 'Não foi possível identificar conversa para o número' }
          continue
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

      // Se grupo sem nome, busca em background (UltraMsg nem sempre envia chatName no webhook)
      if (isGroup && !nomeGrupo && conversa_id) {
        const io = req.app.get('io')
        if (io) {
          setImmediate(() => {
            const { syncConversationGroupOnJoin } = require('../services/ultramsgGroupsSyncService')
            syncConversationGroupOnJoin(supabase, conversa_id, company_id, io, { skipIfRecent: false }).catch(() => {})
          })
        }
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

      // Cache nome/foto do contato. Prioriza nome da API (syncUltramsg = como salvo no celular).
      if (!isGroup && conversa_id && (nomeParaCache || senderName || senderPhoto)) {
        const { data: convAtual } = await supabase
          .from('conversas')
          .select('nome_contato_cache, foto_perfil_contato_cache')
          .eq('id', conversa_id)
          .eq('company_id', company_id)
          .maybeSingle()
        const cacheUpdates = {}
        const nomeCandidato = (nomeParaCache && String(nomeParaCache).trim()) || (senderName && String(senderName).trim())
        const sourceCache = nomeSourceParaCache || ((payload.name && String(payload.name).trim()) ? 'name' : (fromMe ? 'chatName' : 'senderName'))
        if (clienteNomeProtegido) {
          if (clienteNomeAtual && clienteNomeAtual !== (convAtual?.nome_contato_cache || '')) {
            cacheUpdates.nome_contato_cache = clienteNomeAtual
          }
        } else if (nomeCandidato) {
          const { name: bestNome, decision } = chooseBestName(
            convAtual?.nome_contato_cache || null,
            String(nomeCandidato).trim(),
            sourceCache,
            { fromMe, company_id, telefoneTail: String(phone).replace(/\D/g, '').slice(-6) || null }
          )
          if (bestNome && decision === 'updated') cacheUpdates.nome_contato_cache = bestNome
        }
        const fotoCacheVazia = !convAtual?.foto_perfil_contato_cache || !String(convAtual.foto_perfil_contato_cache).trim()
        if (fotoCacheVazia && senderPhoto && String(senderPhoto).trim().startsWith('http')) {
          // Preferir foto já estável em clientes antes da URL fresca do sync (evita gravar foto errada/CDN).
          let fotoParaCache = String(senderPhoto).trim()
          if (cliente_id) {
            try {
              const { data: cliFoto } = await supabase
                .from('clientes')
                .select('foto_perfil')
                .eq('id', cliente_id)
                .eq('company_id', company_id)
                .maybeSingle()
              const existente = cliFoto?.foto_perfil ? String(cliFoto.foto_perfil).trim() : ''
              if (existente.startsWith('http')) fotoParaCache = existente
            } catch (_) {}
          }
          cacheUpdates.foto_perfil_contato_cache = fotoParaCache
        }
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
          const novaConversaPayload = {
            id: conversa_id,
            telefone: telefoneForEmit,
            ...(isLidPhone ? { telefone_lid: true } : {}),
            tipo: isGroup ? 'grupo' : 'cliente',
            nome_grupo: isGroup ? (nomeGrupo || null) : null,
            foto_grupo: isGroup ? (chatPhoto || null) : null,
            contato_nome: isGroup ? (nomeGrupo || phone || 'Grupo') : (clienteNomeProtegido && clienteNomeAtual ? clienteNomeAtual : (nomeParaCache || senderName || payload?.chatName || phone || null)),
            foto_perfil: isGroup ? null : (senderPhoto || null),
            unread_count: unreadInicial,
            tags: [],
          }
          const emittedNovaConversa = await emitirParaUsuariosQuePodemVerConversa(
            io,
            company_id,
            conversa_id,
            io.EVENTS?.NOVA_CONVERSA || 'nova_conversa',
            novaConversaPayload
          )
          if (!emittedNovaConversa && !isGroup) {
            io.to(`empresa_${company_id}`).emit(io.EVENTS?.NOVA_CONVERSA || 'nova_conversa', novaConversaPayload)
          }
        }

        // Captura de lead: nova conversa individual iniciada pelo cliente (inbound).
        // Só quando é contato real (!isGroup), o cliente falou (!fromMe) e temos cliente_id.
        // → controllers/webhookInbound/crmLeadInbound.js (setImmediate, fire-and-forget).
        if (!isGroup && !fromMe && cliente_id) {
          scheduleInboundLeadCapture({
            companyId: company_id,
            conversaId: conversa_id,
            nomeParaCache,
            senderName,
            chatName: payload?.chatName,
            phone,
          })
        }
      }
    } catch (errConv) {
      console.error('[Z-API] ❌ Erro ao obter/criar conversa:', errConv?.message || errConv)
      // IMPORTANTE: payload é 1 de N num lote (ver getPayloads) — abortar a requisição aqui
      // descartaria as demais mensagens do lote. Pula só esta e segue para a próxima.
      lastResult = { ok: false, error: 'Erro ao obter conversa' }
      continue
    }

    // Idempotência de EFEITOS COLATERAIS antes do insert.
    // A dedup por whatsapp_id que evita linha duplicada só roda mais abaixo (ver ~2775), mas a
    // reabertura de conversa encerrada e o chatbot de triagem executam ANTES dela. Sem esta guarda,
    // uma REENTREGA/replay de um inbound antigo (reconexão da instância, retry de webhook UltraMSG,
    // re-sync) dispara boas-vindas/menu "sem o cliente ter mandado mensagem" — o bug relatado.
    // Mensagem genuinamente nova tem whatsapp_id inédito e nunca é bloqueada aqui.
    let inboundReentregue = false
    if (!fromMe && !isGroup && conversa_id && messageId) {
      const waIdReentrega = String(messageId).trim()
      if (waIdReentrega) {
        const { data: jaProcessado } = await selectSingleMensagemByWhatsappId(supabase, {
          company_id,
          whatsapp_id: waIdReentrega,
          whatsapp_instance_id,
          select: 'id, direcao',
          context: 'received.preprocess.idempotency',
        })
        if (jaProcessado?.id) {
          inboundReentregue = true
          console.log('[Z-API] ⏭️ inbound reentregue/replay — pulando reabertura e chatbot (sem novo menu de boas-vindas)', {
            conversa_id,
            company_id,
            whatsappIdTail: waIdReentrega.slice(-8),
          })
        }
      }
    }

    // Captura avaliação (nota 0-10) e reabertura automática em conversa encerrada (fechada ou finalizada)
    let conversaReabertaAposFinalizacao = false
    let reopenedFromAbsence = false
    let absenceReopenExplicitlyDisabled = false
    if (!fromMe && !isGroup && conversa_id && !inboundReentregue) {
      const { data: convStatus } = await supabase
        .from('conversas')
        .select('id, status_atendimento, cliente_id, departamento_id, finalizacao_motivo, atendente_id')
        .eq('id', conversa_id)
        .eq('company_id', company_id)
        .maybeSingle()
      const st = convStatus?.status_atendimento
      const motivoFinalizacao = String(convStatus?.finalizacao_motivo || '').trim().toLowerCase()

      if (st === 'aguardando_cliente') {
        const { data: retomadaManual } = await supabase
          .from('conversas')
          .update({
            status_atendimento: 'em_atendimento',
            aguardando_cliente_desde: null,
          })
          .eq('id', conversa_id)
          .eq('company_id', company_id)
          .eq('status_atendimento', 'aguardando_cliente')
          .select()
          .maybeSingle()
        if (retomadaManual?.id) {
          await supabase.from('historico_atendimentos').insert({
            conversa_id,
            usuario_id: null,
            acao: 'retomada_em_atendimento_resposta_cliente',
            observacao:
              'Cliente enviou mensagem — conversa saiu de aguardando cliente (manual) e voltou para em atendimento',
          })
        }
      }

      const conversaEncerrada = st === 'fechada' || st === 'finalizada'
      if (conversaEncerrada) {
        if (motivoFinalizacao === 'ausencia_cliente') {
          const { absence: cfg } = await loadChatbotTriageMergeAndAbsence(company_id)
          if (cfg.reabrirAutomaticamente) {
            const depAntesReabrir =
              convStatus?.departamento_id != null ? Number(convStatus.departamento_id) : null
            const snap = await fetchLastAbsenceEncerramentoSnap(conversa_id)
            const assign = await resolveReopenAssignmentAfterAbsence(company_id, snap)
            const deptoRestaurar =
              snap?.departamento_id != null && Number(snap.departamento_id) > 0
                ? Number(snap.departamento_id)
                : depAntesReabrir
            const { data: reabertaAusencia } = await supabase
              .from('conversas')
              .update({
                status_atendimento: assign.status_atendimento,
                departamento_id: deptoRestaurar,
                atendente_id: assign.atendente_id,
                atendente_atribuido_em: assign.atendente_atribuido_em,
                finalizacao_motivo: null,
                finalizada_automaticamente: false,
                finalizada_automaticamente_em: null,
                aguardando_cliente_desde: null,
              })
              .eq('id', conversa_id)
              .eq('company_id', company_id)
              .select()
              .single()
            if (reabertaAusencia) {
              departamento_id = reabertaAusencia.departamento_id != null ? Number(reabertaAusencia.departamento_id) : null
              conversaReabertaAposFinalizacao = true
              reopenedFromAbsence = true
              await clearReabertaFaltaInteracao(company_id, conversa_id)
              reabertaAusencia.reaberta_falta_interacao_em = null
              reabertaAusencia.reaberta_por_falta_interacao = false
              await supabase.from('historico_atendimentos').insert({
                conversa_id,
                usuario_id: null,
                acao: 'reabertura_automatica_ausencia',
                observacao:
                  'Reaberto pelo cliente após encerramento automático por ausência — retomada sem novo menu de triagem',
              })
              await logBotAction(company_id, conversa_id, 'reabertura_automatica_ausencia', {
                bypass_chatbot: cfg.reabrirSemChatbot,
                status_atendimento: assign.status_atendimento,
                atendente_restaurado: assign.atendente_id,
              })
              const io = req.app.get('io')
              if (io) {
                emitReaberturaSemSetorRealtime({
                  io,
                  company_id,
                  conversa_id,
                  reabertaRow: reabertaAusencia,
                  departamentoIdAntigo: depAntesReabrir,
                })
                io.to(`empresa_${company_id}`).emit(io.EVENTS?.CONVERSA_REABERTA || 'conversa_reaberta', reabertaAusencia)
              }
            }
          } else {
            absenceReopenExplicitlyDisabled = true
          }
        }
        if (reopenedFromAbsence) {
          await clearWaitingForClient(company_id, conversa_id)
        }
        // Tentar registrar nota de avaliação se o texto for 0-10
        const textoNorm = String(texto || '').trim()
        const avalResult = await tentarRegistrarAvaliacao({
          company_id,
          conversa_id,
          cliente_id: convStatus.cliente_id || cliente_id || null,
          texto: textoNorm,
        })
        if (avalResult.registered) {
          console.log('[Webhook] 📊 Avaliação registrada (UltraMSG):', { conversa_id, nota: textoNorm })
        }
        // Reabrir por defeito após encerramento; não reabrir se for avaliação registrada,
        // nota 0-10 isolada, agradecimento/ACK de encerramento ou mensagem claramente sem nova demanda.
        if (!avalResult.registered && !reopenedFromAbsence && !absenceReopenExplicitlyDisabled) {
          const reopenDecision = shouldReopenFinishedConversation(textoNorm, {
            company_id,
            conversa_id,
            status_atendimento: st
          })
          if (reopenDecision.shouldReopen) {
            const depAntesReabrir =
              convStatus?.departamento_id != null ? Number(convStatus.departamento_id) : null
            const { data: reaberta } = await supabase
              .from('conversas')
              .update({
                status_atendimento: 'aberta',
                departamento_id: null,
                atendente_id: null,
                atendente_atribuido_em: null,
              })
              .eq('id', conversa_id)
              .eq('company_id', company_id)
              .select()
              .single()
            if (reaberta) {
              departamento_id = null
              conversaReabertaAposFinalizacao = true
              await clearReabertaFaltaInteracao(company_id, conversa_id)
              reaberta.reaberta_falta_interacao_em = null
              reaberta.reaberta_por_falta_interacao = false
              const { resetChatbotStateForConversa } = require('../services/chatbotTriageService')
              await resetChatbotStateForConversa(supabase, company_id, conversa_id)
              const io = req.app.get('io')
              if (io) {
                emitReaberturaSemSetorRealtime({
                  io,
                  company_id,
                  conversa_id,
                  reabertaRow: reaberta,
                  departamentoIdAntigo: depAntesReabrir,
                })
                io.to(`empresa_${company_id}`).emit(io.EVENTS?.CONVERSA_REABERTA || 'conversa_reaberta', reaberta)
              }
              console.log('[Z-API] 🔄 Conversa reaberta automaticamente após encerramento — chatbot reiniciado', {
                conversa_id,
                texto: textoNorm,
                reason: reopenDecision.reason
              })
            }
          } else {
            console.log('[Z-API] 🔒 Conversa mantida fechada (avaliação, agradecimento ou ACK de encerramento)', {
              conversa_id,
              texto: textoNorm,
              reason: reopenDecision.reason
            })
          }
        } else if (absenceReopenExplicitlyDisabled) {
          console.log('[Z-API] 🔒 Conversa mantida fechada — reabertura automática por ausência desativada', {
            conversa_id,
            texto: textoNorm,
            motivo_finalizacao: motivoFinalizacao,
          })
        }
      }
    }

    if (!isGroup && conversa_id) {
      if (!fromMe) {
        await clearWaitingForClient(company_id, conversa_id)
      } else {
        await tryMarkWaitingAfterHumanOutbound({
          company_id,
          conversa_id,
          texto,
          criado_em: criado_em || new Date().toISOString(),
        })
      }
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
    // Revalida departamento/atendente no banco (snapshot inicial pode estar stale em webhooks paralelos).
    let atendente_id = null
    let skipChatbotPorCampanha = false
    // Flag de campanha e consume da 1ª resposta não dependem de telefone enviável (LID sem número).
    if (!fromMe && !isGroup && conversa_id && company_id) {
      let convEstado = null
      const convEstadoRes = await supabase
        .from('conversas')
        .select('atendente_id, departamento_id, aguardando_resposta_campanha, status_atendimento')
        .eq('id', conversa_id)
        .eq('company_id', company_id)
        .maybeSingle()
      if (convEstadoRes.error && isMissingAguardandoCampanhaColumn(convEstadoRes.error)) {
        const retryEstado = await supabase
          .from('conversas')
          .select('atendente_id, departamento_id, status_atendimento')
          .eq('id', conversa_id)
          .eq('company_id', company_id)
          .maybeSingle()
        convEstado = retryEstado.data
      } else {
        convEstado = convEstadoRes.data
      }
      atendente_id = convEstado?.atendente_id ?? null
      if (convEstado?.departamento_id != null) {
        departamento_id = Number(convEstado.departamento_id)
      }
      skipChatbotPorCampanha = devePularChatbotPorCampanha(convEstado)
    }
    departamentoIdAntesRealtime = departamento_id
    if (!fromMe && !isGroup && !inboundReentregue && departamento_id == null && atendente_id == null && phoneParaChatbot) {
      const chatbotEligibility = shouldTriggerChatbotForInbound({
        fromMe,
        isGroup,
        type,
        phone: phoneParaChatbot,
        payload,
      })
      if (!chatbotEligibility.ok) {
        console.log('[Z-API] 🤖 Chatbot: ignorado — origem não é mensagem privada real do contato', {
          conversa_id,
          company_id,
          reason: chatbotEligibility.reason,
          type,
        })
      } else {
        try {
        const sendMessage = async (ph, msg, o = {}) => {
          const r = await getProvider().sendText(ph, msg, {
            companyId: company_id,
            conversaId: conversa_id,
            whatsappInstanceId: whatsapp_instance_id || undefined,
            ...o,
            sendOrigin: o?.sendOrigin || o?.origin || 'chatbot_triage',
          })
          return { ok: !!r?.ok, messageId: r?.messageId || null }
        }
        let skipChatbot = false
        if (skipChatbotPorCampanha) {
          skipChatbot = true
        }
        const chatbotHints = {}
        const ioAutomacao = req.app.get('io')
        const emitAutomacaoRealtime =
          ioAutomacao &&
          (async (mensagemRow) =>
            emitBotMensagemRealtime({
              io: ioAutomacao,
              supabase,
              company_id,
              conversa_id,
              mensagem: mensagemRow,
            }))

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
            const optSendResult = await sendMessage(phoneParaChatbot, optResult.mensagemConfirmacao, { sendOrigin: 'opt_out_confirmacao' })
            const optMessageId = optSendResult?.messageId ? String(optSendResult.messageId).trim() : null
            const optTraceable = isTraceableWhatsappMessageId(optMessageId)
            const optQueueId = !!optMessageId && isUltramsgNumericQueueId(optMessageId)
            const { data: optMensagemRow, error: optMensagemError } = await supabase.from('mensagens').insert({
              conversa_id,
              texto: optResult.mensagemConfirmacao,
              direcao: 'out',
              company_id,
              status: optSendResult?.ok ? (optTraceable ? 'sent' : 'pending') : 'erro',
              status_mensagem: optSendResult?.ok ? (optTraceable ? 'sent' : 'sending') : 'failed',
              ...(optTraceable ? { whatsapp_id: optMessageId } : {}),
              ...(optQueueId ? { provider_queue_id: optMessageId } : {}),
              ...(whatsapp_instance_id ? { whatsapp_instance_id } : {}),
            }).select('*').single()
            if (optMensagemError) {
              console.warn('[optOut] erro ao salvar confirmacao enviada:', optMensagemError.message || optMensagemError)
            } else if (optMensagemRow && emitAutomacaoRealtime) {
              await emitAutomacaoRealtime(optMensagemRow).catch((e) => {
                console.warn('[optOut] erro ao emitir confirmacao enviada:', e?.message || e)
              })
            }
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
            whatsapp_instance_id,
            sendMessage,
            emitMensagemRealtime: emitAutomacaoRealtime || null,
          })
          if (regrasResult.matched) skipChatbot = true
        }

        // Chatbot só envia quando o CLIENTE iniciou a conversa. Se o usuário/atendente enviou a 1ª msg, não enviar nada.
        // Exceção 1: conversaReabertaAposFinalizacao — cliente enviou msg após finalização, tratar como novo contato.
        // Exceção 2: bot já estava ativo (menu_enviado em bot_logs) — mesmo que a msg do cliente não tenha sido
        //            salva corretamente, o bot deve continuar processando as respostas do menu.
        const { absence: cfgAbs } = await loadChatbotTriageMergeAndAbsence(company_id)
        if (reopenedFromAbsence && cfgAbs.reabrirSemChatbot) {
          skipChatbot = true
          await logBotAction(company_id, conversa_id, 'chatbot_bypass_retorno_ausencia', {
            reason: 'reopened_from_absence',
          })
        }
        if (skipChatbotPorCampanha && !skipChatbot) {
          skipChatbot = true
        }
        if (skipChatbotPorCampanha) {
          await logBotAction(company_id, conversa_id, 'chatbot_bypass_resposta_campanha', {
            reason: 'aguardando_resposta_campanha',
          }).catch(() => {})
        }
        if (!skipChatbot && !conversaReabertaAposFinalizacao) {
          // Prioridade: verificar se o chatbot já estava ativo para esta conversa via bot_logs.
          // Isso evita o bug onde a mensagem inicial do cliente falha ao salvar mas a resposta
          // do bot é salva, fazendo a primeira msg parecer 'out' e silenciando o chatbot.
          const { data: botLogAtivo } = await supabase
            .from('bot_logs')
            .select('id, tipo')
            .eq('conversa_id', conversa_id)
            .eq('company_id', company_id)
            .in('tipo', ['menu_enviado', 'menu_reenviado', 'opcao_invalida', 'opcao_valida'])
            .limit(1)
            .maybeSingle()

          if (botLogAtivo) {
            // Bot já estava ativo — sempre processar (cliente está respondendo ao menu do bot)
            chatbotHints.menuAlreadySent = true
            console.log('[Z-API] 🤖 Chatbot: conversa com bot ativo (bot_logs) — processando resposta', {
              conversa_id, tipo: botLogAtivo.tipo
            })
          } else {
            // Bot não esteve ativo ainda — verificar se foi o operador quem iniciou a conversa
            const { data: mensagensAnteriores } = await supabase
              .from('mensagens')
              .select('direcao, texto')
              .eq('conversa_id', conversa_id)
              .eq('company_id', company_id)
              .order('criado_em', { ascending: true })
              .limit(25)

            console.log('[Z-API] 🤖 Chatbot: verificando histórico (sem bot_logs)', {
              conversa_id,
              totalMensagens: mensagensAnteriores?.length || 0,
              primeiraMensagem: mensagensAnteriores?.[0]
                ? { direcao: mensagensAnteriores[0].direcao, texto: String(mensagensAnteriores[0].texto || '').slice(0, 30) }
                : null
            })

            if (!mensagensAnteriores || mensagensAnteriores.length === 0) {
              chatbotHints.menuAlreadySent = false
              chatbotHints.isPrimeiraMensagemCliente = true
              console.log('[Z-API] 🤖 Chatbot: primeira mensagem do cliente — permitindo chatbot', { conversa_id })
            } else {
              const primeiraMsg = mensagensAnteriores[0]
              if (primeiraMsg?.direcao === 'out') {
                skipChatbot = true
                chatbotHints.menuAlreadySent = false
                chatbotHints.isPrimeiraMensagemCliente = false
                console.log('[Z-API] 🤖 Chatbot: ignorado — operador iniciou a conversa (1ª msg foi direcao out)', {
                  conversa_id, primeiraMsg: String(primeiraMsg.texto || '').slice(0, 30)
                })
              } else {
                // Cliente falou primeiro, mas já pode existir resposta do bot (menu) — ex.: [in, out, in atual]
                const temRespostaBot = mensagensAnteriores.some((m) => m.direcao === 'out')
                if (temRespostaBot) {
                  chatbotHints.menuAlreadySent = true
                  chatbotHints.isPrimeiraMensagemCliente = false
                  console.log('[Z-API] 🤖 Chatbot: histórico já tem msg do bot — cliente respondendo ao menu', {
                    conversa_id,
                  })
                } else {
                  chatbotHints.menuAlreadySent = false
                  chatbotHints.isPrimeiraMensagemCliente = true
                  console.log('[Z-API] 🤖 Chatbot: cliente iniciou a conversa — permitindo chatbot', {
                    conversa_id, totalMensagensCliente: mensagensAnteriores.filter(m => m.direcao === 'in').length
                  })
                }
              }
            }
          }
        }

        if (!skipChatbot) {
          console.log('[Z-API] 🤖 Chatbot: processando mensagem', { company_id, conversa_id, phoneTail: String(phoneParaChatbot).slice(-8) })
          const ioChatbot = req.app.get('io')
          const emitChatbotRealtime =
            ioChatbot &&
            (async (mensagemRow) =>
              emitBotMensagemRealtime({
                io: ioChatbot,
                supabase,
                company_id,
                conversa_id,
                mensagem: mensagemRow,
              }))
          const result = await processChatbotTriage({
            company_id,
            conversa_id,
            telefone: phoneParaChatbot,
            texto: texto || '',
            supabase,
            sendMessage,
            opts: {
              companyId: company_id,
              ...(whatsapp_instance_id
                ? { whatsappInstanceId: whatsapp_instance_id, whatsapp_instance_id }
                : {}),
            },
            conversaReabertaAposFinalizacao,
            hints: chatbotHints,
            emitChatbotRealtime,
            mensagemClienteCriadoEm: criado_em || null,
          })
          if (result?.handled && result?.departamento_id != null) {
            departamento_id = result.departamento_id
            console.log('[Z-API] 🤖 Chatbot: conversa direcionada para departamento', departamento_id)
            const ioSetor = req.app.get('io')
            if (
              ioSetor &&
              !setorRealtimeJaEmitido &&
              setorRealtimeMudou(departamentoIdAntesRealtime, departamento_id)
            ) {
              emitirMudancaSetorRealtime(ioSetor, company_id, conversa_id, {
                departamento_id,
                departamentoIdAnterior: departamentoIdAntesRealtime,
                atendente_id: result.atendente_id ?? null,
                status_atendimento: result.status_atendimento || 'aberta',
                motivo: 'setor_direcionado',
              })
              setorRealtimeJaEmitido = true
            }
          }
        }
        } catch (errChatbot) {
          console.warn('[Z-API] Chatbot triagem:', errChatbot?.message || errChatbot)
        }
      }
    }

    if (!fromMe && !isGroup && skipChatbotPorCampanha && conversa_id && company_id) {
      try {
        await consumirPrimeiraRespostaCampanha({
          companyId: company_id,
          conversaId: conversa_id,
          instanciaId: whatsapp_instance_id || null,
          io: req.app?.get?.('io') || null,
        })
      } catch (e) {
        console.warn('[disparo:campanha] consumir primeira resposta:', e?.message || e)
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
    const nowIso = new Date().toISOString()
    const soPlaceholderMidia = texto === '(mídia)' && !imageUrl && !documentUrl && !audioUrl && !videoUrl && !stickerUrl && !locationUrl
    if (soPlaceholderMidia && !fromMe) {
      await supabase
        .from('conversas')
        .update({ ultima_atividade: nowIso })
        .eq('id', conversa_id)
        .eq('company_id', company_id)
      // IMPORTANTE: payload é 1 de N num lote (ver getPayloads) — abortar a requisição aqui
      // descartaria as demais mensagens do lote. Pula só esta (nada para salvar) e segue.
      lastResult = { ok: true, conversa_id, skip: 'placeholderMidia' }
      continue
    }
    if (soPlaceholderMidia && fromMe) texto = '(mensagem)' // espelhamento: mostrar algo no chat

    // Histórico de nova conversa: agendado DEPOIS de persistir a mensagem atual + regra mensagem_disparada
    // (evita race: import antigo tornava outra linha a "primeira" e a conversa ficava aberta indevidamente).

    // Idempotencia: chave por instancia quando disponivel; legado fica restrito a whatsapp_instance_id null.
    if (whatsappIdStr) {
      let { data: existente } = await selectSingleMensagemByWhatsappId(supabase, {
        company_id,
        whatsapp_id: whatsappIdStr,
        whatsapp_instance_id,
        select: WEBHOOK_MSG_SELECT,
        context: 'received.idempotency',
      })
      
      // Se não encontrou por whatsapp_id e é mensagem enviada por nós, reconciliar com outbound do CRM
      if (!existente && fromMe) {
        const recentFromIso = new Date(Date.now() - 15 * 60 * 1000).toISOString()
        let tempExistente = await tryReconcileFromMeByCrmReferenceId(supabase, {
          company_id,
          conversa_id,
          whatsapp_instance_id,
          payload,
          whatsappIdStr,
          statusPayload: payload.status ?? payload.ack ?? null,
        })

        let tempNullWaQuery = supabase
          .from('mensagens')
          .select(WEBHOOK_MSG_SELECT)
          .eq('company_id', company_id)
          .eq('conversa_id', conversa_id)
          .eq('direcao', 'out')
          .gte('criado_em', recentFromIso)
          .order('criado_em', { ascending: false })
          .order('id', { ascending: false })
          .limit(15)
        tempNullWaQuery = applyWhatsappInstanceFilterOrLegacy(tempNullWaQuery, whatsapp_instance_id)
        const { data: tempExistenteRecentOut } = await tempNullWaQuery

        const nomeAtendenteFromMe = extrairNomePrefixoTexto(texto)
        if (!tempExistente) {
          tempExistente =
            findFromMeOutboundMediaCandidate(filterRowsForFromMeReconcile(tempExistenteRecentOut), {
              fileName,
              texto,
              tipo: mapWebhookTypeToStorageTipo(type),
              nomeAtendente: nomeAtendenteFromMe,
              whatsappId: whatsappIdStr,
            }) || null
        }

        // ACK pode ter preenchido whatsapp_id (sid) antes do message_create (id) — buscar por nome/tipo
        if (!tempExistente && mapWebhookTypeToStorageTipo(type)) {
          let recentOutQuery = supabase
            .from('mensagens')
            .select(WEBHOOK_MSG_SELECT)
            .eq('company_id', company_id)
            .eq('conversa_id', conversa_id)
            .eq('direcao', 'out')
            .gte('criado_em', recentFromIso)
            .order('criado_em', { ascending: false })
            .order('id', { ascending: false })
            .limit(15)
          recentOutQuery = applyWhatsappInstanceFilterOrLegacy(recentOutQuery, whatsapp_instance_id)
          const { data: recentOut } = await recentOutQuery
          tempExistente =
            findFromMeOutboundMediaCandidate(filterRowsForFromMeReconcile(recentOut), {
              fileName,
              texto,
              tipo: mapWebhookTypeToStorageTipo(type),
              nomeAtendente: nomeAtendenteFromMe,
              whatsappId: whatsappIdStr,
            }) || null
        }

        if (tempExistente) {
          // Atualizar com o whatsapp_id real apenas quando a promoção é segura.
          // referenceId pode ter absorvido o eco sem overwrite — não reescrever o id canônico aqui.
          try {
            const updateFromMe = {}
            if (whatsappIdCompativelParaReconcile(tempExistente, whatsappIdStr)) {
              updateFromMe.whatsapp_id = whatsappIdStr
            }
            const ackStatus = normalizeRawAckStatus(payload?.status ?? payload?.ack)
            if (ackStatus && statusRank(ackStatus) >= statusRank(tempExistente.status || tempExistente.status_mensagem || 'pending')) {
              updateFromMe.status = ackStatus
              updateFromMe.status_mensagem = ackStatus
            }
            if ((audioUrl || imageUrl || documentUrl || videoUrl || stickerUrl) && !tempExistente.url) {
              if (imageUrl) { updateFromMe.url = imageUrl; updateFromMe.tipo = 'imagem' }
              else if (documentUrl) { updateFromMe.url = documentUrl; updateFromMe.tipo = 'arquivo' }
              else if (audioUrl) { updateFromMe.url = audioUrl; updateFromMe.tipo = tempExistente.tipo === 'voice' ? 'voice' : mapWebhookTypeToStorageTipo(type) }
              else if (videoUrl) { updateFromMe.url = videoUrl; updateFromMe.tipo = 'video' }
              else if (stickerUrl) { updateFromMe.url = stickerUrl; updateFromMe.tipo = 'sticker' }
            }
            if (Object.keys(updateFromMe).length === 0) {
              existente = tempExistente
            } else {
              const { data: updatedMsg } = await supabase
                .from('mensagens')
                .update(updateFromMe)
                .eq('company_id', company_id)
                .eq('id', tempExistente.id)
                .select(WEBHOOK_MSG_SELECT)
                .single()
              existente = updatedMsg || tempExistente
            }
          } catch (e) {
            console.warn('Erro ao atualizar whatsapp_id:', e.message)
            existente = tempExistente
          }
        }
      }
      
      if (existente) {
        // Se a mensagem salva tem texto placeholder (DeliveryCallback chegou antes do ReceivedCallback)
        // e o webhook atual traz conteúdo real → atualizar com o texto/mídia corretos.
        // Também: webhook_message_download_media pode chegar DEPOIS com URL da mídia — atualizar mensagem existente sem url.
        const savedTexto = String(existente.texto || '')
        const isPlaceholder = savedTexto === '(mensagem)' || savedTexto === '(mídia)'
        const textoReal = texto && texto !== '(mensagem)' && texto !== '(mídia)' ? texto : null
        const hasMediaToUpdate = (imageUrl || documentUrl || audioUrl || videoUrl || stickerUrl) && !String(existente.url || '').trim()
        const shouldUpdate = (isPlaceholder && textoReal) || hasMediaToUpdate
        if (shouldUpdate) {
          const upFields = {}
          if (textoReal && isPlaceholder) upFields.texto = textoReal
          if (imageUrl && !existente.url) { upFields.url = imageUrl; upFields.tipo = 'imagem' }
          else if (documentUrl && !existente.url) { upFields.url = documentUrl; upFields.tipo = 'arquivo' }
          else if (audioUrl && !existente.url) { upFields.url = audioUrl; upFields.tipo = (existente.tipo === 'voice' ? 'voice' : 'audio') }
          else if (videoUrl && !existente.url) { upFields.url = videoUrl; upFields.tipo = 'video' }
          else if (stickerUrl && !existente.url) { upFields.url = stickerUrl; upFields.tipo = 'sticker' }
          if (Object.keys(upFields).length > 0) {
            try {
              const { data: updMsg } = await supabase
                .from('mensagens')
                .update(upFields)
                .eq('id', existente.id)
                .select(WEBHOOK_MSG_SELECT)
                .single()
              mensagemSalva = updMsg || existente
              if (WHATSAPP_DEBUG || hasMediaToUpdate) console.log('[Z-API] idempotência: mensagem atualizada com mídia/placeholder', existente.id, Object.keys(upFields))
              // Emitir nova_mensagem para frontend atualizar player de áudio quando URL chega via webhook_message_download_media
              if (hasMediaToUpdate && req.app?.get('io')) {
                const io2 = req.app.get('io')
                const rooms = [`conversa_${conversa_id}`, `empresa_${company_id}`]
                const emitPayload = {
                  ...mensagemSalva,
                  criado_em: normalizarTimestampSemFusoAmbiguoParaApi(mensagemSalva.criado_em),
                  conversa_id: mensagemSalva.conversa_id ?? conversa_id,
                  status: mensagemSalva.status || 'delivered',
                  status_mensagem: mensagemSalva.status_mensagem || mensagemSalva.status || 'delivered',
                  fromMe,
                  direcao: mensagemSalva.direcao ?? (fromMe ? 'out' : 'in'),
                }
                io2.to(rooms).emit(io2.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', emitPayload)
                scheduleInboundWebPush(company_id, conversa_id, 'nova_mensagem', emitPayload)
              }
            } catch (_) {
              mensagemSalva = existente
            }
          } else {
            mensagemSalva = existente
          }
        } else {
          mensagemSalva = existente
        }
      }
    }

    // ─── Reply/citação: extraído ANTES da reconciliação para que ambos os caminhos usem ───
    // → controllers/webhookInbound/replyMeta.js. Resolve o reply_meta (resposta a X) do payload.
    const webhookReplyMeta = await buildWebhookReplyMeta(supabase, { payload, company_id, conversa_id, whatsapp_instance_id })

    // ✅ Anti-duplicação profissional (envio pelo sistema + eco do webhook fromMe):
    // Quando enviamos pelo CRM, a mensagem é inserida com whatsapp_id = null.
    // Em seguida o Z-API pode disparar webhook fromMe com whatsapp_id real.
    // Para não duplicar, tentamos "reconciliar" atualizando a mensagem recente do CRM com o whatsapp_id.
    // Reconciliação de eco fromMe (crm-* / candidato por mídia+texto) → webhookInbound/fromMeReceivedReconcile.js.
    if (!mensagemSalva && fromMe && whatsappIdStr) {
      mensagemSalva = await reconcileFromMeInReceived(supabase, {
        company_id, conversa_id, whatsapp_instance_id, payload, whatsappIdStr,
        type, imageUrl, documentUrl, audioUrl, videoUrl, stickerUrl, locationUrl,
        criado_em, fileName, texto, webhookReplyMeta, io: req.app.get('io'),
      })
    }

    // isEdit: mensagem editada → atualizar texto da mensagem existente, não inserir nova
    // isEdit: mensagem editada → atualiza a linha existente → controllers/webhookInbound/persistMensagem.js.
    if (!mensagemSalva && isEdit && whatsappIdStr) {
      mensagemSalva = await resolveEditedMensagemRow(supabase, {
        company_id, whatsapp_instance_id, whatsappIdStr, conversa_id, texto, io: req.app.get('io'),
      })
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
        ...(whatsapp_instance_id ? { whatsapp_instance_id } : {}),
        whatsapp_id: whatsappIdStr || null,
        criado_em,
        ...(statusPayload ? { status: statusPayload } : {})
      }
      if (reply_meta) insertMsg.reply_meta = reply_meta
      if (isGroup && !fromMe) {
        // Grupo: salvar SEMPRE no grupo, e armazenar remetente (membro) na mensagem.
        // → controllers/webhookInbound/groupSender.js (resolve nome/telefone do membro + sync bg).
        const gf = await resolveGroupSenderFields({ companyId: company_id, participantPhone, senderName })
        if (gf.remetente_telefone) insertMsg.remetente_telefone = gf.remetente_telefone
        if (gf.remetente_nome) insertMsg.remetente_nome = gf.remetente_nome
      }
      // Mapeamento tipo/mídia → campos do row (puro) → controllers/webhookInbound/persistMensagem.js.
      applyInboundMediaFields(insertMsg, {
        type, imageUrl, documentUrl, audioUrl, videoUrl, stickerUrl, locationUrl, locationMeta, contactMeta, fileName,
        diag: { company_id, conversa_id, whatsapp_id: whatsappIdStr || null, whatsapp_instance_id: whatsapp_instance_id || null, fromMe },
      })
      // Demais tipos: já têm texto preenchido; tipo padrão é texto

      // Insert + retries de esquema + 23505/merge + fallback → controllers/webhookInbound/persistMensagem.js.
      const _persist = await persistInboundMensagemRow(
        supabase,
        { company_id, whatsapp_instance_id, whatsappIdStr, conversa_id, fromMe, isGroup, senderName, participantPhone, texto, criado_em, io: req.app?.get('io') },
        insertMsg
      )
      if (_persist.failed) {
        // payload é 1 de N num lote — pula só este item e segue para o próximo.
        lastResult = { ok: false, error: 'Erro ao salvar mensagem' }
        continue
      }
      mensagemSalva = _persist.mensagemSalva
      if (_persist.mensagemFoiInseridaPeloWebhook) mensagemFoiInseridaPeloWebhook = true
    }

    if (mensagemSalva) {
      // Mídia remota (UltraMSG/S3): copiar para /uploads em background para não depender de URL com TTL curto.
      const mPersist = mensagemSalva
      if (
        mPersist?.id &&
        mPersist?.url &&
        String(mPersist.url).startsWith('https://') &&
        tipoQualificaPersistencia(mPersist.tipo)
      ) {
        schedulePersistInboundMediaIfNeeded({
          supabase,
          io: req.app.get('io'),
          company_id,
          mensagem_id: mPersist.id,
          fromMe,
          departamento_id,
        })
      }

      // Repara URL ausente: quando o webhook entrega áudio/imagem sem media URL,
      // busca via GET /chats/messages (mesma fonte do "Carregar mensagens antigas").
      scheduleInboundMediaBackfill({
        supabase,
        io: req.app.get('io'),
        company_id,
        conversa_id: mPersist?.conversa_id ?? conversa_id,
        mensagemSalva: mPersist,
      })

      // Usar conversa_id da mensagem quando idempotência retornou existente de outra conversa
      const convIdForUpdate = mensagemSalva.conversa_id ?? conversa_id
      const nowIsoUpdate = new Date().toISOString()
      const { error: errUpdate } = await supabase
        .from('conversas')
        .update({ ultima_atividade: nowIsoUpdate })
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
              .update({ ultimo_contato: mensagemSalva.criado_em || nowIsoUpdate, atualizado_em: nowIsoUpdate })
              .eq('company_id', company_id)
              .eq('id', Number(convRow.cliente_id))
          }
        }
      } catch (_) {}

      // Cliente respondeu: sair de mensagem_disparada → aberta (após persistir a inbound; não altera se insert falhou antes).
      if (!fromMe && separarMensagensDisparadasEmpresa && !isGroup) {
        try {
          await supabase
            .from('conversas')
            .update({
              status_atendimento: 'aberta',
              departamento_id: null,
              atendente_id: null,
              atendente_atribuido_em: null,
            })
            .eq('id', convIdForUpdate)
            .eq('company_id', company_id)
            .eq('status_atendimento', 'mensagem_disparada')
        } catch (e) {
          console.warn('[webhook] mensagem_disparada→aberta (resposta cliente):', e?.message || e)
        }
      }

      // Opcional por empresa: outbound sem autor (WhatsApp/celular). mensagem_disparada se for a 1ª msg da conversa.
      // Não exige mensagemFoiInseridaPeloWebhook: reconciliação (eco CRM → mesmo id) ainda pode ser a única linha válida.
      if (
        separarMensagensDisparadasEmpresa &&
        fromMe &&
        !isGroup &&
        mensagemSalva.autor_usuario_id == null
      ) {
        try {
          const ehPrimeiraDisparoExterno = await mensagemInseridaEhPrimeiraDisparoWhatsappExterno(
            supabase,
            company_id,
            convIdForUpdate,
            mensagemSalva.id
          )
          if (ehPrimeiraDisparoExterno) {
            const temInboundHistorico = await conversaTemAlgumaMensagemInbound(
              supabase,
              company_id,
              convIdForUpdate
            )
            if (temInboundHistorico) {
              // Já há fala do cliente no histórico: não tratar como disparo isolado (import/sync ou estado inconsistente).
            } else {
            const { data: convSt } = await supabase
              .from('conversas')
              .select('status_atendimento, atendente_id, aguardando_resposta_campanha')
              .eq('id', convIdForUpdate)
              .eq('company_id', company_id)
              .maybeSingle()
            const st = String(convSt?.status_atendimento || '')
            const aid = convSt?.atendente_id
            const semAtendente = aid == null || aid === ''
            if (convSt?.aguardando_resposta_campanha === true) {
              // Campanha do módulo Disparo: permanece no filtro Campanhas, não vira mensagem_disparada.
            } else if (!semAtendente) {
              // assumida — não reclassificar
            } else if (st === 'em_atendimento' || st === 'aguardando_cliente') {
              // já em atendimento humano / aguardando cliente
            } else if (st === 'aberta' || st === 'mensagem_disparada' || st === 'fechada' || st === 'finalizada') {
              await supabase
                .from('conversas')
                .update({
                  status_atendimento: 'mensagem_disparada',
                  departamento_id: null,
                  atendente_id: null,
                  atendente_atribuido_em: null,
                })
                .eq('id', convIdForUpdate)
                .eq('company_id', company_id)
                .in('status_atendimento', ['aberta', 'mensagem_disparada', 'fechada', 'finalizada'])
                .is('atendente_id', null)
            }
            }
          }
        } catch (e) {
          console.warn('[webhook] separar_mensagens_disparadas:', e?.message || e)
        }
      }

      console.log('✅ Mensagem salva no sistema:', { conversa_id, mensagem_id: mensagemSalva.id, phone: phone?.slice(-6), direcao: fromMe ? 'out' : 'in' })
      if (fromMe) console.log('📤 Espelhamento: mensagem enviada pelo celular registrada no sistema')

      if (fromMe && !isGroup && company_id && convIdForUpdate && (mensagemSalva.whatsapp_id || mensagemSalva.id)) {
        try {
          const { marcarOrigemCampanhaSeMensagemFila } = require('../services/disparoConversaOrigemService')
          await marcarOrigemCampanhaSeMensagemFila({
            companyId: company_id,
            conversaId: convIdForUpdate,
            providerMessageId: mensagemSalva.whatsapp_id || null,
            mensagemId: mensagemSalva.id || null,
            io: req.app?.get?.('io') || null,
          })
        } catch (e) {
          console.warn('[disparo:campanha] marcar origem fromMe:', e?.message || e)
        }
      }

      // Etapa 8 Disparo: opt-out exact match + vínculo de resposta (best-effort; não bloqueia webhook)
      // → controllers/webhookInbound/disparoInbound.js (fire-and-forget via setImmediate).
      if (!fromMe && !isGroup && mensagemFoiInseridaPeloWebhook && mensagemSalva?.id && company_id) {
        scheduleInboundDisparoHooks({
          companyId: company_id,
          telefone: phone,
          texto: mensagemSalva.texto || texto || '',
          mensagemId: mensagemSalva.id,
          conversaId: conversa_id || mensagemSalva.conversa_id,
          instanciaId: whatsapp_instance_id || null,
          io: req.app?.get?.('io') || null,
        })
      }

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

      // Histórico do celular: nova conversa — importar após a mensagem atual (evita quebrar "primeira
      // mensagem" / mensagem_disparada). → controllers/webhookInbound/historyImport.js (fire-and-forget).
      if (isNewConversation) {
        scheduleNewConversationHistoryImport({
          conversaId: conversa_id,
          phone,
          isGroup,
          companyId: company_id,
          whatsappInstanceId: whatsapp_instance_id,
          io: req.app.get('io'),
        })
      }
    }

    // Mensagem de entrada: incrementa unread no banco para todos os usuários (igual WhatsApp; refetch da lista já vem com contador certo)
    const convIdForEmit = mensagemSalva?.conversa_id ?? conversa_id
    if (!fromMe && mensagemFoiInseridaPeloWebhook) {
      await incrementarUnreadParaConversa(company_id, convIdForEmit)
    }

    // 4) Realtime: nova_mensagem + atualizar_conversa + conversa_atualizada (igual WhatsApp Web)
    // IMPORTANTE: só emite nova_mensagem quando a mensagem foi INSERIDA pelo webhook.
    // Quando idempotência ou reconciliação (msg enviada pelo CRM), o chatController já emitiu — evita duplicata.
    const io = req.app.get('io')
    if (io && mensagemSalva) {
      // Status canônico para os ticks no frontend (sent, delivered, read, pending, erro, played)
      const canon = canonStatusForEmit(mensagemSalva.status_mensagem ?? mensagemSalva.status ?? (fromMe ? 'sent' : 'delivered'))
      // Payload de nova_mensagem (construção pura) → controllers/webhookInbound/realtimePayload.js.
      const emitPayload = buildNovaMensagemPayload({ mensagemSalva, canon, convIdForEmit, fromMe, nomeParaCache, senderName, senderPhoto })
      if (mensagemFoiInseridaPeloWebhook) {
        // Emitir nova_mensagem para todas as mensagens inseridas pelo webhook:
        // - fromMe=false (recebida do cliente) → frontend DEVE notificar
        // - fromMe=true  (espelhamento: enviada pelo celular) → frontend NÃO deve notificar
        // O campo fromMe e direcao no payload permitem o frontend filtrar corretamente.
        const emittedScoped = await emitirParaUsuariosQuePodemVerConversa(
          io,
          company_id,
          convIdForEmit,
          'nova_mensagem',
          emitPayload
        )
        if (!emittedScoped) {
          const rooms = [`conversa_${convIdForEmit}`]
          if (departamento_id != null) rooms.push(`departamento_${departamento_id}`)
          io.to(rooms).emit('nova_mensagem', emitPayload)
        }
        scheduleInboundWebPush(company_id, convIdForEmit, 'nova_mensagem', emitPayload)
      } else {
        // Mensagem já existe (enviada pelo usuário): apenas atualizar status, não duplicar mensagem
        const statusPayload = {
          mensagem_id: mensagemSalva.id,
          conversa_id: convIdForEmit,
          status: canon,
          status_mensagem: canon,
          whatsapp_id: mensagemSalva.whatsapp_id || null,
          whatsapp_instance_id: mensagemSalva.whatsapp_instance_id ?? whatsapp_instance_id ?? null
        }
        let chain = io.to(`empresa_${company_id}`).to(`conversa_${convIdForEmit}`)
        if (mensagemSalva.autor_usuario_id != null) chain = chain.to(`usuario_${mensagemSalva.autor_usuario_id}`)
        chain.emit('status_mensagem', statusPayload)
      }
      // NÃO emitir atualizar_conversa para mensagens enviadas por nós (fromMe)
      // — evita refetch que causa duplicação visual e flicker. status_mensagem já atualiza os ticks.
      // Só emitir para mensagens recebidas (inseridas pelo webhook)
      if (!fromMe) {
        const emittedScoped = await emitirParaUsuariosQuePodemVerConversa(
          io,
          company_id,
          convIdForEmit,
          'atualizar_conversa',
          { id: convIdForEmit }
        )
        if (!emittedScoped) io.to(`conversa_${convIdForEmit}`).emit('atualizar_conversa', { id: convIdForEmit })
      }
      // conversa_atualizada: priorizar nome do sync (name) sobre cache; fallback nome_contato_cache
      let modoSimplesRecalc = null
      if (!isGroup && convIdForEmit && mensagemFoiInseridaPeloWebhook && mensagemSalva) {
        modoSimplesRecalc = await recalcularStatusPorUltimaMensagem({
          company_id,
          conversa_id: convIdForEmit,
          mensagemNova: mensagemSalva,
          io: null,
        }).catch(() => null)
      }
      let convRow = null
      {
        const convRowRes = await supabase
          .from('conversas')
          .select('id, ultima_atividade, nome_contato_cache, foto_perfil_contato_cache, telefone, cliente_id, departamento_id, status_atendimento, atendente_id, aguardando_cliente_desde, modo_simples_aguardando, whatsapp_instance_id, aguardando_resposta_campanha')
          .eq('id', convIdForEmit)
          .eq('company_id', company_id)
          .maybeSingle()
        if (convRowRes.error && isMissingAguardandoCampanhaColumn(convRowRes.error)) {
          const retryConvRow = await supabase
            .from('conversas')
            .select('id, ultima_atividade, nome_contato_cache, foto_perfil_contato_cache, telefone, cliente_id, departamento_id, status_atendimento, atendente_id, aguardando_cliente_desde, modo_simples_aguardando, whatsapp_instance_id')
            .eq('id', convIdForEmit)
            .eq('company_id', company_id)
            .maybeSingle()
          convRow = retryConvRow.data
        } else {
          convRow = convRowRes.data
        }
      }
      let contatoNome = (clienteNomeProtegido && clienteNomeAtual)
        ? String(clienteNomeAtual).trim()
        : ((nomeParaCache && String(nomeParaCache).trim()) || (convRow?.nome_contato_cache ? String(convRow.nome_contato_cache).trim() : null))
      let fotoPerfil = convRow?.foto_perfil_contato_cache ? String(convRow.foto_perfil_contato_cache).trim() : null
      
      // Foto: fallback cliente só se cache vazio
      if (!fotoPerfil && convRow?.cliente_id && !isGroup) {
        try {
          const { data: cli } = await supabase
            .from('clientes')
            .select('foto_perfil')
            .eq('id', convRow.cliente_id)
            .eq('company_id', company_id)
            .maybeSingle()
          if (cli?.foto_perfil) fotoPerfil = String(cli.foto_perfil).trim()
        } catch (e) {
          console.warn('Erro ao buscar foto do cliente no webhook:', e.message)
        }
      }
      const depId = departamento_id ?? convRow?.departamento_id ?? null
      // Payload de conversa_atualizada (construção pura) → controllers/webhookInbound/realtimePayload.js.
      const convPayload = buildConversaAtualizadaPayload({
        convIdForEmit,
        convRow,
        whatsappInstanceId: whatsapp_instance_id,
        skipChatbotPorCampanha,
        isGroup,
        depId,
        contatoNome,
        fotoPerfil,
        mensagemFoiInseridaPeloWebhook,
        fromMe,
        modoSimplesRecalc,
        emitPayload,
      })
      const emittedConversaAtualizadaScoped = await emitirParaUsuariosQuePodemVerConversa(
        io,
        company_id,
        convIdForEmit,
        'conversa_atualizada',
        convPayload
      )
      if (!emittedConversaAtualizadaScoped) {
        io.to(`conversa_${convIdForEmit}`).emit('conversa_atualizada', convPayload)
        if (depId != null) {
          // Não emitir atualizar_conversa em reconciliação (fromMe) — evita refetch que causa bug visual
          if (mensagemFoiInseridaPeloWebhook) io.to(`departamento_${depId}`).emit('atualizar_conversa', { id: convIdForEmit })
          io.to(`departamento_${depId}`).emit('conversa_atualizada', convPayload)
        }
      }
      const depNovoRealtime = convRow?.departamento_id ?? depId ?? null
      if (
        !setorRealtimeJaEmitido &&
        setorRealtimeMudou(departamentoIdAntesRealtime, depNovoRealtime)
      ) {
        emitirMudancaSetorRealtime(io, company_id, convIdForEmit, {
          departamento_id: depNovoRealtime,
          departamentoIdAnterior: departamentoIdAntesRealtime,
          atendente_id: convRow?.atendente_id ?? null,
          status_atendimento: convRow?.status_atendimento || 'aberta',
          motivo: 'setor_direcionado',
        })
        setorRealtimeJaEmitido = true
      }
    }

    if (pendingContactSync && io) {
      const { cliente_id: syncClienteId, chatId: syncChatId } = pendingContactSync
      const syncPhone = pendingContactSync.phone
      const syncInput = (syncChatId && String(syncChatId).endsWith('@c.us')) ? syncChatId : syncPhone
      const convId = convIdForEmit
      // Sync em background: atualiza cliente E conversa (nome/foto) quando o sync inicial falhou ou retornou vazio
      Promise.resolve().then(async () => {
        try {
          const { data: current } = await selectClienteNomeFoto(supabase, { id: syncClienteId, companyId: company_id })
          const { data: convRow } = await supabase.from('conversas').select('nome_contato_cache, foto_perfil_contato_cache').eq('id', convId).eq('company_id', company_id).maybeSingle()
          const synced = await syncUltraMsgContact(syncInput, company_id, { skipPersistence: true, skipCache: fromMe }).catch(() => null)
          if (!synced) return null
          const up = {}
          const telefoneTail = String(syncPhone).replace(/\D/g, '').slice(-6) || null
          if (!clienteTemNomeProtegido(current)) {
            const { name: bestNome } = chooseBestName(current?.nome, synced?.nome, 'syncUltramsg', { fromMe: false, company_id, telefoneTail })
            if (bestNome && bestNome !== (current?.nome || '')) up.nome = bestNome
            else if ((!current?.nome || !String(current.nome).trim()) && synced.nome && String(synced.nome).trim() && !isBadName(synced.nome)) {
              up.nome = String(synced.nome).trim()
            }
          }
          // Sem nome válido do sync e cliente sem nome → NÃO gravar (nome permanece NULL).
          // Nunca usar o telefone como nome; getDisplayName() já faz o fallback só na exibição.
          const pushnameVazio = !current?.pushname || !String(current.pushname).trim()
          const fotoVazia = !current?.foto_perfil || !String(current.foto_perfil).trim()
          if (pushnameVazio && synced.pushname !== undefined) up.pushname = synced.pushname
          if (fotoVazia && synced.foto_perfil) up.foto_perfil = synced.foto_perfil
          if (Object.keys(up).length > 0) {
            await supabase.from('clientes').update(up).eq('id', syncClienteId).eq('company_id', company_id)
          }
          // Atualizar conversa (nome_contato_cache, foto_perfil_contato_cache) quando vazios e sync trouxe dados
          const nomeConvVazio = !convRow?.nome_contato_cache || !String(convRow.nome_contato_cache).trim()
          const fotoConvVazia = !convRow?.foto_perfil_contato_cache || !String(convRow.foto_perfil_contato_cache).trim()
          const syncNomeValido = synced?.nome && String(synced.nome).trim() && !isBadName(synced.nome)
          const syncFotoValida = synced?.foto_perfil && String(synced.foto_perfil).trim().startsWith('http')
          const cacheConv = {}
          if (clienteTemNomeProtegido(current)) {
            const nomeProt = current?.nome && String(current.nome).trim()
            if (nomeProt && nomeProt !== (convRow?.nome_contato_cache || '')) {
              cacheConv.nome_contato_cache = nomeProt
            }
          } else if (nomeConvVazio && syncNomeValido) {
            cacheConv.nome_contato_cache = String(synced.nome).trim()
          }
          if (fotoConvVazia && syncFotoValida) cacheConv.foto_perfil_contato_cache = String(synced.foto_perfil).trim()
          if (Object.keys(cacheConv).length > 0) {
            await supabase.from('conversas').update(cacheConv).eq('id', convId).eq('company_id', company_id)
          }
          const r = await supabase.from('clientes').select('nome, pushname, telefone, foto_perfil').eq('id', syncClienteId).single()
          const data = r?.data
          const nomeParaEmit = (clienteTemNomeProtegido(current) && current?.nome)
            ? String(current.nome).trim()
            : (cacheConv.nome_contato_cache ?? convRow?.nome_contato_cache ?? getDisplayName(data) ?? null)
          const fotoParaEmit = cacheConv.foto_perfil_contato_cache ?? convRow?.foto_perfil_contato_cache ?? data?.foto_perfil ?? null
          if (data && io && (nomeParaEmit || fotoParaEmit)) {
            console.log('✅ Contato sincronizado Z-API:', syncPhone?.slice(-6), nomeParaEmit || '(sem nome)')
            io.to(`empresa_${company_id}`).emit('contato_atualizado', {
              conversa_id: convId,
              contato_nome: nomeParaEmit ? String(nomeParaEmit).trim() : null,
              telefone: data.telefone || syncPhone,
              foto_perfil: fotoParaEmit ? String(fotoParaEmit).trim() : null
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
 * POST /webhooks/ultramsg/status — status da mensagem (entrega/leitura) para ticks ✓✓.
 * Z-API envia: status (SENT|RECEIVED|READ|READ_BY_ME|PLAYED) e ids (array de IDs).
 * Também aceita: messageId, zaapId, id (formato antigo).
 */
// statusZapi (ACK) movido para controllers/webhookInbound/statusZapi.js (Fase 3 - doc 24).
const _statusController = require('./webhookInbound/statusZapi')
exports.statusZapi = _statusController.statusZapi

exports._test = {
  applyWhatsappInstanceFilterOrLegacy,
  selectSingleMensagemByWhatsappId,
  updateSingleMensagemByWhatsappId,
  looksLikeBRPhoneDigits,
  isGroupPayload,
  pickGroupChatId,
  getPayloads,
  resolveConversationKeyFromZapi,
  extractMessage,
  whatsappIdCompativelParaReconcile,
  filterRowsForFromMeReconcile,
  findPendingOutboundByAckPhone,
  findFromMeOutboundMediaCandidate,
  tryReconcileFromMeByCrmReferenceId,
  preserveMediaFieldsOnWebhookFallback,
}

