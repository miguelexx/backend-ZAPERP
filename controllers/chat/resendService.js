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
 * controllers/chat/resendService.js — reenvio manual de mensagem com falha (retry-text/media).
 * Reutiliza SEMPRE a mesma linha de mensagens (nunca cria registro novo). Reenvio só quando o
 * provedor comprovadamente NÃO aceitou a mensagem (avaliarElegibilidadeReenvio) — sem retry cego.
 * Handlers reenviar* vivem em sendMediaController e usam prepararReenvio daqui.
 */

/** Reenvios em voo por mensagem — impede que clique duplo gere dois envios ao provedor. */
const _reenviosEmAndamento = new Set()

const _STATUS_REENVIO_PERMITIDO = new Set(['erro', 'error', 'failed', 'falhou'])

const _STATUS_JA_RESOLVIDO = new Set(['sent', 'delivered', 'read', 'played', 'enviada', 'entregue', 'lida'])

function statusReenvioNormalizado(mensagem) {
  return String(mensagem?.status_mensagem || mensagem?.status || '').toLowerCase().trim()
}

/**
 * Reenvio só é seguro quando o provedor comprovadamente não aceitou a mensagem.
 * Com whatsapp_id real ou provider_queue_id o WhatsApp já a recebeu: reenviar duplicaria para o cliente.
 */
function avaliarElegibilidadeReenvio(mensagem) {
  if (String(mensagem?.direcao || '').toLowerCase() !== 'out') {
    return { permitido: false, httpStatus: 400, motivo: 'Só é possível reenviar mensagens enviadas pelo atendimento.' }
  }
  if (isRealWhatsAppId(mensagem?.whatsapp_id)) {
    return { permitido: false, jaResolvida: true, motivo: 'Mensagem já confirmada pelo WhatsApp.' }
  }
  if (_STATUS_JA_RESOLVIDO.has(statusReenvioNormalizado(mensagem))) {
    return { permitido: false, jaResolvida: true, motivo: 'Mensagem já enviada.' }
  }
  if (_STATUS_REENVIO_PERMITIDO.has(statusReenvioNormalizado(mensagem))) return { permitido: true }
  // Linhas legadas podem ter o ID de fila gravado em whatsapp_id: também significa provedor que já aceitou.
  const idFilaProvedor =
    String(mensagem?.provider_queue_id || '').trim() ||
    (isUltramsgNumericQueueId(String(mensagem?.whatsapp_id || '').trim())
      ? String(mensagem.whatsapp_id).trim()
      : '')
  if (idFilaProvedor) {
    return {
      permitido: false,
      httpStatus: 409,
      motivo: 'O WhatsApp já recebeu esta mensagem e ainda não confirmou. Aguarde antes de reenviar.',
    }
  }
  return { permitido: true }
}

/** Telefone real de envio da conversa (resolve LID). */
async function resolverTelefoneEnvioDaConversa(company_id, conversa, whatsappInstanceId) {
  let telefone = String(conversa?.telefone || '').trim()
  if (telefone && telefone.toLowerCase().startsWith('lid:')) {
    if (conversa?.cliente_id) {
      const { data: cli } = await supabase
        .from('clientes')
        .select('telefone')
        .eq('id', conversa.cliente_id)
        .eq('company_id', company_id)
        .maybeSingle()
      if (cli?.telefone && !String(cli.telefone).startsWith('lid:')) telefone = String(cli.telefone).trim()
    }
    if (telefone.startsWith('lid:') && conversa?.chat_lid) {
      const telSibling = await resolveTelefoneFromLidSiblingConversation(company_id, conversa, whatsappInstanceId)
      if (telSibling) telefone = String(telSibling).trim()
    }
    if (telefone.startsWith('lid:')) {
      return {
        telefone: null,
        erro: 'Número do contato indisponível (conversa por LID). Aguarde o contato enviar uma mensagem ou sincronize os contatos.',
      }
    }
  }
  if (!telefone) return { telefone: null, erro: 'Conversa sem telefone para envio.' }
  return { telefone, erro: null }
}

/** Legenda original do atendente a partir do texto persistido (inverte os placeholders de mídia). */
function captionUsuarioDeMidiaPersistida(mensagem) {
  const texto = String(mensagem?.texto || '').trim()
  if (!texto) return ''
  const placeholders = new Set(['(áudio)', '(áudio de voz)', '(figurinha)', '(imagem)', '(vídeo)', '(arquivo)'])
  if (placeholders.has(texto.toLowerCase())) return ''
  if (texto === String(mensagem?.nome_arquivo || '').trim()) return ''
  return texto
}

/** Persiste o resultado do reenvio na própria mensagem e propaga por socket. */
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

module.exports = {
  _reenviosEmAndamento,
  _STATUS_REENVIO_PERMITIDO,
  _STATUS_JA_RESOLVIDO,
  statusReenvioNormalizado,
  avaliarElegibilidadeReenvio,
  resolverTelefoneEnvioDaConversa,
  captionUsuarioDeMidiaPersistida,
  aplicarResultadoReenvio,
  prepararReenvio,
}
