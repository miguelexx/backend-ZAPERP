/**
 * Fila de participantes de Comunidade: enfileirar (idempotente/dedup/pré-filtro),
 * recalcular contadores e transições de status da operação.
 * Fonte de verdade das comunidades é a Whapi (ao vivo); aqui só persistimos a FILA.
 */

const supabase = require('../../config/supabase')
const { getProvider } = require('../providers')
const { contactIds } = require('../providers/whapi/community')
const { emitComunidade, EVENTS } = require('./comunidadeSocketService')

const ATIVOS = ['pendente', 'reservada', 'enviando']
const INSERT_CHUNK = 200

function provider() {
  return getProvider({ provider: 'whapi' })
}

function jidsFromParticipants(parts) {
  const set = new Set()
  for (const raw of Array.isArray(parts) ? parts : []) {
    const id = String(raw?.id ?? raw ?? '').trim()
    const digits = id.replace(/@[^@]+$/, '').replace(/\D/g, '')
    if (digits) set.add(digits)
  }
  return set
}

/**
 * JIDs já participantes do ALVO (grupo ou comunidade) — para não re-adicionar (evita ruído
 * anti-spam). getCommunity devolve { ok, data }; getGroup devolve o objeto cru (ou null).
 */
async function jidsAtuaisDoDestino(tipo, companyId, instanceId, alvoId) {
  try {
    const p = provider()
    const opts = { companyId, whatsappInstanceId: instanceId }
    if (tipo === 'grupo') {
      if (typeof p.getGroup !== 'function') return new Set()
      const raw = await p.getGroup(alvoId, opts)
      return jidsFromParticipants(raw?.participants || raw?.members)
    }
    if (typeof p.getCommunity !== 'function') return new Set()
    const res = await p.getCommunity(alvoId, opts)
    if (!res?.ok) return new Set()
    return jidsFromParticipants(res.data?.participants)
  } catch {
    return new Set()
  }
}

/**
 * Enfileira participantes para uma operação (add|remove|promote|demote).
 * Retorna { operacao, total, ignorados, jaNaFila }.
 */
async function enfileirarParticipantes({
  io = null,
  companyId,
  instanceId,
  comunidadeId,
  comunidadeNome = null,
  participantes = [],
  operacao = 'add',
  tipo = 'comunidade',
  criadoPor = null,
  maxTentativas = 5,
}) {
  const cid = String(comunidadeId || '').trim()
  const kind = tipo === 'grupo' ? 'grupo' : 'comunidade'
  const LIMITE = kind === 'grupo' ? 1024 : 2000 // grupo WhatsApp ~1024 membros; comunidade ~2000
  if (!cid) return { error: kind === 'grupo' ? 'Grupo inválido.' : 'Comunidade inválida.' }
  if (!Number.isFinite(Number(instanceId))) return { error: 'Instância inválida.' }

  // 1) normaliza + dedup dentro do input
  const normalizados = contactIds(participantes).map((s) => String(s).replace(/@[^@]+$/, '').replace(/\D/g, '')).filter(Boolean)
  const unicos = [...new Set(normalizados)]
  if (!unicos.length) return { error: 'Nenhum número válido informado.' }
  if (unicos.length > LIMITE) return { error: `Limite de ${LIMITE} participantes por operação.` }

  let alvo = unicos
  let ignorados = 0

  // 2) pré-filtro: quem já está no grupo/comunidade (só faz sentido em add)
  if (operacao === 'add') {
    const atuais = await jidsAtuaisDoDestino(kind, companyId, instanceId, cid)
    if (atuais.size) {
      const antes = alvo.length
      alvo = alvo.filter((jid) => !atuais.has(jid))
      ignorados += antes - alvo.length
    }
  }

  // 3) dedup contra itens já ativos na fila (mesma comunidade+operação) — evita duplo-clique/timeout
  const { data: ativos } = await supabase
    .from('comunidade_fila_itens')
    .select('participante_jid')
    .eq('company_id', companyId)
    .eq('comunidade_id', cid)
    .eq('operacao', operacao)
    .in('status', ATIVOS)
  const jaNaFilaSet = new Set((ativos || []).map((r) => String(r.participante_jid)))
  let jaNaFila = 0
  if (jaNaFilaSet.size) {
    const antes = alvo.length
    alvo = alvo.filter((jid) => !jaNaFilaSet.has(jid))
    jaNaFila += antes - alvo.length
  }

  if (!alvo.length) {
    return { operacao: null, total: 0, ignorados, jaNaFila, vazio: true }
  }

  // 4) cria cabeçalho da operação
  const { data: op, error: opErr } = await supabase
    .from('comunidade_operacoes')
    .insert({
      company_id: companyId,
      whatsapp_instance_id: instanceId,
      tipo: kind,
      comunidade_id: cid,
      comunidade_nome: comunidadeNome,
      operacao,
      status: 'em_execucao',
      total: alvo.length,
      ignorados,
      criado_por: criadoPor,
    })
    .select()
    .single()
  if (opErr || !op) {
    console.error('[comunidadeFila] criar operação:', opErr?.message)
    return { error: 'Não foi possível criar a operação.' }
  }

  // 5) insere itens em blocos
  const agora = new Date().toISOString()
  const linhas = alvo.map((jid) => ({
    operacao_id: op.id,
    company_id: companyId,
    whatsapp_instance_id: instanceId,
    tipo: kind,
    comunidade_id: cid,
    operacao,
    participante_jid: jid,
    status: 'pendente',
    max_tentativas: maxTentativas,
    proxima_tentativa_em: agora,
    chave_idempotencia: `op:${op.id}:p:${jid}`,
  }))
  for (let i = 0; i < linhas.length; i += INSERT_CHUNK) {
    const slice = linhas.slice(i, i + INSERT_CHUNK)
    const { error } = await supabase.from('comunidade_fila_itens').insert(slice)
    if (error) console.warn('[comunidadeFila] insert itens:', error.message)
  }

  if (io) emitComunidade(io, companyId, EVENTS.OPERACAO_ATUALIZADA, { operacao: op })
  return { operacao: op, total: alvo.length, ignorados, jaNaFila }
}

