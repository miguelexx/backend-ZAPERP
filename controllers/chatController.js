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
exports.listarConversas = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const role = String(perfil || '').toLowerCase()
    const isAdmin = role === 'admin'
    const isAtendente = role === 'atendente'
    // Campos crus de req.query usados diretamente nas queries SQL abaixo. As flags derivadas
    // (busca, chips de estado, tempo parado, atendente_id validado) vêm de deriveListarConversasFilters.
    const {
      tag_id,
      data_inicio,
      data_fim,
      status_atendimento,
      atendente_id,
      departamento_id: filter_dep_id,
    } = req.query

    // Derivação pura de filtros/flags de req.query (services/chat/read/listarConversasFilters).
    // A validação de atendente_id (HTTP 400) é aplicada mais abaixo, preservando a ordem original
    // (após o early-return do usuário financeiro).
    const {
      tagFilterAtivo,
      incluirColaboradoresEncaminhar,
      incluirTodosClientesAtivo,
      palavraTrim,
      aguardandoClienteAtivo,
      aguardandoAtendenteAtivo,
      pagamentoPendenteAtivo,
      emAtrasoAtivo,
      hojeAtivo,
      minhaFilaAtiva,
      campanhasAtiva,
      tempoParadoHoras,
      filtroAusenciaLista,
      statusNorm,
      filtroAtendenteInformado,
      atendenteIdInvalido,
    } = deriveListarConversasFilters(req.query)

    const chatListPagination = parseChatListPagination(req.query)

    async function sendEmptyChatListResponse(semConversaIncluded = false) {
      const emptyPagination = {
        limit: chatListPagination.limit,
        has_more: false,
        next_cursor: null,
        next_cursor_id: null,
        returned: 0,
        sem_conversa_included: Boolean(semConversaIncluded),
      }
      setChatListPaginationHeaders(res, emptyPagination, {
        semConversaIncluded: Boolean(semConversaIncluded),
        totalCount: 0,
      })
      if (!incluirColaboradoresEncaminhar) {
        if (chatListPagination.paginatedResponse) {
          return res.json({ conversas: [], pagination: emptyPagination })
        }
        return res.json([])
      }
      const colaboradores_encaminhar = await loadColaboradoresEncaminhar()
      return res.json({ conversas: [], colaboradores_encaminhar, pagination: emptyPagination })
    }

    // Em producao, GET /chats nunca anexa a base inteira de clientes por padrao.
    // Clientes sem conversa entram apenas em busca explicita e paginada.
    const incluirTodosClientesDefault = false

    const isFinanceiroUser = await usuarioPertenceSetorFinanceiro(departamento_ids, company_id)

    if ((pagamentoPendenteAtivo || emAtrasoAtivo) && !isFinanceiroUser) {
      return sendEmptyChatListResponse(false)
    }

    // atendente_id inválido (UUID/texto/não-inteiro) — mesma posição/ordem original: só após o
    // early-return do usuário financeiro acima.
    if (atendenteIdInvalido) {
      return res.status(400).json({
        error:
          'atendente_id deve ser o id inteiro positivo referente a usuarios.id. Este parâmetro não aceita UUID nem texto arbitrário.',
      })
    }

    async function loadColaboradoresEncaminhar() {
      const { data, error } = await supabase
        .from('usuarios')
        .select('id, nome, email, perfil')
        .eq('company_id', company_id)
        .eq('ativo', true)
        .neq('id', user_id)
        .order('nome', { ascending: true })
      if (error) return []
      return (data || []).map((u) => ({
        usuario_id: Number(u.id),
        nome: u.nome ?? null,
        email: u.email ?? null,
        perfil: u.perfil ?? null,
      }))
    }

    // Calculado antes do Promise.all pois depende apenas de valores síncronos já disponíveis
    const incluirGruposSemDepartamentoNoTodos = deveIncluirGruposSemDepartamentoNoFiltroTodos({
      isAdmin,
      filter_dep_id,
      filtroAtendenteInformado,
      minhaFilaAtiva,
      aguardandoClienteAtivo,
      aguardandoAtendenteAtivo,
      pagamentoPendenteAtivo,
      emAtrasoAtivo,
      hojeAtivo,
      statusNorm,
    })

    // 5 queries independentes executadas em paralelo — elimina latência serial (~200-400ms economizados por request)
    const transferLimit = getChatFilterIdLimit()
    const [
      empListaFlags,
      atendimentoModoSimplesEmpresa,
      unreadMap,
      [conversaIdsTransferidas, conversaIdsParticipanteAtivo],
      grupoIdsPermitidosPorDepartamento,
      grupoIdsSemDepartamento,
    ] = await Promise.all([
      supabase
        .from('empresas')
        .select('separar_mensagens_disparadas, modulo_campanhas_ativo')
        .eq('id', company_id)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error) return { separar: false, campanhasModulo: false }
          return {
            separar: !!data?.separar_mensagens_disparadas,
            campanhasModulo: !!data?.modulo_campanhas_ativo,
          }
        })
        .catch(() => ({ separar: false, campanhasModulo: false })),
      empresaModoSimplesAtivo(company_id).catch(() => false),
      obterUnreadMap({ company_id, usuario_id: user_id }),
      !isAdmin
        ? Promise.all([
            supabase
              .from('atendimentos')
              .select('conversa_id')
              .eq('company_id', company_id)
              .eq('de_usuario_id', user_id)
              .eq('acao', 'transferiu')
              .order('criado_em', { ascending: false })
              .limit(transferLimit)
              .then(({ data }) => [...new Set((data || []).map((r) => Number(r.conversa_id)).filter(Boolean))]),
            getConversaIdsParticipanteAtivo(company_id, user_id),
          ])
        : Promise.resolve([[], []]),
      !isAdmin
        ? getGrupoIdsPorDepartamentos(company_id, departamento_ids)
        : filter_dep_id
          ? getGrupoIdsPorDepartamentos(company_id, [filter_dep_id])
          : Promise.resolve([]),
      incluirGruposSemDepartamentoNoTodos ? getGrupoIdsSemDepartamento(company_id) : Promise.resolve([]),
    ])
    const separarMensagensDisparadasEmpresa = !!empListaFlags?.separar
    const moduloCampanhasAtivo = !!empListaFlags?.campanhasModulo
    if (campanhasAtiva && !moduloCampanhasAtivo) {
      return sendEmptyChatListResponse(false)
    }
    const conversaIdsParticipanteAtivoSet = new Set(conversaIdsParticipanteAtivo.map(Number))

    let grupoUnreadIdsAguardando = []
    if (aguardandoAtendenteAtivo && atendimentoModoSimplesEmpresa) {
      grupoUnreadIdsAguardando = await resolveGrupoIdsComUnreadParaUsuario({
        company_id,
        unreadMap,
      })
    }

    // Exceção: conversas que o usuário transferiu para outro — aparecem na lista independente do setor

    if (statusNorm === 'mensagem_disparada' && !separarMensagensDisparadasEmpresa) {
      return sendEmptyChatListResponse(false)
    }

    let conversaIdsFilter = null
    let forceEmptyConversas = false
    // Busca por texto: IDs cujo match veio de nome/telefone (faixa prioritária na ordenação).
    let searchPriorityIdSet = null
    let searchMessageOnlyIdSet = new Set()
    let searchDefensiveRemovedConversationCount = 0
    let isTextSearch = false

    if (tagFilterAtivo) {
      const filterIdLimit = getChatFilterIdLimit()
      const { data: tagRows } = await supabase
        .from('conversa_tags')
        .select('conversa_id')
        .eq('company_id', company_id)
        .eq('tag_id', tag_id)
        .order('criado_em', { ascending: false })
        .limit(filterIdLimit)
      const ids = (tagRows || []).map((r) => r.conversa_id)
      if (ids.length === 0) {
        return sendEmptyChatListResponse(false)
      }
      conversaIdsFilter = ids
    }

    if (palavraTrim) {
      const searchIdLimit = getChatSearchIdLimit()
      const phoneVariacoes = buildPhoneSearchTerms(palavraTrim)

      // Busca de cliente = nome ou telefone da base da empresa (com/sem conversa).
      // O 3º ramo (texto de mensagens) trazia conversas que só *mencionavam* o termo
      // no corpo de uma mensagem antiga — clientes sem relação com o texto buscado —
      // e afogava/poluía o contato procurado. Fica DESLIGADO por padrão; reative com
      // CHAT_SEARCH_INCLUDE_MESSAGE_TEXT=1 se algum dia a busca por conteúdo voltar.
      const incluirTextoMensagens =
        String(process.env.CHAT_SEARCH_INCLUDE_MESSAGE_TEXT ?? '').trim() === '1'

      // Branches em paralelo (B3 fix: elimina await sequencial de clientes):
      //   (1) RPC buscar_conversas_por_nome_ids: nome/pushname do cliente + nome_contato_cache
      //       + nome_grupo — tudo com suporte a acentos via unaccent (L1 fix)
      //   (2) Telefone direto em conversas (com variantes BR)
      //   (3) Texto de mensagens (paginado) — apenas quando explicitamente habilitado
      const [convByNomeIds, { data: convByTelefone }, idsFromMsg, idsPorVinculo] = await Promise.all([
        supabase
          .rpc('buscar_conversas_por_nome_ids', {
            p_company_id: Number(company_id),
            p_termo: palavraTrim,
            p_phone_variacoes: phoneVariacoes.length ? phoneVariacoes : null,
            p_limit: searchIdLimit,
          })
          .then(({ data, error }) => {
            if (error) console.warn('[busca-nome] RPC error:', error.message)
            return Array.isArray(data) ? data : []
          }),
        supabase
          .from('conversas')
          .select('id')
          .eq('company_id', company_id)
          .or(buildTelefoneSearchOr(palavraTrim))
          .order('ultima_atividade', { ascending: false, nullsFirst: false })
          .limit(searchIdLimit),
        incluirTextoMensagens
          ? buscarConversaIdsPorTextoMensagens({ company_id, term: palavraTrim })
          : Promise.resolve([]),
        buscarConversaIdsPorNomesVinculados(supabase, company_id, palavraTrim, searchIdLimit),
      ])

      isTextSearch = true
      // Faixa prioritária: match em nome/pushname/telefone (RPC + telefone direto).
      const priorityIds = new Set(
        [
          ...convByNomeIds,
          ...(convByTelefone || []).map((c) => c.id),
          ...(idsPorVinculo || []),
        ]
          .map((v) => Number(v))
          .filter((n) => Number.isFinite(n) && n > 0)
      )
      // Faixa secundária: match apenas no texto de mensagens — limitada para não
      // "afogar" o contato procurado (busca de cliente prioriza nome/telefone).
      const msgTierLimit = Math.max(1, parsePositiveInt(process.env.CHAT_SEARCH_MSG_TIER_LIMIT, 30))
      const messageOnlyIds = []
      for (const raw of idsFromMsg) {
        const n = Number(raw)
        if (!Number.isFinite(n) || n <= 0 || priorityIds.has(n)) continue
        messageOnlyIds.push(n)
        if (messageOnlyIds.length >= msgTierLimit) break
      }
      searchMessageOnlyIdSet = new Set(messageOnlyIds)
      searchPriorityIdSet = priorityIds

      const mergedSet = new Set([...priorityIds, ...messageOnlyIds])
      const merged = [...mergedSet]
      if (merged.length === 0) {
        if (shouldIncludeClientesSemConversa({ incluirTodosClientesAtivo, palavraTrim })) {
          conversaIdsFilter = []
          forceEmptyConversas = true
        } else {
          return sendEmptyChatListResponse(false)
        }
      } else {
        conversaIdsFilter = conversaIdsFilter ? conversaIdsFilter.filter((id) => mergedSet.has(Number(id))) : merged
      }
    }

    const conversaIdsRaw = req.query.conversa_ids
    if (conversaIdsRaw != null && String(conversaIdsRaw).trim() === '0') {
      forceEmptyConversas = true
    } else {
      const conversaIdsExplicit = parseConversaIdsQuery(conversaIdsRaw)
      if (conversaIdsExplicit.length > 0) {
        const explicitSet = new Set(conversaIdsExplicit)
        if (conversaIdsFilter && conversaIdsFilter.length > 0) {
          conversaIdsFilter = conversaIdsFilter.filter((id) => explicitSet.has(Number(id)))
          if (conversaIdsFilter.length === 0) forceEmptyConversas = true
        } else {
          conversaIdsFilter = conversaIdsExplicit
        }
      }
    }

    const selectCompleto = `
      id,
      whatsapp_instance_id,
      telefone,
      cliente_id,
      usuario_id,
      status_atendimento,
      aguardando_resposta_campanha,
      atendente_id,
      aguardando_cliente_desde,
      modo_simples_aguardando,
      lida,
      criado_em,
      ultima_atividade,
      departamento_id,
      tipo,
      nome_grupo,
      foto_grupo,
      nome_contato_cache,
      foto_perfil_contato_cache,
      finalizacao_motivo,
      finalizada_automaticamente,
      finalizada_automaticamente_em,
      clientes!conversas_cliente_fk ( id, nome, pushname, telefone, foto_perfil, company_id, cliente_tags ( tag_id, tags ( id, nome, cor ) ) ),
      atendente:usuarios!conversas_atendente_id_fkey ( id, nome, email ),
      departamentos ( id, nome ),
      mensagens ( conversa_id, texto, criado_em, direcao, tipo, url, nome_arquivo, whatsapp_id, status, autor_usuario_id, contact_meta, location_meta ),
      conversa_tags (
        tag_id,
        tags (
          id,
          nome,
          cor
        )
      )
    `
    const selectMinimo = `
      id,
      whatsapp_instance_id,
      telefone,
      cliente_id,
      usuario_id,
      status_atendimento,
      aguardando_resposta_campanha,
      atendente_id,
      aguardando_cliente_desde,
      modo_simples_aguardando,
      pagamento_prazo_ate,
      pagamento_prazo_origem,
      pagamento_concluido_em,
      finalizacao_motivo,
      finalizada_automaticamente,
      finalizada_automaticamente_em,
      lida,
      criado_em,
      ultima_atividade,
      departamento_id,
      tipo,
      nome_grupo,
      foto_grupo,
      nome_contato_cache,
      foto_perfil_contato_cache,
      clientes!conversas_cliente_fk ( id, nome, pushname, telefone, foto_perfil, company_id, cliente_tags ( tag_id, tags ( id, nome, cor ) ) ),
      atendente:usuarios!conversas_atendente_id_fkey ( id, nome, email ),
      departamentos ( id, nome ),
      mensagens ( conversa_id, texto, criado_em, direcao, tipo, url, nome_arquivo, whatsapp_id, status, autor_usuario_id, contact_meta, location_meta ),
      conversa_tags (
        tag_id,
        tags (
          id,
          nome,
          cor
        )
      )
    `
    // Fallback mínimo mas com foto e última mensagem para não quebrar setas/fotos na UI ao atualizar
    const selectBare = `
      id,
      whatsapp_instance_id,
      telefone,
      cliente_id,
      usuario_id,
      status_atendimento,
      aguardando_resposta_campanha,
      atendente_id,
      aguardando_cliente_desde,
      modo_simples_aguardando,
      pagamento_prazo_ate,
      pagamento_prazo_origem,
      pagamento_concluido_em,
      lida,
      criado_em,
      ultima_atividade,
      departamento_id,
      tipo,
      nome_grupo,
      foto_grupo,
      nome_contato_cache,
      foto_perfil_contato_cache,
      finalizacao_motivo,
      finalizada_automaticamente,
      finalizada_automaticamente_em,
      clientes!conversas_cliente_fk ( id, nome, pushname, telefone, foto_perfil, company_id, cliente_tags ( tag_id, tags ( id, nome, cor ) ) ),
      atendente:usuarios!conversas_atendente_id_fkey ( id, nome, email ),
      departamentos ( id, nome ),
      mensagens ( conversa_id, texto, criado_em, direcao, tipo, url, nome_arquivo, whatsapp_id, status, autor_usuario_id, contact_meta, location_meta )
    `

    function buildQuery(select) {
      let q = supabase
        .from('conversas')
        .select(select)
        .eq('company_id', company_id)
      // Filtro por setor: conversas sem setor visíveis para TODOS; com setor só mesmo setor.
      // EXCEÇÃO: conversas que o usuário transferiu — aparecem independente do setor.
      if (!isAdmin) {
        const depIds = Array.isArray(departamento_ids) ? departamento_ids.filter((id) => id != null && Number.isFinite(Number(id))) : []
        const parts = []
        if (depIds.length > 0) {
          pushNonGroupVisibilityParts(parts, 'departamento_id', depIds)
        }
        parts.push('and(departamento_id.is.null,tipo.is.null)', 'and(departamento_id.is.null,tipo.neq.grupo)')
        pushNonGroupVisibilityParts(parts, 'atendente_id', [user_id])
        pushAllowedGroupIdsPart(parts, grupoIdsPermitidosPorDepartamento)
        pushAllowedGroupIdsPart(parts, grupoIdsSemDepartamento)
        if (conversaIdsTransferidas.length > 0) {
          parts.push(`id.in.(${conversaIdsTransferidas.join(',')})`)
        }
        if (conversaIdsParticipanteAtivo.length > 0) {
          parts.push(`id.in.(${conversaIdsParticipanteAtivo.join(',')})`)
        }
        q = q.or(parts.join(','))
      } else if (filter_dep_id) {
        const parts = []
        pushNonGroupVisibilityParts(parts, 'departamento_id', [filter_dep_id])
        pushAllowedGroupIdsPart(parts, grupoIdsPermitidosPorDepartamento)
        q = parts.length > 0 ? q.or(parts.join(',')) : q.eq('departamento_id', Number(filter_dep_id))
      }
      if (forceEmptyConversas) {
        q = q.in('id', [0])
      } else if (conversaIdsFilter && conversaIdsFilter.length > 0) {
        q = q.in('id', conversaIdsFilter)
      }
      // Mensagens disparadas: fora da listagem geral quando sem filtro de status; se a empresa desligou a opção, nunca misturar esse status nas demais queries.
      if (
        !minhaFilaAtiva &&
        !campanhasAtiva &&
        !aguardandoClienteAtivo &&
        !aguardandoAtendenteAtivo &&
        !pagamentoPendenteAtivo &&
        !emAtrasoAtivo &&
        !hojeAtivo &&
        (!statusNorm || !separarMensagensDisparadasEmpresa)
      ) {
        q = q.or('tipo.eq.grupo,status_atendimento.neq.mensagem_disparada,status_atendimento.is.null')
      }
      // Filtro "Campanhas": disparos do módulo aguardando primeira resposta do contato.
      if (campanhasAtiva) {
        q = q.or('tipo.is.null,tipo.neq.grupo')
        q = q.eq('aguardando_resposta_campanha', true)
      }
      // Filtro personalizado "Minha fila": abertas (fila) + em atendimento só comigo + grupos do setor; sem finalizadas
      if (minhaFilaAtiva) {
        // Grupos vinculados ao setor do atendente (departamento_grupos) aparecem na Minha fila.
        // O bloco de visibilidade acima já restringe quais grupos o atendente pode ver.
        // Admin ou usuário sem grupos vinculados: comportamento original (excluir grupos).
        const incluirGruposSetor = !isAdmin && grupoIdsPermitidosPorDepartamento.length > 0
        if (!incluirGruposSetor) {
          q = q.or('tipo.is.null,tipo.neq.grupo')
        }
        q = q.or(
          `${incluirGruposSetor ? `id.in.(${grupoIdsPermitidosPorDepartamento.join(',')}),` : ''}status_atendimento.eq.aberta,and(status_atendimento.eq.em_atendimento,atendente_id.eq.${user_id}),and(status_atendimento.eq.aguardando_cliente,atendente_id.eq.${user_id}),and(status_atendimento.eq.pagamento_pendente,atendente_id.eq.${user_id}),and(status_atendimento.eq.em_atraso,atendente_id.eq.${user_id})${conversaIdsParticipanteAtivo.length > 0 ? `,and(status_atendimento.in.(em_atendimento,aguardando_cliente,pagamento_pendente,em_atraso),id.in.(${conversaIdsParticipanteAtivo.join(',')}))` : ''}`
        )
      } else if (pagamentoPendenteAtivo) {
        q = q.eq('status_atendimento', 'pagamento_pendente')
        q = q.not('atendente_id', 'is', null)
        if (isAtendente) {
          q = conversaIdsParticipanteAtivo.length > 0
            ? q.or(`atendente_id.eq.${Number(user_id)},id.in.(${conversaIdsParticipanteAtivo.join(',')})`)
            : q.eq('atendente_id', Number(user_id))
        } else if (filtroAtendenteInformado != null) {
          q = q.eq('atendente_id', Number(filtroAtendenteInformado))
        }
      } else if (emAtrasoAtivo) {
        q = q.eq('status_atendimento', 'em_atraso')
        q = q.not('atendente_id', 'is', null)
        if (isAtendente) {
          q = conversaIdsParticipanteAtivo.length > 0
            ? q.or(`atendente_id.eq.${Number(user_id)},id.in.(${conversaIdsParticipanteAtivo.join(',')})`)
            : q.eq('atendente_id', Number(user_id))
        } else if (filtroAtendenteInformado != null) {
          q = q.eq('atendente_id', Number(filtroAtendenteInformado))
        }
      } else if (statusNorm === 'mensagem_disparada') {
        q = q.eq('status_atendimento', 'mensagem_disparada')
        q = q.neq('tipo', 'grupo')
      } else if (statusNorm) {
        // Grupos são sempre visíveis independentemente do filtro de status —
        // não têm estado de atendimento (não precisam ser assumidos nem encerrados).
        if (statusNorm === 'em_atendimento' && !isAtendente) {
          q = q.or('tipo.eq.grupo,status_atendimento.eq.em_atendimento,status_atendimento.eq.aguardando_cliente')
        } else {
          q = q.or(`tipo.eq.grupo,status_atendimento.eq.${statusNorm}`)
        }
      }
      if (!campanhasAtiva && (minhaFilaAtiva || statusNorm === 'aberta')) {
        q = q.eq('aguardando_resposta_campanha', false)
      }
      // Atendente: vê TODAS as conversas (pode assumir, transferir, responder qualquer uma)
      // Admin/supervisor: filtro opcional por atendente_id — sem filtro implícito de status; exclui grupos (conversas "assumidas" são individuais)
      if (!minhaFilaAtiva && !campanhasAtiva && !isAtendente && filtroAtendenteInformado != null) {
        q = q.eq('atendente_id', filtroAtendenteInformado)
        q = q.or('tipo.is.null,tipo.neq.grupo')
      }
      if (data_inicio) q = q.gte('criado_em', new Date(data_inicio).toISOString())
      if (data_fim) {
        const end = new Date(data_fim)
        end.setHours(23, 59, 59, 999)
        q = q.lte('criado_em', end.toISOString())
      }

      if (hojeAtivo) {
        q = q.gte('ultima_atividade', getStartOfTodayIso()).lte('ultima_atividade', getEndOfTodayIso())
      }

      // Filtro "Aguardando cliente": modo simples usa modo_simples_aguardando; senão fluxo legado.
      if (aguardandoClienteAtivo) {
        if (atendimentoModoSimplesEmpresa) {
          q = q.eq('modo_simples_aguardando', 'cliente')
        } else {
          q = q.or(
            `and(status_atendimento.eq.em_atendimento,aguardando_cliente_desde.not.is.null),status_atendimento.eq.aguardando_cliente`
          )
          q = q.not('atendente_id', 'is', null)
        }
        if (!atendimentoModoSimplesEmpresa) {
          if (isAtendente) {
            q = conversaIdsParticipanteAtivo.length > 0
              ? q.or(`atendente_id.eq.${Number(user_id)},id.in.(${conversaIdsParticipanteAtivo.join(',')})`)
              : q.eq('atendente_id', Number(user_id))
          } else if (filtroAtendenteInformado != null) {
            q = q.eq('atendente_id', Number(filtroAtendenteInformado))
          }
        }
      }

      // Filtro "Aguardando atendente" (modo simples): individuais + grupos não lidos (estilo WhatsApp).
      if (aguardandoAtendenteAtivo) {
        if (atendimentoModoSimplesEmpresa) {
          q = applyAguardandoAtendenteModoSimplesQuery(q, grupoUnreadIdsAguardando)
        } else {
          q = q.in('id', [0])
        }
      }

      // Filtro opcional: tempo parado (usa aguardando_cliente_desde — leve, indexável; sem alterar paginação da API)
      if (tempoParadoHoras != null) {
        const limiteParado = new Date(Date.now() - tempoParadoHoras * 3600000).toISOString()
        q = q.not('aguardando_cliente_desde', 'is', null).lte('aguardando_cliente_desde', limiteParado)
      }

      // Aba "Por ausência" (GET com finalizacao_motivo=ausencia_cliente + status fechada): só conversas encerradas por ausência / auto.
      if (filtroAusenciaLista) {
        q = q.or('finalizacao_motivo.eq.ausencia_cliente,finalizada_automaticamente.eq.true')
      }

      // PERFORMANCE: a lista de conversas só precisa da ÚLTIMA mensagem (preview).
      // Se vier todas as mensagens embutidas, a payload explode e a UI fica lenta.
      // Supabase-js v2: use referencedTable para ordenar/limitar relação.
      q = q
        .order('criado_em', { ascending: false, referencedTable: 'mensagens' })
        .order('id', { ascending: false, referencedTable: 'mensagens' })
        .limit(1, { referencedTable: 'mensagens' })
      return q
    }

    const countsCtx = {
      company_id,
      user_id,
      isAdmin,
      isAtendente,
      departamento_ids,
      filter_dep_id,
      filtroAtendenteInformado,
      conversaIdsTransferidas,
      conversaIdsParticipanteAtivo,
      grupoIdsPermitidosPorDepartamento,
      grupoIdsSemDepartamento,
      conversaIdsFilter,
      forceEmptyConversas,
      data_inicio,
      data_fim,
      separarMensagensDisparadasEmpresa,
      isFinanceiro: isFinanceiroUser,
    }
    const listFilterOverrides = overridesFromListQuery(req.query)
    const totalCountPromise =
      chatListPagination.cursor
        ? Promise.resolve(null)
        : forceEmptyConversas
          ? Promise.resolve(0)
          : countConversasWithFilter(countsCtx, listFilterOverrides).catch((err) => {
            console.warn('[listarConversas] total_count:', err?.message || err)
            return null
          })

    let data = null
    let error = null

    // Busca por texto: buscar TODOS os matches (até um teto) numa página só, para que
    // a ordenação por relevância (nome/telefone antes de texto) não seja truncada pelo
    // corte por ultima_atividade do banco. Fora da busca, mantém a paginação normal.
    const searchListFetchCap = Math.max(
      chatListPagination.limit,
      parsePositiveInt(process.env.CHAT_SEARCH_LIST_FETCH_CAP, 300)
    )
    const effectivePageLimit =
      isTextSearch && Array.isArray(conversaIdsFilter)
        ? Math.min(searchListFetchCap, Math.max(chatListPagination.limit, conversaIdsFilter.length))
        : chatListPagination.limit

    const queryCompleto = applyChatListCursor(
      buildQuery(selectCompleto)
        .order('ultima_atividade', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false }),
      chatListPagination.cursor,
      chatListPagination.cursor_id
    ).limit(effectivePageLimit + 1)
    let result = await queryCompleto
    data = result.data
    error = result.error

    if (error) {
      const queryMinimo = applyChatListCursor(
        buildQuery(selectMinimo)
          .order('ultima_atividade', { ascending: false, nullsFirst: false })
          .order('id', { ascending: false }),
        chatListPagination.cursor,
        chatListPagination.cursor_id
      ).limit(effectivePageLimit + 1)
      result = await queryMinimo
      data = result.data
      error = result.error
    }

    if (error) {
      const queryBare = applyChatListCursor(
        buildQuery(selectBare)
          .order('ultima_atividade', { ascending: false, nullsFirst: false })
          .order('id', { ascending: false }),
        chatListPagination.cursor,
        chatListPagination.cursor_id
      ).limit(effectivePageLimit + 1)
      result = await queryBare
      data = result.data
      error = result.error
    }

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const rawSqlRows = Array.isArray(data) ? data : []
    const rawSqlHadMore = rawSqlRows.length > effectivePageLimit
    const whatsappInstanceMetaMap = await loadWhatsappInstanceMetaMap(
      company_id,
      rawSqlRows.map((c) => c?.whatsapp_instance_id)
    )

    // Enriquece última mensagem de cada conversa com usuario_nome
    const allLastMsgs = (rawSqlRows || []).flatMap((c) => c.mensagens || [])
    const hasAuthorToEnrich = allLastMsgs.some((m) => m && m.autor_usuario_id != null)
    if (allLastMsgs.length > 0 && hasAuthorToEnrich) {
      const enriched = await enrichMensagensComAutorUsuario(supabase, company_id, allLastMsgs)
      let idx = 0
      for (const c of rawSqlRows || []) {
        if (c.mensagens && c.mensagens.length > 0) {
          c.mensagens = [enriched[idx++]]
        }
      }
    }

    // Fallback: quando conversa.cliente_id é null mas existe cliente com o mesmo telefone,
    // usamos esse cliente para exibir nome/foto na lista.
    // Usa possiblePhonesBR para matching entre formatos (5511... vs 11..., 12 vs 13 dígitos).
    const phoneToClientFallback = new Map()
    try {
      const phonesSemCliente = (rawSqlRows || [])
        .filter((c) => !isGroupConversation(c) && !c.cliente_id && c.telefone && !String(c.telefone).startsWith('lid:'))
        .map((c) => String(c.telefone).trim())
      const uniquePhones = Array.from(new Set(phonesSemCliente.filter(Boolean)))
      if (uniquePhones.length > 0) {
        const expandedPhones = new Set()
        for (const p of uniquePhones) {
          const variants = possiblePhonesBR(p)
          if (variants.length > 0) variants.forEach((v) => expandedPhones.add(v))
          else expandedPhones.add(p)
        }
        const { data: clientesFallback } = await supabase
          .from('clientes')
          .select('id, nome, pushname, telefone, foto_perfil')
          .eq('company_id', company_id)
          .in('telefone', Array.from(expandedPhones))
        for (const cl of clientesFallback || []) {
          if (!cl || !cl.telefone) continue
          const variants = possiblePhonesBR(cl.telefone)
          const keys = variants.length > 0 ? variants : [String(cl.telefone).trim()]
          // Não sobrescrever chave já mapeada — evita foto/nome de outro cliente no mesmo variant.
          for (const k of keys) {
            if (k && !phoneToClientFallback.has(k)) phoneToClientFallback.set(k, cl)
          }
          const exact = String(cl.telefone).trim()
          if (exact) phoneToClientFallback.set(exact, cl)
        }
      }
    } catch (_) {
      // fallback silencioso — se falhar, apenas seguimos sem foto/nome extra
    }

    const cid = Number(company_id)
    let conversasFormatadas = (rawSqlRows || []).map((c) => {
      const raw = c.clientes
      // NUNCA usar raw[0] — pega outro cliente do join e coloca a foto errada no card.
      let clientesObj = Array.isArray(raw)
        ? (raw.find((cl) => cl && c.cliente_id != null && Number(cl.id) === Number(c.cliente_id)) || null)
        : raw
      // Isolamento multi-tenant: descarta cliente de outra empresa (evita vazamento entre companies)
      if (clientesObj && clientesObj.company_id != null && Number(clientesObj.company_id) !== cid) {
        clientesObj = null
      }
      if (
        clientesObj &&
        c.cliente_id != null &&
        clientesObj.id != null &&
        Number(clientesObj.id) !== Number(c.cliente_id)
      ) {
        clientesObj = null
      }
      if (!clientesObj && !isGroupConversation(c) && !c.cliente_id && c.telefone) {
        const convTel = String(c.telefone).trim()
        let fallbackCli = phoneToClientFallback.get(convTel)
        if (!fallbackCli && convTel) {
          const variants = possiblePhonesBR(convTel)
          for (const v of variants) {
            if ((fallbackCli = phoneToClientFallback.get(v))) break
          }
        }
        if (fallbackCli) clientesObj = fallbackCli
      }

      const nomeCliente = getDisplayName(clientesObj)

      const fotoCliente =
        (clientesObj?.foto_perfil && String(clientesObj.foto_perfil).trim()) ||
        null

      const isGroup = isGroupConversation(c)
      const ultimaMsg = Array.isArray(c.mensagens) && c.mensagens.length > 0 ? c.mensagens[0] : null

      const isLid = !isGroup && isLidPhoneKey(c.telefone)
      // LID: nunca exibir lid:xxx; se houver telefone real no cliente vinculado, liberar na UI.
      // Não-LID: mantém o telefone da conversa (não exigir BR estrito só para exibir).
      const telefoneExibivel = isGroup
        ? c.telefone
        : (isLid
          ? (pickRealPhoneCandidate(clientesObj?.telefone) || null)
          : (String(c.telefone || '').trim() || pickRealPhoneCandidate(clientesObj?.telefone) || null))

      const contatoNome = isGroup
        ? (c.nome_grupo || telefoneExibivel || 'Grupo')
        : (
            nomeCliente ||
            (c.nome_contato_cache && String(c.nome_contato_cache).trim()) ||
            telefoneExibivel ||
            (isLid ? 'Contato' : 'Sem nome')
          )

      const fotoPerfil = isGroup
        ? null
        : (
            fotoCliente ||
            (c.foto_perfil_contato_cache && String(c.foto_perfil_contato_cache).trim()) ||
            null
          )
      const unreadCount = unreadMap[Number(c.id)] || 0
      // Grupos não têm estado de atendimento: sem badge "aberta", sem status, sem atendente obrigatório
      const temMensagem = Array.isArray(c.mensagens) && c.mensagens.length > 0
      // Igual a detalharChat: badge "Aberta" só com mensagem ou atendente (sem movimentação → ociosa, fora de Abertas)
      const exibir_badge_aberta =
        !isGroup &&
        (temMensagem || c.atendente_id != null) &&
        c.status_atendimento !== 'mensagem_disparada'
      const atendRow = c.atendente && typeof c.atendente === 'object' ? c.atendente : null
      const atendenteNome =
        atendRow && atendRow.nome != null && String(atendRow.nome).trim()
          ? String(atendRow.nome).trim()
          : null
      const atendenteEmail =
        atendRow && atendRow.email != null && String(atendRow.email).trim()
          ? String(atendRow.email).trim()
          : null
      const temNovasMensagens = unreadCount > 0
      const dbStatusLista = String(c.status_atendimento || '')
      const assumidaPorOutroLista =
        c.atendente_id != null && Number(c.atendente_id) !== Number(user_id)
      const assumidaPorMimLista =
        c.atendente_id != null && Number(c.atendente_id) === Number(user_id)
      const exibir_cta_assumir_sem_mensagens =
        !atendimentoModoSimplesEmpresa &&
        !isGroup &&
        !temMensagem &&
        dbStatusLista !== 'fechada' &&
        !assumidaPorMimLista &&
        !assumidaPorOutroLista
      const conversaEmAtendimentoDoUsuario =
        !isGroup &&
        (c.status_atendimento === 'em_atendimento' || c.status_atendimento === 'aguardando_cliente') &&
        Number(c.atendente_id) === Number(user_id)
      const temNotificacaoDiscretaEmAtendimento =
        !isGroup &&
        conversaEmAtendimentoDoUsuario &&
        temNovasMensagens

      return {
        id: c.id,
        whatsapp_instance_id: c.whatsapp_instance_id ?? null,
        ...safeWhatsappInstanceMeta(whatsappInstanceMetaMap.get(Number(c.whatsapp_instance_id))),
        cliente_id: c.cliente_id,
        telefone: c.telefone,
        telefone_exibivel: telefoneExibivel,
        status_atendimento_real: isGroup ? null : c.status_atendimento,
        status_atendimento: statusAtendimentoParaLista(isGroup, c.status_atendimento, exibir_badge_aberta),
        aguardando_resposta_campanha: c.aguardando_resposta_campanha === true,
        exibir_badge_aberta,
        atendente_id: c.atendente_id,
        aguardando_cliente_desde: c.aguardando_cliente_desde ?? null,
        modo_simples_aguardando: c.modo_simples_aguardando ?? null,
        ...(atendimentoModoSimplesEmpresa ? { atendimento_modo_simples: true } : {}),
        pagamento_prazo_ate: c.pagamento_prazo_ate ?? null,
        pagamento_prazo_origem: c.pagamento_prazo_origem ?? null,
        pagamento_concluido_em: c.pagamento_concluido_em ?? null,
        atendente_nome: atendenteNome,
        atendente_email: atendenteEmail,
        lida: unreadCount === 0,
        tem_novas_mensagens: temNovasMensagens,
        tem_novas_mensagens_em_atendimento: temNotificacaoDiscretaEmAtendimento,
        criado_em: c.criado_em,
        ultima_atividade: c.ultima_atividade,
        departamento_id: c.departamento_id,
        tipo: c.tipo,
        nome_grupo: c.nome_grupo,
        foto_grupo: isGroup ? (c.foto_grupo ?? null) : null,
        mensagens: c.mensagens,
        ultima_mensagem: ultimaMsg,
        conversa_tags: c.conversa_tags || [],
        departamentos: c.departamentos,
        is_group: isGroup,
        contato_nome: contatoNome,
        foto_perfil: fotoPerfil,
        setor: c.departamentos?.nome || null,
        tags: mergeConversaClienteTags(c),
        unread_count: unreadCount,
        sem_mensagens: !temMensagem,
        exibir_cta_assumir_sem_mensagens,
        finalizacao_motivo: c.finalizacao_motivo ?? null,
        finalizada_automaticamente: Boolean(c.finalizada_automaticamente),
        finalizada_automaticamente_em: c.finalizada_automaticamente_em ?? null,
        reaberta_falta_interacao_em: null,
        reaberta_por_falta_interacao: resolveReabertaPorFaltaInteracao(c),
      }
    })

    conversasFormatadas = await enrichConversasReabertaFaltaInteracao(company_id, conversasFormatadas)

    const encerradasVaziasIds = conversasFormatadas
      .filter((c) =>
        !c.is_group &&
        c.sem_mensagens === true &&
        c.atendente_id == null &&
        isClosedAttendanceStatus(c.status_atendimento_real)
      )
      .map((c) => Number(c.id))
      .filter((id) => Number.isFinite(id) && id > 0)
    if (encerradasVaziasIds.length > 0) {
      const comAtendimento = new Set()
      const chunkSize = 300
      let podeFiltrarEncerradasVazias = true
      for (let i = 0; i < encerradasVaziasIds.length; i += chunkSize) {
        const slice = encerradasVaziasIds.slice(i, i + chunkSize)
        const { data: atendimentoRows, error: atendErr } = await supabase
          .from('atendimentos')
          .select('conversa_id')
          .eq('company_id', company_id)
          .in('conversa_id', slice)
        if (atendErr) {
          console.warn('[listarConversas] filtro encerradas vazias:', atendErr.message || atendErr)
          podeFiltrarEncerradasVazias = false
          break
        }
        for (const row of atendimentoRows || []) {
          if (row?.conversa_id != null) comAtendimento.add(Number(row.conversa_id))
        }
      }
      if (podeFiltrarEncerradasVazias) {
        const encerradasVaziasSet = new Set(encerradasVaziasIds)
        conversasFormatadas = conversasFormatadas.filter((c) => {
          const id = Number(c.id)
          if (!encerradasVaziasSet.has(id)) return true
          return comAtendimento.has(id)
        })
      }
    }

    // Um contato = uma conversa na lista (evita duplicata 55... vs 11...); conversas mais recentes no topo
    conversasFormatadas = deduplicateConversationsByContact(conversasFormatadas)
    conversasFormatadas = sortConversationsByRecent(conversasFormatadas)

    // Aba "Mensagens disparadas": omitir conversas com resposta inbound já no histórico (dados inconsistentes).
    if (statusNorm === 'mensagem_disparada' && Array.isArray(conversasFormatadas) && conversasFormatadas.length > 0) {
      const convIds = [
        ...new Set(
          conversasFormatadas.map((c) => Number(c.id)).filter((n) => Number.isFinite(n) && n > 0)
        ),
      ]
      if (convIds.length > 0) {
        const comInbound = new Set()
        const chunkSize = 300
        for (let i = 0; i < convIds.length; i += chunkSize) {
          const slice = convIds.slice(i, i + chunkSize)
          const { data: inboundRows, error: inboundErr } = await supabase
            .from('mensagens')
            .select('conversa_id')
            .eq('company_id', company_id)
            .in('conversa_id', slice)
            .eq('direcao', 'in')
          if (inboundErr) {
            console.warn('[listarConversas] filtro disparada+inbound:', inboundErr.message || inboundErr)
            break
          }
          for (const row of inboundRows || []) {
            if (row?.conversa_id != null) comInbound.add(Number(row.conversa_id))
          }
        }
        if (comInbound.size > 0) {
          conversasFormatadas = conversasFormatadas.filter((c) => !comInbound.has(Number(c.id)))
        }
      }
    }

    if (filtroAtendenteInformado != null && !isAtendente) {
      conversasFormatadas = conversasFormatadas.filter((c) => !c.is_group && !c.sem_conversa)
    }

    // Filtro "Abertas": só incluir conversas com movimentação (mensagem ou atendente assumiu)
    // Exclui: conversas sem mensagens e sem atividade — não contam como abertas
    if (statusNorm === 'aberta') {
      conversasFormatadas = conversasFormatadas.filter((c) => {
        if (c.sem_conversa) return false
        if (c.aguardando_resposta_campanha === true) return false
        if (c.is_group) return c.ultima_mensagem != null // grupo precisa ter ao menos 1 mensagem
        return c.exibir_badge_aberta // individual: tem mensagem ou atendente assumiu
      })
    }

    // Filtro "Em atendimento":
    // - Atendente comum: apenas status real "em_atendimento" (escopo padrão da sessão)
    // - Admin/supervisor: inclui "em_atendimento" + "aguardando_cliente" (manual), com opcional atendente_id.
    if (!aguardandoClienteAtivo && statusNorm === 'em_atendimento') {
      conversasFormatadas = conversasFormatadas.filter((c) => {
        if (c.sem_conversa || c.is_group) return false
        const st = String(c.status_atendimento_real || '')
        if (isAtendente) {
          const vinculadaAoUsuario =
            Number(c.atendente_id) === Number(user_id) ||
            conversaIdsParticipanteAtivoSet.has(Number(c.id))
          return st === 'em_atendimento' && vinculadaAoUsuario
        }
        if (filtroAtendenteInformado != null && Number(c.atendente_id) !== Number(filtroAtendenteInformado)) return false
        return st === 'em_atendimento' || st === 'aguardando_cliente'
      })
    }

    // "Minha fila": alinha com abas Abertas + Em atendimento só do usuário + grupos do setor; exclui finalizadas e assumidas por outros
    if (minhaFilaAtiva) {
      conversasFormatadas = conversasFormatadas.filter((c) => {
        if (c.sem_conversa) return false
        if (c.aguardando_resposta_campanha === true) return false
        // Grupos do setor do atendente: visíveis na Minha fila e ordenados por atividade como os demais.
        if (c.is_group) return true
        if (c.status_atendimento === 'ociosa') return false
        if (
          c.status_atendimento === 'em_atendimento' ||
          c.status_atendimento === 'aguardando_cliente' ||
          c.status_atendimento === 'pagamento_pendente' ||
          c.status_atendimento === 'em_atraso'
        ) {
          return Number(c.atendente_id) === Number(user_id) || conversaIdsParticipanteAtivoSet.has(Number(c.id))
        }
        if (c.status_atendimento === 'aberta') {
          if (c.aguardando_resposta_campanha === true) return false
          const livreOuMeu = c.atendente_id == null || Number(c.atendente_id) === Number(user_id)
          return c.exibir_badge_aberta && livreOuMeu
        }
        return false
      })
    }

    if (campanhasAtiva) {
      conversasFormatadas = conversasFormatadas.filter((c) => {
        if (c.sem_conversa || c.is_group) return false
        return c.aguardando_resposta_campanha === true
      })
    }

    // Filtro "Aguardando cliente": garantia final no backend para retornar apenas conversas realmente aguardando.
    // Atendente comum: escopo próprio. Admin/supervisor: agregado; com atendente_id, escopo do atendente informado.
    if (aguardandoClienteAtivo) {
      const restringirPorAtendente = isAtendente || (!isAtendente && filtroAtendenteInformado != null)
      const atendenteEscopoAguardando = isAtendente
        ? Number(user_id)
        : Number(filtroAtendenteInformado)
      conversasFormatadas = conversasFormatadas.filter((c) => {
        if (c.sem_conversa || c.is_group) return false
        if (
          restringirPorAtendente &&
          Number(c.atendente_id) !== atendenteEscopoAguardando &&
          !(isAtendente && conversaIdsParticipanteAtivoSet.has(Number(c.id)))
        ) return false
        if (atendimentoModoSimplesEmpresa) {
          return String(c.modo_simples_aguardando || '').toLowerCase() === 'cliente'
        }
        const statusReal = String(c.status_atendimento_real || '')
        const aguardandoAuto = statusReal === 'em_atendimento' && c.aguardando_cliente_desde != null
        const aguardandoManual = statusReal === 'aguardando_cliente'
        return aguardandoAuto || aguardandoManual
      })
      if (atendimentoModoSimplesEmpresa) {
        conversasFormatadas = sortConversationsByRecent(conversasFormatadas)
      }
    }

    if (aguardandoAtendenteAtivo) {
      conversasFormatadas = conversasFormatadas.filter((c) => {
        if (c.sem_conversa) return false
        if (!atendimentoModoSimplesEmpresa) return false
        const unread = unreadMap[Number(c.id)] || c.unread_count || 0
        return rowAguardandoAtendenteModoSimples(
          { ...c, tipo: c.is_group ? 'grupo' : c.tipo, modo_simples_aguardando: c.modo_simples_aguardando },
          unread
        )
      })
      conversasFormatadas = sortConversationsByRecent(conversasFormatadas)
    }

    if (pagamentoPendenteAtivo) {
      const restringirPorAtendente = isAtendente || (!isAtendente && filtroAtendenteInformado != null)
      const atendenteEscopo = isAtendente ? Number(user_id) : Number(filtroAtendenteInformado)
      conversasFormatadas = conversasFormatadas.filter((c) => {
        if (c.sem_conversa || c.is_group) return false
        if (
          restringirPorAtendente &&
          Number(c.atendente_id) !== atendenteEscopo &&
          !(isAtendente && conversaIdsParticipanteAtivoSet.has(Number(c.id)))
        ) return false
        return String(c.status_atendimento_real || '') === 'pagamento_pendente'
      })
    }

    if (emAtrasoAtivo) {
      const restringirPorAtendente = isAtendente || (!isAtendente && filtroAtendenteInformado != null)
      const atendenteEscopo = isAtendente ? Number(user_id) : Number(filtroAtendenteInformado)
      conversasFormatadas = conversasFormatadas.filter((c) => {
        if (c.sem_conversa || c.is_group) return false
        if (
          restringirPorAtendente &&
          Number(c.atendente_id) !== atendenteEscopo &&
          !(isAtendente && conversaIdsParticipanteAtivoSet.has(Number(c.id)))
        ) return false
        return String(c.status_atendimento_real || '') === 'em_atraso'
      })
    }

    // Incluir todos os clientes: quem não tem conversa aparece como "Sem conversa" (clicável para abrir)
    // Não misturar "sem conversa" em filtros por estado de atendimento (aberta / disparada / etc.).
    const incluirTodos =
      (shouldIncludeClientesSemConversa({ incluirTodosClientesAtivo, palavraTrim }) || incluirTodosClientesDefault) &&
      !statusNorm &&
      !minhaFilaAtiva &&
      !hojeAtivo &&
      !aguardandoClienteAtivo &&
      !aguardandoAtendenteAtivo &&
      !pagamentoPendenteAtivo &&
      !emAtrasoAtivo &&
      !tagFilterAtivo &&
      !data_inicio &&
      !data_fim &&
      !filter_dep_id &&
      !tempoParadoHoras &&
      !filtroAusenciaLista &&
      !(filtroAtendenteInformado != null && !isAtendente)
    if (incluirTodos) {
      const cid = Number(company_id)
      const todosClientes = []
      const remainingSlots = Math.max(0, effectivePageLimit - conversasFormatadas.length)
      const semConversaLimit = Math.min(
        remainingSlots,
        Math.max(1, parsePositiveInt(process.env.CHAT_LIST_SEM_CONVERSA_LIMIT, 50))
      )
      if (semConversaLimit > 0) {
        const searchFetchLimit = Math.min(Math.max(semConversaLimit * 3, semConversaLimit), 150)
        const phoneVariacoesCliente = buildPhoneSearchTerms(palavraTrim)

        // Preferência: RPC accent-insensitive (unaccent_lower) para casar "José" com "jose".
        // A busca de conversas já é sem acento (RPC buscar_conversas_por_nome_ids); aqui
        // espelhamos isso para o cliente SEM conversa, senão ele seria o único ramo que
        // ignora acento. Fallback gracioso para .ilike caso a RPC ainda não exista no banco.
        const { data: rpcRows, error: rpcErr } = await supabase.rpc(
          'buscar_clientes_por_nome_telefone',
          {
            p_company_id: cid,
            p_termo: palavraTrim,
            p_phone_variacoes: phoneVariacoesCliente.length ? phoneVariacoesCliente : null,
            p_limit: searchFetchLimit,
          }
        )
        if (!rpcErr && Array.isArray(rpcRows)) {
          todosClientes.push(...rpcRows)
        } else {
          if (rpcErr) {
            console.warn('[listarConversas] RPC clientes sem conversa (fallback ilike):', rpcErr.message || rpcErr)
          }
          const { data: chunkRows, error: chunkErr } = await supabase
            .from('clientes')
            .select('id, nome, pushname, telefone, foto_perfil')
            .eq('company_id', cid)
            .or(buildClienteSearchOr(palavraTrim))
            .order('nome', { ascending: true, nullsFirst: false })
            .range(0, searchFetchLimit - 1)
          if (chunkErr) {
            console.warn('[listarConversas] carregar clientes sem conversa:', chunkErr.message || chunkErr)
          } else {
            todosClientes.push(...(chunkRows || []))
          }
        }
        const extraVinculoIds = await buscarClienteIdsPorNomeVinculado(supabase, cid, palavraTrim, {
          mode: 'prefix',
          limit: searchFetchLimit,
        })
        if (extraVinculoIds.length > 0) {
          const jaTem = new Set(todosClientes.map((cl) => Number(cl.id)))
          const faltando = extraVinculoIds.filter((id) => !jaTem.has(id))
          if (faltando.length > 0) {
            const { data: extraCli } = await supabase
              .from('clientes')
              .select('id, nome, pushname, telefone, foto_perfil')
              .eq('company_id', cid)
              .in('id', faltando)
            todosClientes.push(...(extraCli || []))
          }
        }
      }
      const { instances: companyInstances } = await listWhatsappInstances(cid)
      const activeInstances = (companyInstances || []).filter((i) => i && i.ativo !== false)
      const multiInstanceMode = activeInstances.length > 1

      /** Pares (cliente_id|phone, instância) que já possuem conversa */
      const conversaScopeKeys = new Set()
      const addConversaScope = (row) => {
        if (!row) return
        const instKey = row.whatsapp_instance_id != null ? String(row.whatsapp_instance_id) : 'legacy'
        if (row.cliente_id != null) conversaScopeKeys.add(`c:${Number(row.cliente_id)}:wi:${instKey}`)
        const pk = phoneKeyBR(row.telefone || '')
        if (pk) conversaScopeKeys.add(`p:${pk}:wi:${instKey}`)
      }
      for (const c of conversasFormatadas || []) {
        if (c.is_group || c.sem_conversa) continue
        addConversaScope(c)
      }

      const candidatosClienteIds = [
        ...new Set((todosClientes || []).map((cl) => Number(cl.id)).filter((n) => Number.isFinite(n) && n > 0)),
      ]
      const candidatosTelefones = [
        ...new Set(
          (todosClientes || [])
            .flatMap((cl) => possiblePhonesBR(cl.telefone || ''))
            .map((tel) => String(tel || '').trim())
            .filter(Boolean)
        ),
      ]
      if (candidatosClienteIds.length > 0 || candidatosTelefones.length > 0) {
        const porClientePromise = candidatosClienteIds.length > 0
          ? supabase
              .from('conversas')
              .select('cliente_id, telefone, whatsapp_instance_id')
              .eq('company_id', cid)
              .in('cliente_id', candidatosClienteIds)
          : Promise.resolve({ data: [], error: null })
        const porTelefonePromise = candidatosTelefones.length > 0
          ? supabase
              .from('conversas')
              .select('cliente_id, telefone, whatsapp_instance_id')
              .eq('company_id', cid)
              .in('telefone', candidatosTelefones)
          : Promise.resolve({ data: [], error: null })
        const [{ data: convByClienteRows }, { data: convByTelefoneRows }] = await Promise.all([
          porClientePromise,
          porTelefonePromise,
        ])
        for (const row of [...(convByClienteRows || []), ...(convByTelefoneRows || [])]) {
          addConversaScope(row)
        }
      }

      const clienteHasAnyConversa = (cl) => {
        if (conversaScopeKeys.has(`c:${Number(cl.id)}:wi:legacy`)) return true
        for (const inst of activeInstances) {
          if (conversaScopeKeys.has(`c:${Number(cl.id)}:wi:${inst.id}`)) return true
        }
        const pk = phoneKeyBR(cl.telefone || '')
        if (pk) {
          if (conversaScopeKeys.has(`p:${pk}:wi:legacy`)) return true
          for (const inst of activeInstances) {
            if (conversaScopeKeys.has(`p:${pk}:wi:${inst.id}`)) return true
          }
        }
        return false
      }

      const clienteMissingInstance = (cl, inst) => {
        const instKey = inst?.id != null ? String(inst.id) : 'legacy'
        if (conversaScopeKeys.has(`c:${Number(cl.id)}:wi:${instKey}`)) return false
        const pk = phoneKeyBR(cl.telefone || '')
        if (pk && conversaScopeKeys.has(`p:${pk}:wi:${instKey}`)) return false
        return true
      }

      const instanceScopes = multiInstanceMode
        ? activeInstances.map((inst) => sanitizeWhatsappInstance(inst)).filter(Boolean)
        : [null]

      const itensSemConversa = []
      for (const cl of todosClientes || []) {
        if (!multiInstanceMode) {
          if (clienteHasAnyConversa(cl)) continue
          itensSemConversa.push({
            id: null,
            cliente_id: cl.id,
            telefone: cl.telefone || '',
            tipo: 'cliente',
            contato_nome: getDisplayName(cl) || null,
            pushname: cl.pushname || null,
            foto_perfil: cl.foto_perfil || null,
            sem_conversa: true,
            mensagens: [],
            unread_count: 0,
            tags: [],
            status_atendimento: null,
            exibir_badge_aberta: false,
            ultima_atividade: null,
            criado_em: null,
          })
          if (itensSemConversa.length >= semConversaLimit) break
          continue
        }
        for (const inst of instanceScopes) {
          if (!clienteMissingInstance(cl, inst)) continue
          itensSemConversa.push({
            id: null,
            cliente_id: cl.id,
            telefone: cl.telefone || '',
            tipo: 'cliente',
            contato_nome: getDisplayName(cl) || null,
            pushname: cl.pushname || null,
            foto_perfil: cl.foto_perfil || null,
            sem_conversa: true,
            whatsapp_instance_id: inst?.id ?? null,
            whatsapp_instance_nome: inst?.nome ?? null,
            whatsapp_instance_display_phone: inst?.display_phone ?? null,
            mensagens: [],
            unread_count: 0,
            tags: [],
            status_atendimento: null,
            exibir_badge_aberta: false,
            ultima_atividade: null,
            criado_em: null,
          })
          if (itensSemConversa.length >= semConversaLimit) break
        }
        if (itensSemConversa.length >= semConversaLimit) break
      }
      conversasFormatadas = [...conversasFormatadas, ...itensSemConversa]
      conversasFormatadas.sort((a, b) => {
        if (a.sem_conversa && b.sem_conversa) {
          const na = (a.contato_nome || '').toString().toLowerCase()
          const nb = (b.contato_nome || '').toString().toLowerCase()
          return na.localeCompare(nb)
        }
        if (a.sem_conversa) return 1
        if (b.sem_conversa) return -1
        const ta = a.ultima_atividade || a.criado_em || ''
        const tb = b.ultima_atividade || b.criado_em || ''
        return new Date(tb) - new Date(ta)
      })
    }

    // Mensagens disparadas: só linhas de conversa reais com pelo menos uma mensagem (nunca "sem conversa" / vazias).
    if (statusNorm === 'mensagem_disparada') {
      conversasFormatadas = conversasFormatadas.filter((c) => {
        if (c.sem_conversa || c.id == null) return false
        const temMsg =
          (Array.isArray(c.mensagens) && c.mensagens.length > 0) ||
          (c.ultima_mensagem != null && typeof c.ultima_mensagem === 'object')
        return temMsg
      })
    }

    // Defesa de rollout: a RPC antiga usava %termo% e fazia "hu" casar em
    // S-hu-arts / C-hu-rrascaria. A migration nova corrige isso no banco, mas
    // esta camada impede falsos positivos mesmo antes de ela ser aplicada.
    // Resultados que vieram exclusivamente do texto de mensagens continuam
    // válidos somente quando esse recurso foi explicitamente habilitado.
    if (isTextSearch && palavraTrim) {
      await anexarVinculosEmBusca(supabase, company_id, conversasFormatadas, palavraTrim, 'prefix')
      const realConversationCountBefore = conversasFormatadas.filter((c) => c?.id != null && !c?.sem_conversa).length
      conversasFormatadas = conversasFormatadas.filter((c) => {
        const id = Number(c?.id)
        if (Number.isFinite(id) && searchMessageOnlyIdSet.has(id)) return true
        return chatIdentityMatchesSearch(c, palavraTrim)
      })
      const realConversationCountAfter = conversasFormatadas.filter((c) => c?.id != null && !c?.sem_conversa).length
      searchDefensiveRemovedConversationCount = Math.max(
        0,
        realConversationCountBefore - realConversationCountAfter
      )
    }

    // Preferências por usuário (silenciar / fixar / favoritar) — migration: conversa_usuario_prefs
    try {
      const idsComConversa = conversasFormatadas
        .filter((c) => c.id != null && !c.sem_conversa)
        .map((c) => Number(c.id))
        .filter((id) => Number.isFinite(id) && id > 0)
      if (idsComConversa.length > 0) {
        const { data: prefRows, error: prefErr } = await supabase
          .from('conversa_usuario_prefs')
          .select('conversa_id, silenciada, fixada, favorita, fixada_em')
          .eq('company_id', Number(company_id))
          .eq('usuario_id', Number(user_id))
          .in('conversa_id', idsComConversa)
        const missingTable =
          prefErr &&
          (String(prefErr.message || '').toLowerCase().includes('conversa_usuario_prefs') ||
            String(prefErr.message || '').includes('schema cache') ||
            String(prefErr.code || '') === '42P01')
        if (prefErr && !missingTable) {
          console.warn('[listarConversas] conversa_usuario_prefs:', prefErr.message)
        } else {
          const prefMap = new Map((prefRows || []).map((r) => [Number(r.conversa_id), r]))
          conversasFormatadas = conversasFormatadas.map((c) => {
            if (c.sem_conversa || c.id == null) {
              return {
                ...c,
                silenciada: false,
                fixada: false,
                favorita: false,
                fixada_em: null,
              }
            }
            const p = prefMap.get(Number(c.id))
            return {
              ...c,
              silenciada: !!(p && p.silenciada),
              fixada: !!(p && p.fixada),
              favorita: !!(p && p.favorita),
              fixada_em: p && p.fixada_em != null ? p.fixada_em : null,
            }
          })
          if (!prefErr) {
            conversasFormatadas = sortConversationsPinThenRecent(conversasFormatadas)
          }
        }
      }
    } catch (e) {
      console.warn('[listarConversas] prefs:', e?.message || e)
    }

    // Busca por texto: reordena por relevância (nome/telefone antes de match só no texto),
    // recência dentro de cada faixa. É a última ordenação aplicada antes de paginar.
    // Marca `busca_rank` (0 = nome/telefone, 1 = só texto) para o frontend preservar a
    // prioridade — ele re-ordena por recência e sem esse rank perderia o "nome/telefone no topo".
    if (isTextSearch && searchPriorityIdSet) {
      conversasFormatadas = sortConversationsBySearchRelevance(conversasFormatadas, searchPriorityIdSet)
      for (const c of conversasFormatadas) {
        if (!c) continue
        const id = Number(c.id)
        const isPrioridade = c.sem_conversa === true || (Number.isFinite(id) && searchPriorityIdSet.has(id))
        c.busca_rank = isPrioridade ? 0 : 1
      }
    }

    let chatListPage = splitChatListPage(conversasFormatadas || [], effectivePageLimit)
    if (
      !chatListPage.pagination.has_more &&
      rawSqlHadMore &&
      (chatListPage.rows.length < effectivePageLimit || chatListPage.rows.length === 0)
    ) {
      const cursorRow =
        rawSqlRows[Math.min(effectivePageLimit, rawSqlRows.length) - 1] ||
        rawSqlRows[rawSqlRows.length - 1]
      chatListPage = {
        rows: chatListPage.rows,
        pagination: {
          ...chatListPage.pagination,
          has_more: true,
          next_cursor: cursorRow?.ultima_atividade || cursorRow?.criado_em || null,
          next_cursor_id: cursorRow?.id != null ? Number(cursorRow.id) : null,
        },
      }
    }
    conversasFormatadas = chatListPage.rows

    const responsePagination = {
      ...chatListPage.pagination,
      returned: Array.isArray(conversasFormatadas) ? conversasFormatadas.length : 0,
      sem_conversa_included: Boolean(incluirTodos),
    }
    const totalCountFromQuery = await totalCountPromise
    // Durante o rollout da RPC nova, o count SQL ainda pode incluir os falsos
    // positivos eliminados pela defesa acima. Ajusta o cabeçalho "X de Y" para
    // ele não continuar anunciando resultados que a lista corretamente removeu.
    const totalCountRaw =
      totalCountFromQuery != null && searchDefensiveRemovedConversationCount > 0
        ? Math.max(0, Number(totalCountFromQuery) - searchDefensiveRemovedConversationCount)
        : totalCountFromQuery
    const totalCount =
      totalCountRaw == null &&
      !chatListPagination.cursor &&
      Array.isArray(conversasFormatadas) &&
      conversasFormatadas.length === 0 &&
      !responsePagination.has_more
        ? 0
        : totalCountRaw
    setChatListPaginationHeaders(res, responsePagination, {
      semConversaIncluded: incluirTodos,
      totalCount,
    })

    if (!incluirColaboradoresEncaminhar) {
      if (chatListPagination.paginatedResponse) {
        return res.json({ conversas: conversasFormatadas, pagination: responsePagination })
      }
      return res.json(conversasFormatadas)
    }
    const colaboradores_encaminhar = await loadColaboradoresEncaminhar()
    return res.json({ conversas: conversasFormatadas, colaboradores_encaminhar, pagination: responsePagination })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar conversas' })
  }
}

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
exports.getPixConfig = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('empresa_pix_config')
      .select('tipo_chave, chave_pix, nome_recebedor, mensagem_padrao, atualizado_em')
      .eq('company_id', Number(company_id))
      .maybeSingle()

    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('empresa_pix_config') || msg.includes('does not exist')) {
        return res.json({ configured: false, config: null })
      }
      console.error('[chatController] getPixConfig', error?.message)
      return res.status(500).json({ error: 'Erro interno' })
    }

    if (!data) return res.json({ configured: false, config: null })
    return res.json({ configured: true, config: data })
  } catch (err) {
    console.error('[getPixConfig]', err)
    return res.status(500).json({ error: 'Erro ao obter configuração Pix.' })
  }
}

