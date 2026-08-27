const supabase = require('../config/supabase')
const _chatShared = require('./chat/shared')
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
// __CHAT_MODULE_IMPORTS__
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
} = require('./chat/resendService')
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
} = require('./chat/mediaProcessing')
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
} = require('./chat/sendShared')
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
} = require('./chat/realtime')
const {
  registrarAtendimento,
  buildMensagemInternaMovimentacao,
  listarMensagensInternasMovimentacao,
  perfilPodeVerMovimentacaoInterna,
  isMensagemLegadaMovimentacaoInterna,
} = require('../services/atendimentosRegistroService')
const { ensureConversaForCliente } = require('../services/conversaAbrirClienteService')
const { executarAssumirConversa } = require('../services/conversaAssumirInternoService')
const { resetAlertaSemRespostaAoAssumirReaberta } = require('../services/atendimentoSemRespostaService')
const { getProvider } = require('../services/providers')
const { getStatus } = require('../services/ultramsgIntegrationService')
const { getDefaultWhatsappInstance, listWhatsappInstances, resolveWhatsappInstanceForManualAction, sanitizeWhatsappInstance } = require('../services/whatsappInstanceService')
const { isGroupConversation, isClosedAttendanceStatus } = require('../helpers/conversaHelper')
const {
  normalizePhoneBR,
  possiblePhonesBR,
  phoneKeyBR,
  isLidPhoneKey,
  pickRealPhoneCandidate,
} = require('../helpers/phoneHelper')
const { deduplicateConversationsByContact, sortConversationsByRecent, sortConversationsPinThenRecent, sortConversationsBySearchRelevance, getCanonicalPhone, getCanonicalPhoneAnyIntl, getOrCreateCliente, findOrCreateConversation, mergeConversasIntoCanonico } = require('../helpers/conversationSync')
const { enrichConversationsWithContactData } = require('../helpers/conversaEnrichment')
const {
  resolveReabertaPorFaltaInteracao,
  enrichConversasReabertaFaltaInteracao,
  clearReabertaFaltaInteracao,
} = require('../helpers/reabertaFaltaInteracaoHelper')
const { getDisplayName, normalizeName, isBadName } = require('../helpers/contactEnrichment')
const { tryMarkWaitingAfterHumanOutbound } = require('../services/absenceFinalizationService')
const {
  aplicarModoSimplesNoPayload,
  recalcularStatusPorUltimaMensagem,
  limparAguardandoAtendenteModoSimples,
  getUltimaMensagemReal,
  resolverModoSimplesAguardando,
} = require('../services/atendimentoModoSimplesService')
const { empresaModoSimplesAtivo } = require('../helpers/empresaModoSimplesFlag')
const {
  resolveGrupoIdsComUnreadParaUsuario,
  applyAguardandoAtendenteModoSimplesQuery,
  rowAguardandoAtendenteModoSimples,
} = require('../helpers/modoSimplesGrupoUnread')
const { syncOldMessagesForConversation } = require('../services/oldMessagesSyncService')
const {
  marcarAguardandoClienteManual,
  retomarEmAtendimentoManual,
} = require('../services/conversaStatusManualService')
const {
  marcarAguardandoPagamento,
  retomarDeCobrancaFinanceira,
} = require('../services/conversaPagamentoFinanceiroService')
const { usuarioPertenceSetorFinanceiro } = require('../helpers/financeiroSetorHelper')
const {
  buildClienteSearchOr,
  buildTelefoneSearchOr,
  buildPhoneSearchTerms,
  chatIdentityMatchesSearch,
  escapeIlikePattern,
} = require('../helpers/chatSearchHelper')
const {
  getGrupoDepartamentoIds,
  getGrupoIdsPorDepartamentos,
  getGrupoIdsSemDepartamento,
  usuarioPodeVerGrupo,
  pushNonGroupVisibilityParts,
  pushAllowedGroupIdsPart,
} = require('../helpers/departamentoGruposHelper')
const {
  countConversasWithFilter,
  overridesFromListQuery,
  getChatFilterCounts,
  parseConversaIdsQuery,
  getStartOfTodayIso,
  getEndOfTodayIso,
} = require('../services/chatListCountsService')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../helpers/timestampApiCompat')
const { isRealWhatsAppId, isUltramsgNumericQueueId } = require('../helpers/whatsappMessageIdHelper')
const { schedulePendingOutboundReconciliation } = require('../services/pendingOutboundReconciliationService')
const {
  INTERNAL_NOTE_PERMISSAO,
  INTERNAL_NOTE_STATUS,
  REAL_MESSAGE_DIRECOES,
  isInternalNoteRow,
  sanitizeInternalNoteTexto,
  buildInternalNoteInsert,
} = require('../helpers/internalNote')
const { usuarioTemPermissao } = require('../helpers/permissoesService')





































