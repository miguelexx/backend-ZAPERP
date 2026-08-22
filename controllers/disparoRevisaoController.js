/**
 * Controller de Revisão Final — módulo Disparo de Mensagens (Etapa 6).
 * Checklist, prévia, confirmação, histórico e exportação.
 * Nunca envia mensagens / nunca chama UltraMSG.
 */

const supabase = require('../config/supabase')
const {
  statusPermiteEdicao,
  statusPermiteVoltarEdicao,
  mensagemBloqueioEdicao,
  statusEstaCongelado,
} = require('../helpers/disparoStatusHelper')
const {
  DECLARACAO_AUTORIZACAO,
  montarChecklist,
  mascararTelefone,
  montarPayloadHash,
  hashConfig,
} = require('../helpers/disparoRevisaoChecklist')
const {
  simularDuracao,
  efetivarConfigInstancia,
  FUSO_PADRAO,
} = require('../helpers/disparoLimitesHelper')
const { _substituirVariaveis: substituirVariaveis } = require('./disparoVariacoesController')
const { revalidarInstanciasConectadas } = require('./disparoLimitesController')

// ─── Constantes de seleção ───────────────────────────────────────────────────

const CAMPANHA_SELECT = [
  'id', 'company_id', 'nome', 'descricao', 'status',
  'criado_por', 'criado_em', 'atualizado_em',
  'versao_atual', 'config_hash', 'confirmada_em', 'confirmada_por',
  'autorizacao_aceita_em', 'autorizacao_texto',
  'distribuicao_modo', 'distribuicao_confirmada', 'distribuicao_revisao',
  'variacao_modo', 'variacao_confirmada', 'variacao_revisao', 'variacao_padrao_valores',
  'limites_confirmados', 'limites_revisao',
].join(', ')

const DEST_SELECT = [
  'id', 'nome', 'telefone_normalizado', 'origem',
  'instancia_id', 'variacao_id', 'status', 'variaveis',
].join(', ')

const VARIACAO_SELECT = [
  'id', 'campanha_id', 'nome', 'tipo_mensagem', 'texto', 'legenda',
  'midia_storage_key', 'midia_url_disco', 'midia_nome_original', 'midia_mime', 'midia_tamanho',
  'ordem', 'ativa',
].join(', ')

const LIMITES_SELECT = [
  'id', 'company_id', 'campanha_id', 'perfil', 'limite_total',
  'limite_por_hora', 'limite_por_dia', 'intervalo_min_sec', 'intervalo_max_sec',
  'lote_tamanho', 'pausa_lote_min_sec', 'pausa_lote_max_sec',
  'fuso_horario', 'inicio_modo', 'agendado_para', 'data_limite',
  'confirmada', 'revisao',
].join(', ')

const INST_LIMITES_SELECT = [
  'id', 'company_id', 'campanha_id', 'instancia_id', 'herdar_global',
  'limite_por_hora', 'limite_por_dia', 'intervalo_min_sec', 'intervalo_max_sec',
  'lote_tamanho', 'pausa_lote_min_sec', 'pausa_lote_max_sec', 'janelas_proprias',
].join(', ')

const JANELAS_SELECT = [
  'id', 'company_id', 'campanha_id', 'instancia_id',
  'dia_semana', 'hora_inicio', 'hora_fim', 'ativo',
].join(', ')

const REVISAO_LIST_SELECT = [
  'id', 'versao', 'hash', 'status', 'resumo', 'quantidades', 'checklist_resumo',
  'avisos_aceitos', 'declaracao_texto', 'confirmado_por', 'confirmado_em', 'confirmado_ip',
  'invalidada_em', 'invalidada_por', 'motivo_invalidacao', 'criado_em',
].join(', ')

const TIPOS_COM_MIDIA = new Set(['imagem', 'video', 'audio', 'documento'])
const PREVIEW_MAX = 280
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 200

// ─── Helpers locais ────────────────────────────────────────────────────────────

function positiveInt(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

function requireAdmin(req, res) {
  if (String(req.user?.perfil ?? '').toLowerCase() !== 'admin') {
    res.status(403).json({ error: 'Acesso restrito a administradores.' })
    return false
  }
  return true
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || '')
    .toString()
    .split(',')[0]
    .trim()
    .slice(0, 80)
}

async function carregarCampanha(campanhaId, companyId, res) {
  const { data, error } = await supabase
    .from('disparo_campanhas')
    .select(CAMPANHA_SELECT)
    .eq('id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!data) {
    res.status(404).json({ error: 'Campanha não encontrada.' })
    return null
  }
  return data
}

function truncatePreview(text, max = PREVIEW_MAX) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