/** PUT /chats/pix-config */
exports.putPixConfig = async (req, res) => {
  try {
    const { company_id, id: user_id } = req.user
    const parsed = sanitizePixConfigPayload(req.body)
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error })

    const payload = {
      company_id: Number(company_id),
      ...parsed.data,
      atualizado_por: Number(user_id),
      atualizado_em: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('empresa_pix_config')
      .upsert(payload, { onConflict: 'company_id' })
      .select('tipo_chave, chave_pix, nome_recebedor, mensagem_padrao, atualizado_em')
      .single()

    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('empresa_pix_config') || msg.includes('does not exist') || msg.includes('schema cache')) {
        return res.status(400).json({
          error: 'Funcionalidade Pix ainda não habilitada no banco. Aplique a migration 20260427233000_empresa_pix_config.sql e tente novamente.'
        })
      }
      console.error('[chatController] putPixConfig', error?.message)
      return res.status(500).json({ error: 'Erro interno' })
    }
    return res.json({ ok: true, config: data })
  } catch (err) {
    console.error('[putPixConfig]', err)
    return res.status(500).json({ error: 'Erro ao salvar configuração Pix.' })
  }
}

/** POST /chats/:id/pix — envia mensagem Pix usando o mesmo fluxo de envio/realtime existente */
exports.enviarMensagemPix = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('empresa_pix_config')
      .select('tipo_chave, chave_pix, nome_recebedor, mensagem_padrao')
      .eq('company_id', Number(company_id))
      .maybeSingle()

    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('empresa_pix_config') || msg.includes('does not exist') || msg.includes('schema cache')) {
        return res.status(400).json({
          error: 'Funcionalidade Pix ainda não habilitada no banco. Aplique a migration 20260427233000_empresa_pix_config.sql.'
        })
      }
      console.error('[chatController] enviarMensagemPix', error?.message)
      return res.status(500).json({ error: 'Erro interno' })
    }
    if (!data) return res.status(400).json({ error: 'Pix não configurado para esta empresa.' })

    const mensagem = buildPixMessageFromConfig(data)
    req.body = { ...req.body, texto: mensagem }
    return exports.enviarMensagemChat(req, res)
  } catch (err) {
    console.error('[enviarMensagemPix]', err)
    return res.status(500).json({ error: 'Erro ao enviar mensagem Pix.' })
  }
}

