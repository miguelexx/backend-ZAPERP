/**
 * Relatório pós-campanha — Etapa 8 Disparo.
 * Não infere entrega/leitura sem ACK explícito do provedor.
 */

const supabase = require('../config/supabase')

const EXECUCAO_SELECT = [
  'id', 'company_id', 'campanha_id', 'status', 'versao', 'config_hash',
  'iniciado_em', 'finalizado_em', 'dry_run',
  'total_itens', 'total_enviados', 'total_entregues', 'total_lidos',
  'total_falhas', 'total_incertos', 'total_ignorados', 'total_cancelados',
].join(', ')

const FILA_STATUS_PROCESSADO = new Set([
  'enviada', 'entregue', 'lida', 'respondida', 'optout',
  'falhou', 'incerta', 'ignorada', 'cancelada',
])

function calcularDuracao(inicio, fim) {
  if (!inicio) return null
  const t0 = new Date(inicio).getTime()
  const t1 = fim ? new Date(fim).getTime() : Date.now()
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return null
  return Math.round((t1 - t0) / 1000)
}

function taxa(parte, total) {
  if (!total) return 0
  return Math.round((parte / total) * 10000) / 100
}

async function buscarExecucaoCampanha(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_execucoes')
    .select(EXECUCAO_SELECT)
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

async function contarFilaPorStatus(execucaoId, companyId) {
  const { data, error } = await supabase
    .from('disparo_fila_itens')
    .select('status')
    .eq('execucao_id', execucaoId)
    .eq('company_id', companyId)
  if (error) throw error

  const counts = {
    pendente: 0,
    reservada: 0,
    enviando: 0,
    enviada: 0,
    entregue: 0,
    lida: 0,
    respondida: 0,
    optout: 0,
    falhou: 0,
    incerta: 0,
    ignorada: 0,
    cancelada: 0,
  }

  for (const row of data ?? []) {
    const s = row.status
    if (counts[s] != null) counts[s] += 1
  }
  return counts
}

async function contarRespostasOptouts(campanhaId, companyId, execucaoId) {
  const [respostas, optouts] = await Promise.all([
    supabase
      .from('disparo_respostas')
      .select('id', { count: 'exact', head: true })
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId),
    supabase
      .from('disparo_optout_eventos')
      .select('id', { count: 'exact', head: true })
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .eq('tipo', 'optout')
      .eq('execucao_id', execucaoId),
  ])

  if (respostas.error) throw respostas.error
  if (optouts.error) throw optouts.error

  return {
    respondidas: respostas.count ?? 0,
    optouts: optouts.count ?? 0,
  }
}

async function origemDestinatarios(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_destinatarios')
    .select('origem')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .neq('status', 'excluido')
  if (error) throw error

  const map = {}
  for (const row of data ?? []) {
    const o = row.origem || 'manual'
    map[o] = (map[o] || 0) + 1
  }
  return map
}

async function montarTimeline(execucaoId, companyId) {
  const [eventos, pausas] = await Promise.all([
    supabase
      .from('disparo_execucao_eventos')
      .select('id, tipo, payload, usuario_id, criado_em')
      .eq('execucao_id', execucaoId)
      .eq('company_id', companyId)
      .order('criado_em', { ascending: true })
      .limit(500),
    supabase
      .from('disparo_pausas')
      .select('id, tipo_pausa, motivo, escopo, instancia_id, iniciado_em, finalizado_em')
      .eq('execucao_id', execucaoId)
      .eq('company_id', companyId)
      .order('iniciado_em', { ascending: true })
      .limit(200),
  ])

  if (eventos.error) throw eventos.error
  if (pausas.error) throw pausas.error

  const linha = []

  for (const e of eventos.data ?? []) {
    linha.push({
      tipo: 'evento',
      subtipo: e.tipo,
      criado_em: e.criado_em,
      payload: e.payload,
      usuario_id: e.usuario_id,
    })
  }

  for (const p of pausas.data ?? []) {
    linha.push({
      tipo: 'pausa',
      subtipo: p.tipo_pausa,
      criado_em: p.iniciado_em,
      finalizado_em: p.finalizado_em,
      motivo: p.motivo,
      escopo: p.escopo,
      instancia_id: p.instancia_id,
    })
  }

  linha.sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em))
  return linha
}