function normalizarChaveVar(chave) {
  return String(chave ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
}

function extrairVariaveisUsadas(texto) {
  const regex = /\{\{([^{}]{1,100})\}\}/g
  const vars = new Set()
  let m
  while ((m = regex.exec(texto || '')) !== null) {
    const chave = normalizarChaveVar(m[1])
    if (chave) vars.add(chave)
  }
  return [...vars]
}

function buildMidiaUrlRelativa(variacao) {
  if (variacao?.midia_storage_key) {
    return `/media/r2/${variacao.midia_storage_key}`
  }
  if (variacao?.midia_url_disco) {
    return `/uploads/${variacao.midia_url_disco}`
  }
  return null
}

function formatarMidiaMeta(variacao) {
  if (!variacao) return null
  const temMidia = variacao.midia_storage_key || variacao.midia_url_disco
  if (!temMidia) return null
  return {
    nome: variacao.midia_nome_original ?? null,
    mime: variacao.midia_mime ?? null,
    tamanho: variacao.midia_tamanho ?? null,
    url_relativa: buildMidiaUrlRelativa(variacao),
  }
}

function formatarVariacaoPreview(v) {
  const tipo = v.tipo_mensagem || 'texto'
  let texto = v.texto ?? ''
  let legenda = v.legenda ?? ''
  if (tipo !== 'texto' && !legenda && texto) {
    legenda = texto
    texto = ''
  }
  return {
    id: v.id,
    nome: v.nome,
    tipo_mensagem: tipo,
    texto_preview: truncatePreview(tipo === 'texto' ? texto : ''),
    legenda_preview: truncatePreview(tipo !== 'texto' ? legenda : ''),
    midia: formatarMidiaMeta(v),
    ativa: v.ativa !== false,
    ordem: v.ordem,
  }
}

function separarJanelas(janelas) {
  const globais = []
  const porInstancia = {}
  for (const j of janelas ?? []) {
    if (j.instancia_id == null) {
      globais.push(j)
    } else {
      const key = String(j.instancia_id)
      if (!porInstancia[key]) porInstancia[key] = []
      porInstancia[key].push(j)
    }
  }
  return { globais, porInstancia }
}

function resolverConteudoVariacao(variacao) {
  if (!variacao) return { texto: '', legenda: '', tipo: 'texto' }
  const tipo = variacao.tipo_mensagem || 'texto'
  let texto = variacao.texto ?? ''
  let legenda = variacao.legenda ?? ''
  if (tipo !== 'texto' && !legenda && texto) {
    legenda = texto
    texto = ''
  }
  if (tipo === 'texto') legenda = ''
  return { texto, legenda, tipo }
}

function variavelTemValor(chave, destinatario, padrao) {
  if (chave === 'nome') return Boolean(String(destinatario.nome ?? '').trim())
  if (chave === 'telefone') return Boolean(String(destinatario.telefone_normalizado ?? '').trim())
  const vars = destinatario.variaveis ?? {}
  const val = vars[chave] ?? padrao?.[chave] ?? padrao?.[normalizarChaveVar(chave)]
  return val !== undefined && val !== null && String(val).trim() !== ''
}

// ─── Carregamento de dados ─────────────────────────────────────────────────────

async function carregarLimitesGlobais(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_limites')
    .select(LIMITES_SELECT)
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function carregarOverridesInstancia(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_instancia_limites')
    .select(INST_LIMITES_SELECT)
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
  if (error) throw error
  return data ?? []
}

async function carregarJanelas(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_janelas')
    .select(JANELAS_SELECT)
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .order('dia_semana', { ascending: true })
    .order('hora_inicio', { ascending: true })
  if (error) throw error
  return data ?? []
}

async function carregarInstanciasCampanha(campanhaId, companyId) {
  const { data: configs, error: cErr } = await supabase
    .from('disparo_campanha_instancias')
    .select('instancia_id, ordem, ativa')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .order('ordem', { ascending: true })
  if (cErr) throw cErr

  const ids = (configs ?? []).map((c) => c.instancia_id).filter(Boolean)
  if (!ids.length) return []

  const { data: wa, error: wErr } = await supabase
    .from('whatsapp_instances')
    .select('id, nome, status, ativo, display_phone, telefone_conectado')
    .in('id', ids)
    .eq('company_id', companyId)
  if (wErr) throw wErr

  const waMap = (wa ?? []).reduce((m, i) => {
    m[i.id] = i
    return m
  }, {})

  return (configs ?? []).map((c) => {
    const inst = waMap[c.instancia_id] ?? {}
    return {
      instancia_id: c.instancia_id,
      ordem: c.ordem,
      ativa_na_campanha: c.ativa,
      id: inst.id ?? c.instancia_id,
      nome: inst.nome ?? `#${c.instancia_id}`,
      status: inst.status ?? 'unknown',
      ativo: inst.ativo ?? false,
      display_phone: inst.display_phone ?? inst.telefone_conectado ?? null,
      conectada: inst.status === 'connected' && inst.ativo === true,
    }
  })
}

async function carregarCriadorNome(userId) {
  if (!userId) return null
  const { data } = await supabase
    .from('usuarios')
    .select('id, nome')
    .eq('id', userId)
    .maybeSingle()
  return data?.nome ?? null
}

async function montarDestinatariosPorInstancia(campanhaId, companyId) {
  const { data: rows, error } = await supabase
    .from('disparo_campanha_destinatarios')
    .select('instancia_id')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .neq('status', 'excluido')
  if (error) throw error

  const contagem = (rows ?? []).reduce((m, r) => {
    if (!r.instancia_id) return m
    m.set(r.instancia_id, (m.get(r.instancia_id) ?? 0) + 1)
    return m
  }, new Map())

  const ids = [...contagem.keys()]
  let nomes = {}
  if (ids.length) {
    const { data: inst } = await supabase
      .from('whatsapp_instances')
      .select('id, nome')
      .in('id', ids)
      .eq('company_id', companyId)
    nomes = (inst ?? []).reduce((m, i) => {
      m[i.id] = i.nome
      return m
    }, {})
  }

  return [...contagem.entries()].map(([instancia_id, quantidade]) => ({
    instancia_id,
    nome: nomes[instancia_id] ?? `#${instancia_id}`,
    quantidade,
  }))
}

async function executarSimulacao(campanhaId, companyId) {
  const [globalCfg, overrides, janelas, destinatariosPorInstancia] = await Promise.all([
    carregarLimitesGlobais(campanhaId, companyId),
    carregarOverridesInstancia(campanhaId, companyId),
    carregarJanelas(campanhaId, companyId),
    montarDestinatariosPorInstancia(campanhaId, companyId),
  ])

  if (!globalCfg) {
    return {
      ok: false,
      erros: ['Limites não configurados.'],
      avisos: [],
      instancias: [],
      resumo: null,
    }
  }

  const { globais, porInstancia } = separarJanelas(janelas)
  const overridesByInst = (overrides ?? []).reduce((m, o) => {
    m[o.instancia_id] = o
    return m
  }, {})

  return simularDuracao({
    destinatariosPorInstancia,
    globalCfg,
    overridesByInst,
    janelasGlobais: globais,
    janelasByInst: porInstancia,
  })
}

async function localizarConflitos(campanhaId, companyId) {
  const { data: campInst, error: ciErr } = await supabase
    .from('disparo_campanha_instancias')
    .select('instancia_id')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
  if (ciErr) throw ciErr

  const instanciaIds = [...new Set((campInst ?? []).map((r) => r.instancia_id).filter(Boolean))]
  if (!instanciaIds.length) {
    return { conflitos: [], conflito_impeditivo: false, avisos: [] }
  }

  const { data: outrasInst, error: oiErr } = await supabase
    .from('disparo_campanha_instancias')
    .select('instancia_id, campanha_id')
    .eq('company_id', companyId)
    .in('instancia_id', instanciaIds)
    .neq('campanha_id', campanhaId)
  if (oiErr) throw oiErr

  const outrasCampanhaIds = [...new Set((outrasInst ?? []).map((r) => r.campanha_id))]
  if (!outrasCampanhaIds.length) {
    return { conflitos: [], conflito_impeditivo: false, avisos: [] }
  }

  const [{ data: campanhas }, { data: limites }] = await Promise.all([
    supabase
      .from('disparo_campanhas')
      .select('id, nome, status, limites_confirmados')
      .in('id', outrasCampanhaIds)
      .eq('company_id', companyId),
    supabase
      .from('disparo_campanha_limites')
      .select('campanha_id, inicio_modo, agendado_para')
      .in('campanha_id', outrasCampanhaIds)
      .eq('company_id', companyId),
  ])

  const campMap = (campanhas ?? []).reduce((m, c) => {
    m[c.id] = c
    return m
  }, {})
  const limMap = (limites ?? []).reduce((m, l) => {
    m[l.campanha_id] = l
    return m
  }, {})

  const conflitos = []
  const avisos = []
  const statusRelevantes = new Set(['em_execucao', 'agendada', 'pronta'])

  for (const row of outrasInst ?? []) {
    const camp = campMap[row.campanha_id]
    if (!camp) continue

    const lim = limMap[row.campanha_id] ?? {}
    const status = camp.status
    const limitesConfirmados = camp.limites_confirmados === true
    const inicioModo = lim.inicio_modo ?? 'imediato'

    const emExecucao = status === 'em_execucao'
    const agendada = status === 'agendada'
    const pronta = status === 'pronta'
    const confirmadaAgendada =
      limitesConfirmados && inicioModo === 'agendado' && !emExecucao && !agendada && !pronta

    if (!emExecucao && !agendada && !pronta && !confirmadaAgendada) continue
    if (!statusRelevantes.has(status) && !confirmadaAgendada) continue

    let tipo = 'confirmada'
    if (emExecucao) tipo = 'em_execucao'
    else if (agendada) tipo = 'agendada'
    else if (pronta) tipo = 'pronta'

    conflitos.push({
      instancia_id: row.instancia_id,
      campanha_id: camp.id,
      campanha_nome: camp.nome,
      status: camp.status,
      agendado_para: lim.agendado_para ?? null,
      inicio_modo: inicioModo,
      tipo,
    })
  }

  const conflito_impeditivo = conflitos.some(
    (c) => c.tipo === 'em_execucao' || c.tipo === 'agendada',
  )
  if (conflitos.some((c) => c.tipo === 'pronta' || c.tipo === 'confirmada')) {
    avisos.push('Existem outras campanhas confirmadas ou prontas usando a mesma instância.')
  }

  return { conflitos, conflito_impeditivo, avisos }
}

function contarVarsAusentes(destinatarios, variacoes, padraoValores) {
  const ativas = (variacoes ?? []).filter((v) => v.ativa !== false)
  const varsPorVariacao = new Map()

  for (const v of ativas) {
    const { texto, legenda } = resolverConteudoVariacao(v)
    const vars = new Set([
      ...extrairVariaveisUsadas(texto),
      ...extrairVariaveisUsadas(legenda),
    ])
    varsPorVariacao.set(v.id, vars)
  }

  let count = 0
  for (const d of destinatarios ?? []) {
    if (d.status === 'excluido') continue
    if (!d.variacao_id) continue
    const vars = varsPorVariacao.get(d.variacao_id)
    if (!vars?.size) continue
    for (const chave of vars) {
      if (!variavelTemValor(chave, d, padraoValores)) count += 1
    }
  }
  return count
}

function detectarMidiasInvalidas(variacoes) {
  const invalidas = []
  for (const v of variacoes ?? []) {
    if (v.ativa === false) continue
    const tipo = v.tipo_mensagem || 'texto'
    if (!TIPOS_COM_MIDIA.has(tipo)) continue
    if (v.midia_storage_key || v.midia_url_disco) continue
    invalidas.push({
      variacao_id: v.id,
      variacao_nome: v.nome,
      tipo_mensagem: tipo,
      motivo: `Variação "${v.nome}" (${tipo}) sem mídia anexada.`,
    })
  }
  return invalidas
}

function montarStatsDestinatarios(destinatarios) {
  const ativos = (destinatarios ?? []).filter((d) => d.status !== 'excluido')
  return {
    total: ativos.length,
    contato_salvo: ativos.filter((d) => d.origem === 'contato_salvo').length,
    importacao: ativos.filter((d) => d.origem === 'importacao_planilha').length,
    manuais: ativos.filter((d) => d.origem === 'manual').length,
    sem_instancia: ativos.filter((d) => !d.instancia_id).length,
    sem_variacao: ativos.filter((d) => !d.variacao_id).length,
  }
}

function montarInstanciasResumo(instancias, destinatarios, overrides, janelas, limites) {
  const { globais, porInstancia } = separarJanelas(janelas)
  const overridesByInst = (overrides ?? []).reduce((m, o) => {
    m[o.instancia_id] = o
    return m
  }, {})
  const qtdPorInst = (destinatarios ?? [])
    .filter((d) => d.status !== 'excluido')
    .reduce((m, d) => {
      if (!d.instancia_id) return m
      m.set(d.instancia_id, (m.get(d.instancia_id) ?? 0) + 1)
      return m
    }, new Map())

  return (instancias ?? []).map((inst) => {
    const cfg = limites
      ? efetivarConfigInstancia(limites, overridesByInst[inst.instancia_id])
      : null
    const janelasInst =
      cfg?.janelas_proprias && porInstancia[String(inst.instancia_id)]?.length
        ? porInstancia[String(inst.instancia_id)]
        : globais

    return {
      instancia_id: inst.instancia_id,
      nome: inst.nome,
      status: inst.status,
      ativo: inst.ativo,
      conectada: inst.conectada,
      display_phone: inst.display_phone,
      destinatarios: qtdPorInst.get(inst.instancia_id) ?? 0,
      limites_efetivos: cfg
        ? {
            limite_por_hora: cfg.limite_por_hora,
            limite_por_dia: cfg.limite_por_dia,
            intervalo_min_sec: cfg.intervalo_min_sec,
            intervalo_max_sec: cfg.intervalo_max_sec,
            lote_tamanho: cfg.lote_tamanho,
            pausa_lote_min_sec: cfg.pausa_lote_min_sec,
            pausa_lote_max_sec: cfg.pausa_lote_max_sec,
            janelas_proprias: cfg.janelas_proprias,
          }
        : null,
      janelas: janelasInst,
    }
  })
}

function montarMensagensResumo(variacoes, destinatarios) {
  const qtdPorVar = (destinatarios ?? [])
    .filter((d) => d.status !== 'excluido')
    .reduce((m, d) => {
      if (!d.variacao_id) return m
      m.set(d.variacao_id, (m.get(d.variacao_id) ?? 0) + 1)
      return m
    }, new Map())

  return (variacoes ?? [])
    .filter((v) => v.ativa !== false)
    .map((v) => ({
      ...formatarVariacaoPreview(v),
      quantidade_destinatarios: qtdPorVar.get(v.id) ?? 0,
    }))
}

function montarResumoAuditoria(ctx) {
  const { campanha, instancias, variacoes, limites, janelas, destinatarios, simulacao, conflitos } = ctx
  const stats = montarStatsDestinatarios(destinatarios)
  const { globais } = separarJanelas(janelas)

  return {
    campanha_id: campanha.id,
    nome: campanha.nome,
    status: campanha.status,
    distribuicao_modo: campanha.distribuicao_modo,
    variacao_modo: campanha.variacao_modo,
    instancia_ids: (instancias ?? []).map((i) => i.instancia_id),
    variacao_ids: (variacoes ?? []).filter((v) => v.ativa !== false).map((v) => v.id),
    total_destinatarios: stats.total,
    limites: limites
      ? {
          perfil: limites.perfil,
          limite_por_hora: limites.limite_por_hora,
          limite_por_dia: limites.limite_por_dia,
          intervalo_min_sec: limites.intervalo_min_sec,
          intervalo_max_sec: limites.intervalo_max_sec,
          inicio_modo: limites.inicio_modo,
          agendado_para: limites.agendado_para ?? null,
          fuso_horario: limites.fuso_horario ?? FUSO_PADRAO,
        }
      : null,
    janelas_globais: globais.map((j) => ({
      dia_semana: j.dia_semana,
      hora_inicio: j.hora_inicio,
      hora_fim: j.hora_fim,
      ativo: j.ativo !== false,
    })),
    previsao: simulacao?.resumo ?? null,
    conflitos_count: (conflitos?.conflitos ?? []).length,
  }
}

function construirHashConfig(ctx) {
  const { campanha, campanhaId, companyId, instancias, variacoes, limites, janelas, destinatarios } = ctx
  const ativos = (destinatarios ?? []).filter((d) => d.status !== 'excluido')
  const { globais } = separarJanelas(janelas)

  const payload = montarPayloadHash({
    campanhaId,
    companyId,
    nome: campanha.nome,
    instanciaIds: (instancias ?? []).map((i) => i.instancia_id),
    variacaoIds: (variacoes ?? []).filter((v) => v.ativa !== false).map((v) => v.id),
    limites,
    janelas: globais,
    totalDest: ativos.length,
    distribuicaoModo: campanha.distribuicao_modo,
    variacaoModo: campanha.variacao_modo,
  })

  return { payload, hash: hashConfig(payload) }
}

function avisosAceitosValidos(checklist, body = {}) {
  const avisos = checklist.avisos ?? []
  if (!avisos.length) return { ok: true }

  if (body.ciencia_avisos === true) return { ok: true }

  const codigosEsperados = avisos.map((a) => a.codigo)
  const aceitos = Array.isArray(body.avisos_aceitos) ? body.avisos_aceitos.map(String) : []
  const faltando = codigosEsperados.filter((c) => !aceitos.includes(c))

  if (faltando.length) {
    return {
      ok: false,
      error: 'É necessário registrar ciência dos avisos antes de confirmar.',
      avisos_pendentes: faltando,
    }
  }
  return { ok: true }
}

function montarHorariosEstimados(simulacao, destinatariosOrdenados) {
  if (!simulacao?.ok || !simulacao?.instancias?.length) return null

  const porInst = simulacao.instancias.reduce((m, linha) => {
    m.set(linha.instancia_id, linha)
    return m
  }, new Map())

  const indicesPorInst = new Map()
  const horarios = new Map()

  for (const dest of destinatariosOrdenados) {
    if (!dest.instancia_id) {
      horarios.set(dest.id, null)
      continue
    }
    const linha = porInst.get(dest.instancia_id)
    if (!linha?.inicio || !linha?.fim || !linha.quantidade) {
      horarios.set(dest.id, 'Estimativa disponível após simulação')
      continue
    }

    const idx = indicesPorInst.get(dest.instancia_id) ?? 0
    indicesPorInst.set(dest.instancia_id, idx + 1)

    const inicioMs = Date.parse(linha.inicio)
    const fimMs = Date.parse(linha.fim)
    if (!Number.isFinite(inicioMs) || !Number.isFinite(fimMs) || linha.quantidade <= 0) {
      horarios.set(dest.id, 'Estimativa disponível após simulação')
      continue
    }

    const duracaoTotal = fimMs - inicioMs
    const intervalo = duracaoTotal / linha.quantidade
    const estimado = new Date(inicioMs + intervalo * idx)
    horarios.set(dest.id, estimado.toISOString())
  }

  return horarios
}

// ─── Contexto central da revisão ───────────────────────────────────────────────

async function carregarContextoRevisao(campanhaId, companyId) {
  const [
    campanha,
    destinatarios,
    instancias,
    variacoes,
    limites,
    janelas,
    overrides,
    conflitos,
    instCheck,
  ] = await Promise.all([
    supabase
      .from('disparo_campanhas')
      .select(CAMPANHA_SELECT)
      .eq('id', campanhaId)
      .eq('company_id', companyId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) throw error
        return data
      }),
    supabase
      .from('disparo_campanha_destinatarios')
      .select(DEST_SELECT)
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .neq('status', 'excluido')
      .then(({ data, error }) => {
        if (error) throw error
        return data ?? []
      }),
    carregarInstanciasCampanha(campanhaId, companyId),
    supabase
      .from('disparo_campanha_variacoes')
      .select(VARIACAO_SELECT)
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .order('ordem', { ascending: true })
      .order('id', { ascending: true })
      .then(({ data, error }) => {
        if (error) throw error
        return data ?? []
      }),
    carregarLimitesGlobais(campanhaId, companyId),
    carregarJanelas(campanhaId, companyId),
    carregarOverridesInstancia(campanhaId, companyId),
    localizarConflitos(campanhaId, companyId),
    revalidarInstanciasConectadas(campanhaId, companyId),
  ])

  if (!campanha) return null

  const criador = await carregarCriadorNome(campanha.criado_por)

  const instanciasStatus = (instancias ?? []).map((i) => ({
    id: i.id,
    nome: i.nome,
    status: i.status,
    ativo: i.ativo,
  }))

  const padraoValores = campanha.variacao_padrao_valores ?? {}
  const varsAusentesCount = contarVarsAusentes(destinatarios, variacoes, padraoValores)
  const midiasInvalidas = detectarMidiasInvalidas(variacoes)

  let simulacao = null
  if (limites) {
    try {
      simulacao = await executarSimulacao(campanhaId, companyId)
    } catch (err) {
      console.error('[disparo:revisao] simulacao', err)
      simulacao = { ok: false, erros: ['Falha ao simular duração.'], avisos: [], resumo: null }
    }
  }

  return {
    campanhaId,
    companyId,
    campanha,
    criadorNome: criador,
    destinatarios,
    instancias,
    instanciasStatus,
    instCheck,
    variacoes,
    limites,
    janelas,
    overrides,
    conflitos,
    varsAusentesCount,
    midiasInvalidas,
    simulacao,
  }
}

