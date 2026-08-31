/**
 * Geração da fila persistente e contadores — Etapa 7 Disparo.
 * Idempotente por execução (campanha+versão+execucao_id+destinatário). Nunca envia mensagens.
 */

const supabase = require('../config/supabase')
const { getDisparoFlags } = require('../helpers/disparoWorkerConfig')
const { revalidarInstanciasConectadas } = require('../controllers/disparoLimitesController')
const {
  DateTime,
  PERFIS,
  FUSO_PADRAO,
  gerarHorariosDisparo,
} = require('../helpers/disparoLimitesHelper')

const BATCH_SIZE = 500
const EXECUCAO_ATIVA = ['aguardando', 'em_execucao', 'pausada']

const CAMPANHA_SELECT = [
  'id', 'company_id', 'status', 'versao_atual', 'config_hash',
  'distribuicao_confirmada', 'distribuicao_revisao',
  'variacao_confirmada', 'variacao_revisao',
  'limites_confirmados', 'limites_revisao',
].join(', ')

const DEST_SELECT = [
  'id', 'nome', 'telefone_normalizado', 'instancia_id', 'variacao_id', 'status', 'cliente_id',
].join(', ')

class DisparoFilaError extends Error {
  constructor(message, code = 'VALIDATION') {
    super(message)
    this.name = 'DisparoFilaError'
    this.code = code
  }
}

function chaveIdempotencia(campanhaId, versao, destinatarioId, execucaoId) {
  const exec = Number(execucaoId)
  if (Number.isInteger(exec) && exec > 0) {
    return `campanha:${campanhaId}:v${versao}:exec:${exec}:dest:${destinatarioId}`
  }
  return `campanha:${campanhaId}:v${versao}:dest:${destinatarioId}`
}

function assertCampanhaPronta(campanha) {
  const status = String(campanha?.status || '')
  if (status !== 'pronta' && status !== 'agendada') {
    throw new DisparoFilaError(
      `Campanha deve estar com status "pronta" ou "agendada" (atual: ${status || 'desconhecido'}).`,
    )
  }
}

function assertConfirmacoes(campanha) {
  const erros = []
  if (!campanha.versao_atual || campanha.versao_atual < 1) {
    erros.push('versao_atual inválida ou ausente.')
  }
  if (!campanha.config_hash) {
    erros.push('config_hash ausente — confirme a revisão da campanha.')
  }
  if (!campanha.limites_confirmados) erros.push('Limites não confirmados.')
  if (!campanha.distribuicao_confirmada) erros.push('Distribuição de instâncias não confirmada.')
  if (!campanha.variacao_confirmada) erros.push('Distribuição de mensagens não confirmada.')
  if (campanha.distribuicao_revisao) erros.push('Distribuição marcada para revisão.')
  if (campanha.variacao_revisao) erros.push('Mensagens marcadas para revisão.')
  if (campanha.limites_revisao) erros.push('Limites marcados para revisão.')
  if (erros.length) {
    throw new DisparoFilaError(erros.join(' '))
  }
}

async function carregarRevisaoAtiva(campanhaId, companyId, versao) {
  const { data, error } = await supabase
    .from('disparo_campanha_revisoes')
    .select('id, versao, hash, status')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .eq('versao', versao)
    .eq('status', 'ativa')
    .maybeSingle()
  if (error) throw error
  if (!data) {
    throw new DisparoFilaError('Revisão ativa não encontrada para a versão atual da campanha.')
  }
  return data
}