async function listarErrosAgrupados(campanhaId, companyId, execucaoId = null) {
  const cid = Number(companyId)
  const campId = Number(campanhaId)

  let execId = execucaoId
  if (!execId) {
    const exec = await buscarExecucaoCampanha(campId, cid)
    execId = exec?.id
  }
  if (!execId) return []

  const { data, error } = await supabase
    .from('disparo_fila_itens')
    .select('erro_codigo, erro_mensagem, erro_classificacao, status')
    .eq('execucao_id', execId)
    .eq('company_id', cid)
    .in('status', ['falhou', 'incerta'])
  if (error) throw error

  const grupos = new Map()
  for (const row of data ?? []) {
    const codigo = row.erro_codigo || 'DESCONHECIDO'
    const chave = `${codigo}::${row.erro_classificacao || ''}`
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        erro_codigo: codigo,
        erro_mensagem: row.erro_mensagem || null,
        erro_classificacao: row.erro_classificacao || null,
        total: 0,
        incertos: 0,
        falhas: 0,
      })
    }
    const g = grupos.get(chave)
    g.total += 1
    if (row.status === 'incerta') g.incertos += 1
    if (row.status === 'falhou') g.falhas += 1
    if (!g.erro_mensagem && row.erro_mensagem) g.erro_mensagem = row.erro_mensagem
  }

  return [...grupos.values()].sort((a, b) => b.total - a.total)
}

async function metricasPorInstancia(campanhaId, companyId, execucaoId = null) {
  const cid = Number(companyId)
  const campId = Number(campanhaId)

  let execId = execucaoId
  if (!execId) {
    const exec = await buscarExecucaoCampanha(campId, cid)
    execId = exec?.id
  }
  if (!execId) return []

  const { data, error } = await supabase
    .from('disparo_fila_itens')
    .select('instancia_id, status')
    .eq('execucao_id', execId)
    .eq('company_id', cid)
  if (error) throw error

  const map = new Map()
  for (const row of data ?? []) {
    const instId = row.instancia_id
    if (!map.has(instId)) {
      map.set(instId, {
        instancia_id: instId,
        planejado: 0,
        processado: 0,
        enviadas: 0,
        entregues: 0,
        lidas: 0,
        respondidas: 0,
        falhas: 0,
        incertos: 0,
        ignoradas: 0,
        canceladas: 0,
      })
    }
    const m = map.get(instId)
    m.planejado += 1
    if (FILA_STATUS_PROCESSADO.has(row.status)) m.processado += 1
    if (['enviada', 'entregue', 'lida', 'respondida', 'optout'].includes(row.status)) m.enviadas += 1
    if (['entregue', 'lida', 'respondida'].includes(row.status)) m.entregues += 1
    if (['lida', 'respondida'].includes(row.status)) m.lidas += 1
    if (row.status === 'respondida') m.respondidas += 1
    if (row.status === 'falhou') m.falhas += 1
    if (row.status === 'incerta') m.incertos += 1
    if (row.status === 'ignorada') m.ignoradas += 1
    if (row.status === 'cancelada') m.canceladas += 1
  }

  const instIds = [...map.keys()].filter(Boolean)
  let instancias = {}
  if (instIds.length) {
    const { data: instData, error: instErr } = await supabase
      .from('whatsapp_instances')
      .select('id, nome, numero')
      .in('id', instIds)
      .eq('company_id', cid)
    if (instErr) throw instErr
    instancias = Object.fromEntries((instData ?? []).map((i) => [i.id, i]))
  }

  return [...map.values()].map((m) => ({
    ...m,
    instancia: instancias[m.instancia_id] ?? null,
    taxa_entrega: taxa(m.entregues, m.enviadas),
    taxa_leitura: taxa(m.lidas, m.enviadas),
    taxa_resposta: taxa(m.respondidas, m.enviadas),
  }))
}

async function metricasPorVariacao(campanhaId, companyId, execucaoId = null) {
  const cid = Number(companyId)
  const campId = Number(campanhaId)

  let execId = execucaoId
  if (!execId) {
    const exec = await buscarExecucaoCampanha(campId, cid)
    execId = exec?.id
  }
  if (!execId) return []

  const { data, error } = await supabase
    .from('disparo_fila_itens')
    .select('variacao_id, status')
    .eq('execucao_id', execId)
    .eq('company_id', cid)
  if (error) throw error

  const map = new Map()
  for (const row of data ?? []) {
    const varId = row.variacao_id
    if (!map.has(varId)) {
      map.set(varId, {
        variacao_id: varId,
        planejado: 0,
        processado: 0,
        enviadas: 0,
        entregues: 0,
        lidas: 0,
        respondidas: 0,
        falhas: 0,
        incertos: 0,
      })
    }
    const m = map.get(varId)
    m.planejado += 1
    if (FILA_STATUS_PROCESSADO.has(row.status)) m.processado += 1
    if (['enviada', 'entregue', 'lida', 'respondida', 'optout'].includes(row.status)) m.enviadas += 1
    if (['entregue', 'lida', 'respondida'].includes(row.status)) m.entregues += 1
    if (['lida', 'respondida'].includes(row.status)) m.lidas += 1
    if (row.status === 'respondida') m.respondidas += 1
    if (row.status === 'falhou') m.falhas += 1
    if (row.status === 'incerta') m.incertos += 1
  }

  const varIds = [...map.keys()].filter(Boolean)
  let variacoes = {}
  if (varIds.length) {
    const { data: varData, error: varErr } = await supabase
      .from('disparo_campanha_variacoes')
      .select('id, nome, tipo_mensagem, ordem')
      .in('id', varIds)
      .eq('company_id', cid)
    if (varErr) throw varErr
    variacoes = Object.fromEntries((varData ?? []).map((v) => [v.id, v]))
  }

  return [...map.values()].map((m) => ({
    ...m,
    variacao: variacoes[m.variacao_id] ?? null,
    taxa_entrega: taxa(m.entregues, m.enviadas),
    taxa_leitura: taxa(m.lidas, m.enviadas),
    taxa_resposta: taxa(m.respondidas, m.enviadas),
  }))
}