function montarChecklistDoContexto(ctx, req, opts = {}) {
  const autorizacaoAceita =
    opts.autorizacaoAceita === true ||
    Boolean(ctx.campanha?.autorizacao_aceita_em)

  return montarChecklist({
    companyIdToken: ctx.companyId,
    campanha: ctx.campanha,
    isAdmin: String(req.user?.perfil ?? '').toLowerCase() === 'admin',
    destinatarios: ctx.destinatarios,
    instanciasStatus: ctx.instanciasStatus,
    variacoes: ctx.variacoes,
    limites: ctx.limites,
    janelas: ctx.janelas,
    conflitos: ctx.conflitos,
    midiasInvalidas: ctx.midiasInvalidas,
    varsAusentesCount: ctx.varsAusentesCount,
    autorizacaoAceita,
  })
}

function montarRespostaRevisao(ctx, req, opts = {}) {
  const checklist = montarChecklistDoContexto(ctx, req, opts)
  const stats = montarStatsDestinatarios(ctx.destinatarios)
  const { globais } = separarJanelas(ctx.janelas)

  return {
    campanha: {
      id: ctx.campanha.id,
      nome: ctx.campanha.nome,
      descricao: ctx.campanha.descricao ?? null,
      status: ctx.campanha.status,
      criador: ctx.criadorNome,
      criado_em: ctx.campanha.criado_em,
      atualizado_em: ctx.campanha.atualizado_em,
      versao_atual: ctx.campanha.versao_atual ?? 0,
      config_hash: ctx.campanha.config_hash ?? null,
      confirmada_em: ctx.campanha.confirmada_em ?? null,
      autorizacao_aceita_em: ctx.campanha.autorizacao_aceita_em ?? null,
    },
    inicio: {
      modo: ctx.limites?.inicio_modo ?? 'imediato',
      agendado_para: ctx.limites?.agendado_para ?? null,
      fuso: ctx.limites?.fuso_horario ?? FUSO_PADRAO,
      data_limite: ctx.limites?.data_limite ?? null,
    },
    previsao: ctx.simulacao?.resumo ?? null,
    destinatarios: stats,
    instancias: montarInstanciasResumo(
      ctx.instancias,
      ctx.destinatarios,
      ctx.overrides,
      ctx.janelas,
      ctx.limites,
    ),
    mensagens: montarMensagensResumo(ctx.variacoes, ctx.destinatarios),
    planejamento: {
      janelas_globais: globais,
      fuso: ctx.limites?.fuso_horario ?? FUSO_PADRAO,
      simulacao: ctx.simulacao
        ? {
            ok: ctx.simulacao.ok,
            resumo: ctx.simulacao.resumo,
            avisos: ctx.simulacao.avisos,
            erros: ctx.simulacao.erros,
            instancias: (ctx.simulacao.instancias ?? []).map((i) => ({
              instancia_id: i.instancia_id,
              nome: i.nome,
              quantidade: i.quantidade,
              inicio: i.inicio,
              fim: i.fim,
              duracao_horas: i.duracao_horas,
            })),
          }
        : null,
      conflitos: ctx.conflitos,
    },
    checklist,
    bloqueado: statusEstaCongelado(ctx.campanha.status),
    pode_voltar_edicao: statusPermiteVoltarEdicao(ctx.campanha.status),
    declaracao_texto: DECLARACAO_AUTORIZACAO,
    instancias_revalidacao: ctx.instCheck,
  }
}

