const supabase = require('../../config/supabase')
const _chatShared = require('./shared')
const {
  mergeConversaClienteTags,
  resolveTelefoneFromLidSiblingConversation,
  safeWhatsappInstanceMeta,
  loadWhatsappInstanceMetaMap,
  statusAtendimentoParaLista,
  applyDetalharChatMensagensCursor,
  parsePositiveInt,
  parseBooleanQuery,
  isFlagAtivo,
  isMensagemColumnFallbackError,
  parseChatListPagination,
  applyChatListCursor,
  splitChatListPage,
  parseMessageHistoryPagination,
  splitMessageHistoryPage,
  shouldIncludeClientesSemConversa,
  setChatListPaginationHeaders,
  ordenarMensagensHistoricoAsc,
  textoRevogadoApagadaParaTodos,
  aplicarApagadaParaTodosNaMensagem,
  enrichMensagensComAutorUsuario,
  assertPermissaoConversa,
  marcarComoLidaPorUsuario,
  obterUnreadMap,
  getSearchMessagesPageSize,
  getChatSearchScanLimit,
  getChatSearchIdLimit,
  getChatFilterIdLimit,
  getConversaMessagesSearchLimit,
  buscarConversaIdsPorTextoMensagens,
  isConversaAtendentesMissingTable,
  getConversaIdsParticipanteAtivo,
  usuarioParticipaAtivamenteDaConversa,
  deveIncluirGruposSemDepartamentoNoFiltroTodos,
} = _chatShared
const {
  _reenviosEmAndamento,
  _STATUS_REENVIO_PERMITIDO,
  _STATUS_JA_RESOLVIDO,
  statusReenvioNormalizado,
  avaliarElegibilidadeReenvio,
  resolverTelefoneEnvioDaConversa,
  captionUsuarioDeMidiaPersistida,
  aplicarResultadoReenvio,
  prepararReenvio,
} = require('./resendService')
const {
  IMAGE_FILE_EXTENSIONS,
  VIDEO_FILE_EXTENSIONS,
  ULTRAMSG_VIDEO_FILE_EXTENSIONS,
  ULTRAMSG_VIDEO_MAX_BYTES,
  ULTRAMSG_VIDEO_TARGET_BYTES,
  AUDIO_FILE_EXTENSIONS,
  DOCUMENT_FILE_EXTENSIONS,
  MAX_ARQUIVOS_LOTE_ENVIO,
  MAX_MEDIA_CAPTION_CHARS,
  MAX_ENC_AMINHAR_LOTE,
  mimeBase,
  extBaseArquivo,
  isForcedVoiceAudioish,
  aplicarTipoForcadoSticker,
  inferirTipoArquivo,
  getAudioFileExtension,
  resolveFfmpegPath,
  convertAudioWithFfmpeg,
  probeAudioDurationSec,
  normalizeAudioForUltraMsg,
  shouldAbortAudioAfterNormalize,
  shouldNormalizeVideoForUltraMsg,
  shouldForceProviderUploadForMedia,
  buildVideoTranscodeProfile,
  probeVideoDurationSec,
  convertVideoToUltraMsgMp4,
  normalizeVideoForUltraMsg,
  shouldNormalizeImageForWhatsapp,
  convertImageToWhatsappJpeg,
  normalizeImageForWhatsapp,
  dedupeMulterFiles,
  enviarArquivoProcessarUm,
  collectOrderedMessageIds,
  normalizeForwardTipo,
  getForwardMediaUrlCandidate,
  safeDecodeURIComponent,
  resolveLocalUploadPathFromMediaUrl,
  downloadR2MediaToTemp,
  resolveForwardMediaForProvider,
  encaminharUmaMensagemParaConversa,
} = require('./mediaProcessing')
const {
  _clientTempIdDeduplicationMap,
  _sendMemo,
  parseAudioDuracaoSecFromBody,
  normalizeClientTempId,
  clientTempIdDedupeKey,
  isMissingMensagemColumnError,
  isGenericMissingColumnError,
  isClientTempIdUniqueViolation,
  buildClientTempIdDedupResponse,
  findMensagemByClientTempId,
  normalizeLinkPayload,
  resolveConversationWhatsappInstance,
  resolveUltraMsgReplyMessageId,
  aplicarAguardandoClienteNoPayload,
  recalcularEMesclarModoSimples,
  textoParaEnvioWhatsapp,
  prefixarParaCliente,
  getUsuarioParaEnvioCliente,
  enrichMensagemComAutorUsuario,
  podeAssumirConversaPorPerfil,
  assertPodeEnviarMensagem,
} = require('./sendShared')
const {
  conversaVisibilityCache,
  CONVERSA_VISIBILITY_CACHE_TTL_MS,
  conversaVisibilityCacheKey,
  invalidateConversaVisibilityCache,
  getConversaParticipanteIdsAtivos,
  payloadAlteraVisibilidadeConversa,
  carregarUsuarioIdsQuePodemVerConversaSemCache,
  obterUsuarioIdsQuePodemVerConversa,
  incrementarUnreadParaConversa,
  emitirConversaAtualizada,
  emitirParaUsuariosQuePodemVerConversa,
  emitirEventoConversaVisivel,
  emitirEventoEmpresaConversa,
  emitirSincronizacaoListaConversas,
  emitirLock,
  emitirRealtimeAposAssumir,
  emitirParaUsuario,
  emitirMovimentacaoInternaAtendimento,
  emitirDepartamento,
} = require('./realtime')
const {
  registrarAtendimento,
  buildMensagemInternaMovimentacao,
  listarMensagensInternasMovimentacao,
  perfilPodeVerMovimentacaoInterna,
  isMensagemLegadaMovimentacaoInterna,
} = require('../../services/atendimentosRegistroService')
const { ensureConversaForCliente } = require('../../services/conversaAbrirClienteService')
const { executarAssumirConversa } = require('../../services/conversaAssumirInternoService')
const { resetAlertaSemRespostaAoAssumirReaberta } = require('../../services/atendimentoSemRespostaService')
const { getProvider } = require('../../services/providers')
const { getStatus } = require('../../services/ultramsgIntegrationService')
const { getDefaultWhatsappInstance, listWhatsappInstances, resolveWhatsappInstanceForManualAction, sanitizeWhatsappInstance } = require('../../services/whatsappInstanceService')
const { isGroupConversation, isClosedAttendanceStatus } = require('../../helpers/conversaHelper')
const {
  normalizePhoneBR,
  possiblePhonesBR,
  phoneKeyBR,
  isLidPhoneKey,
  pickRealPhoneCandidate,
} = require('../../helpers/phoneHelper')
const { deduplicateConversationsByContact, sortConversationsByRecent, sortConversationsPinThenRecent, sortConversationsBySearchRelevance, getCanonicalPhone, getCanonicalPhoneAnyIntl, getOrCreateCliente, findOrCreateConversation, mergeConversasIntoCanonico } = require('../../helpers/conversationSync')
const { enrichConversationsWithContactData } = require('../../helpers/conversaEnrichment')
const {
  resolveReabertaPorFaltaInteracao,
  enrichConversasReabertaFaltaInteracao,
  clearReabertaFaltaInteracao,
} = require('../../helpers/reabertaFaltaInteracaoHelper')
const { getDisplayName, normalizeName, isBadName } = require('../../helpers/contactEnrichment')
const { tryMarkWaitingAfterHumanOutbound } = require('../../services/absenceFinalizationService')
const {
  aplicarModoSimplesNoPayload,
  recalcularStatusPorUltimaMensagem,
  limparAguardandoAtendenteModoSimples,
  getUltimaMensagemReal,
  resolverModoSimplesAguardando,
} = require('../../services/atendimentoModoSimplesService')
const { empresaModoSimplesAtivo } = require('../../helpers/empresaModoSimplesFlag')
const {
  resolveGrupoIdsComUnreadParaUsuario,
  applyAguardandoAtendenteModoSimplesQuery,
  rowAguardandoAtendenteModoSimples,
} = require('../../helpers/modoSimplesGrupoUnread')
const { syncOldMessagesForConversation } = require('../../services/oldMessagesSyncService')
const {
  marcarAguardandoClienteManual,
  retomarEmAtendimentoManual,
} = require('../../services/conversaStatusManualService')
const {
  marcarAguardandoPagamento,
  retomarDeCobrancaFinanceira,
} = require('../../services/conversaPagamentoFinanceiroService')
const { usuarioPertenceSetorFinanceiro } = require('../../helpers/financeiroSetorHelper')
const {
  buildClienteSearchOr,
  buildTelefoneSearchOr,
  buildPhoneSearchTerms,
  chatIdentityMatchesSearch,
  escapeIlikePattern,
} = require('../../helpers/chatSearchHelper')
const {
  getGrupoDepartamentoIds,
  getGrupoIdsPorDepartamentos,
  getGrupoIdsSemDepartamento,
  usuarioPodeVerGrupo,
  pushNonGroupVisibilityParts,
  pushAllowedGroupIdsPart,
} = require('../../helpers/departamentoGruposHelper')
const {
  countConversasWithFilter,
  overridesFromListQuery,
  getChatFilterCounts,
  parseConversaIdsQuery,
  getStartOfTodayIso,
  getEndOfTodayIso,
} = require('../../services/chatListCountsService')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../../helpers/timestampApiCompat')
const { isRealWhatsAppId, isUltramsgNumericQueueId } = require('../../helpers/whatsappMessageIdHelper')
const { schedulePendingOutboundReconciliation } = require('../../services/pendingOutboundReconciliationService')
const {
  INTERNAL_NOTE_PERMISSAO,
  INTERNAL_NOTE_STATUS,
  REAL_MESSAGE_DIRECOES,
  isInternalNoteRow,
  sanitizeInternalNoteTexto,
  buildInternalNoteInsert,
} = require('../../helpers/internalNote')
const { usuarioTemPermissao } = require('../../helpers/permissoesService')

/**
 * controllers/chat/sendMediaController.js — Envio de mídia (arquivo/imagem/vídeo/áudio/documento), encaminhamento e reenvio manual. Usa mediaProcessing + resendService; nunca duplica mídia (idempotência sendShared).
 * Invariantes: isolamento por company_id; permissões/visibilidade; status unidirecional; sem retry cego.
 */

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

    const provider = getProvider()
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