async function montarRelatorioCampanha(campanhaId, companyId) {
  const cid = Number(companyId)
  const campId = Number(campanhaId)

  const [{ data: campanha, error: campErr }, execucao] = await Promise.all([
    supabase
      .from('disparo_campanhas')
      .select('id, nome, status, versao_atual, criado_em')
      .eq('id', campId)
      .eq('company_id', cid)
      .maybeSingle(),
    buscarExecucaoCampanha(campId, cid),
  ])
  if (campErr) throw campErr
  if (!campanha) {
    throw Object.assign(new Error('Campanha não encontrada.'), { code: 'CAMPANHA_NAO_ENCONTRADA' })
  }

  if (!execucao) {
    return {
      campanha,
      execucao: null,
      metricas: {
        planejado: 0,
        processado: 0,
        enviadas: 0,
        entregues: 0,
        lidas: 0,
        respondidas: 0,
        optouts: 0,
        falhas: 0,
        incertos: 0,
        ignoradas: 0,
        canceladas: 0,
      },
      taxas: {},
      duracao_segundos: null,
      origem_destinatario: {},
      erros: [],
      timeline: [],
      instancias: [],
      variacoes: [],
    }
  }

  const [statusCounts, extras, origem, erros, timeline, instancias, variacoes] = await Promise.all([
    contarFilaPorStatus(execucao.id, cid),
    contarRespostasOptouts(campId, cid, execucao.id),
    origemDestinatarios(campId, cid),
    listarErrosAgrupados(campId, cid, execucao.id),
    montarTimeline(execucao.id, cid),
    metricasPorInstancia(campId, cid, execucao.id),
    metricasPorVariacao(campId, cid, execucao.id),
  ])

  const planejado = execucao.total_itens || Object.values(statusCounts).reduce((a, b) => a + b, 0)
  const enviadas = statusCounts.enviada + statusCounts.entregue + statusCounts.lida
    + statusCounts.respondida + (statusCounts.optout || 0)
  const entregues = statusCounts.entregue + statusCounts.lida + statusCounts.respondida
  const lidas = statusCounts.lida + statusCounts.respondida
  const processado = [...FILA_STATUS_PROCESSADO].reduce((acc, s) => acc + (statusCounts[s] || 0), 0)

  const metricas = {
    planejado,
    processado,
    enviadas,
    entregues,
    lidas,
    respondidas: statusCounts.respondida,
    optouts: extras.optouts,
    falhas: statusCounts.falhou,
    incertos: statusCounts.incerta,
    ignoradas: statusCounts.ignorada,
    canceladas: statusCounts.cancelada,
    pendentes: statusCounts.pendente + statusCounts.reservada + statusCounts.enviando,
  }

  const taxas = {
    processamento: taxa(metricas.processado, planejado),
    envio: taxa(enviadas, planejado),
    entrega: taxa(entregues, enviadas),
    leitura: taxa(lidas, enviadas),
    resposta: taxa(metricas.respondidas, enviadas),
    falha: taxa(metricas.falhas, planejado),
    incerteza: taxa(metricas.incertos, planejado),
  }

  return {
    campanha,
    execucao: {
      id: execucao.id,
      status: execucao.status,
      versao: execucao.versao,
      dry_run: execucao.dry_run,
      iniciado_em: execucao.iniciado_em,
      finalizado_em: execucao.finalizado_em,
    },
    metricas,
    taxas,
    duracao_segundos: calcularDuracao(execucao.iniciado_em, execucao.finalizado_em),
    origem_destinatario: origem,
    erros,
    timeline,
    instancias,
    variacoes,
    observacao: 'Entregues/lidas exigem ACK explícito na fila; enviada sem ACK não conta como entregue.',
  }
}

module.exports = {
  montarRelatorioCampanha,
  metricasPorInstancia,
  metricasPorVariacao,
  listarErrosAgrupados,
}