function csvEscape(val) {
  const s = val == null ? '' : String(val)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function montarCsvResumo(exportObj) {
  const linhas = []
  linhas.push(['campo', 'valor'].join(','))
  const flat = {
    campanha_id: exportObj.campanha?.id,
    campanha_nome: exportObj.campanha?.nome,
    campanha_status: exportObj.campanha?.status,
    versao_atual: exportObj.campanha?.versao_atual,
    config_hash: exportObj.campanha?.config_hash,
    total_destinatarios: exportObj.destinatarios?.total,
    inicio_modo: exportObj.inicio?.modo,
    agendado_para: exportObj.inicio?.agendado_para,
    fuso: exportObj.inicio?.fuso,
    conclusao_aproximada: exportObj.previsao?.conclusao_aproximada ?? '',
    checklist_ok: exportObj.checklist?.ok,
    bloqueios: exportObj.checklist?.totais?.bloqueios,
    avisos: exportObj.checklist?.totais?.avisos,
  }
  for (const [k, v] of Object.entries(flat)) {
    linhas.push([csvEscape(k), csvEscape(v)].join(','))
  }
  return `${linhas.join('\n')}\n`
}

// ─── 1. Obter revisão ──────────────────────────────────────────────────────────

exports.obterRevisao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const ctx = await carregarContextoRevisao(campanhaId, companyId)
    if (!ctx) return res.status(404).json({ error: 'Campanha não encontrada.' })

    const autorizacaoAceita = Boolean(ctx.campanha.autorizacao_aceita_em)
    res.json(montarRespostaRevisao(ctx, req, { autorizacaoAceita }))
  } catch (err) {
    console.error('[disparo:revisao] obterRevisao', err)
    res.status(500).json({ error: 'Erro ao carregar revisão da campanha.' })
  }
}

