const supabase = require('../config/supabase')
const { usuarioPertenceSetorFinanceiro } = require('../helpers/financeiroSetorHelper')
const {
  buildTelefoneSearchOr,
  buildPhoneSearchTerms,
  escapeIlikePattern,
  getSearchMessagesPageSize,
  getChatSearchScanLimit,
  getChatSearchIdLimit,
} = require('../helpers/chatSearchHelper')
const {
  buscarConversaIdsPorNomesVinculados,
} = require('../helpers/clienteNomesVinculados')
const {
  getGrupoIdsPorDepartamentos,
  getGrupoIdsSemDepartamento,
  pushNonGroupVisibilityParts,
  pushAllowedGroupIdsPart,
} = require('../helpers/departamentoGruposHelper')

function parseBooleanQuery(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true'
}

function getChatFilterIdLimit() {
  const raw = Number(process.env.CHAT_FILTER_ID_LIMIT)
  if (!Number.isFinite(raw) || raw <= 0) return 2000
  return Math.min(Math.max(Math.floor(raw), 100), 5000)
}


function getStartOfTodayIso() {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return now.toISOString()
}

function getEndOfTodayIso() {
  const now = new Date()
  now.setHours(23, 59, 59, 999)
  return now.toISOString()
}

function deveIncluirGruposSemDepartamentoNoFiltroTodos({
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
}) {
  return (
    !isAdmin &&
    !filter_dep_id &&
    filtroAtendenteInformado == null &&
    !minhaFilaAtiva &&
    !aguardandoClienteAtivo &&
    !aguardandoAtendenteAtivo &&
    !pagamentoPendenteAtivo &&
    !emAtrasoAtivo &&
    !hojeAtivo &&
    !statusNorm
  )
}