/**
 * Recalcula contadores da operação e fecha quando não há mais itens ativos.
 * Retorna a operação atualizada.
 */
async function recalcularContadores(operacaoId, io = null, companyId = null) {
  const { data: itens, error } = await supabase
    .from('comunidade_fila_itens')
    .select('status')
    .eq('operacao_id', operacaoId)
  if (error) {
    console.warn('[comunidadeFila] recalcular:', error.message)
    return null
  }
  const cont = { total: itens.length, concluidos: 0, falhados: 0, ignorados: 0, ativos: 0 }
  for (const it of itens) {
    if (it.status === 'concluida') cont.concluidos++
    else if (it.status === 'falhou') cont.falhados++
    else if (it.status === 'ignorada' || it.status === 'cancelada') cont.ignorados++
    else cont.ativos++
  }

  // lê status atual (para não reabrir operação pausada/cancelada manualmente)
  const { data: atual } = await supabase
    .from('comunidade_operacoes')
    .select('status, company_id')
    .eq('id', operacaoId)
    .maybeSingle()
  const cid = companyId || atual?.company_id

  const patch = {
    concluidos: cont.concluidos,
    falhados: cont.falhados,
    updated_at: new Date().toISOString(),
  }
  let concluiu = false
  if (atual && atual.status === 'em_execucao' && cont.ativos === 0) {
    patch.status = cont.falhados > 0 ? 'concluida_com_erros' : 'concluida'
    concluiu = true
  }

  const { data: op } = await supabase
    .from('comunidade_operacoes')
    .update(patch)
    .eq('id', operacaoId)
    .select()
    .single()

  if (io && cid) {
    emitComunidade(io, cid, concluiu ? EVENTS.OPERACAO_CONCLUIDA : EVENTS.OPERACAO_ATUALIZADA, { operacao: op })
  }
  return op
}