// ─── 2. Validar revisão ────────────────────────────────────────────────────────

exports.validarRevisao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const ctx = await carregarContextoRevisao(campanhaId, companyId)
    if (!ctx) return res.status(404).json({ error: 'Campanha não encontrada.' })

    const autorizacaoAceita = req.body?.autorizacao_aceita === true
    const checklist = montarChecklistDoContexto(ctx, req, { autorizacaoAceita })

    res.json({
      ok: checklist.ok,
      checklist,
      totais: checklist.totais,
    })
  } catch (err) {
    console.error('[disparo:revisao] validarRevisao', err)
    res.status(500).json({ error: 'Erro ao validar revisão.' })
  }
}

// ─── 3. Prévia de destinatários ────────────────────────────────────────────────

exports.previaDestinatarios = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const page = Math.max(1, positiveInt(req.query.page) ?? 1)
    const limit = Math.min(MAX_PAGE_LIMIT, positiveInt(req.query.limit) ?? DEFAULT_PAGE_LIMIT)
    const offset = (page - 1) * limit
    const filtroInst = positiveInt(req.query.instancia_id)
    const filtroVar = positiveInt(req.query.variacao_id)

    let query = supabase
      .from('disparo_campanha_destinatarios')
      .select(DEST_SELECT, { count: 'exact' })
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .neq('status', 'excluido')
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1)

    if (filtroInst) query = query.eq('instancia_id', filtroInst)
    if (filtroVar) query = query.eq('variacao_id', filtroVar)

    const { data: destinatarios, error, count } = await query
    if (error) throw error

    const variacaoIds = [...new Set((destinatarios ?? []).map((d) => d.variacao_id).filter(Boolean))]
    const instanciaIds = [...new Set((destinatarios ?? []).map((d) => d.instancia_id).filter(Boolean))]

    const [variacoesRes, instanciasRes, simulacao] = await Promise.all([
      variacaoIds.length
        ? supabase
            .from('disparo_campanha_variacoes')
            .select(VARIACAO_SELECT)
            .in('id', variacaoIds)
            .eq('campanha_id', campanhaId)
            .eq('company_id', companyId)
        : Promise.resolve({ data: [] }),
      instanciaIds.length
        ? supabase
            .from('whatsapp_instances')
            .select('id, nome')
            .in('id', instanciaIds)
            .eq('company_id', companyId)
        : Promise.resolve({ data: [] }),
      executarSimulacao(campanhaId, companyId).catch((e) => {
        console.error('[disparo:revisao] previa simulacao', e)
        return null
      }),
    ])

    const varMap = (variacoesRes.data ?? []).reduce((m, v) => {
      m[v.id] = v
      return m
    }, {})
    const instMap = (instanciasRes.data ?? []).reduce((m, i) => {
      m[i.id] = i
      return m
    }, {})

    const padrao = campanha.variacao_padrao_valores ?? {}
    const horarios = montarHorariosEstimados(simulacao, destinatarios ?? [])

    const itens = (destinatarios ?? []).map((dest) => {
      const variacao = dest.variacao_id ? varMap[dest.variacao_id] : null
      const { texto, legenda, tipo } = resolverConteudoVariacao(variacao)
      const mensagemFinal = substituirVariaveis(tipo === 'texto' ? texto : '', dest, padrao)
      const legendaFinal = substituirVariaveis(tipo !== 'texto' ? legenda : '', dest, padrao)

      return {
        id: dest.id,
        nome: dest.nome,
        telefone_mascarado: mascararTelefone(dest.telefone_normalizado),
        instancia_id: dest.instancia_id,
        instancia_nome: dest.instancia_id ? instMap[dest.instancia_id]?.nome ?? `#${dest.instancia_id}` : null,
        variacao_id: dest.variacao_id,
        variacao_nome: variacao?.nome ?? null,
        tipo_mensagem: tipo,
        mensagem_final: mensagemFinal,
        legenda_final: legendaFinal || null,
        midia: formatarMidiaMeta(variacao),
        horario_estimado: horarios?.get(dest.id) ?? 'Estimativa disponível após simulação',
      }
    })

    res.json({
      page,
      limit,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / limit) || 0,
      itens,
    })
  } catch (err) {
    console.error('[disparo:revisao] previaDestinatarios', err)
    res.status(500).json({ error: 'Erro ao gerar prévia de destinatários.' })
  }
}