function parseConversaIdsQuery(raw) {
  if (raw == null || String(raw).trim() === '') return []
  return [
    ...new Set(
      String(raw)
        .split(/[,;\s]+/)
        .map((x) => Number(String(x).trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ]
}

function isConversaAtendentesMissingTable(error) {
  const msg = String(error?.message || error || '').toLowerCase()
  const code = String(error?.code || '')
  return (
    code === '42P01' ||
    code === '42501' ||
    code === 'PGRST205' ||
    (msg.includes('conversa_atendentes') &&
      (msg.includes('does not exist') ||
        msg.includes('could not find') ||
        msg.includes('schema cache') ||
        msg.includes('permission denied'))) ||
    msg.includes('permission denied for table conversa_atendentes')
  )
}

async function getConversaIdsParticipanteAtivo(company_id, usuario_id) {
  if (company_id == null || usuario_id == null) return []
  const limit = getChatFilterIdLimit()
  const { data, error } = await supabase
    .from('conversa_atendentes')
    .select('conversa_id')
    .eq('company_id', Number(company_id))
    .eq('usuario_id', Number(usuario_id))
    .eq('ativo', true)
    .order('criado_em', { ascending: false })
    .limit(limit)
  if (error) {
    if (isConversaAtendentesMissingTable(error)) return []
    throw error
  }
  return [...new Set((data || []).map((row) => Number(row.conversa_id)).filter((n) => Number.isFinite(n) && n > 0))]
}

async function buscarConversaIdsPorTextoMensagens({ company_id, term }) {
  const pageSize = getSearchMessagesPageSize()
  const scanLimit = getChatSearchScanLimit()
  const idLimit = getChatSearchIdLimit()
  const ids = new Set()
  // term chega sem wildcards; construímos aqui (uniforme com chatController)
  const likePattern = `%${escapeIlikePattern(term)}%`

  for (let start = 0; start < scanLimit && ids.size < idLimit; start += pageSize) {
    const end = Math.min(start + pageSize - 1, scanLimit - 1)
    const { data, error } = await supabase
      .from('mensagens')
      .select('conversa_id')
      .eq('company_id', Number(company_id))
      .ilike('texto', likePattern)
      .order('criado_em', { ascending: false })
      .order('id', { ascending: false })
      .range(start, end)
    if (error) break
    for (const row of data || []) {
      if (row?.conversa_id != null) ids.add(Number(row.conversa_id))
      if (ids.size >= idLimit) break
    }
    if (!data || data.length < (end - start + 1)) break
  }
  return [...ids]
}

/**
 * Resolve escopo compartilhado (tags, busca, transferências, empresa) para contagens e total da lista.
 */
async function resolveChatListCountsContext(req) {
  const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user || {}
  const role = String(perfil || '').toLowerCase()
  const isAdmin = role === 'admin'
  const isAtendente = role === 'atendente'
  const q = req.query || {}

  const tag_id = q.tag_id
  const data_inicio = q.data_inicio
  const data_fim = q.data_fim
  const palavra = q.palavra
  const filter_dep_id = q.departamento_id
  const atendente_id = q.atendente_id

  let filtroAtendenteInformado = null
  if (atendente_id != null && String(atendente_id).trim() !== '') {
    const num = Number(String(atendente_id).trim())
    if (Number.isInteger(num) && num > 0) filtroAtendenteInformado = num
  }

  let separarMensagensDisparadasEmpresa = false
  let atendimentoModoSimplesEmpresa = false
  try {
    const { data: empSep } = await supabase
      .from('empresas')
      .select('separar_mensagens_disparadas, atendimento_modo_simples')
      .eq('id', company_id)
      .maybeSingle()
    separarMensagensDisparadasEmpresa = !!empSep?.separar_mensagens_disparadas
    atendimentoModoSimplesEmpresa = !!empSep?.atendimento_modo_simples
  } catch (_) {}

  const isFinanceiro = await usuarioPertenceSetorFinanceiro(departamento_ids, company_id)

  let conversaIdsTransferidas = []
  let conversaIdsParticipanteAtivo = []
  if (!isAdmin) {
    const transferLimit = getChatFilterIdLimit()
    const { data: transferRows } = await supabase
      .from('atendimentos')
      .select('conversa_id')
      .eq('company_id', company_id)
      .eq('de_usuario_id', user_id)
      .eq('acao', 'transferiu')
      .order('criado_em', { ascending: false })
      .limit(transferLimit)
    conversaIdsTransferidas = [...new Set((transferRows || []).map((r) => Number(r.conversa_id)).filter(Boolean))]
    conversaIdsParticipanteAtivo = await getConversaIdsParticipanteAtivo(company_id, user_id)
  }

  let grupoIdsPermitidosPorDepartamento = []
  if (!isAdmin) {
    grupoIdsPermitidosPorDepartamento = await getGrupoIdsPorDepartamentos(company_id, departamento_ids)
  } else if (filter_dep_id) {
    grupoIdsPermitidosPorDepartamento = await getGrupoIdsPorDepartamentos(company_id, [filter_dep_id])
  }
  const grupoIdsSemDepartamento =
    !isAdmin && !filter_dep_id ? await getGrupoIdsSemDepartamento(company_id) : []

  let grupoUnreadIdsAguardando = []
  let unreadMap = {}
  if (atendimentoModoSimplesEmpresa) {
    const {
      obterUnreadMap,
      resolveGrupoIdsComUnreadParaUsuario,
    } = require('../helpers/modoSimplesGrupoUnread')
    unreadMap = await obterUnreadMap({ company_id, usuario_id: user_id })
    grupoUnreadIdsAguardando = await resolveGrupoIdsComUnreadParaUsuario({
      company_id,
      unreadMap,
    })
  }

  const tagFilterAtivo =
    tag_id != null &&
    String(tag_id).trim() !== '' &&
    String(tag_id).trim().toLowerCase() !== 'todas'

  let conversaIdsFilter = null
  let forceEmptyConversas = false

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
    if (ids.length === 0) forceEmptyConversas = true
    else conversaIdsFilter = ids
  }

  const palavraTrim = palavra && String(palavra).trim() ? String(palavra).trim() : ''
  if (palavraTrim) {
    const searchIdLimit = getChatSearchIdLimit()
    const phoneVariacoes = buildPhoneSearchTerms(palavraTrim)

    // Idêntico ao chatController: 3 branches paralelas, RPC unaccent para nomes
    const [convByNomeIds, convByTelefone, idsFromMsg, idsPorVinculo] = await Promise.all([
      supabase
        .rpc('buscar_conversas_por_nome_ids', {
          p_company_id: Number(company_id),
          p_termo: palavraTrim,
          p_phone_variacoes: phoneVariacoes.length ? phoneVariacoes : null,
          p_limit: searchIdLimit,
        })
        .then(({ data, error }) => {
          if (error) console.warn('[counts-busca-nome] RPC error:', error.message)
          return Array.isArray(data) ? data : []
        }),
      supabase
        .from('conversas')
        .select('id')
        .eq('company_id', company_id)
        .or(buildTelefoneSearchOr(palavraTrim))
        .order('ultima_atividade', { ascending: false, nullsFirst: false })
        .limit(searchIdLimit),
      String(process.env.CHAT_SEARCH_INCLUDE_MESSAGE_TEXT ?? '').trim() === '1'
        ? buscarConversaIdsPorTextoMensagens({ company_id, term: palavraTrim })
        : Promise.resolve([]),
      buscarConversaIdsPorNomesVinculados(supabase, company_id, palavraTrim, searchIdLimit),
    ])

    const mergedSet = new Set([
      ...convByNomeIds,
      ...(convByTelefone.data || []).map((c) => c.id),
      ...idsFromMsg,
      ...(idsPorVinculo || []),
    ])
    if (mergedSet.size === 0) {
      forceEmptyConversas = true
    } else {
      conversaIdsFilter = conversaIdsFilter
        ? conversaIdsFilter.filter((id) => mergedSet.has(id))
        : [...mergedSet]
      if (conversaIdsFilter.length === 0) forceEmptyConversas = true
    }
  }

  return {
    company_id,
    user_id,
    isAdmin,
    isAtendente,
    departamento_ids,
    filter_dep_id,
    filtroAtendenteInformado,
    conversaIdsTransferidas,
    conversaIdsParticipanteAtivo: Array.isArray(conversaIdsParticipanteAtivo) ? conversaIdsParticipanteAtivo : [],
    grupoIdsPermitidosPorDepartamento,
    grupoIdsSemDepartamento,
    conversaIdsFilter,
    forceEmptyConversas,
    data_inicio,
    data_fim,
    separarMensagensDisparadasEmpresa,
    atendimentoModoSimplesEmpresa,
    isFinanceiro,
    grupoUnreadIdsAguardando,
    unreadMap,
  }
}

/**
 * Aplica filtros SQL espelhando buildQuery de listarConversas.
 * @param {object} overrides — minha_fila, hoje, status_atendimento, aguardando_cliente, pagamento_pendente, em_atraso, finalizacao_motivo
 */
function applyChatListSqlFilters(query, ctx, overrides = {}) {
  const {
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
  } = ctx

  const minhaFilaAtiva = overrides.minha_fila === true
  const campanhasAtiva = overrides.campanhas === true
  const hojeAtivo = overrides.hoje === true
  const aguardandoClienteAtivo = overrides.aguardando_cliente === true
  const aguardandoAtendenteAtivo = overrides.aguardando_atendente === true
  const pagamentoPendenteAtivo = overrides.pagamento_pendente === true
  const emAtrasoAtivo = overrides.em_atraso === true
  const filtroAusenciaLista =
    String(overrides.finalizacao_motivo || '').trim().toLowerCase() === 'ausencia_cliente'

  const statusNorm =
    !minhaFilaAtiva &&
    !campanhasAtiva &&
    !pagamentoPendenteAtivo &&
    !emAtrasoAtivo &&
    !hojeAtivo &&
    overrides.status_atendimento != null &&
    String(overrides.status_atendimento).trim() !== ''
      ? String(overrides.status_atendimento).toLowerCase().trim()
      : null

  let q = query.eq('company_id', company_id)

  if (!isAdmin) {
    const depIds = Array.isArray(departamento_ids)
      ? departamento_ids.filter((id) => id != null && Number.isFinite(Number(id)))
      : []
    const parts = []
    if (depIds.length > 0) {
      pushNonGroupVisibilityParts(parts, 'departamento_id', depIds)
    }
    parts.push('and(departamento_id.is.null,tipo.is.null)', 'and(departamento_id.is.null,tipo.neq.grupo)')
    pushNonGroupVisibilityParts(parts, 'atendente_id', [user_id])
    pushAllowedGroupIdsPart(parts, grupoIdsPermitidosPorDepartamento)
    if (deveIncluirGruposSemDepartamentoNoFiltroTodos({
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
    })) {
      pushAllowedGroupIdsPart(parts, grupoIdsSemDepartamento)
    }
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
  } else if (overrides.conversa_ids && overrides.conversa_ids.length > 0) {
    q = q.in('id', overrides.conversa_ids)
  } else if (conversaIdsFilter && conversaIdsFilter.length > 0) {
    q = q.in('id', conversaIdsFilter)
  }

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

  if (campanhasAtiva) {
    q = q.or('tipo.is.null,tipo.neq.grupo')
    q = q.eq('aguardando_resposta_campanha', true)
  } else if (minhaFilaAtiva) {
    q = q.or('tipo.is.null,tipo.neq.grupo')
    q = q.or(
      `status_atendimento.eq.aberta,and(status_atendimento.eq.em_atendimento,atendente_id.eq.${user_id}),and(status_atendimento.eq.aguardando_cliente,atendente_id.eq.${user_id}),and(status_atendimento.eq.pagamento_pendente,atendente_id.eq.${user_id}),and(status_atendimento.eq.em_atraso,atendente_id.eq.${user_id})${conversaIdsParticipanteAtivo.length > 0 ? `,and(status_atendimento.in.(em_atendimento,aguardando_cliente,pagamento_pendente,em_atraso),id.in.(${conversaIdsParticipanteAtivo.join(',')}))` : ''}`
    )
  } else if (pagamentoPendenteAtivo) {
    q = q.eq('status_atendimento', 'pagamento_pendente')
    q = q.not('atendente_id', 'is', null)
    if (isAtendente) {
      q = conversaIdsParticipanteAtivo.length > 0
        ? q.or(`atendente_id.eq.${Number(user_id)},id.in.(${conversaIdsParticipanteAtivo.join(',')})`)
        : q.eq('atendente_id', Number(user_id))
    }
    else if (filtroAtendenteInformado != null) q = q.eq('atendente_id', Number(filtroAtendenteInformado))
  } else if (emAtrasoAtivo) {
    q = q.eq('status_atendimento', 'em_atraso')
    q = q.not('atendente_id', 'is', null)
    if (isAtendente) {
      q = conversaIdsParticipanteAtivo.length > 0
        ? q.or(`atendente_id.eq.${Number(user_id)},id.in.(${conversaIdsParticipanteAtivo.join(',')})`)
        : q.eq('atendente_id', Number(user_id))
    }
    else if (filtroAtendenteInformado != null) q = q.eq('atendente_id', Number(filtroAtendenteInformado))
  } else if (statusNorm === 'mensagem_disparada') {
    q = q.eq('status_atendimento', 'mensagem_disparada')
    q = q.neq('tipo', 'grupo')
  } else if (statusNorm) {
    if (statusNorm === 'em_atendimento' && !isAtendente) {
      q = q.or('tipo.eq.grupo,status_atendimento.eq.em_atendimento,status_atendimento.eq.aguardando_cliente')
    } else {
      q = q.or(`tipo.eq.grupo,status_atendimento.eq.${statusNorm}`)
    }
  }

  if (!campanhasAtiva && (minhaFilaAtiva || statusNorm === 'aberta')) {
    q = q.eq('aguardando_resposta_campanha', false)
  }

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

  if (aguardandoClienteAtivo) {
    if (ctx.atendimentoModoSimplesEmpresa) {
      q = q.eq('modo_simples_aguardando', 'cliente')
    } else {
      q = q.or(
        'and(status_atendimento.eq.em_atendimento,aguardando_cliente_desde.not.is.null),status_atendimento.eq.aguardando_cliente'
      )
      q = q.not('atendente_id', 'is', null)
    }
    if (!ctx.atendimentoModoSimplesEmpresa) {
      if (isAtendente) {
        q = conversaIdsParticipanteAtivo.length > 0
          ? q.or(`atendente_id.eq.${Number(user_id)},id.in.(${conversaIdsParticipanteAtivo.join(',')})`)
          : q.eq('atendente_id', Number(user_id))
      }
      else if (filtroAtendenteInformado != null) q = q.eq('atendente_id', Number(filtroAtendenteInformado))
    }
  }

  if (aguardandoAtendenteAtivo) {
    if (ctx.atendimentoModoSimplesEmpresa) {
      const { applyAguardandoAtendenteModoSimplesQuery } = require('../helpers/modoSimplesGrupoUnread')
      q = applyAguardandoAtendenteModoSimplesQuery(q, ctx.grupoUnreadIdsAguardando || [])
    } else {
      q = q.in('id', [0])
    }
  }

  if (filtroAusenciaLista) {
    q = q.or('finalizacao_motivo.eq.ausencia_cliente,finalizada_automaticamente.eq.true')
    if (!statusNorm) q = q.eq('status_atendimento', 'fechada')
  }

  return q
}

function isGroupConversationRow(row) {
  return String(row?.tipo || '').trim().toLowerCase() === 'grupo'
}

function rowHasMessage(row) {
  return Array.isArray(row?.mensagens) && row.mensagens.length > 0
}

function rowVisibleInPostFilteredList(row, ctx, overrides = {}) {
  if (!row) return false
  const isGroup = isGroupConversationRow(row)

  const status = String(row.status_atendimento || '').trim().toLowerCase()
  const atendenteId = row.atendente_id != null ? Number(row.atendente_id) : null
  const userId = ctx?.user_id != null ? Number(ctx.user_id) : null
  const participanteSet = new Set((ctx?.conversaIdsParticipanteAtivo || []).map(Number))
  const vinculadaAoUsuario =
    (Number.isFinite(atendenteId) && Number.isFinite(userId) && atendenteId === userId) ||
    participanteSet.has(Number(row.id))
  const filtroAtendente =
    ctx?.filtroAtendenteInformado != null ? Number(ctx.filtroAtendenteInformado) : null

  if (overrides.minha_fila === true) {
    if (isGroup) return false
    if (row.aguardando_resposta_campanha === true) return false
    if (['em_atendimento', 'aguardando_cliente', 'pagamento_pendente', 'em_atraso'].includes(status)) {
      return vinculadaAoUsuario
    }
    if (status === 'aberta') {
      const livreOuMeu = atendenteId == null || (Number.isFinite(userId) && atendenteId === userId)
      return livreOuMeu && (rowHasMessage(row) || atendenteId != null)
    }
    return false
  }

  if (overrides.aguardando_atendente === true) {
    if (!ctx?.atendimentoModoSimplesEmpresa) return false
    const unread =
      ctx?.unreadMap && ctx.unreadMap[Number(row.id)] != null
        ? Number(ctx.unreadMap[Number(row.id)])
        : 0
    const { rowAguardandoAtendenteModoSimples } = require('../helpers/modoSimplesGrupoUnread')
    return rowAguardandoAtendenteModoSimples(row, unread)
  }

  if (overrides.status_atendimento === 'aberta') {
    if (isGroup) return rowHasMessage(row)
    if (row.aguardando_resposta_campanha === true) return false
    return status === 'aberta' && (rowHasMessage(row) || atendenteId != null)
  }

  if (overrides.status_atendimento === 'em_atendimento' && !overrides.aguardando_cliente) {
    if (isGroup) return false
    if (ctx?.isAtendente) return status === 'em_atendimento' && vinculadaAoUsuario
    if (filtroAtendente != null && atendenteId !== filtroAtendente) return false
    return status === 'em_atendimento' || status === 'aguardando_cliente'
  }

  return true
}

function countNeedsPostListRules(overrides = {}, ctx = {}) {
  if (overrides.aguardando_atendente === true && ctx?.atendimentoModoSimplesEmpresa) {
    return false
  }
  return (
    overrides.minha_fila === true ||
    overrides.status_atendimento === 'aberta' ||
    overrides.status_atendimento === 'em_atendimento'
  )
}

async function countConversasWithPostListRules(ctx, overrides = {}) {
  const pageSize = Math.min(getChatFilterIdLimit(), 1000)
  const maxRows = getChatFilterIdLimit()
  let total = 0

  for (let from = 0; from < maxRows; from += pageSize) {
    const to = Math.min(from + pageSize - 1, maxRows - 1)
    let q = supabase
      .from('conversas')
      .select('id, tipo, status_atendimento, atendente_id, aguardando_resposta_campanha, mensagens ( id )')

    q = applyChatListSqlFilters(q, ctx, overrides)
      .order('ultima_atividade', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .order('criado_em', { ascending: false, referencedTable: 'mensagens' })
      .limit(1, { referencedTable: 'mensagens' })
      .range(from, to)
    const { data, error } = await q
    if (error) throw error

    const rows = Array.isArray(data) ? data : []
    total += rows.filter((row) => rowVisibleInPostFilteredList(row, ctx, overrides)).length
    if (rows.length < pageSize) break
  }

  return total
}

async function countConversasWithFilter(ctx, overrides = {}) {
  if (ctx.forceEmptyConversas) return 0
  if (overrides.status_atendimento === 'mensagem_disparada' && !ctx.separarMensagensDisparadasEmpresa) {
    return 0
  }
  if ((overrides.pagamento_pendente || overrides.em_atraso) && !ctx.isFinanceiro) {
    return 0
  }
  if (countNeedsPostListRules(overrides, ctx)) {
    return countConversasWithPostListRules(ctx, overrides)
  }

  let q = supabase.from('conversas').select('id', { count: 'exact', head: true })
  q = applyChatListSqlFilters(q, ctx, overrides)
  const { count, error } = await q
  if (error) throw error
  return Number(count) || 0
}

async function countConversasTransferidas(ctx) {
  if (ctx.forceEmptyConversas) return 0

  const limit = getChatFilterIdLimit()
  let q = supabase
    .from('atendimentos')
    .select('conversa_id')
    .eq('company_id', ctx.company_id)
    .eq('acao', 'transferiu')
    .order('criado_em', { ascending: false })
    .limit(limit)

  if (!ctx.isAdmin && ctx.user_id != null) {
    q = q.eq('para_usuario_id', ctx.user_id)
  } else if (ctx.filtroAtendenteInformado != null) {
    q = q.eq('para_usuario_id', ctx.filtroAtendenteInformado)
  }

  const { data, error } = await q
  if (error) throw error
  const ids = [...new Set((data || []).map((r) => Number(r.conversa_id)).filter((n) => Number.isFinite(n) && n > 0))]
  if (!ids.length) return 0
  return countConversasWithFilter(ctx, { conversa_ids: ids })
}

/**
 * Deriva overrides do filtro ativo a partir da query GET /chats (para total_count da listagem).
 */
function overridesFromListQuery(query = {}) {
  const explicitIds = parseConversaIdsQuery(query.conversa_ids)
  if (query.conversa_ids != null && String(query.conversa_ids).trim() !== '' && explicitIds.length === 0) {
    return { conversa_ids: [0] }
  }
  if (explicitIds.length > 0) {
    return { conversa_ids: explicitIds }
  }

  const minhaFilaAtiva = parseBooleanQuery(query.minha_fila)
  const aguardandoClienteAtivo = parseBooleanQuery(query.aguardando_cliente)
  const aguardandoAtendenteAtivo = parseBooleanQuery(query.aguardando_atendente)
  const pagamentoPendenteAtivo = parseBooleanQuery(query.pagamento_pendente)
  const emAtrasoAtivo = parseBooleanQuery(query.em_atraso)
  const hojeAtivo = parseBooleanQuery(query.hoje)
  const filtroAusenciaLista =
    String(query.finalizacao_motivo || '').trim().toLowerCase() === 'ausencia_cliente'

  if (minhaFilaAtiva) return { minha_fila: true }
  if (parseBooleanQuery(query.campanhas)) return { campanhas: true }
  if (aguardandoAtendenteAtivo) return { aguardando_atendente: true }
  if (hojeAtivo) return { hoje: true }
  if (aguardandoClienteAtivo) return { aguardando_cliente: true }
  if (pagamentoPendenteAtivo) return { pagamento_pendente: true }
  if (emAtrasoAtivo) return { em_atraso: true }
  if (filtroAusenciaLista) {
    return { status_atendimento: 'fechada', finalizacao_motivo: 'ausencia_cliente' }
  }
  const status =
    query.status_atendimento != null && String(query.status_atendimento).trim() !== ''
      ? String(query.status_atendimento).trim().toLowerCase()
      : null
  if (status) return { status_atendimento: status }
  return {}
}

function getChatCountsTimeoutMs() {
  const raw = Number(process.env.CHAT_COUNTS_TIMEOUT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return 20000
  return Math.min(Math.max(Math.floor(raw), 3000), 50000)
}

function withTimeout(promise, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return promise
  let settled = false
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const err = new Error('Timeout ao contar conversas')
      err.code = 'CHAT_COUNTS_TIMEOUT'
      reject(err)
    }, timeoutMs)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}
async function getChatFilterCounts(req) {
  const timeoutMs = getChatCountsTimeoutMs()
  return withTimeout((async () => {
    const ctx = await resolveChatListCountsContext(req)
    const counts = await Promise.all([
      countConversasWithFilter(ctx, {}),
      countConversasWithFilter(ctx, { minha_fila: true }),
      countConversasWithFilter(ctx, { hoje: true }),
      countConversasWithFilter(ctx, { status_atendimento: 'aberta' }),
      countConversasWithFilter(ctx, { status_atendimento: 'em_atendimento' }),
      countConversasWithFilter(ctx, { status_atendimento: 'fechada' }),
      countConversasWithFilter(ctx, {
        status_atendimento: 'fechada',
        finalizacao_motivo: 'ausencia_cliente',
      }),
      countConversasWithFilter(ctx, { aguardando_cliente: true }),
      ctx.atendimentoModoSimplesEmpresa
        ? countConversasWithFilter(ctx, { aguardando_atendente: true })
        : Promise.resolve(0),
      countConversasWithFilter(ctx, { pagamento_pendente: true }),
      countConversasWithFilter(ctx, { em_atraso: true }),
      countConversasTransferidas(ctx),
      ctx.separarMensagensDisparadasEmpresa
        ? countConversasWithFilter(ctx, { status_atendimento: 'mensagem_disparada' })
        : Promise.resolve(0),
      countConversasWithFilter(ctx, { campanhas: true }),
    ])

    return {
      total: counts[0],
      minha_fila: counts[1],
      hoje: counts[2],
      abertas: counts[3],
      em_atendimento: counts[4],
      finalizadas: counts[5],
      por_ausencia: counts[6],
      aguardando_cliente: counts[7],
      aguardando_atendente: counts[8],
      pagamentos_pendentes: counts[9],
      em_atraso: counts[10],
      transferidos: counts[11],
      mensagens_disparadas: counts[12],
      campanhas: counts[13],
      // aguardando_funcionario vem de GET /supervisao/resumo no frontend
      aguardando: counts[7],
      atraso: counts[10],
    }
  })(), timeoutMs)
}

module.exports = {
  resolveChatListCountsContext,
  applyChatListSqlFilters,
  countConversasWithFilter,
  overridesFromListQuery,
  rowVisibleInPostFilteredList,
  parseConversaIdsQuery,
  getChatFilterCounts,
  getChatCountsTimeoutMs,
  withTimeout,
  getStartOfTodayIso,
  getEndOfTodayIso,
}
