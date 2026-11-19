'use strict'

/**
 * Ranking gamificado de atendentes — competição semanal por empresa.
 * Doc: docs/ai-handoff/42-RANKING-GAMIFICADO.md
 *
 * Princípios:
 * - NÃO existe contador próprio. A contagem lê `atendimentos` (acao='encerrou', por
 *   de_usuario_id) — a mesma fonte/regra do "Finalizadas hoje" da Supervisão.
 * - Ciclo = intervalo semiaberto [inicio, fim) no tempo absoluto; a regra (dia/horário/fuso)
 *   é congelada no nascimento do ciclo. Mudar a config vale para o PRÓXIMO ciclo.
 * - Encerramento atômico: UPDATE … WHERE status='em_andamento' RETURNING. Só quem "ganha"
 *   esse UPDATE anuncia — reinício, duas abas ou scheduler + request não anunciam duas vezes.
 * - Resultado consolidado (snapshot) no encerramento: apagar conversa depois não muda o passado.
 * - Toda query filtra company_id (SERVICE_ROLE bypassa RLS).
 * - Tabelas ausentes (migration não aplicada) → ranking "indisponível", nunca 500/crash.
 */

const supabase = require('../../config/supabase')
const { getEmpresaTimezone } = require('../../helpers/empresaTimezone')
const {
  calcularFimDoCiclo,
  montarClassificacao,
  normalizarDiaSemana,
  normalizarHorario,
  descreverEncerramento,
} = require('./rankingRegras')

const T_CONFIG = 'ranking_config'
const T_CICLOS = 'ranking_ciclos'
const PAGE = 1000
const CACHE_TTL_MS = 15 * 1000
/** Crash entre "encerrar" e "abrir o próximo": retoma do fim anterior se foi há menos disso. */
const JANELA_CONTINUIDADE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ENCERRAMENTOS_POR_RODADA = 12
const EVENTO_VENCEDOR = 'ranking:vencedor'
const EVENTO_CONFIG = 'ranking:config_atualizada'

const CONFIG_PADRAO = Object.freeze({ ativo: false, dia_semana: 5, horario: '18:00' })
const CICLO_COLS =
  'id, company_id, inicio, fim, timezone, dia_semana, horario, status, classificacao, vencedores, total_vencedor, total_atendimentos, encerrado_em, criado_em'

/** company:ciclo → { expiresAt, promise } (coalescing: N atendentes = 1 query por TTL). */
const _cacheClassificacao = new Map()

class RankingValidacaoError extends Error {
  constructor(message) {
    super(message)
    this.statusCode = 400
  }
}

function tabelaAusente(error) {
  if (!error) return false
  const code = String(error.code || '')
  const msg = String(error.message || error)
  return code === '42P01' || code === 'PGRST205' || /does not exist|schema cache|could not find the table/i.test(msg)
}

function cid(companyId) {
  const n = Number(companyId)
  if (!Number.isInteger(n) || n <= 0) throw new Error('company_id inválido')
  return n
}

function formatarCiclo(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    inicio: row.inicio,
    fim: row.fim,
    timezone: row.timezone,
    dia_semana: Number(row.dia_semana),
    horario: row.horario,
    encerramento_descricao: descreverEncerramento(row.dia_semana, row.horario),
    status: row.status,
    classificacao: Array.isArray(row.classificacao) ? row.classificacao : null,
    vencedores: Array.isArray(row.vencedores) ? row.vencedores : null,
    total_vencedor: row.total_vencedor != null ? Number(row.total_vencedor) : null,
    total_atendimentos: row.total_atendimentos != null ? Number(row.total_atendimentos) : null,
    encerrado_em: row.encerrado_em || null,
  }
}

function emitirEmpresa(io, companyId, evento, payload) {
  if (!io) return
  try {
    if (typeof io.emitEmpresa === 'function') io.emitEmpresa(companyId, evento, payload)
    else io.to(`empresa_${companyId}`).emit(evento, payload)
  } catch (err) {
    console.warn('[ranking] emit falhou:', err?.message || err)
  }
}

