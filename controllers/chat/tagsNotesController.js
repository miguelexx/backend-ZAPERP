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
 * controllers/chat/tagsNotesController.js — etiquetas da conversa e notas internas.
 * Handlers: adicionarTagConversa, removerTagConversa, criarNotaInterna.
 * Invariantes: isolamento por company_id; permissões; emissão de socket via ./realtime.
 */

exports.criarNotaInterna = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params

    let texto
    try {
      texto = sanitizeInternalNoteTexto(req.body?.texto)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    const podeAnotar = await usuarioTemPermissao({
      usuario_id: user_id,
      company_id,
      perfil,
      permissao_codigo: INTERNAL_NOTE_PERMISSAO,
    })
    if (!podeAnotar) {
      return res.status(403).json({ error: 'Sem permissão para criar nota interna' })
    }

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_ids: departamento_ids })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    if (perm.conv && isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Notas internas não são suportadas em grupos' })
    }

    const { data: nota, error: insertErr } = await supabase
      .from('mensagens')
      .insert(buildInternalNoteInsert({ company_id, conversa_id, autor_usuario_id: user_id, texto }))
      .select('id, company_id, conversa_id, texto, tipo, direcao, autor_usuario_id, criado_em')
      .single()

    if (insertErr) {
      console.error('[criarNotaInterna] insert error:', insertErr?.message, insertErr?.details, insertErr?.hint, insertErr?.code)
      const _debug = [insertErr?.code, insertErr?.message, insertErr?.details, insertErr?.hint].filter(Boolean).join(' | ')
      return res.status(500).json({ error: 'Erro ao salvar nota interna', _debug })
    }

    const { data: autorRow } = await supabase
      .from('usuarios')
      .select('id, nome')
      .eq('company_id', Number(company_id))
      .eq('id', Number(user_id))
      .maybeSingle()

    const notaEnriquecida = {
      ...nota,
      status: INTERNAL_NOTE_STATUS,
      criado_em: normalizarTimestampSemFusoAmbiguoParaApi(nota.criado_em),
      usuario_id: Number(user_id),
      usuario_nome: autorRow?.nome || null,
      enviado_por_usuario: false,
      fromMe: false,
    }

    const io = req.app.get('io')
    if (io) {
      await emitirParaUsuariosQuePodemVerConversa(io, company_id, conversa_id, 'mensagem_interna_atendimento', notaEnriquecida)
    }

    return res.status(201).json({ ok: true, nota: notaEnriquecida })
  } catch (err) {
    console.error('[criarNotaInterna]', err)
    return res.status(500).json({ error: 'Erro ao criar nota interna' })
  }
}

// =====================================================
// TAGS (padronizado)
// =====================================================
exports.adicionarTagConversa = async (req, res) => {
  try {
    const { id } = req.params
    const { tag_id } = req.body
    const { company_id } = req.user

    if (!tag_id) return res.status(400).json({ error: 'tag_id é obrigatório' })

    const { data: existente } = await supabase
      .from('conversa_tags')
      .select('id')
      .eq('conversa_id', id)
      .eq('tag_id', tag_id)
      .eq('company_id', company_id)
      .maybeSingle()

    if (existente) return res.status(409).json({ error: 'Tag já vinculada' })

    const { data, error } = await supabase
      .from('conversa_tags')
      .insert([{ conversa_id: id, tag_id, company_id }])
      .select(`
        id,
        tags (
          id,
          nome,
          cor
        )
      `)
      .single()

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const io = req.app.get('io')
    if (io) {
      const payload = { conversa_id: Number(id), tag: data.tags }

      emitirEventoEmpresaConversa(
        io,
        company_id,
        id,
        io.EVENTS?.TAG_ADICIONADA || 'tag_adicionada',
        payload
      )
      emitirConversaAtualizada(io, company_id, id, { id: Number(id) }, { skipAtualizarConversa: true })
    }

    return res.json({ success: true, tag: data.tags })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao adicionar tag' })
  }
}

exports.removerTagConversa = async (req, res) => {
  try {
    const { id, tag_id } = req.params
    const { company_id } = req.user

    const { error } = await supabase
      .from('conversa_tags')
      .delete()
      .eq('conversa_id', id)
      .eq('tag_id', tag_id)
      .eq('company_id', company_id)

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const io = req.app.get('io')
    if (io) {
      const payload = { conversa_id: Number(id), tag_id: Number(tag_id) }

      emitirEventoEmpresaConversa(
        io,
        company_id,
        id,
        io.EVENTS?.TAG_REMOVIDA || 'tag_removida',
        payload
      )
      emitirConversaAtualizada(io, company_id, id, { id: Number(id) }, { skipAtualizarConversa: true })
    }

    return res.json({ success: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao remover tag' })
  }
}

