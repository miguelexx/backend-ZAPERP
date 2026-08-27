const supabase = require('../../config/supabase')
const _chatShared = require('./shared')
const {
  mergeConversaClienteTags,
  safeWhatsappInstanceMeta,
  loadWhatsappInstanceMetaMap,
  statusAtendimentoParaLista,
  parsePositiveInt,
  isFlagAtivo,
  parseChatListPagination,
  applyChatListCursor,
  splitChatListPage,
  shouldIncludeClientesSemConversa,
  setChatListPaginationHeaders,
  enrichMensagensComAutorUsuario,
  obterUnreadMap,
  getChatSearchIdLimit,
  getChatFilterIdLimit,
  buscarConversaIdsPorTextoMensagens,
  getConversaIdsParticipanteAtivo,
  deveIncluirGruposSemDepartamentoNoFiltroTodos,
} = _chatShared
const {
  registrarAtendimento,
  buildMensagemInternaMovimentacao,
  listarMensagensInternasMovimentacao,
  perfilPodeVerMovimentacaoInterna,
  isMensagemLegadaMovimentacaoInterna,
} = require('../../services/atendimentosRegistroService')





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

const {
  resolveReabertaPorFaltaInteracao,
  enrichConversasReabertaFaltaInteracao,
  clearReabertaFaltaInteracao,
} = require('../../helpers/reabertaFaltaInteracaoHelper')
const { getDisplayName, normalizeName, isBadName } = require('../../helpers/contactEnrichment')


const { empresaModoSimplesAtivo } = require('../../helpers/empresaModoSimplesFlag')
const {
  resolveGrupoIdsComUnreadParaUsuario,
  applyAguardandoAtendenteModoSimplesQuery,
  rowAguardandoAtendenteModoSimples,
} = require('../../helpers/modoSimplesGrupoUnread')



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






/**
 * controllers/chat/listController.js
 *
 * Handlers de LEITURA de listagem/contagem de conversas (fachada em chatController.js):
 *   - listarConversas          GET  /chats
 *   - contarConversasPorFiltros GET /chats/counts
 *
 * Invariantes: isolamento por company_id em toda query; ordenação e paginação keyset
 * idênticas ao original; filtros de fila/setor/atendente/status/tags/não-lidas e busca
 * por nome/telefone preservados. Regras de negócio pesadas vivem em services
 * (chatListCountsService, conversationSync, conversaEnrichment) e helpers de chat/shared.
 */