// ─── 4. Confirmar campanha ─────────────────────────────────────────────────────

exports.confirmarCampanha = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = req.user?.id ?? null
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    // Validação antecipada do body (antes do contexto completo) — evita 500 opaco
    if (req.body?.autorizacao_aceita !== true) {
      return res.status(422).json({ error: 'É necessário aceitar a declaração de autorização.' })
    }

    const campanhaPre = await carregarCampanha(campanhaId, companyId, res)
    if (!campanhaPre) return

    const confirmacaoTexto = String(req.body?.confirmacao_texto ?? '').trim()
    if (confirmacaoTexto !== campanhaPre.nome && confirmacaoTexto !== 'CONFIRMAR') {
      return res.status(422).json({
        error: 'Texto de confirmação inválido. Informe o nome exato da campanha ou CONFIRMAR.',
      })
    }

    const ctx = await carregarContextoRevisao(campanhaId, companyId)
    if (!ctx) return res.status(404).json({ error: 'Campanha não encontrada.' })

    const { campanha } = ctx

    if (!statusPermiteEdicao(campanha.status)) {
      if (
        (campanha.status === 'pronta' || campanha.status === 'agendada') &&
        campanha.config_hash
      ) {
        const { hash: hashAtual } = construirHashConfig(ctx)
        if (hashAtual === campanha.config_hash) {
          return res.json({
            ok: true,
            idempotente: true,
            versao: campanha.versao_atual ?? 0,
            hash: campanha.config_hash,
            status: campanha.status,
          })
        }
      }
      return res.status(422).json({
        error: mensagemBloqueioEdicao(campanha.status),
        status: campanha.status,
      })
    }

    const checklist = montarChecklistDoContexto(ctx, req, { autorizacaoAceita: true })
    if (!checklist.ok) {
      return res.status(422).json({
        error: 'A campanha possui bloqueios que impedem a confirmação.',
        bloqueios: checklist.bloqueios,
        checklist,
      })
    }

    const avisosCheck = avisosAceitosValidos(checklist, req.body ?? {})
    if (!avisosCheck.ok) {
      return res.status(422).json({
        error: avisosCheck.error,
        avisos_pendentes: avisosCheck.avisos_pendentes,
        checklist,
      })
    }

    const { hash } = construirHashConfig(ctx)
    const proximaVersao = (campanha.versao_atual ?? 0) + 1
    const agora = new Date().toISOString()
    const ip = getClientIp(req)
    const avisosAceitos = Array.isArray(req.body?.avisos_aceitos)
      ? req.body.avisos_aceitos.map(String)
      : req.body?.ciencia_avisos === true
        ? (checklist.avisos ?? []).map((a) => a.codigo)
        : []

    const novoStatus =
      ctx.limites?.inicio_modo === 'agendado' ? 'agendada' : 'pronta'

    const resumo = montarResumoAuditoria(ctx)
    const quantidades = montarStatsDestinatarios(ctx.destinatarios)

    const { data: revisao, error: revErr } = await supabase
      .from('disparo_campanha_revisoes')
      .insert({
        company_id: companyId,
        campanha_id: campanhaId,
        versao: proximaVersao,
        hash,
        status: 'ativa',
        resumo,
        quantidades,
        checklist_resumo: {
          ok: checklist.ok,
          totais: checklist.totais,
          bloqueios: checklist.bloqueios.map((b) => b.codigo),
          avisos: checklist.avisos.map((a) => a.codigo),
        },
        avisos_aceitos: avisosAceitos,
        declaracao_texto: DECLARACAO_AUTORIZACAO,
        confirmado_por: userId,
        confirmado_em: agora,
        confirmado_ip: ip,
      })
      .select('id, versao, hash, status')
      .single()
    if (revErr) throw revErr

    await supabase
      .from('disparo_campanha_revisoes')
      .update({
        status: 'invalidada',
        invalidada_em: agora,
        invalidada_por: userId,
        motivo_invalidacao: `Substituída pela versão ${proximaVersao}`,
      })
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .eq('status', 'ativa')
      .neq('id', revisao.id)

    const { error: updErr } = await supabase
      .from('disparo_campanhas')
      .update({
        status: novoStatus,
        versao_atual: proximaVersao,
        config_hash: hash,
        confirmada_em: agora,
        confirmada_por: userId,
        autorizacao_aceita_em: agora,
        autorizacao_texto: DECLARACAO_AUTORIZACAO,
        atualizado_em: agora,
      })
      .eq('id', campanhaId)
      .eq('company_id', companyId)
    if (updErr) throw updErr

    res.json({
      ok: true,
      status: novoStatus,
      versao: proximaVersao,
      hash,
      revisao_id: revisao.id,
    })
  } catch (err) {
    console.error('[disparo:revisao] confirmarCampanha', err)
    res.status(500).json({ error: 'Erro ao confirmar campanha.' })
  }
}

