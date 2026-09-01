const supabase = require('../config/supabase')
const {
  registrarAtendimento,
  listarMensagensInternasMovimentacao,
  perfilPodeVerMovimentacaoInterna,
  isMensagemLegadaMovimentacaoInterna,
} = require('../services/atendimentosRegistroService')
const { ensureConversaForCliente } = require('../services/conversaAbrirClienteService')
const { executarAssumirConversa } = require('../services/conversaAssumirInternoService')
const { resetAlertaSemRespostaAoAssumirReaberta } = require('../services/atendimentoSemRespostaService')
const { getProvider } = require('../services/providers')
const { listWhatsappInstances, resolveWhatsappInstanceForManualAction, sanitizeWhatsappInstance } = require('../services/whatsappInstanceService')
const { isGroupConversation, isClosedAttendanceStatus } = require('../helpers/conversaHelper')
const {
  normalizePhoneBR,
  possiblePhonesBR,
  phoneKeyBR,
  isLidPhoneKey,
  pickRealPhoneCandidate,
} = require('../helpers/phoneHelper')
const { deduplicateConversationsByContact, sortConversationsByRecent, sortConversationsPinThenRecent, sortConversationsBySearchRelevance, getCanonicalPhone, getCanonicalPhoneAnyIntl, getOrCreateCliente, findOrCreateConversation } = require('../helpers/conversationSync')
const { enrichConversationsWithContactData } = require('../helpers/conversaEnrichment')
const {
  resolveReabertaPorFaltaInteracao,
  enrichConversasReabertaFaltaInteracao,
  clearReabertaFaltaInteracao,
} = require('../helpers/reabertaFaltaInteracaoHelper')
const { getDisplayName, normalizeName, isBadName } = require('../helpers/contactEnrichment')
const { updateClienteResiliente } = require('../helpers/clienteNomeColunas')
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
  buscarConversaIdsPorNomesVinculados,
  buscarClienteIdsPorNomeVinculado,
  anexarVinculosEmBusca,
} = require('../helpers/clienteNomesVinculados')
const {
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

// =====================================================
// Módulos extraídos do chatController (Fase 1 da modularização).
// Funções puras movidas para services/chat/**; reimportadas aqui com o mesmo nome
// para preservar todos os call sites internos, exports e o export `_test`.
// =====================================================
const {
  parsePositiveInt,
  parseBooleanQuery,
  parseChatListPagination,
  applyChatListCursor,
  splitChatListPage,
  parseMessageHistoryPagination,
  splitMessageHistoryPage,
  shouldIncludeClientesSemConversa,
  setChatListPaginationHeaders,
  applyDetalharChatMensagensCursor,
} = require('../services/chat/read/pagination')
const {
  getSearchMessagesPageSize,
  getChatSearchScanLimit,
  getChatSearchIdLimit,
  getChatFilterIdLimit,
  getConversaMessagesSearchLimit,
} = require('../services/chat/read/searchLimits')
const {
  mergeConversaClienteTags,
  statusAtendimentoParaLista,
  safeWhatsappInstanceMeta,
} = require('../services/chat/presentation/chatDto')
const {
  normalizeClientTempId,
  clientTempIdDedupeKey,
  isMissingMensagemColumnError,
  isGenericMissingColumnError,
  isClientTempIdUniqueViolation,
  buildClientTempIdDedupResponse,
} = require('../services/chat/outbound/idempotencyHelpers')
const {
  normalizeLinkPayload,
  normalizeForwardTipo,
} = require('../services/chat/outbound/messageNormalizers')
const {
  statusReenvioNormalizado,
  avaliarElegibilidadeReenvio,
  captionUsuarioDeMidiaPersistida,
} = require('../services/chat/outbound/retryEligibility')
const {
  parseAudioDuracaoSecFromBody,
  isForcedVoiceAudioish,
  aplicarTipoForcadoSticker,
  inferirTipoArquivo,
  shouldAbortAudioAfterNormalize,
  shouldNormalizeVideoForUltraMsg,
  shouldForceProviderUploadForMedia,
  buildVideoTranscodeProfile,
  shouldNormalizeImageForWhatsapp,
} = require('../services/chat/media/mediaType')
const {
  resolveTelefoneFromLidSiblingConversation,
  resolveConversationWhatsappInstance,
  resolverTelefoneEnvioDaConversa,
} = require('../services/chat/identity/conversationAddressService')
const {
  invalidateConversaVisibilityCache,
  isConversaAtendentesMissingTable,
  getConversaParticipanteIdsAtivos,
  getConversaIdsParticipanteAtivo,
  usuarioParticipaAtivamenteDaConversa,
  payloadAlteraVisibilidadeConversa,
  deveIncluirGruposSemDepartamentoNoFiltroTodos,
  carregarUsuarioIdsQuePodemVerConversaSemCache,
  obterUsuarioIdsQuePodemVerConversa,
  incrementarUnreadParaConversa,
} = require('../services/chat/access/conversationVisibilityService')
const {
  emitirConversaAtualizada,
  emitirParaUsuariosQuePodemVerConversa,
  emitirEventoEmpresaConversa,
  emitirSincronizacaoListaConversas,
  emitirLock,
  emitirRealtimeAposAssumir,
  emitirParaUsuario,
  emitirMovimentacaoInternaAtendimento,
  emitirDepartamento,
} = require('../services/chat/realtime/chatRealtimeGateway')
const {
  normalizeAudioForUltraMsg,
  probeAudioDurationSec,
  normalizeVideoForUltraMsg,
  normalizeImageForWhatsapp,
} = require('../services/chat/media/mediaNormalizers')
const {
  getForwardMediaUrlCandidate,
  resolveForwardMediaForProvider,
} = require('../services/chat/outbound/forwardMediaResolver')
const {
  assertPermissaoConversa,
  podeAssumirConversaPorPerfil,
  assertPodeEnviarMensagem,
} = require('../services/chat/access/conversationPolicy')
const { deriveListarConversasFilters } = require('../services/chat/read/listarConversasFilters')
const {
  textoRevogadoApagadaParaTodos,
  aplicarApagadaParaTodosNaMensagem,
  enrichMensagensComAutorUsuario,
  textoParaEnvioWhatsapp,
  prefixarParaCliente,
  getUsuarioParaEnvioCliente,
  enrichMensagemComAutorUsuario,
} = require('../services/chat/presentation/messageAuthorEnrichment')
const { marcarComoLidaPorUsuario, obterUnreadMap } = require('../services/chat/unread/conversationUnreadService')
const {
  loadWhatsappInstanceMetaMap,
  resolveUltraMsgReplyMessageId,
  buscarConversaIdsPorTextoMensagens,
} = require('../services/chat/read/conversationLookups')
const { sanitizePixConfigPayload, formatPixTipoLabel, buildPixMessageFromConfig } = require('../services/chat/outbound/pixConfig')

const {
  deduplicationMap: _clientTempIdDeduplicationMap,
  findMensagemByClientTempId,
  isDbDedupeUnavailable,
  markDbDedupeUnavailable,
  isAudioDuracaoSecColumnUnavailable,
  markAudioDuracaoSecColumnUnavailable,
} = require('../services/chat/outbound/idempotencyService')

// =====================================================
// 1) HELPERS (TOPO DO ARQUIVO)
// =====================================================
const {
  aplicarAguardandoClienteNoPayload,
  recalcularEMesclarModoSimples,
} = require('../services/chat/outbound/modoSimplesOutbound')

exports.emitirEventoEmpresaConversa = emitirEventoEmpresaConversa

exports.emitirRealtimeAposAssumir = emitirRealtimeAposAssumir

exports.emitirMovimentacaoInternaAtendimento = emitirMovimentacaoInternaAtendimento

exports.incrementarUnreadParaConversa = incrementarUnreadParaConversa
exports.emitirParaUsuariosQuePodemVerConversa = emitirParaUsuariosQuePodemVerConversa
exports.obterUsuarioIdsQuePodemVerConversa = obterUsuarioIdsQuePodemVerConversa

// =====================================================
// 3) listarConversas (com unread_count + pesquisa avançada)
// Query: tag_id, data_inicio, data_fim, status_atendimento, atendente_id, palavra, minha_fila, aguardando_cliente, tempo_parado, finalizacao_motivo (ex.: ausencia_cliente — filtra com status fechada)
// minha_fila=1: conversas em aberta (fila visível) + em_atendimento onde o responsável é o usuário logado
//   + grupos vinculados aos departamentos do usuário, todos ordenados por última atividade.
// aguardando_cliente=1: só conversas “aguardando” em que o atendente responsável é o usuário logado (organização por atendente).
//   Admin/supervisor pode combinar com atendente_id=<id> para ver a fila de outro colaborador (mesmo critério do restante da API).
// atendente_id=<usuarios.id>: admin/supervisor — todas as conversas individuais com esse responsável (qualquer status_atendimento); sem minha_fila; ver docs/API-CHATS-QUERY.md
// =====================================================
// listarConversas — controllers/chat/conversationListController.js (reexportado).
const _conversationListController = require('./chat/conversationListController')
exports.listarConversas = _conversationListController.listarConversas

// HTML mínimo da página "Apagar duplicatas" (botão + chamada à API)
// Merge de duplicatas movido para controllers/chat/maintenanceController.js (reexportado abaixo).
const _maintenanceController = require('./chat/maintenanceController')
exports.paginaMergeDuplicatas = _maintenanceController.paginaMergeDuplicatas
exports.mergeConversasDuplicadas = _maintenanceController.mergeConversasDuplicadas

// =====================================================
// 3a) Instâncias WhatsApp ativas (atendimento — sem tokens)
// GET /chats/whatsapp-instances
// =====================================================
// Integração/sync WhatsApp movida para controllers/chat/integrationController.js (reexportado abaixo).
const _integrationController = require('./chat/integrationController')
exports.listWhatsappInstancesAtendimento = _integrationController.listWhatsappInstancesAtendimento
exports.whatsappStatus = _integrationController.whatsappStatus
exports.zapiStatus = _integrationController.zapiStatus
exports.sincronizarContatosZapi = _integrationController.sincronizarContatosZapi
exports.debugSyncContatos = _integrationController.debugSyncContatos
exports.sincronizarFotosPerfilZapi = _integrationController.sincronizarFotosPerfilZapi

// =====================================================
// 4) CRIAR GRUPO
// =====================================================
// Contatos/grupos movidos para controllers/chat/contactController.js (reexportado abaixo).
const _contactController = require('./chat/contactController')
exports.criarGrupo = _contactController.criarGrupo
exports.criarComunidade = _contactController.criarComunidade
exports.vincularClienteConversa = _contactController.vincularClienteConversa
exports.atualizarNomeContato = _contactController.atualizarNomeContato
exports.atualizarObservacao = _contactController.atualizarObservacao

// =====================================================
// Preferências da lista (silenciar / fixar / favoritar) — PATCH /chats/:id/prefs
// =====================================================
// patchConversaPrefs — controllers/chat/preferencesController.js (reexportado).
const _preferencesController = require('./chat/preferencesController')
exports.patchConversaPrefs = _preferencesController.patchConversaPrefs

// =====================================================
// Limpar mensagens da conversa (mantém a conversa) — POST /chats/:id/limpar-mensagens
// =====================================================
// limparMensagensConversa, apagarConversa — controllers/chat/conversationCleanupController.js (reexportado).
const _conversationCleanupController = require('./chat/conversationCleanupController')
exports.limparMensagensConversa = _conversationCleanupController.limparMensagensConversa
exports.apagarConversa = _conversationCleanupController.apagarConversa

// =====================================================
// 5b) ABRIR CONVERSA POR CLIENTE (lista de clientes → chat list)
// =====================================================
// abrirConversaCliente / criarContato — controllers/chat/contactController.js (reexportado).
exports.abrirConversaCliente = _contactController.abrirConversaCliente
exports.criarContato = _contactController.criarContato



// =====================================================
// 4) detalharChat (paginação + marcar como lida)
// IMPORTANTÍSSIMO: não disparar atualizar lista ao abrir (evita loop)
// =====================================================
// detalharChat — controllers/chat/conversationDetailController.js (reexportado).
const _conversationDetailController = require('./chat/conversationDetailController')
exports.detalharChat = _conversationDetailController.detalharChat

// carregarMensagensAntigasContato, buscarMensagensConversa — controllers/chat/messageReadController.js (reexportado).
const _messageReadController = require('./chat/messageReadController')
exports.carregarMensagensAntigasContato = _messageReadController.carregarMensagensAntigasContato
exports.buscarMensagensConversa = _messageReadController.buscarMensagensConversa

// =====================================================
// 5) assumirChat (lock real)
// =====================================================
// Ciclo de atendimento movido para controllers/chat/attendanceController.js (reexportado abaixo).
const _attendanceController = require('./chat/attendanceController')
exports.assumirChat = _attendanceController.assumirChat
exports.encerrarChat = _attendanceController.encerrarChat
exports.reabrirChat = _attendanceController.reabrirChat
exports.marcarLidaModoSimplesChat = _attendanceController.marcarLidaModoSimplesChat
exports.marcarAguardandoClienteManualChat = _attendanceController.marcarAguardandoClienteManualChat
exports.marcarAguardandoPagamentoFinanceiroChat = _attendanceController.marcarAguardandoPagamentoFinanceiroChat
exports.retomarEmAtendimentoManualChat = _attendanceController.retomarEmAtendimentoManualChat
exports.transferirChat = _attendanceController.transferirChat
exports.listarAtendentesDisponiveisConversa = _attendanceController.listarAtendentesDisponiveisConversa
exports.criarNotaInterna = _attendanceController.criarNotaInterna
exports.removerAtendenteConversa = _attendanceController.removerAtendenteConversa
exports.listarAtendentesConversa = _attendanceController.listarAtendentesConversa
exports.adicionarAtendenteConversa = _attendanceController.adicionarAtendenteConversa
exports.transferirSetor = _attendanceController.transferirSetor

/** GET /chats/pix-config */
// getPixConfig, putPixConfig, enviarMensagemPix — controllers/chat/pixController.js (reexportado).
const _pixController = require('./chat/pixController')
exports.getPixConfig = _pixController.getPixConfig
exports.putPixConfig = _pixController.putPixConfig
exports.enviarMensagemPix = _pixController.enviarMensagemPix

// =====================================================
// enviarMensagemChat (corrigido + padronizado)
// =====================================================
// enviarMensagemChat — controllers/chat/textMessageController.js (reexportado).
const _textMessageController = require('./chat/textMessageController')
exports.enviarMensagemChat = _textMessageController.enviarMensagemChat

// =====================================================
// Reações em mensagens (Z-API send-reaction / send-remove-reaction)
// =====================================================

// Saída não-mídia (reação/contato/localização/ligação) movida para controllers/chat/outboundController.js.
const _outboundController = require('./chat/outboundController')
exports.enviarReacaoMensagem = _outboundController.enviarReacaoMensagem
exports.removerReacaoMensagem = _outboundController.removerReacaoMensagem
exports.enviarContatoWhatsapp = _outboundController.enviarContatoWhatsapp
exports.enviarLocalizacao = _outboundController.enviarLocalizacao
exports.enviarLigacaoWhatsapp = _outboundController.enviarLigacaoWhatsapp

// =====================================================
// excluirMensagem — remove do sistema (DB) + realtime
// =====================================================
// excluirMensagem — controllers/chat/messageDeletionController.js (reexportado).
const _messageDeletionController = require('./chat/messageDeletionController')
exports.excluirMensagem = _messageDeletionController.excluirMensagem

// =====================================================
// listarAtendimentos — atendimentos + historico (transferiu_setor) com nomes
// =====================================================
// listarAtendimentos, puxarChatFila — controllers/chat/attendanceQueueController.js (reexportado).
const _attendanceQueueController = require('./chat/attendanceQueueController')
exports.listarAtendimentos = _attendanceQueueController.listarAtendimentos
exports.puxarChatFila = _attendanceQueueController.puxarChatFila

// =====================================================
// TAGS (padronizado)
// =====================================================
// adicionarTagConversa, removerTagConversa — controllers/chat/tagsController.js (reexportado).
const _tagsController = require('./chat/tagsController')
exports.adicionarTagConversa = _tagsController.adicionarTagConversa
exports.removerTagConversa = _tagsController.removerTagConversa
// enviarArquivo — controllers/chat/mediaMessageController.js (reexportado).
const _mediaMessageController = require('./chat/mediaMessageController')
exports.enviarArquivo = _mediaMessageController.enviarArquivo

// Encaminhamento movido para controllers/chat/forwardController.js (reexportado abaixo).
const _forwardController = require('./chat/forwardController')
exports.encaminharMensagem = _forwardController.encaminharMensagem

/**
 * POST /chats/finalizacao-ausencia-lote — supervisor/admin, JWT.
 * Body: { conversa_ids, dry_run?, execute?, confirm? } — delega a finalizeAbsenceForConversaIds.
 */
// contarConversasPorFiltros, finalizacaoAusenciaLoteAuth — controllers/chat/batchOpsController.js (reexportado).
const _batchOpsController = require('./chat/batchOpsController')
exports.contarConversasPorFiltros = _batchOpsController.contarConversasPorFiltros
exports.finalizacaoAusenciaLoteAuth = _batchOpsController.finalizacaoAusenciaLoteAuth

/* ==========================================================================
   REENVIO MANUAL DE MENSAGEM COM FALHA (retry-text / retry-media)
   Movido para controllers/chat/retryController.js (reexportado abaixo).
   ========================================================================== */
const _retryController = require('./chat/retryController')
exports.reenviarTextoMensagem = _retryController.reenviarTextoMensagem
exports.reenviarMidiaMensagem = _retryController.reenviarMidiaMensagem

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