function invalidarCacheRanking(companyId) {
  const prefix = `${companyId}:`
  for (const key of _cacheClassificacao.keys()) {
    if (key.startsWith(prefix)) _cacheClassificacao.delete(key)
  }
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

async function getConfig(companyId) {
  const company_id = cid(companyId)
  const { data, error } = await supabase
    .from(T_CONFIG)
    .select('company_id, ativo, dia_semana, horario, atualizado_em')
    .eq('company_id', company_id)
    .maybeSingle()
  if (error) {
    if (tabelaAusente(error)) return { ...CONFIG_PADRAO, indisponivel: true }
    throw error
  }
  if (!data) return { ...CONFIG_PADRAO }
  return {
    ativo: data.ativo === true,
    dia_semana: normalizarDiaSemana(data.dia_semana) ?? CONFIG_PADRAO.dia_semana,
    horario: normalizarHorario(data.horario) || CONFIG_PADRAO.horario,
    atualizado_em: data.atualizado_em || null,
  }
}

function validarEntradaConfig(body = {}) {
  const ativo = body.ativo === true || body.ativo === 'true'
  const dia_semana = normalizarDiaSemana(body.dia_semana)
  if (dia_semana == null) throw new RankingValidacaoError('Escolha o dia da semana do encerramento.')
  const horario = normalizarHorario(body.horario)
  if (!horario) throw new RankingValidacaoError('Horário inválido. Use o formato HH:MM.')
  return { ativo, dia_semana, horario }
}

// ---------------------------------------------------------------------------
// Ciclos
// ---------------------------------------------------------------------------

async function getCicloEmAndamento(company_id) {
  const { data, error } = await supabase
    .from(T_CICLOS)
    .select(CICLO_COLS)
    .eq('company_id', company_id)
    .eq('status', 'em_andamento')
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function getUltimoCiclo(company_id, { somenteEncerrados = false } = {}) {
  let q = supabase.from(T_CICLOS).select(CICLO_COLS).eq('company_id', company_id)
  q = somenteEncerrados ? q.eq('status', 'encerrado') : q.in('status', ['encerrado', 'cancelado'])
  const { data, error } = await q.order('fim', { ascending: false }).limit(1)
  if (error) throw error
  return Array.isArray(data) && data[0] ? data[0] : null
}

/**
 * Garante um ciclo em andamento para empresa com ranking ativo. Idempotente e seguro sob
 * concorrência (índice único parcial → 23505 → relê o vencedor da corrida).
 */
async function garantirCicloAtual(companyId, config, { agora = new Date() } = {}) {
  const company_id = cid(companyId)
  if (!config?.ativo) return null
  const existente = await getCicloEmAndamento(company_id)
  if (existente) return existente

  const agoraMs = agora.getTime()
  const ultimo = await getUltimoCiclo(company_id)
  let inicio = agora
  // Continuidade: o ciclo anterior foi ENCERRADO (não cancelado) e o próximo não chegou a
  // nascer (queda entre os dois passos). Retoma exatamente do fim anterior — sem buraco e
  // sem sobreposição. Desativar (cancelado) ou parada longa → começa agora.
  if (ultimo && ultimo.status === 'encerrado') {
    const fimAnterior = new Date(ultimo.fim)
    const fimMs = fimAnterior.getTime()
    if (Number.isFinite(fimMs) && fimMs <= agoraMs && agoraMs - fimMs < JANELA_CONTINUIDADE_MS) {
      inicio = fimAnterior
    }
  }

  const { timezone } = await getEmpresaTimezone(company_id)
  const fim = calcularFimDoCiclo(inicio, { diaSemana: config.dia_semana, horario: config.horario }, timezone)

  const { data, error } = await supabase
    .from(T_CICLOS)
    .insert({
      company_id,
      inicio: inicio.toISOString(),
      fim: fim.toISOString(),
      timezone,
      dia_semana: config.dia_semana,
      horario: config.horario,
      status: 'em_andamento',
    })
    .select(CICLO_COLS)
    .single()
  if (error) {
    if (String(error.code) === '23505') return getCicloEmAndamento(company_id)
    throw error
  }
  return data
}

async function listarEncerramentos(company_id, inicioIso, fimIso) {
  const linhas = []
  let offset = 0
  for (;;) {
    const { data, error } = await supabase
      .from('atendimentos')
      .select('id, de_usuario_id')
      .eq('company_id', company_id)
      .eq('acao', 'encerrou')
      .gte('criado_em', inicioIso)
      .lt('criado_em', fimIso)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) throw error
    const rows = data || []
    linhas.push(...rows)
    if (rows.length < PAGE) break
    offset += PAGE
  }
  return linhas
}

async function nomesUsuarios(company_id, ids) {
  const lista = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
  if (lista.length === 0) return {}
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome')
    .eq('company_id', company_id)
    .in('id', lista)
  if (error) throw error
  const out = {}
  for (const u of data || []) out[Number(u.id)] = u.nome || ''
  return out
}

/** Classificação da janela [inicio, fim). No ciclo ao vivo `fim` está no futuro → conta até agora. */
async function calcularClassificacao(companyId, inicio, fim) {
  const company_id = cid(companyId)
  const linhas = await listarEncerramentos(company_id, new Date(inicio).toISOString(), new Date(fim).toISOString())
  const nomes = await nomesUsuarios(company_id, linhas.map((l) => l.de_usuario_id))
  return montarClassificacao(linhas, nomes)
}

function classificacaoAoVivo(company_id, ciclo) {
  const key = `${company_id}:${ciclo.id}`
  const now = Date.now()
  const hit = _cacheClassificacao.get(key)
  if (hit && hit.expiresAt > now) return hit.promise
  const promise = calcularClassificacao(company_id, ciclo.inicio, ciclo.fim).catch((err) => {
    _cacheClassificacao.delete(key)
    throw err
  })
  _cacheClassificacao.set(key, { expiresAt: now + CACHE_TTL_MS, promise })
  return promise
}

/**
 * Encerra (e anuncia) todo ciclo em andamento cujo `fim` já passou, abrindo o próximo.
 * Seguro para chamar de qualquer lugar e a qualquer momento: só o UPDATE condicional que
 * casar anuncia.
 * @returns {Promise<Array<object>>} ciclos encerrados nesta chamada (formatados)
 */
async function encerrarCiclosVencidos(companyId, { io = null, agora = () => new Date(), config = null } = {}) {
  const company_id = cid(companyId)
  const encerrados = []
  for (let i = 0; i < MAX_ENCERRAMENTOS_POR_RODADA; i += 1) {
    const ciclo = await getCicloEmAndamento(company_id)
    if (!ciclo) break
    if (new Date(ciclo.fim).getTime() > agora().getTime()) break

    // Resultado fechado na janela exata do ciclo — não importa quanto o encerramento atrasou.
    const resultado = await calcularClassificacao(company_id, ciclo.inicio, ciclo.fim)
    const { data: fechado, error } = await supabase
      .from(T_CICLOS)
      .update({
        status: 'encerrado',
        classificacao: resultado.classificacao,
        vencedores: resultado.vencedores,
        total_vencedor: resultado.total_vencedor,
        total_atendimentos: resultado.total_atendimentos,
        encerrado_em: agora().toISOString(),
      })
      .eq('company_id', company_id)
      .eq('id', ciclo.id)
      .eq('status', 'em_andamento')
      .select(CICLO_COLS)
      .maybeSingle()
    if (error) throw error

    if (fechado) {
      const formatado = formatarCiclo(fechado)
      encerrados.push(formatado)
      invalidarCacheRanking(company_id)
      emitirEmpresa(io, company_id, EVENTO_VENCEDOR, { ciclo: formatado })
      console.log('[ranking] ciclo encerrado', {
        company_id,
        ciclo_id: formatado.id,
        vencedores: (formatado.vencedores || []).length,
        total_vencedor: formatado.total_vencedor,
      })
    }

    // Próximo ciclo com a config ATUAL (mudanças valem a partir daqui).
    const cfg = config || (await getConfig(company_id))
    if (!cfg.ativo || cfg.indisponivel) break
    await garantirCicloAtual(company_id, cfg, { agora: agora() })
  }
  return encerrados
}

async function cancelarCicloEmAndamento(company_id, agora = new Date()) {
  const { error } = await supabase
    .from(T_CICLOS)
    .update({ status: 'cancelado', encerrado_em: agora.toISOString() })
    .eq('company_id', company_id)
    .eq('status', 'em_andamento')
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Casos de uso (controller)
// ---------------------------------------------------------------------------

/**
 * Painel de qualquer usuário da empresa.
 * @param {{ resumo?: boolean, io?: object }} opts resumo=true → sem classificação (boot/layout)
 */
async function getRankingAtual(companyId, usuarioId, { resumo = false, io = null } = {}) {
  const company_id = cid(companyId)
  const config = await getConfig(company_id)
  if (config.indisponivel || !config.ativo) {
    return { ativo: false, indisponivel: config.indisponivel === true, agora: new Date().toISOString() }
  }

  let ciclo = await getCicloEmAndamento(company_id)
  // Scheduler atrasado (ou acabou de reiniciar): quem abre a tela apura na hora.
  if (ciclo && new Date(ciclo.fim).getTime() <= Date.now()) {
    await encerrarCiclosVencidos(company_id, { io, config })
    ciclo = await getCicloEmAndamento(company_id)
  }
  if (!ciclo) ciclo = await garantirCicloAtual(company_id, config)

  const ultimo = await getUltimoCiclo(company_id, { somenteEncerrados: true })
  const base = {
    ativo: true,
    agora: new Date().toISOString(),
    config: {
      dia_semana: config.dia_semana,
      horario: config.horario,
      encerramento_descricao: descreverEncerramento(config.dia_semana, config.horario),
    },
    ciclo: ciclo ? formatarCiclo({ ...ciclo, classificacao: null, vencedores: null }) : null,
    proximo_ciclo_com_nova_regra:
      !!ciclo && (Number(ciclo.dia_semana) !== config.dia_semana || ciclo.horario !== config.horario),
    ultimo_resultado: formatarCiclo(ultimo),
  }
  if (resumo || !ciclo) return base

  const ao = await classificacaoAoVivo(company_id, ciclo)
  const uid = Number(usuarioId)
  const minha = ao.classificacao.find((item) => item.usuario_id === uid) || null
  return {
    ...base,
    classificacao: ao.classificacao,
    lideres: ao.vencedores,
    total_atendimentos: ao.total_atendimentos,
    eu: { usuario_id: uid, posicao: minha ? minha.posicao : null, total: minha ? minha.total : 0 },
  }
}

/** Tela de configuração (admin). */
async function getPainelAdmin(companyId) {
  const company_id = cid(companyId)
  const config = await getConfig(company_id)
  const fuso = await getEmpresaTimezone(company_id)
  let ciclo = null
  if (!config.indisponivel) ciclo = await getCicloEmAndamento(company_id)
  return {
    config: {
      ativo: config.ativo,
      dia_semana: config.dia_semana,
      horario: config.horario,
      encerramento_descricao: descreverEncerramento(config.dia_semana, config.horario),
    },
    indisponivel: config.indisponivel === true,
    fuso: { timezone: fuso.timezone, timezone_label: fuso.timezone_label },
    ciclo_atual: ciclo ? formatarCiclo({ ...ciclo, classificacao: null, vencedores: null }) : null,
  }
}

async function salvarConfig(companyId, usuarioId, body, { io = null } = {}) {
  const company_id = cid(companyId)
  const entrada = validarEntradaConfig(body)
  const atual = await getConfig(company_id)
  if (atual.indisponivel) {
    const err = new Error('Ranking indisponível: a migration do ranking ainda não foi aplicada no banco.')
    err.statusCode = 503
    throw err
  }

  const { error } = await supabase.from(T_CONFIG).upsert(
    {
      company_id,
      ativo: entrada.ativo,
      dia_semana: entrada.dia_semana,
      horario: entrada.horario,
      atualizado_por: Number.isInteger(Number(usuarioId)) ? Number(usuarioId) : null,
      atualizado_em: new Date().toISOString(),
    },
    { onConflict: 'company_id' }
  )
  if (error) throw error

  if (!entrada.ativo) {
    // Desligar encerra a competição corrente SEM vencedor (nada é apagado).
    await cancelarCicloEmAndamento(company_id)
  } else {
    // Ligar: o primeiro ciclo nasce agora. Já ligado: o ciclo corrente fica intacto.
    await garantirCicloAtual(company_id, entrada)
  }
  invalidarCacheRanking(company_id)
  if (atual.ativo !== entrada.ativo) emitirEmpresa(io, company_id, EVENTO_CONFIG, { ativo: entrada.ativo })
  return getPainelAdmin(company_id)
}

async function listarHistorico(companyId, { limit = 20 } = {}) {
  const company_id = cid(companyId)
  const lim = Math.max(1, Math.min(100, Number(limit) || 20))
  const { data, error } = await supabase
    .from(T_CICLOS)
    .select(CICLO_COLS)
    .eq('company_id', company_id)
    .eq('status', 'encerrado')
    .order('fim', { ascending: false })
    .limit(lim)
  if (error) {
    if (tabelaAusente(error)) return { itens: [], indisponivel: true }
    throw error
  }
  return { itens: (data || []).map(formatarCiclo) }
}

/** Empresas com ranking ligado (scheduler). */
async function listarEmpresasAtivas() {
  const { data, error } = await supabase
    .from(T_CONFIG)
    .select('company_id, ativo, dia_semana, horario')
    .eq('ativo', true)
  if (error) throw error
  return (data || []).map((row) => ({
    company_id: Number(row.company_id),
    ativo: true,
    dia_semana: normalizarDiaSemana(row.dia_semana) ?? CONFIG_PADRAO.dia_semana,
    horario: normalizarHorario(row.horario) || CONFIG_PADRAO.horario,
  }))
}

module.exports = {
  EVENTO_VENCEDOR,
  EVENTO_CONFIG,
  RankingValidacaoError,
  tabelaAusente,
  getConfig,
  validarEntradaConfig,
  garantirCicloAtual,
  calcularClassificacao,
  encerrarCiclosVencidos,
  getRankingAtual,
  getPainelAdmin,
  salvarConfig,
  listarHistorico,
  listarEmpresasAtivas,
  invalidarCacheRanking,
  _cacheClassificacao,
}