/** Pausa/retoma/cancela (admin). Retorna a operação atualizada ou { error }. */
async function alterarStatusOperacao({ io = null, companyId, operacaoId, acao }) {
  const { data: op } = await supabase
    .from('comunidade_operacoes')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', operacaoId)
    .maybeSingle()
  if (!op) return { error: 'Operação não encontrada.', status: 404 }

  const nowIso = new Date().toISOString()
  if (acao === 'pausar') {
    if (op.status !== 'em_execucao') return { error: 'Só é possível pausar uma operação em execução.', status: 409 }
    const { data } = await supabase.from('comunidade_operacoes')
      .update({ status: 'pausada', pausa_motivo: 'manual', updated_at: nowIso })
      .eq('id', operacaoId).select().single()
    if (io) emitComunidade(io, companyId, EVENTS.OPERACAO_PAUSADA, { operacao: data })
    return { operacao: data }
  }
  if (acao === 'retomar') {
    if (op.status !== 'pausada') return { error: 'Só é possível retomar uma operação pausada.', status: 409 }
    const { data } = await supabase.from('comunidade_operacoes')
      .update({ status: 'em_execucao', pausa_motivo: null, updated_at: nowIso })
      .eq('id', operacaoId).select().single()
    if (io) emitComunidade(io, companyId, EVENTS.OPERACAO_ATUALIZADA, { operacao: data })
    return { operacao: data }
  }
  if (acao === 'cancelar') {
    if (['concluida', 'concluida_com_erros', 'cancelada'].includes(op.status)) {
      return { error: 'Operação já finalizada.', status: 409 }
    }
    // cancela itens ainda não terminais
    await supabase.from('comunidade_fila_itens')
      .update({ status: 'cancelada', updated_at: nowIso })
      .eq('operacao_id', operacaoId)
      .in('status', ATIVOS)
    const { data } = await supabase.from('comunidade_operacoes')
      .update({ status: 'cancelada', updated_at: nowIso })
      .eq('id', operacaoId).select().single()
    if (io) emitComunidade(io, companyId, EVENTS.OPERACAO_ATUALIZADA, { operacao: data })
    return { operacao: data }
  }
  return { error: 'Ação inválida.', status: 400 }
}

/**
 * Cancela TODAS as operações não finalizadas de um alvo (ao apagar a comunidade/grupo).
 * Retorna quantas operações foram canceladas.
 */
async function cancelarOperacoesDoAlvo({ io = null, companyId, comunidadeId }) {
  const cid = String(comunidadeId || '').trim()
  if (!cid || !Number.isFinite(Number(companyId))) return 0
  const { data: ops } = await supabase
    .from('comunidade_operacoes')
    .select('id')
    .eq('company_id', companyId)
    .eq('comunidade_id', cid)
    .in('status', ['em_execucao', 'pausada'])
  const ids = (ops || []).map((o) => o.id)
  if (!ids.length) return 0

  const nowIso = new Date().toISOString()
  await supabase
    .from('comunidade_fila_itens')
    .update({ status: 'cancelada', updated_at: nowIso })
    .in('operacao_id', ids)
    .in('status', ATIVOS)
  const { data: atualizadas } = await supabase
    .from('comunidade_operacoes')
    .update({ status: 'cancelada', pausa_motivo: null, updated_at: nowIso })
    .in('id', ids)
    .select()

  if (io) {
    for (const op of atualizadas || []) {
      emitComunidade(io, companyId, EVENTS.OPERACAO_ATUALIZADA, { operacao: op })
    }
  }
  return ids.length
}

/** Pausa automática da operação por sinal de limitação (rate limit/limite). */
async function pausarOperacaoAutomatica({ io = null, companyId, operacaoId, motivo }) {
  const { data } = await supabase.from('comunidade_operacoes')
    .update({ status: 'pausada', pausa_motivo: motivo || 'limite', updated_at: new Date().toISOString() })
    .eq('id', operacaoId)
    .eq('status', 'em_execucao')
    .select()
    .maybeSingle()
  if (data && io) emitComunidade(io, companyId, EVENTS.OPERACAO_PAUSADA, { operacao: data, motivo })
  return data
}

async function listarOperacoes(companyId, { limit = 50 } = {}) {
  const { data } = await supabase
    .from('comunidade_operacoes')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(1, Number(limit) || 50), 200))
  return data || []
}

/** Operações de um ALVO específico (ex.: um grupo @g.us) — para progresso na UI do grupo. */
async function listarOperacoesDoAlvo(companyId, comunidadeId, { limit = 10 } = {}) {
  const { data } = await supabase
    .from('comunidade_operacoes')
    .select('*')
    .eq('company_id', companyId)
    .eq('comunidade_id', String(comunidadeId || '').trim())
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(1, Number(limit) || 10), 50))
  return data || []
}

async function obterOperacao(companyId, operacaoId) {
  const { data: op } = await supabase
    .from('comunidade_operacoes')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', operacaoId)
    .maybeSingle()
  if (!op) return null
  const { data: itens } = await supabase
    .from('comunidade_fila_itens')
    .select('id, participante_jid, status, tentativas, resultado, erro_codigo, erro_mensagem, concluido_em')
    .eq('operacao_id', operacaoId)
    .order('id', { ascending: true })
    .limit(2100)
  return { ...op, itens: itens || [] }
}

module.exports = {
  enfileirarParticipantes,
  recalcularContadores,
  alterarStatusOperacao,
  cancelarOperacoesDoAlvo,
  pausarOperacaoAutomatica,
  listarOperacoes,
  listarOperacoesDoAlvo,
  obterOperacao,
}