// =====================================================
// enviarMensagemChat (corrigido + padronizado)
// =====================================================
exports.enviarMensagemChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const { id: conversa_id } = req.params
    const { texto, reply_meta, link, client_temp_id } = req.body
    const clientTempId = normalizeClientTempId(client_temp_id)

    if (!texto || !String(texto).trim()) {
      return res.status(400).json({ error: 'texto é obrigatório' })
    }

    // Deduplicação por client_temp_id em memória: evita double-send por double-click ou retry do frontend.
    // Map com TTL de 30s por (company_id + conversa_id + client_temp_id).
    if (clientTempId) {
      const dedupKey = clientTempIdDedupeKey(company_id, conversa_id, clientTempId)
      const existing = _clientTempIdDeduplicationMap.get(dedupKey)
      if (existing && Date.now() - existing.ts < 30_000) {
        return res.json({
          ok: true,
          id: existing.id,
          conversa_id: Number(conversa_id),
          client_temp_id: clientTempId,
          status: existing.status || 'pending',
          deduplicated: true,
        })
      }
      const persisted = await findMensagemByClientTempId(company_id, conversa_id, clientTempId)
      const persistedResponse = buildClientTempIdDedupResponse(persisted, conversa_id, clientTempId)
      if (persistedResponse) {
        _clientTempIdDeduplicationMap.set(dedupKey, {
          id: persistedResponse.id,
          status: persistedResponse.status,
          ts: Date.now(),
        })
        return res.json(persistedResponse)
      }
    }

    const io = req.app.get('io')
    const modoSimplesEnvio = await empresaModoSimplesAtivo(company_id).catch(() => false)
    const permEnvio = await assertPodeEnviarMensagem({
      company_id,
      conversa_id,
      user_id,
      role: req.user?.perfil,
      user_dep_ids: req.user?.departamento_ids,
      autoAssumirAoEnviar: !modoSimplesEnvio,
      io,
    })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, tipo, nome_contato_cache, foto_perfil_contato_cache, chat_lid, whatsapp_instance_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .single()

    if (errConv || !conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    // Resolver telefone real quando conversa tem apenas LID (lid:xxx) — Z-API não envia para LID
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

    // Garantir que o contato (número + nome) esteja salvo em clientes antes de enviar
    const isGroup = String(conversa?.tipo || '').toLowerCase() === 'grupo' || String(conversa?.telefone || '').includes('@g.us')
    if (!isGroup && conversa?.telefone && !conversa?.cliente_id) {
      const nomeCache = conversa?.nome_contato_cache ? String(conversa.nome_contato_cache).trim() : null
      const fotoCache = conversa?.foto_perfil_contato_cache ? String(conversa.foto_perfil_contato_cache).trim() : null
      const { cliente_id: novoClienteId } = await getOrCreateCliente(supabase, company_id, conversa.telefone, {
        nome: nomeCache || undefined,
        nomeSource: 'chatName',
        foto_perfil: fotoCache || undefined
      })
      if (novoClienteId) {
        await supabase.from('conversas').update({ cliente_id: novoClienteId }).eq('id', conversa_id).eq('company_id', company_id)
        conversa.cliente_id = novoClienteId
        // Enriquecer em background com dados reais da UltraMsg (nome, foto do WhatsApp)
        const { syncUltraMsgContact } = require('../services/ultramsgSyncContact')
        setImmediate(async () => {
          try {
            const synced = await syncUltraMsgContact(conversa.telefone, company_id)
            if (synced && req.app?.get('io')) {
              const io = req.app.get('io')
              const { data: cli } = await supabase.from('clientes').select('nome, pushname, telefone, foto_perfil').eq('id', novoClienteId).eq('company_id', company_id).maybeSingle()
              const { data: conv } = await supabase.from('conversas').select('nome_contato_cache, foto_perfil_contato_cache').eq('id', conversa_id).eq('company_id', company_id).maybeSingle()
              const contatoNome = getDisplayName(cli) || conv?.nome_contato_cache || synced.nome || conversa.telefone
              const fotoPerfil = conv?.foto_perfil_contato_cache || cli?.foto_perfil || synced.foto_perfil
              io.to(`empresa_${company_id}`).emit('contato_atualizado', {
                conversa_id: Number(conversa_id),
                contato_nome: contatoNome,
                telefone: cli?.telefone || conversa.telefone,
                foto_perfil: fotoPerfil
              })
            }
          } catch (_) {}
        })
      }
    }

    const linkPayload = normalizeLinkPayload(link)
    const hasLinkPayload = !!linkPayload

    // Reply (citação) — opcional. Requer coluna mensagens.reply_meta (jsonb).
    const timestamp = new Date().toISOString()
    const basePayload = {
      company_id,
      conversa_id: Number(conversa_id),
      texto: String(texto).trim(),
      tipo: hasLinkPayload ? 'link' : 'texto',
      direcao: 'out',
      autor_usuario_id: Number(user_id),
      status: 'pending',
      criado_em: timestamp
    }
    if (whatsappInstanceId) basePayload.whatsapp_instance_id = whatsappInstanceId
    if (clientTempId && !isDbDedupeUnavailable()) basePayload.client_temp_id = clientTempId
    const payloadWithReply =
      reply_meta && typeof reply_meta === 'object'
        ? {
            ...basePayload,
            reply_meta: {
              name: String(reply_meta.name || '').slice(0, 80),
              snippet: String(reply_meta.snippet || '').slice(0, 180),
              ts: Number(reply_meta.ts || Date.now()),
              replyToId: reply_meta.replyToId != null ? String(reply_meta.replyToId) : undefined,
              ...(reply_meta.thumb
                ? { thumb: String(reply_meta.thumb).slice(0, 500) }
                : {}),
              ...(reply_meta.reply_kind
                ? { reply_kind: String(reply_meta.reply_kind).slice(0, 24) }
                : {}),
            },
          }
        : basePayload

    let msg = null
    let errMsg = null
    let insertPayload = payloadWithReply
    for (let attempt = 0; attempt < 3; attempt++) {
      ;({ data: msg, error: errMsg } = await supabase
        .from('mensagens')
        .insert(insertPayload)
        .select()
        .single())

      if (!errMsg) break

      if (clientTempId && isClientTempIdUniqueViolation(errMsg)) {
        const persisted = await findMensagemByClientTempId(company_id, conversa_id, clientTempId)
        const persistedResponse = buildClientTempIdDedupResponse(persisted, conversa_id, clientTempId)
        if (persistedResponse) {
          _clientTempIdDeduplicationMap.set(clientTempIdDedupeKey(company_id, conversa_id, clientTempId), {
            id: persistedResponse.id,
            status: persistedResponse.status,
            ts: Date.now(),
          })
          return res.json(persistedResponse)
        }
      }

      const missingClientTempId =
        insertPayload.client_temp_id &&
        (isMissingMensagemColumnError(errMsg, 'client_temp_id') || isGenericMissingColumnError(errMsg))
      const missingReplyMeta =
        insertPayload.reply_meta &&
        (isMissingMensagemColumnError(errMsg, 'reply_meta') || (!missingClientTempId && isGenericMissingColumnError(errMsg)))

      if (!missingClientTempId && !missingReplyMeta) break

      insertPayload = { ...insertPayload }
      if (missingClientTempId) {
        delete insertPayload.client_temp_id
        markDbDedupeUnavailable()
      }
      if (missingReplyMeta) delete insertPayload.reply_meta
    }

    if (errMsg) return res.status(500).json({ error: errMsg.message })

    // Registrar no Map de deduplicação após INSERT bem-sucedido
    if (clientTempId && msg?.id) {
      const dedupKey = clientTempIdDedupeKey(company_id, conversa_id, clientTempId)
      _clientTempIdDeduplicationMap.set(dedupKey, { id: msg.id, status: 'pending', ts: Date.now() })
    }

    // Paralelo: tryMarkWaiting + UPDATE conversas + UPDATE clientes são independentes entre si
    const updateNow = new Date().toISOString()
    const [waitingAfterOutbound, modoSimplesResult] = await Promise.all([
      modoSimplesEnvio
        ? Promise.resolve(null)
        : tryMarkWaitingAfterHumanOutbound({
            company_id,
            conversa_id: Number(conversa_id),
            texto: String(texto || '').trim(),
            criado_em: msg.criado_em,
            autor_usuario_id: Number(user_id),
          }).catch(() => null),
      recalcularEMesclarModoSimples({
        company_id,
        conversa_id: Number(conversa_id),
        mensagemNova: msg,
        io: null,
      }).catch(() => null),
      supabase
        .from('conversas')
        .update({ lida: true, ultima_atividade: updateNow })
        .eq('company_id', Number(company_id))
        .eq('id', Number(conversa_id)),
      isGroup || conversa?.cliente_id == null
        ? Promise.resolve()
        : supabase
            .from('clientes')
            .update({ ultimo_contato: basePayload.criado_em, atualizado_em: updateNow })
            .eq('company_id', Number(company_id))
            .eq('id', Number(conversa.cliente_id)),
    ])

    if (io) {
      const basePayload = { ...msg, id: msg.id, conversa_id: msg.conversa_id ?? Number(conversa_id), status: 'sending', status_mensagem: 'sending', direcao: 'out', ...(clientTempId ? { client_temp_id: clientTempId } : {}) }
      const novaMsgPayload = await enrichMensagemComAutorUsuario(supabase, company_id, basePayload)
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem',
        novaMsgPayload
      )
      // Atualizar sidebar (preview) sem disparar refetch que causa duplicação.
      // Não reenviar foto_perfil: cache e cliente.foto_perfil podem diferir (CDN) e o card “pula”.
      let contatoNome = conversa?.nome_contato_cache ? String(conversa.nome_contato_cache).trim() : null
      const telefoneParaPayload = conversa?.telefone && !String(conversa.telefone).startsWith('lid:') ? String(conversa.telefone).trim() : null
      const whatsappInstanceMetaMap = await loadWhatsappInstanceMetaMap(company_id, [whatsappInstanceId])
      const whatsappInstanceMeta = safeWhatsappInstanceMeta(whatsappInstanceMetaMap.get(Number(whatsappInstanceId)))
      const convPayload = aplicarAguardandoClienteNoPayload({
        id: Number(conversa_id),
        ultima_atividade: novaMsgPayload.criado_em,
        exibir_badge_aberta: true,
        whatsapp_instance_id: whatsappInstanceId ?? conversa?.whatsapp_instance_id ?? null,
        ...whatsappInstanceMeta,
        ...(telefoneParaPayload ? { telefone: telefoneParaPayload } : {}),
        ...(conversa?.cliente_id != null ? { cliente_id: conversa.cliente_id } : {}),
        ...(contatoNome ? { nome_contato_cache: contatoNome, contato_nome: contatoNome } : {}),
        ultima_mensagem_preview: {
          texto: basePayload.texto,
          criado_em: novaMsgPayload.criado_em,
          direcao: 'out',
          fromMe: true,
          usuario_id: novaMsgPayload.usuario_id,
          usuario_nome: novaMsgPayload.usuario_nome,
        },
        reordenar_suave: true // Frontend: animar item para o topo em vez de refetch (evita "desce e sobe")
      }, waitingAfterOutbound, {
        ...(modoSimplesResult?.conversa || {}),
        atendimento_modo_simples: modoSimplesEnvio,
        modo_simples_aguardando: modoSimplesResult?.modo_simples_aguardando ?? null,
      })
      emitirConversaAtualizada(io, company_id, conversa_id, convPayload, { skipAtualizarConversa: true })
    }

    // Envio para WhatsApp via provider (ultramsg, conforme instância configurada)
    let sendResult = null
    if (!telefoneParaEnvio) {
      // Mensagem manual sem telefone: não pode ficar como pending para sempre
      console.warn('[ENVIO_MANUAL] ❌ Conversa sem telefone — mensagem não enviada ao WhatsApp', {
        company_id,
        conversa_id,
        mensagem_id: msg.id,
      })
      await supabase
        .from('mensagens')
        .update({ status: 'erro', status_mensagem: 'failed' })
        .eq('company_id', company_id)
        .eq('id', msg.id)
      const ioNoPhone = req.app.get('io')
      if (ioNoPhone) {
        ioNoPhone.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`)
          .emit('status_mensagem', {
            mensagem_id: msg.id,
            conversa_id: Number(conversa_id),
            status: 'erro',
            status_mensagem: 'failed',
          })
      }
      sendResult = { ok: false, error: 'Número do contato indisponível para envio' }
    }
    if (telefoneParaEnvio) {
      let phoneId = null
      try {
        const { data: ew } = await supabase
          .from('empresas_whatsapp')
          .select('phone_number_id')
          .eq('company_id', company_id)
          .maybeSingle()
        if (ew?.phone_number_id) phoneId = String(ew.phone_number_id)
      } catch (_) {}

      // Resolve o whatsapp_id real da mensagem citada para enviar reply nativo ao WhatsApp (UltraMsg: body.msgId)
      let replyMessageId = null
      if (reply_meta?.replyToId != null) {
        replyMessageId = await resolveUltraMsgReplyMessageId(supabase, company_id, conversa_id, reply_meta.replyToId)
        if (!replyMessageId) {
          console.warn('[WhatsApp reply] msgId da citação não resolvido — envio sem reply no WhatsApp.', {
            conversa_id,
            replyToId: String(reply_meta.replyToId).slice(0, 96),
          })
        }
      }

      const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, user_id)
      const provider = getProvider()

      // Log de início de envio manual (auditoria e diagnóstico)
      console.log('[ENVIO_MANUAL] Iniciando envio', {
        company_id,
        conversa_id,
        mensagem_id: msg.id,
        telefone_destino: String(telefoneParaEnvio || '').slice(-12),
        whatsapp_instance_id: whatsappInstanceId,
        provedor: 'ultramsg',
        tipo: hasLinkPayload ? 'link' : 'texto',
      })

      try {
        let result = null

        if (hasLinkPayload && provider.sendLink) {
          let messageToSend = String(texto).trim()
          const linkUrlStr = linkPayload.linkUrl
          if (linkUrlStr && !messageToSend.includes(linkUrlStr)) {
            messageToSend = messageToSend ? `${messageToSend} ${linkUrlStr}` : linkUrlStr
          }
          messageToSend = textoParaEnvioWhatsapp(messageToSend, usuarioNome)
          result = await provider.sendLink(telefoneParaEnvio, {
            message: messageToSend,
            image: linkPayload.image || '',
            linkUrl: linkUrlStr,
            title: linkPayload.title || linkUrlStr,
            linkDescription: linkPayload.linkDescription || messageToSend,
          }, {
            companyId: company_id,
            conversaId: conversa_id,
            whatsappInstanceId: whatsappInstanceId || undefined,
            replyMessageId: replyMessageId || undefined,
            sendOrigin: 'atendimento_humano',
          })
        } else {
          const textoParaCliente = textoParaEnvioWhatsapp(String(texto).trim(), usuarioNome)
          result = await provider.sendText(telefoneParaEnvio, textoParaCliente, {
            companyId: company_id,
            conversaId: conversa_id,
            whatsappInstanceId: whatsappInstanceId || undefined,
            phoneId: phoneId || undefined,
            replyMessageId: replyMessageId || undefined,
            referenceId: `crm-${msg.id}`,
            sendOrigin: 'atendimento_humano',
          })
        }

        const ok = typeof result === 'boolean' ? result : result?.ok === true
        const waMessageId = typeof result === 'object' && result?.messageId ? String(result.messageId).trim() : null
        // hasValidId: ID reconhecível como WhatsApp real (hex 12+ chars ou contém @).
        // Usado apenas para salvar whatsapp_id e habilitar rastreamento de ACK.
        // NÃO determina se o envio foi bem-sucedido — isso depende apenas de ok.
        const hasValidId = isRealWhatsAppId(waMessageId)
        const hasQueueId = !!waMessageId && isUltramsgNumericQueueId(waMessageId)
        const providerError = (typeof result === 'object') ? (result?.error || result?.blockedBy || null) : null
        const acceptedWithoutTrace = ok && !hasValidId

        // Regra: sent exige aceite do provider e ID rastreavel.
        // Aceite sem ID rastreavel permanece pending/sending para evitar mensagem fantasma.
        // O whatsapp_id só é salvo quando o ID retornado é um WhatsApp ID rastreável.
        const nextStatus = ok ? (hasValidId ? 'sent' : 'pending') : 'erro'
        const nextStatusMensagem = ok ? (hasValidId ? 'sent' : 'sending') : 'failed'

        if (ok) {
          console.log('[ENVIO_MANUAL] ✅ Sucesso', {
            company_id,
            conversa_id,
            mensagem_id: msg.id,
            telefone_destino: String(telefoneParaEnvio || '').slice(-12),
            whatsapp_instance_id: whatsappInstanceId,
            provedor: 'ultramsg',
            provider_message_id: waMessageId || null,
            whatsapp_id_salvo: hasValidId ? waMessageId : null,
          })
          if (acceptedWithoutTrace) {
            // Provider aceitou a mensagem, mas o ID retornado não é rastreável como WhatsApp ID.
            // Isso é normal quando UltraMsg retorna ID interno de fila (ex: "35096").
            // Não marcar como sent sem ID rastreável; o ACK pode chegar depois via webhook/reconciliação.
            console.warn('[ENVIO_MANUAL] ℹ️ Provider aceitou envio sem WhatsApp ID rastreável', {
              company_id,
              conversa_id,
              mensagem_id: msg.id,
              telefone_destino: String(telefoneParaEnvio || '').slice(-12),
              whatsapp_instance_id: whatsappInstanceId,
              provider_id_recebido: waMessageId || 'NULL',
              nota: 'Mensagem mantida como pending/sending ate chegar ACK rastreavel ou retry confirmar falha.',
            })
          }
        } else {
          console.warn('[ENVIO_MANUAL] ❌ Falha no envio', {
            company_id,
            conversa_id,
            mensagem_id: msg.id,
            telefone_destino: String(telefoneParaEnvio || '').slice(-12),
            whatsapp_instance_id: whatsappInstanceId,
            provedor: 'ultramsg',
            erro: String(providerError || '').slice(0, 200) || 'desconhecido',
          })
        }

        // whatsapp_id só recebe IDs reais do WhatsApp (rastreáveis).
        // IDs de fila numéricos da UltraMsg (ex: "35096") vão para provider_queue_id
        // para permitir reconciliação de ACK sem poluir whatsapp_id com IDs não reais.
        await supabase
          .from('mensagens')
          .update({
            status: nextStatus,
            status_mensagem: nextStatusMensagem,
            ...(hasValidId ? { whatsapp_id: waMessageId } : {}),
            ...(hasQueueId ? { provider_queue_id: waMessageId } : {}),
          })
          .eq('company_id', company_id)
          .eq('id', msg.id)

        if (clientTempId && msg?.id) {
          _clientTempIdDeduplicationMap.set(
            clientTempIdDedupeKey(company_id, conversa_id, clientTempId),
            { id: msg.id, status: nextStatus, ts: Date.now() }
          )
        }

        const io2 = req.app.get('io')
        if (io2) {
          // Emite para empresa, conversa E usuario que enviou (garante ticks ✓✓ em tempo real)
          io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`)
            .emit('status_mensagem', {
              mensagem_id: msg.id,
              conversa_id: Number(conversa_id),
              status: nextStatus,
              status_mensagem: nextStatusMensagem,
              ...(hasValidId ? { whatsapp_id: waMessageId } : {}),
            })
        }

        if (acceptedWithoutTrace) {
          schedulePendingOutboundReconciliation({
            companyId: company_id,
            mensagemId: msg.id,
            io: io2,
          })
        }

        sendResult = result
      } catch (e) {
        console.error('[ENVIO_MANUAL] ❌ Exceção ao enviar mensagem', {
          company_id,
          conversa_id,
          mensagem_id: msg.id,
          telefone_destino: String(telefoneParaEnvio || '').slice(-12),
          whatsapp_instance_id: whatsappInstanceId,
          erro: e?.message || String(e),
        })
        sendResult = { ok: false, error: e?.message || 'Erro ao enviar mensagem' }
        await supabase
          .from('mensagens')
          .update({ status: 'erro', status_mensagem: 'failed' })
          .eq('company_id', company_id)
          .eq('id', msg.id)
        const io2 = req.app.get('io')
        if (io2) {
          io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`)
            .emit('status_mensagem', {
              mensagem_id: msg.id,
              conversa_id: Number(conversa_id),
              status: 'erro',
              status_mensagem: 'failed',
            })
        }
      }
    }

    // Não retornar mensagem completa — evita duplicação no frontend (API + socket).
    // A mensagem chega via socket nova_mensagem (única fonte de verdade para exibição).
    const sendOk = !!telefoneParaEnvio && (typeof sendResult === 'boolean' ? sendResult : sendResult?.ok === true)
    const sendWaMessageId = typeof sendResult === 'object' && sendResult?.messageId ? String(sendResult.messageId).trim() : null
    const sendTraceable = sendOk && isRealWhatsAppId(sendWaMessageId)
    const motivoErro = sendResult?.error || sendResult?.blockedBy
    return res.json({
      ok: true,
      id: msg.id,
      conversa_id: Number(conversa_id),
      ...(clientTempId ? { client_temp_id: clientTempId } : {}),
      ...(sendTraceable ? { status: 'sent', whatsapp_id: sendWaMessageId } : sendOk ? { status: 'pending' } : {
        status: sendResult?.blockedBy ? 'blocked' : 'erro',
        ...(motivoErro ? { motivo: motivoErro } : {})
      })
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao enviar mensagem' })
  }
}

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