// ─── 5. Histórico de revisões ──────────────────────────────────────────────────

exports.historicoRevisoes = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const { data, error } = await supabase
      .from('disparo_campanha_revisoes')
      .select(REVISAO_LIST_SELECT)
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .order('versao', { ascending: false })
    if (error) throw error

    res.json({
      campanha_id: campanhaId,
      versao_atual: campanha.versao_atual ?? 0,
      revisoes: data ?? [],
    })
  } catch (err) {
    console.error('[disparo:revisao] historicoRevisoes', err)
    res.status(500).json({ error: 'Erro ao carregar histórico de revisões.' })
  }
}

// ─── 6. Voltar para edição ─────────────────────────────────────────────────────

exports.voltarEdicao = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = req.user?.id ?? null
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    if (!statusPermiteVoltarEdicao(campanha.status)) {
      return res.status(422).json({
        error: 'Não é possível voltar para edição nesta fase da campanha.',
        status: campanha.status,
      })
    }

    if (req.body?.confirmacao !== true) {
      return res.status(422).json({ error: 'Confirmação explícita é necessária (confirmacao: true).' })
    }

    const agora = new Date().toISOString()
    const motivo =
      String(req.body?.motivo ?? '').trim().slice(0, 500) ||
      'Administrador solicitou retorno à edição.'

    await supabase
      .from('disparo_campanha_revisoes')
      .update({
        status: 'invalidada',
        invalidada_em: agora,
        invalidada_por: userId,
        motivo_invalidacao: motivo,
      })
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .eq('status', 'ativa')

    const { error: updErr } = await supabase
      .from('disparo_campanhas')
      .update({
        status: 'configurando',
        confirmada_em: null,
        confirmada_por: null,
        autorizacao_aceita_em: null,
        autorizacao_texto: null,
        distribuicao_revisao: true,
        variacao_revisao: true,
        limites_revisao: true,
        atualizado_em: agora,
      })
      .eq('id', campanhaId)
      .eq('company_id', companyId)
    if (updErr) throw updErr

    res.json({
      ok: true,
      status: 'configurando',
      mensagem:
        'Confirmação invalidada. As etapas de instâncias, mensagens e limites precisam ser revisadas antes de uma nova confirmação.',
      versao_historico: campanha.versao_atual ?? 0,
      config_hash_historico: campanha.config_hash ?? null,
      motivo,
    })
  } catch (err) {
    console.error('[disparo:revisao] voltarEdicao', err)
    res.status(500).json({ error: 'Erro ao voltar campanha para edição.' })
  }
}