exports.emitirEventoEmpresaConversa = emitirEventoEmpresaConversa




exports.emitirRealtimeAposAssumir = emitirRealtimeAposAssumir




exports.emitirMovimentacaoInternaAtendimento = emitirMovimentacaoInternaAtendimento





const { formatTextoWhatsappComNomeAtendente } = require('../helpers/mensagemAtendenteNomeHelper')




























exports.incrementarUnreadParaConversa = incrementarUnreadParaConversa
exports.emitirParaUsuariosQuePodemVerConversa = emitirParaUsuariosQuePodemVerConversa
exports.obterUsuarioIdsQuePodemVerConversa = obterUsuarioIdsQuePodemVerConversa














































// =====================================================
// Reações em mensagens (Z-API send-reaction / send-remove-reaction)
// =====================================================



// =====================================================
// Compartilhar contato existente pelo WhatsApp (Z-API /send-contact)
// =====================================================


// =====================================================
// enviarLocalizacao — envia localização via UltraMsg (contrato WhatsApp)
// =====================================================


// =====================================================
// Registro de ligações via WhatsApp (Z-API /send-call)
// =====================================================




























const {
  parseClientTempIdsFromBody,
  buildArquivoApiResultRow,
} = require('../helpers/arquivoUploadResponseHelper')

















/* ==========================================================================
   REENVIO MANUAL DE MENSAGEM COM FALHA (retry-text / retry-media)
   Reutiliza sempre a mesma linha de `mensagens`: nunca cria registro novo.
   ========================================================================== */











exports._test = {
  assertPodeEnviarMensagem,
  avaliarElegibilidadeReenvio,
  captionUsuarioDeMidiaPersistida,
  parseChatListPagination,
  splitChatListPage,
  parseMessageHistoryPagination,
  splitMessageHistoryPage,
  shouldIncludeClientesSemConversa,
  getSearchMessagesPageSize,
  getChatSearchScanLimit,
  getChatSearchIdLimit,
  getChatFilterIdLimit,
  resolveConversationWhatsappInstance,
  normalizeLinkPayload,
  normalizeClientTempId,
  buildClientTempIdDedupResponse,
  isClientTempIdUniqueViolation,
  inferirTipoArquivo,
  aplicarTipoForcadoSticker,
  isForcedVoiceAudioish,
  shouldAbortAudioAfterNormalize,
  shouldNormalizeVideoForUltraMsg,
  shouldForceProviderUploadForMedia,
  buildVideoTranscodeProfile,
  normalizeVideoForUltraMsg,
  parseAudioDuracaoSecFromBody,
  shouldNormalizeImageForWhatsapp,
  normalizeForwardTipo,
  resolveForwardMediaForProvider,
}

// =====================================================
// Fachada dos fluxos de LEITURA (modularizados em controllers/chat/).
// Mantém os mesmos nomes de export para rotas e testes existentes.
// =====================================================
const _chatListController = require('./chat/listController')
const _chatHistoryController = require('./chat/historyController')
exports.listarConversas = _chatListController.listarConversas
exports.contarConversasPorFiltros = _chatListController.contarConversasPorFiltros
exports.detalharChat = _chatHistoryController.detalharChat
exports.buscarMensagensConversa = _chatHistoryController.buscarMensagensConversa

const _tagsNotesController = require('./chat/tagsNotesController')
exports.adicionarTagConversa = _tagsNotesController.adicionarTagConversa
exports.removerTagConversa = _tagsNotesController.removerTagConversa
exports.criarNotaInterna = _tagsNotesController.criarNotaInterna

