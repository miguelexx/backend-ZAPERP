/**
 * Reconciliação manual de itens incertos — Etapa 8 Disparo.
 * Nunca reenvia mensagens automaticamente.
 */

const supabase = require('../config/supabase')
const { buildDispReferenceId } = require('../helpers/disparoReferenceHelper')
const { podeAvancarStatusFila, calcularProximaTentativa } = require('../helpers/disparoFilaRetryHelper')
const { normalizeRawAckStatus } = require('../helpers/messageStatusHelper')
const { recalcularContadores } = require('./disparoFilaService')
const { emitDisparo, EVENTS } = require('./disparoSocketService')

const FILA_ITEM_SELECT = [
  'id', 'company_id', 'campanha_id', 'execucao_id', 'status',
  'reference_id', 'provider_message_id', 'mensagem_id', 'conversa_id',
  'tentativas', 'max_tentativas', 'enviado_em', 'entregue_em', 'lido_em', 'falhou_em',
  'erro_codigo', 'erro_mensagem', 'erro_classificacao',
].join(', ')

const MENSAGEM_SELECT = 'id, status, status_mensagem, whatsapp_id, direcao, criado_em'

const DECISOES_VALIDAS = new Set(['enviada', 'falhou', 'reatentar', 'manter_incerta'])

function mapAckToFilaStatus(ack) {
  switch (ack) {
    case 'sent':
      return 'enviada'
    case 'delivered':
      return 'entregue'
    case 'read':
    case 'played':
      return 'lida'
    case 'erro':
    case 'failed':
      return 'falhou'
    default:
      return null
  }
}

function timestampsParaStatus(novoStatus, agora) {
  const patch = { atualizado_em: agora }
  if (novoStatus === 'enviada') patch.enviado_em = agora
  if (novoStatus === 'entregue') patch.entregue_em = agora
  if (novoStatus === 'lida') patch.lido_em = agora
  if (novoStatus === 'falhou') patch.falhou_em = agora
  return patch
}