async function carregarLimites(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_limites')
    .select('*')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function carregarJanelas(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_janelas')
    .select('*')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
  if (error) throw error
  return data ?? []
}

async function carregarOverridesInstancia(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_instancia_limites')
    .select('*')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
  if (error) throw error
  return data ?? []
}

function limitesEfetivos(row) {
  return {
    ...PERFIS.moderado,
    fuso_horario: FUSO_PADRAO,
    inicio_modo: 'imediato',
    ...(row || {}),
  }
}

function resolverInicioDisparo(campanha, limites) {
  const fuso = limites?.fuso_horario || FUSO_PADRAO
  if (campanha.status === 'agendada' || limites?.inicio_modo === 'agendado') {
    if (limites?.agendado_para) {
      const ag = DateTime.fromISO(limites.agendado_para, { zone: 'utc' }).setZone(fuso)
      if (ag.isValid) return ag
    }
  }
  return DateTime.utc().setZone(fuso)
}

function janelasDaInstancia(janelas, instanciaId, override) {
  const lista = janelas || []
  if (override?.janelas_proprias) {
    const proprias = lista.filter((j) => Number(j.instancia_id) === Number(instanciaId))
    if (proprias.length) return proprias
  }
  return lista.filter((j) => j.instancia_id == null)
}

/**
 * Espaça planejado_para por instância conforme limites da campanha.
 * Destinatários excluídos ficam no horário base (não entram no ritmo de envio).
 */
function montarHorariosFila({ campanha, destinatarios, exclusoes, limites, janelas, overrides }) {
  const inicio = resolverInicioDisparo(campanha, limites)
  const overridesByInst = {}
  for (const o of overrides || []) {
    if (o?.instancia_id != null) overridesByInst[Number(o.instancia_id)] = o
  }

  const grupos = new Map()
  for (const dest of destinatarios || []) {
    const excluido = exclusoes.has(String(dest.telefone_normalizado))
    if (excluido) continue
    const instId = Number(dest.instancia_id)
    if (!grupos.has(instId)) grupos.set(instId, [])
    grupos.get(instId).push(dest)
  }

  const porDestino = new Map()
  const baseIso = inicio.toUTC().toISO()
  for (const dest of destinatarios || []) {
    porDestino.set(dest.id, baseIso)
  }

  for (const [instId, dests] of grupos) {
    dests.sort((a, b) => Number(a.id) - Number(b.id))
    const override = overridesByInst[instId] || null
    const horarios = gerarHorariosDisparo({
      quantidade: dests.length,
      globalCfg: limites,
      override,
      janelas: janelasDaInstancia(janelas, instId, override),
      inicioDt: inicio,
    })
    dests.forEach((dest, idx) => {
      porDestino.set(dest.id, horarios[idx] || baseIso)
    })
  }
  return porDestino
}

async function carregarDestinatarios(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_destinatarios')
    .select(DEST_SELECT)
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .neq('status', 'excluido')
  if (error) throw error
  const todos = data ?? []
  const semAtribuicao = todos.filter((d) => d.instancia_id == null || d.variacao_id == null)
  if (semAtribuicao.length) {
    throw new DisparoFilaError(
      `${semAtribuicao.length} destinatário(s) sem instância ou variação. A fila não seria gerada para todos. Confirme a distribuição nas etapas Instâncias e Mensagens.`,
      'DESTINATARIOS_INCOMPLETOS',
    )
  }
  if (!todos.length) {
    throw new DisparoFilaError('Nenhum destinatário válido com instância e variação atribuídas.')
  }
  return todos
}

async function carregarExclusoesAtivas(companyId) {
  const { data, error } = await supabase
    .from('disparo_exclusoes')
    .select('telefone_normalizado')
    .eq('company_id', companyId)
    .eq('ativo', true)
  if (error) throw error
  return new Set((data ?? []).map((e) => String(e.telefone_normalizado)))
}

async function buscarExecucaoAtiva(campanhaId, companyId, versao) {
  const { data, error } = await supabase
    .from('disparo_execucoes')
    .select('*')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .eq('versao', versao)
    .in('status', EXECUCAO_ATIVA)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

function resolverPlanejadoPara(campanha, limites) {
  return resolverInicioDisparo(campanha, limites).toUTC().toISO()
}

async function contarItensPorChaves(chaves) {
  if (!chaves.length) return 0
  const { count, error } = await supabase
    .from('disparo_fila_itens')
    .select('id', { count: 'exact', head: true })
    .in('chave_idempotencia', chaves)
  if (error) throw error
  return count ?? 0
}

async function upsertFilaChunk(rows) {
  if (!rows.length) return
  const { error } = await supabase
    .from('disparo_fila_itens')
    .upsert(rows, { onConflict: 'chave_idempotencia', ignoreDuplicates: true })
  if (error) throw error
}

/**
 * Gera execução e itens da fila para uma campanha confirmada.
 */
async function gerarFilaParaCampanha({ companyId, campanhaId, userId, dryRun }) {
  const cid = Number(companyId)
  const campId = Number(campanhaId)
  if (!cid || !campId) {
    throw new DisparoFilaError('companyId e campanhaId são obrigatórios.')
  }

  const flags = getDisparoFlags()
  const effectiveDryRun = dryRun !== undefined ? Boolean(dryRun) : flags.dryRun

  const { data: campanha, error: campErr } = await supabase
    .from('disparo_campanhas')
    .select(CAMPANHA_SELECT)
    .eq('id', campId)
    .eq('company_id', cid)
    .maybeSingle()
  if (campErr) throw campErr
  if (!campanha) throw new DisparoFilaError('Campanha não encontrada.')

  assertCampanhaPronta(campanha)
  assertConfirmacoes(campanha)

  const versao = campanha.versao_atual
  const revisao = await carregarRevisaoAtiva(campId, cid, versao)

  const instCheck = await revalidarInstanciasConectadas(campId, cid)
  if (!instCheck.ok) {
    const nomes = (instCheck.desconectadas || []).map((i) => i.nome || i.id).join(', ')
    throw new DisparoFilaError(
      instCheck.mensagem || `Instâncias desconectadas ou inativas: ${nomes || 'verifique as instâncias.'}`,
    )
  }

  const destinatarios = await carregarDestinatarios(campId, cid)

  let execucao = await buscarExecucaoAtiva(campId, cid, versao)
  if (execucao) {
    const { count: totalItens, error: countErr } = await supabase
      .from('disparo_fila_itens')
      .select('id', { count: 'exact', head: true })
      .eq('execucao_id', execucao.id)
    if (countErr) throw countErr
    const n = totalItens ?? 0
    if (n >= destinatarios.length) {
      return {
        execucao,
        gerados: 0,
        ignorados: execucao.total_ignorados ?? 0,
        ja_existentes: n,
        idempotente: true,
      }
    }
    console.warn(
      '[disparo:fila] execução ativa incompleta — completando fila',
      { execucao_id: execucao.id, itens: n, destinatarios: destinatarios.length },
    )
  }

  const limitesRow = await carregarLimites(campId, cid)
  const limites = limitesEfetivos(limitesRow)
  const janelas = await carregarJanelas(campId, cid)
  const overrides = await carregarOverridesInstancia(campId, cid)

  const exclusoes = await carregarExclusoesAtivas(cid)
  const horariosPorDestino = montarHorariosFila({
    campanha,
    destinatarios,
    exclusoes,
    limites,
    janelas,
    overrides,
  })

  if (!execucao) {
    const { data: execNova, error: execErr } = await supabase
      .from('disparo_execucoes')
      .insert({
        company_id: cid,
        campanha_id: campId,
        revisao_id: revisao.id,
        versao,
        config_hash: campanha.config_hash,
        status: 'aguardando',
        iniciado_por: userId ?? null,
        dry_run: effectiveDryRun,
        total_itens: 0,
      })
      .select('*')
      .single()
    if (execErr) throw execErr
    execucao = execNova
  }

  const todasChaves = destinatarios.map((d) => chaveIdempotencia(campId, versao, d.id, execucao.id))
  const jaExistentesAntes = await contarItensPorChaves(todasChaves)

  let gerados = 0
  let ignorados = 0
  const rows = []

  for (const dest of destinatarios) {
    const chave = chaveIdempotencia(campId, versao, dest.id, execucao.id)
    const excluido = exclusoes.has(String(dest.telefone_normalizado))
    const planejadoPara = horariosPorDestino.get(dest.id) || resolverPlanejadoPara(campanha, limites)

    if (excluido) {
      rows.push({
        company_id: cid,
        campanha_id: campId,
        execucao_id: execucao.id,
        revisao_id: revisao.id,
        versao,
        destinatario_id: dest.id,
        instancia_id: dest.instancia_id,
        variacao_id: dest.variacao_id,
        status: 'ignorada',
        chave_idempotencia: chave,
        planejado_para: planejadoPara,
        proxima_tentativa_em: planejadoPara,
        erro_codigo: 'EXCLUIDO',
        erro_mensagem: 'Telefone na lista de exclusão da empresa.',
        erro_classificacao: 'permanente',
      })
      ignorados += 1
    } else {
      rows.push({
        company_id: cid,
        campanha_id: campId,
        execucao_id: execucao.id,
        revisao_id: revisao.id,
        versao,
        destinatario_id: dest.id,
        instancia_id: dest.instancia_id,
        variacao_id: dest.variacao_id,
        status: 'pendente',
        chave_idempotencia: chave,
        planejado_para: planejadoPara,
        proxima_tentativa_em: planejadoPara,
        reference_id: null,
      })
      gerados += 1
    }
  }

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await upsertFilaChunk(rows.slice(i, i + BATCH_SIZE))
  }

  const jaExistentesDepois = await contarItensPorChaves(todasChaves)
  const inseridosNovos = Math.max(0, jaExistentesDepois - jaExistentesAntes)
  const jaExistentes = jaExistentesAntes

  await recalcularContadores(execucao.id, cid)

  const { data: itensExec } = await supabase
    .from('disparo_fila_itens')
    .select('status')
    .eq('execucao_id', execucao.id)
    .eq('company_id', cid)

  gerados = (itensExec ?? []).filter((i) => i.status === 'pendente').length
  ignorados = (itensExec ?? []).filter((i) => i.status === 'ignorada').length

  if ((jaExistentesDepois ?? 0) < destinatarios.length) {
    throw new DisparoFilaError(
      `Fila incompleta: ${jaExistentesDepois ?? 0} de ${destinatarios.length} destinatários na execução ${execucao.id}. ` +
        'Chaves de uma execução anterior podem ter bloqueado a inserção. Publique a campanha de novo (nova versão) e inicie outra vez.',
      'FILA_INCOMPLETA',
    )
  }

  const { data: execAtualizada } = await supabase
    .from('disparo_execucoes')
    .select('*')
    .eq('id', execucao.id)
    .eq('company_id', cid)
    .single()

  await registrarEvento({
    companyId: cid,
    execucaoId: execucao.id,
    campanhaId: campId,
    tipo: 'fila_gerada',
    payload: {
      versao,
      gerados: inseridosNovos,
      ignorados,
      ja_existentes: jaExistentes,
      dry_run: effectiveDryRun,
    },
    usuarioId: userId ?? null,
  })

  return {
    execucao: execAtualizada || execucao,
    gerados: inseridosNovos,
    ignorados,
    ja_existentes: jaExistentes,
    idempotente: false,
  }
}

async function registrarEvento({ companyId, execucaoId, campanhaId, tipo, payload, usuarioId }) {
  const { error } = await supabase
    .from('disparo_execucao_eventos')
    .insert({
      company_id: Number(companyId),
      execucao_id: Number(execucaoId),
      campanha_id: Number(campanhaId),
      tipo: String(tipo),
      payload: payload ?? {},
      usuario_id: usuarioId ?? null,
    })
  if (error) throw error
}

async function recalcularContadores(execucaoId, companyId) {
  const { data: itens, error } = await supabase
    .from('disparo_fila_itens')
    .select('status')
    .eq('execucao_id', execucaoId)
    .eq('company_id', companyId)
  if (error) throw error

  const counts = {
    total_itens: 0,
    total_enviados: 0,
    total_entregues: 0,
    total_lidos: 0,
    total_falhas: 0,
    total_incertos: 0,
    total_ignorados: 0,
    total_cancelados: 0,
    total_respondidas: 0,
    total_optouts: 0,
  }

  for (const item of itens ?? []) {
    counts.total_itens += 1
    switch (item.status) {
      case 'enviada':
        counts.total_enviados += 1
        break
      case 'entregue':
        counts.total_enviados += 1
        counts.total_entregues += 1
        break
      case 'lida':
        counts.total_enviados += 1
        counts.total_entregues += 1
        counts.total_lidos += 1
        break
      case 'respondida':
        // Já foi enviada; resposta é métrica adicional
        counts.total_enviados += 1
        counts.total_entregues += 1
        counts.total_lidos += 1
        counts.total_respondidas = (counts.total_respondidas || 0) + 1
        break
      case 'optout':
        counts.total_optouts = (counts.total_optouts || 0) + 1
        break
      case 'falhou':
        counts.total_falhas += 1
        break
      case 'incerta':
        counts.total_incertos += 1
        break
      case 'ignorada':
        counts.total_ignorados += 1
        break
      case 'cancelada':
        counts.total_cancelados += 1
        break
      default:
        break
    }
  }

  // Campos novos podem não existir até migration Etapa 9 — remove se update falhar? Preferir enviar sempre;
  // PostgREST ignora? Não — remove se undefined. Garantir defaults:
  if (counts.total_respondidas == null) counts.total_respondidas = 0
  if (counts.total_optouts == null) counts.total_optouts = 0

  const { error: updErr } = await supabase
    .from('disparo_execucoes')
    .update({
      ...counts,
      atualizado_em: new Date().toISOString(),
    })
    .eq('id', execucaoId)
    .eq('company_id', companyId)
  if (updErr) {
    // Compat pré-migration 9: tenta sem colunas novas
    if (/total_respondidas|total_optouts/i.test(updErr.message || '')) {
      const { total_respondidas, total_optouts, ...legacy } = counts
      const { error: legacyErr } = await supabase
        .from('disparo_execucoes')
        .update({ ...legacy, atualizado_em: new Date().toISOString() })
        .eq('id', execucaoId)
        .eq('company_id', companyId)
      if (legacyErr) throw legacyErr
    } else {
      throw updErr
    }
  }

  return counts
}

const ITENS_CANCELAVEIS_REEDICAO = ['pendente', 'reservada']

/**
 * Encerra execução aguardando/pausada para a campanha voltar ao wizard.
 * Não cancela a campanha. Itens já enviados permanecem.
 * Recusa se a execução ainda estiver em_execucao.
 */
async function encerrarExecucaoAtivaParaReedicao({ companyId, campanhaId, userId, motivo }) {
  const cid = Number(companyId)
  const campId = Number(campanhaId)
  const { data: exec, error } = await supabase
    .from('disparo_execucoes')
    .select('id, status')
    .eq('campanha_id', campId)
    .eq('company_id', cid)
    .in('status', EXECUCAO_ATIVA)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!exec) return { encerrada: false, execucaoId: null, itens_cancelados: 0 }

  if (exec.status === 'em_execucao') {
    throw new DisparoFilaError(
      'Pause a campanha antes de voltar para edição.',
      'EM_EXECUCAO',
    )
  }

  const agora = new Date().toISOString()
  const { data: itens, error: itensErr } = await supabase
    .from('disparo_fila_itens')
    .select('id')
    .eq('execucao_id', exec.id)
    .eq('company_id', cid)
    .in('status', ITENS_CANCELAVEIS_REEDICAO)
  if (itensErr) throw itensErr

  const ids = (itens ?? []).map((i) => i.id)
  if (ids.length) {
    const { error: updItensErr } = await supabase
      .from('disparo_fila_itens')
      .update({
        status: 'cancelada',
        cancelado_em: agora,
        worker_id: null,
        lease_inicio: null,
        lease_ate: null,
        atualizado_em: agora,
      })
      .eq('execucao_id', exec.id)
      .eq('company_id', cid)
      .in('status', ITENS_CANCELAVEIS_REEDICAO)
    if (updItensErr) throw updItensErr
  }

  await recalcularContadores(exec.id, cid)

  const { error: updExecErr } = await supabase
    .from('disparo_execucoes')
    .update({
      status: 'cancelada',
      cancelado_por: userId ?? null,
      finalizado_em: agora,
      atualizado_em: agora,
    })
    .eq('id', exec.id)
    .eq('company_id', cid)
  if (updExecErr) throw updExecErr

  await registrarEvento({
    companyId: cid,
    execucaoId: exec.id,
    campanhaId: campId,
    tipo: 'cancelada',
    payload: {
      motivo: motivo || 'reedicao',
      itens_cancelados: ids.length,
      origem: 'voltar_edicao',
    },
    usuarioId: userId ?? null,
  })

  return { encerrada: true, execucaoId: exec.id, itens_cancelados: ids.length }
}

module.exports = {
  chaveIdempotencia,
  gerarFilaParaCampanha,
  registrarEvento,
  recalcularContadores,
  montarHorariosFila,
  encerrarExecucaoAtivaParaReedicao,
  DisparoFilaError,
}