const _messageActionsController = require('./chat/messageActionsController')
exports.excluirMensagem = _messageActionsController.excluirMensagem
exports.enviarReacaoMensagem = _messageActionsController.enviarReacaoMensagem
exports.removerReacaoMensagem = _messageActionsController.removerReacaoMensagem

const _attendanceController = require('./chat/attendanceController')
exports.assumirChat = _attendanceController.assumirChat
exports.encerrarChat = _attendanceController.encerrarChat
exports.reabrirChat = _attendanceController.reabrirChat
exports.marcarLidaModoSimplesChat = _attendanceController.marcarLidaModoSimplesChat
exports.marcarAguardandoClienteManualChat = _attendanceController.marcarAguardandoClienteManualChat
exports.marcarAguardandoPagamentoFinanceiroChat = _attendanceController.marcarAguardandoPagamentoFinanceiroChat
exports.retomarEmAtendimentoManualChat = _attendanceController.retomarEmAtendimentoManualChat
exports.transferirChat = _attendanceController.transferirChat
exports.transferirSetor = _attendanceController.transferirSetor
exports.listarAtendentesDisponiveisConversa = _attendanceController.listarAtendentesDisponiveisConversa
exports.removerAtendenteConversa = _attendanceController.removerAtendenteConversa
exports.listarAtendentesConversa = _attendanceController.listarAtendentesConversa
exports.adicionarAtendenteConversa = _attendanceController.adicionarAtendenteConversa
exports.listarAtendimentos = _attendanceController.listarAtendimentos
exports.puxarChatFila = _attendanceController.puxarChatFila
exports.finalizacaoAusenciaLoteAuth = _attendanceController.finalizacaoAusenciaLoteAuth

const _contactController = require('./chat/contactController')
exports.vincularClienteConversa = _contactController.vincularClienteConversa
exports.atualizarNomeContato = _contactController.atualizarNomeContato
exports.atualizarObservacao = _contactController.atualizarObservacao
exports.patchConversaPrefs = _contactController.patchConversaPrefs
exports.criarContato = _contactController.criarContato
exports.abrirConversaCliente = _contactController.abrirConversaCliente
exports.sincronizarContatosZapi = _contactController.sincronizarContatosZapi
exports.sincronizarFotosPerfilZapi = _contactController.sincronizarFotosPerfilZapi
exports.debugSyncContatos = _contactController.debugSyncContatos
exports.whatsappStatus = _contactController.whatsappStatus
exports.zapiStatus = _contactController.zapiStatus
exports.listWhatsappInstancesAtendimento = _contactController.listWhatsappInstancesAtendimento

const _conversationController = require('./chat/conversationController')
exports.limparMensagensConversa = _conversationController.limparMensagensConversa
exports.apagarConversa = _conversationController.apagarConversa
exports.carregarMensagensAntigasContato = _conversationController.carregarMensagensAntigasContato
exports.mergeConversasDuplicadas = _conversationController.mergeConversasDuplicadas
exports.paginaMergeDuplicatas = _conversationController.paginaMergeDuplicatas
exports.criarGrupo = _conversationController.criarGrupo
exports.criarComunidade = _conversationController.criarComunidade

const _sendMessageController = require('./chat/sendMessageController')
exports.enviarMensagemChat = _sendMessageController.enviarMensagemChat
exports.enviarMensagemPix = _sendMessageController.enviarMensagemPix
exports.getPixConfig = _sendMessageController.getPixConfig
exports.putPixConfig = _sendMessageController.putPixConfig
exports.enviarLocalizacao = _sendMessageController.enviarLocalizacao
exports.enviarContatoWhatsapp = _sendMessageController.enviarContatoWhatsapp
exports.enviarLigacaoWhatsapp = _sendMessageController.enviarLigacaoWhatsapp

const _sendMediaController = require('./chat/sendMediaController')
exports.enviarArquivo = _sendMediaController.enviarArquivo
exports.encaminharMensagem = _sendMediaController.encaminharMensagem
exports.reenviarTextoMensagem = _sendMediaController.reenviarTextoMensagem
exports.reenviarMidiaMensagem = _sendMediaController.reenviarMidiaMensagem