async function carregarItemFila(filaItemId, companyId) {
  const { data, error } = await supabase
    .from('disparo_fila_itens')
    .select(FILA_ITEM_SELECT)
    .eq('id', filaItemId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function buscarMensagensEvidencia(item, companyId) {
  const evidencias = []
  const cid = Number(companyId)

  if (item.mensagem_id) {
    const { data, error } = await supabase
      .from('mensagens')
      .select(MENSAGEM_SELECT)
      .eq('id', item.mensagem_id)
      .eq('company_id', cid)
      .maybeSingle()
    if (error) throw error
    if (data) evidencias.push({ origem: 'mensagem_id', mensagem: data })
  }

  const pid = item.provider_message_id ? String(item.provider_message_id).trim() : ''
  if (pid) {
    const { data, error } = await supabase
      .from('mensagens')
      .select(MENSAGEM_SELECT)
      .eq('company_id', cid)
      .eq('whatsapp_id', pid)
      .order('id', { ascending: false })
      .limit(3)
    if (error) throw error
    for (const m of data ?? []) {
      if (!evidencias.some((e) => e.mensagem?.id === m.id)) {
        evidencias.push({ origem: 'provider_message_id', mensagem: m })
      }
    }
  }

  const ref = item.reference_id || buildDispReferenceId(item.id)
  if (ref) {
    const { data, error } = await supabase
      .from('disparo_fila_itens')
      .select('id, mensagem_id, provider_message_id, reference_id, status')
      .eq('company_id', cid)
      .eq('reference_id', ref)
      .neq('id', item.id)
      .limit(1)
    if (error) throw error
    if (data?.length) {
      evidencias.push({ origem: 'reference_id_duplicado', conflito: data[0] })
    }
  }

  return evidencias
}

function analisarEvidencias(item, evidencias) {
  const resultado = {
    resultado: 'ainda_incerta',
    status_sugerido: null,
    evidencias: [],
    motivo: null,
  }

  const conflitoRef = evidencias.find((e) => e.origem === 'reference_id_duplicado')
  if (conflitoRef) {
    return {
      ...resultado,
      resultado: 'exige_manual',
      motivo: 'reference_id associado a outro item da fila',
      evidencias,
    }
  }

  const mensagens = evidencias
    .filter((e) => e.mensagem)
    .map((e) => ({ ...e.mensagem, origem_busca: e.origem }))

  if (!mensagens.length) {
    if (item.provider_message_id || item.mensagem_id) {
      return {
        ...resultado,
        resultado: 'exige_manual',
        motivo: 'IDs registrados na fila, mas mensagem não encontrada no banco',
        evidencias,
      }
    }
    return {
      ...resultado,
      motivo: 'Sem mensagem vinculada ou ID do provedor',
      evidencias,
    }
  }

  const acks = mensagens.map((m) => ({
    id: m.id,
    ack: normalizeRawAckStatus(m.status_mensagem || m.status),
    origem_busca: m.origem_busca,
  }))

  const falhas = acks.filter((a) => a.ack === 'erro' || a.ack === 'failed')
  const confirmadas = acks.filter((a) => ['sent', 'delivered', 'read', 'played'].includes(a.ack))
  const pendentes = acks.filter((a) => !a.ack || a.ack === 'pending' || a.ack === 'sending')

  if (falhas.length && confirmadas.length) {
    return {
      ...resultado,
      resultado: 'exige_manual',
      motivo: 'Evidências conflitantes (falha e confirmação de envio)',
      evidencias: acks,
    }
  }

  if (falhas.length) {
    return {
      ...resultado,
      resultado: 'confirmada_falha',
      status_sugerido: 'falhou',
      motivo: 'Mensagem registrada com status de falha',
      evidencias: acks,
    }
  }

  if (confirmadas.length) {
    const melhorAck = confirmadas.reduce((best, cur) => {
      const rank = { sent: 1, delivered: 2, read: 3, played: 4 }
      return (rank[cur.ack] ?? 0) >= (rank[best.ack] ?? 0) ? cur : best
    })
    const statusSugerido = mapAckToFilaStatus(melhorAck.ack)
    return {
      ...resultado,
      resultado: 'confirmada_enviada',
      status_sugerido: statusSugerido,
      motivo: `Mensagem com ACK ${melhorAck.ack}`,
      evidencias: acks,
    }
  }

  if (pendentes.length) {
    return {
      ...resultado,
      resultado: 'ainda_incerta',
      motivo: 'Mensagem encontrada, mas ainda sem confirmação definitiva',
      evidencias: acks,
    }
  }

  return {
    ...resultado,
    resultado: 'exige_manual',
    motivo: 'Status da mensagem não classificável',
    evidencias: acks,
  }
}

/**
 * Analisa um item incerto — não altera a fila e nunca reenvia.
 */
async function reconciliarItem(filaItemId, companyId) {
  const cid = Number(companyId)
  const itemId = Number(filaItemId)
  if (!cid || !itemId) {
    throw Object.assign(new Error('Parâmetros inválidos.'), { code: 'PARAMS_INVALIDOS' })
  }

  const item = await carregarItemFila(itemId, cid)
  if (!item) {
    throw Object.assign(new Error('Item da fila não encontrado.'), { code: 'ITEM_NAO_ENCONTRADO' })
  }

  if (item.status !== 'incerta') {
    return {
      fila_item_id: item.id,
      status_atual: item.status,
      resultado: 'ignorado',
      motivo: 'Item não está com status incerta',
    }
  }

  const evidencias = await buscarMensagensEvidencia(item, cid)
  const analise = analisarEvidencias(item, evidencias)

  return {
    fila_item_id: item.id,
    execucao_id: item.execucao_id,
    campanha_id: item.campanha_id,
    status_atual: item.status,
    reference_id: item.reference_id || buildDispReferenceId(item.id),
    provider_message_id: item.provider_message_id,
    mensagem_id: item.mensagem_id,
    ...analise,
  }
}

async function aplicarReconciliacaoAutomatica(item, analise, io = null) {
  if (!['confirmada_enviada', 'confirmada_falha'].includes(analise.resultado)) {
    return { aplicado: false, analise }
  }

  const novoStatus = analise.status_sugerido
  if (!novoStatus || !podeAvancarStatusFila(item.status, novoStatus)) {
    return { aplicado: false, analise, motivo: 'Transição de status não permitida' }
  }

  const agora = new Date().toISOString()
  const updates = {
    status: novoStatus,
    ...timestampsParaStatus(novoStatus, agora),
  }

  const { error } = await supabase
    .from('disparo_fila_itens')
    .update(updates)
    .eq('id', item.id)
    .eq('company_id', item.company_id)
    .eq('status', 'incerta')
  if (error) throw error

  await recalcularContadores(item.execucao_id, item.company_id)

  emitDisparo(io, item.company_id, EVENTS.RECONCILIADO, {
    campanha_id: item.campanha_id,
    execucao_id: item.execucao_id,
    fila_item_id: item.id,
    status: novoStatus,
    origem: 'reconciliacao_automatica',
    resultado: analise.resultado,
  })

  emitDisparo(io, item.company_id, EVENTS.ITEM_ATUALIZADO, {
    campanha_id: item.campanha_id,
    execucao_id: item.execucao_id,
    item_id: item.id,
    status: novoStatus,
    origem: 'reconciliacao',
  })

  return { aplicado: true, analise, status: novoStatus }
}

/**
 * Reconcilia em lote itens incertos de uma execução.
 */
async function reconciliarExecucao(execucaoId, companyId, { limit = 50, io = null } = {}) {
  const cid = Number(companyId)
  const execId = Number(execucaoId)
  const lim = Math.min(200, Math.max(1, Number(limit) || 50))

  const { data: itens, error } = await supabase
    .from('disparo_fila_itens')
    .select('id')
    .eq('execucao_id', execId)
    .eq('company_id', cid)
    .eq('status', 'incerta')
    .order('atualizado_em', { ascending: true })
    .limit(lim)
  if (error) throw error

  const resultados = []
  for (const row of itens ?? []) {
    const analise = await reconciliarItem(row.id, cid)
    if (analise.resultado === 'ignorado') {
      resultados.push(analise)
      continue
    }

    const item = await carregarItemFila(row.id, cid)
    const aplicacao = await aplicarReconciliacaoAutomatica(item, analise, io)
    resultados.push({
      ...analise,
      aplicado: aplicacao.aplicado,
      status_final: aplicacao.status ?? item.status,
    })
  }

  return {
    execucao_id: execId,
    processados: resultados.length,
    resumo: {
      confirmada_enviada: resultados.filter((r) => r.resultado === 'confirmada_enviada').length,
      confirmada_falha: resultados.filter((r) => r.resultado === 'confirmada_falha').length,
      ainda_incerta: resultados.filter((r) => r.resultado === 'ainda_incerta').length,
      exige_manual: resultados.filter((r) => r.resultado === 'exige_manual').length,
      aplicados: resultados.filter((r) => r.aplicado).length,
    },
    itens: resultados,
  }
}

async function listarIncertos(campanhaId, companyId, { page = 1, limit = 50 } = {}) {
  const cid = Number(companyId)
  const campId = Number(campanhaId)
  const pg = Math.max(1, Number(page) || 1)
  const lim = Math.min(200, Math.max(1, Number(limit) || 50))
  const offset = (pg - 1) * lim

  const { data, error, count } = await supabase
    .from('disparo_fila_itens')
    .select(FILA_ITEM_SELECT, { count: 'exact' })
    .eq('company_id', cid)
    .eq('campanha_id', campId)
    .eq('status', 'incerta')
    .order('atualizado_em', { ascending: false })
    .range(offset, offset + lim - 1)
  if (error) throw error

  return {
    page: pg,
    limit: lim,
    total: count ?? 0,
    total_pages: Math.ceil((count ?? 0) / lim) || 0,
    itens: data ?? [],
  }
}

/**
 * Registra decisão manual sobre item incerto.
 */
async function registrarDecisaoManual({
  companyId,
  filaItemId,
  decisao,
  justificativa,
  usuarioId,
  evidencias = {},
  autorizarRetentativa = false,
  io = null,
}) {
  const cid = Number(companyId)
  const itemId = Number(filaItemId)
  const dec = String(decisao ?? '').trim().toLowerCase()
  const just = String(justificativa ?? '').trim()

  if (!cid || !itemId) {
    throw Object.assign(new Error('Parâmetros inválidos.'), { code: 'PARAMS_INVALIDOS' })
  }
  if (!DECISOES_VALIDAS.has(dec)) {
    throw Object.assign(new Error('Decisão inválida.'), { code: 'DECISAO_INVALIDA' })
  }
  if (!just) {
    throw Object.assign(new Error('Justificativa obrigatória.'), { code: 'JUSTIFICATIVA_OBRIGATORIA' })
  }

  const item = await carregarItemFila(itemId, cid)
  if (!item) {
    throw Object.assign(new Error('Item da fila não encontrado.'), { code: 'ITEM_NAO_ENCONTRADO' })
  }
  if (item.status !== 'incerta') {
    throw Object.assign(new Error('Decisão manual só se aplica a itens incertos.'), { code: 'STATUS_INVALIDO' })
  }

  const agora = new Date().toISOString()
  let novoStatus = item.status
  const updates = { atualizado_em: agora }

  if (dec === 'enviada') {
    novoStatus = 'enviada'
  } else if (dec === 'falhou') {
    novoStatus = 'falhou'
  } else if (dec === 'manter_incerta') {
    novoStatus = 'incerta'
  } else if (dec === 'reatentar') {
    const evidenciaNaoAceita = evidencias?.nao_aceita === true
      || evidencias?.mensagem_nao_aceita === true
      || evidencias?.confirmado_nao_enviado === true

    if (!evidenciaNaoAceita && !autorizarRetentativa) {
      throw Object.assign(
        new Error('Reatentar exige evidência de que a mensagem não foi aceita ou flag autorizarRetentativa.'),
        { code: 'EVIDENCIA_REATENTAR' },
      )
    }

    if (item.tentativas >= item.max_tentativas) {
      throw Object.assign(new Error('Limite de tentativas atingido.'), { code: 'MAX_TENTATIVAS' })
    }

    novoStatus = 'pendente'
    updates.tentativas = item.tentativas
    updates.proxima_tentativa_em = calcularProximaTentativa({
      tentativas: item.tentativas + 1,
      agora: Date.now(),
    })
    updates.worker_id = null
    updates.lease_inicio = null
    updates.lease_ate = null
  }

  if (dec !== 'manter_incerta' && dec !== 'reatentar') {
    if (!podeAvancarStatusFila(item.status, novoStatus)) {
      throw Object.assign(
        new Error(`Transição de status não permitida: ${item.status} → ${novoStatus}`),
        { code: 'TRANSICAO_INVALIDA' },
      )
    }
    Object.assign(updates, timestampsParaStatus(novoStatus, agora))
  }
  if (novoStatus !== item.status) {
    updates.status = novoStatus
  }

  const { data: decisaoRow, error: insErr } = await supabase
    .from('disparo_reconciliacao_decisoes')
    .insert({
      company_id: cid,
      fila_item_id: item.id,
      execucao_id: item.execucao_id,
      decisao: dec,
      justificativa: just.slice(0, 2000),
      evidencias: evidencias ?? {},
      usuario_id: usuarioId ?? null,
    })
    .select('id, decisao, criado_em')
    .single()
  if (insErr) throw insErr

  if (Object.keys(updates).length > 1) {
    const { error: updErr } = await supabase
      .from('disparo_fila_itens')
      .update(updates)
      .eq('id', item.id)
      .eq('company_id', cid)
    if (updErr) throw updErr

    await recalcularContadores(item.execucao_id, cid)

    emitDisparo(io, cid, EVENTS.RECONCILIADO, {
      campanha_id: item.campanha_id,
      execucao_id: item.execucao_id,
      fila_item_id: item.id,
      status: novoStatus,
      decisao: dec,
      origem: 'decisao_manual',
      decisao_id: decisaoRow.id,
    })

    if (novoStatus !== item.status) {
      emitDisparo(io, cid, EVENTS.ITEM_ATUALIZADO, {
        campanha_id: item.campanha_id,
        execucao_id: item.execucao_id,
        item_id: item.id,
        status: novoStatus,
        origem: 'decisao_manual',
      })
    }
  }

  return {
    ok: true,
    decisao_id: decisaoRow.id,
    fila_item_id: item.id,
    decisao: dec,
    status: novoStatus,
  }
}

module.exports = {
  reconciliarItem,
  reconciliarExecucao,
  registrarDecisaoManual,
  listarIncertos,
  analisarEvidencias,
  mapAckToFilaStatus,
}