// ─── 7. Exportar resumo ────────────────────────────────────────────────────────

exports.exportarResumo = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const ctx = await carregarContextoRevisao(campanhaId, companyId)
    if (!ctx) return res.status(404).json({ error: 'Campanha não encontrada.' })

    const format = String(req.query.format ?? 'json').toLowerCase() === 'csv' ? 'csv' : 'json'
    const resposta = montarRespostaRevisao(ctx, req, {
      autorizacaoAceita: Boolean(ctx.campanha.autorizacao_aceita_em),
    })

    const exportObj = {
      exportado_em: new Date().toISOString(),
      campanha: resposta.campanha,
      inicio: resposta.inicio,
      previsao: resposta.previsao,
      destinatarios: resposta.destinatarios,
      instancias: (resposta.instancias ?? []).map((i) => ({
        instancia_id: i.instancia_id,
        nome: i.nome,
        status: i.status,
        destinatarios: i.destinatarios,
        limites_efetivos: i.limites_efetivos,
      })),
      mensagens: resposta.mensagens,
      planejamento: {
        fuso: resposta.planejamento.fuso,
        conflitos: resposta.planejamento.conflitos,
        simulacao_resumo: resposta.planejamento.simulacao?.resumo ?? null,
      },
      checklist: {
        ok: resposta.checklist.ok,
        totais: resposta.checklist.totais,
        bloqueios: resposta.checklist.bloqueios.map((b) => ({
          codigo: b.codigo,
          titulo: b.titulo,
          detalhe: b.detalhe,
        })),
        avisos: resposta.checklist.avisos.map((a) => ({
          codigo: a.codigo,
          titulo: a.titulo,
          detalhe: a.detalhe,
        })),
      },
    }

    if (format === 'csv') {
      const csv = montarCsvResumo({ ...exportObj, checklist: resposta.checklist })
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="disparo-revisao-${campanhaId}.csv"`,
      )
      return res.send(csv)
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.json(exportObj)
  } catch (err) {
    console.error('[disparo:revisao] exportarResumo', err)
    res.status(500).json({ error: 'Erro ao exportar resumo da revisão.' })
  }
}

// ─── 8. Estado de bloqueio ─────────────────────────────────────────────────────

exports.estadoBloqueio = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    res.json({
      congelada: statusEstaCongelado(campanha.status),
      status: campanha.status,
      pode_editar: statusPermiteEdicao(campanha.status),
      pode_voltar_edicao: statusPermiteVoltarEdicao(campanha.status),
      versao_atual: campanha.versao_atual ?? 0,
      config_hash: campanha.config_hash ?? null,
      confirmada_em: campanha.confirmada_em ?? null,
      mensagem_bloqueio: statusPermiteEdicao(campanha.status)
        ? null
        : mensagemBloqueioEdicao(campanha.status),
    })
  } catch (err) {
    console.error('[disparo:revisao] estadoBloqueio', err)
    res.status(500).json({ error: 'Erro ao consultar estado de bloqueio.' })
  }
}

// ─── Exports para testes ───────────────────────────────────────────────────────

exports._montarChecklist = montarChecklist
exports.DECLARACAO_AUTORIZACAO = DECLARACAO_AUTORIZACAO
exports._carregarContextoRevisao = carregarContextoRevisao
exports._construirHashConfig = construirHashConfig