exports.listarConversas = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const role = String(perfil || '').toLowerCase()
    const isAdmin = role === 'admin'
    const isAtendente = role === 'atendente'
    const {
      tag_id,
      data_inicio,
      data_fim,
      status_atendimento,
      atendente_id,
      palavra,
      departamento_id: filter_dep_id,
      incluir_todos_clientes: incluirTodosClientes,
      minha_fila: minhaFilaRaw,
      incluir_colaboradores_encaminhar: incluirColabEncRaw,
      aguardando_cliente: aguardandoClienteRaw,
      aguardando_atendente: aguardandoAtendenteRaw,
      pagamento_pendente: pagamentoPendenteRaw,
      em_atraso: emAtrasoRaw,
      tempo_parado: tempoParadoRaw,
      finalizacao_motivo: finalizacaoMotivoRaw,
      hoje: hojeRaw,
    } = req.query

    const filtroAusenciaListaRaw =
      String(finalizacaoMotivoRaw ?? '')
        .trim()
        .toLowerCase() === 'ausencia_cliente'

    const TEMPO_PARADO_HORAS = {
      '2h': 2,
      '12h': 12,
      '24h': 24,
      '7d': 24 * 7,
      '30d': 24 * 30,
    }
    const tempoParadoKey =
      tempoParadoRaw != null && String(tempoParadoRaw).trim() !== ''
        ? String(tempoParadoRaw).trim().toLowerCase()
        : null
    const tempoParadoHorasRaw =
      tempoParadoKey && Object.prototype.hasOwnProperty.call(TEMPO_PARADO_HORAS, tempoParadoKey)
        ? TEMPO_PARADO_HORAS[tempoParadoKey]
        : null

    const aguardandoClienteRawAtivo = isFlagAtivo(aguardandoClienteRaw)
    const aguardandoAtendenteRawAtivo = isFlagAtivo(aguardandoAtendenteRaw)
    const pagamentoPendenteRawAtivo = isFlagAtivo(pagamentoPendenteRaw)
    const emAtrasoRawAtivo = isFlagAtivo(emAtrasoRaw)
    const hojeRawAtivo = isFlagAtivo(hojeRaw)
    const minhaFilaRawAtiva = isFlagAtivo(minhaFilaRaw)

    const tagFilterAtivo =
      tag_id != null &&
      String(tag_id).trim() !== '' &&
      String(tag_id).trim().toLowerCase() !== 'todas'

    const incluirColaboradoresEncaminhar = isFlagAtivo(incluirColabEncRaw)

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

    const incluirTodosClientesAtivo = isFlagAtivo(incluirTodosClientes)

    // Em producao, GET /chats nunca anexa a base inteira de clientes por padrao.
    // Clientes sem conversa entram apenas em busca explicita e paginada.
    const incluirTodosClientesDefault = false
    const palavraTrim = palavra && String(palavra).trim() ? String(palavra).trim() : ''
    // B01: com termo de busca, não restringir por aba/chip de estado (comportamento tipo WhatsApp).
    // Mantém filtros avançados explícitos (tag, setor, datas, atendente_id).
    const searchBypassesStateFilters = Boolean(palavraTrim)

    const aguardandoClienteAtivo = searchBypassesStateFilters ? false : aguardandoClienteRawAtivo
    const aguardandoAtendenteAtivo = searchBypassesStateFilters ? false : aguardandoAtendenteRawAtivo
    const pagamentoPendenteAtivo = searchBypassesStateFilters ? false : pagamentoPendenteRawAtivo
    const emAtrasoAtivo = searchBypassesStateFilters ? false : emAtrasoRawAtivo
    const hojeAtivo = searchBypassesStateFilters ? false : hojeRawAtivo
    const minhaFilaAtiva = searchBypassesStateFilters ? false : minhaFilaRawAtiva
    const tempoParadoHoras = searchBypassesStateFilters ? null : tempoParadoHorasRaw
    const filtroAusenciaLista = searchBypassesStateFilters ? false : filtroAusenciaListaRaw

    const isFinanceiroUser = await usuarioPertenceSetorFinanceiro(departamento_ids, company_id)

    if ((pagamentoPendenteAtivo || emAtrasoAtivo) && !isFinanceiroUser) {
      return sendEmptyChatListResponse(false)
    }

    const statusNorm =
      searchBypassesStateFilters
        ? null
        : !minhaFilaAtiva &&
            !pagamentoPendenteAtivo &&
            !emAtrasoAtivo &&
            !hojeAtivo &&
            status_atendimento != null &&
            String(status_atendimento).trim() !== ''
          ? String(status_atendimento).toLowerCase().trim()
          : null

    /** Inteiro positivo (usuarios.id). UUID não é coluna de atendente_id na conversa — rejeitar valores não inteiros. */
    let filtroAtendenteInformado = null
    if (atendente_id != null && String(atendente_id).trim() !== '') {
      const trimmed = String(atendente_id).trim()
      const num = Number(trimmed)
      if (!Number.isInteger(num) || num <= 0) {
        return res.status(400).json({
          error:
            'atendente_id deve ser o id inteiro positivo referente a usuarios.id. Este parâmetro não aceita UUID nem texto arbitrário.',
        })
      }
      filtroAtendenteInformado = num
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
      separarMensagensDisparadasEmpresa,
      atendimentoModoSimplesEmpresa,
      unreadMap,
      [conversaIdsTransferidas, conversaIdsParticipanteAtivo],
      grupoIdsPermitidosPorDepartamento,
      grupoIdsSemDepartamento,
    ] = await Promise.all([
      supabase
        .from('empresas')
        .select('separar_mensagens_disparadas')
        .eq('id', company_id)
        .maybeSingle()
        .then(({ data }) => !!data?.separar_mensagens_disparadas)
        .catch(() => false),
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
      const [convByNomeIds, { data: convByTelefone }, idsFromMsg] = await Promise.all([
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
      ])

      isTextSearch = true
      // Faixa prioritária: match em nome/pushname/telefone (RPC + telefone direto).
      const priorityIds = new Set(
        [
          ...convByNomeIds,
          ...(convByTelefone || []).map((c) => c.id),
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
        !aguardandoClienteAtivo &&
        !aguardandoAtendenteAtivo &&
        !pagamentoPendenteAtivo &&
        !emAtrasoAtivo &&
        !hojeAtivo &&
        (!statusNorm || !separarMensagensDisparadasEmpresa)
      ) {
        q = q.or('tipo.eq.grupo,status_atendimento.neq.mensagem_disparada,status_atendimento.is.null')
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
      // Atendente: vê TODAS as conversas (pode assumir, transferir, responder qualquer uma)
      // Admin/supervisor: filtro opcional por atendente_id — sem filtro implícito de status; exclui grupos (conversas "assumidas" são individuais)
      if (!minhaFilaAtiva && !isAtendente && filtroAtendenteInformado != null) {
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
          const livreOuMeu = c.atendente_id == null || Number(c.atendente_id) === Number(user_id)
          return c.exibir_badge_aberta && livreOuMeu
        }
        return false
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

exports.contarConversasPorFiltros = async (req, res) => {
  try {
    const counts = await getChatFilterCounts(req)
    return res.json(counts)
  } catch (err) {
    console.error('[contarConversasPorFiltros]', err)
    return res.status(500).json({ error: 'Erro ao contar conversas' })
  }
}

module.exports = {
  listarConversas: exports.listarConversas,
  contarConversasPorFiltros: exports.contarConversasPorFiltros,
}
