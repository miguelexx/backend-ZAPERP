/**
 * Geração da fila persistente e contadores — Etapa 7 Disparo.
 * Idempotente por campanha+versão. Nunca envia mensagens.
 */

const supabase = require('../config/supabase')
const { getDisparoFlags } = require('../helpers/disparoWorkerConfig')
const { revalidarInstanciasConectadas } = require('../controllers/disparoLimitesController')

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

function chaveIdempotencia(campanhaId, versao, destinatarioId) {
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
    .select('inicio_modo, agendado_para, fuso_horario')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function carregarDestinatarios(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_campanha_destinatarios')
    .select(DEST_SELECT)
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .neq('status', 'excluido')
    .not('instancia_id', 'is', null)
    .not('variacao_id', 'is', null)
  if (error) throw error
  return data ?? []
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
  const agora = new Date().toISOString()
  if (campanha.status === 'agendada' || limites?.inicio_modo === 'agendado') {
    if (limites?.agendado_para) return limites.agendado_para
  }
  return agora
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

  const existente = await buscarExecucaoAtiva(campId, cid, versao)
  if (existente) {
    const { count: totalItens } = await supabase
      .from('disparo_fila_itens')
      .select('id', { count: 'exact', head: true })
      .eq('execucao_id', existente.id)

    return {
      execucao: existente,
      gerados: 0,
      ignorados: existente.total_ignorados ?? 0,
      ja_existentes: totalItens ?? 0,
      idempotente: true,
    }
  }

  const limites = await carregarLimites(campId, cid)
  const planejadoPara = resolverPlanejadoPara(campanha, limites)

  const destinatarios = await carregarDestinatarios(campId, cid)
  if (!destinatarios.length) {
    throw new DisparoFilaError('Nenhum destinatário válido com instância e variação atribuídas.')
  }

  const exclusoes = await carregarExclusoesAtivas(cid)

  const { data: execucao, error: execErr } = await supabase
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

  const todasChaves = destinatarios.map((d) => chaveIdempotencia(campId, versao, d.id))
  const jaExistentesAntes = await contarItensPorChaves(todasChaves)

  let gerados = 0
  let ignorados = 0
  const rows = []

  for (const dest of destinatarios) {
    const chave = chaveIdempotencia(campId, versao, dest.id)
    const excluido = exclusoes.has(String(dest.telefone_normalizado))

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

module.exports = {
  chaveIdempotencia,
  gerarFilaParaCampanha,
  registrarEvento,
  recalcularContadores,
  DisparoFilaError,
}
