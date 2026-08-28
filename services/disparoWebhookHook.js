/**
 * Hook de status UltraMSG → fila do Disparo.
 * Casa por disp-{filaItemId}, provider_message_id ou mensagem_id do chat.
 */

const supabase = require('../config/supabase')
const { parseDispReferenceId } = require('../helpers/disparoReferenceHelper')
const { podeAvancarStatusFila } = require('../helpers/disparoFilaRetryHelper')
const { normalizeRawAckStatus } = require('../helpers/messageStatusHelper')
const { recalcularContadores } = require('./disparoFilaService')
const { emitDisparo, EVENTS } = require('./disparoSocketService')

function mapAckToFilaStatus(rawStatus) {
  const ack = normalizeRawAckStatus(rawStatus)
  if (!ack) return null
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

const FILA_ITEM_SELECT = 'id, company_id, campanha_id, execucao_id, status, reference_id, provider_message_id, mensagem_id, entregue_em'

async function carregarItemFila({ filaItemId, referenceId, providerMessageId, mensagemId, companyId }) {
  const cid = Number(companyId)
  if (!cid) return null

  if (filaItemId) {
    const { data, error } = await supabase
      .from('disparo_fila_itens')
      .select(FILA_ITEM_SELECT)
      .eq('id', filaItemId)
      .eq('company_id', cid)
      .maybeSingle()
    if (error) throw error
    return data
  }

  if (referenceId) {
    const { data, error } = await supabase
      .from('disparo_fila_itens')
      .select(FILA_ITEM_SELECT)
      .eq('reference_id', referenceId)
      .eq('company_id', cid)
      .maybeSingle()
    if (error) throw error
    return data
  }

  if (providerMessageId) {
    const pid = String(providerMessageId).trim()
    if (pid) {
      const { data, error } = await supabase
        .from('disparo_fila_itens')
        .select(FILA_ITEM_SELECT)
        .eq('provider_message_id', pid)
        .eq('company_id', cid)
        .maybeSingle()
      if (error) throw error
      return data
    }
  }

  if (mensagemId) {
    const mid = Number(mensagemId)
    if (Number.isInteger(mid) && mid > 0) {
      const { data, error } = await supabase
        .from('disparo_fila_itens')
        .select(FILA_ITEM_SELECT)
        .eq('mensagem_id', mid)
        .eq('company_id', cid)
        .maybeSingle()
      if (error) throw error
      return data
    }
  }

  return null
}

/**
 * Aplica ACK de webhook UltraMSG a um item da fila de disparo.
 * Casa por disp-{id}, id do provedor ou mensagem do chat — o ACK quase nunca ecoa referenceId.
 */
async function aplicarStatusDisparoFromWebhook({
  referenceId,
  providerMessageId,
  mensagemId,
  status,
  companyId,
  io = null,
}) {
  const ref = String(referenceId ?? '').trim()
  const refDisp = ref.startsWith('disp-')
  const pid = providerMessageId ? String(providerMessageId).trim() : ''
  const mid = mensagemId != null && Number(mensagemId) > 0 ? Number(mensagemId) : null

  if (!refDisp && !pid && !mid) {
    return { ok: false, ignored: 'not_disp_reference' }
  }

  const filaItemIdFromRef = refDisp ? parseDispReferenceId(ref) : null
  if (refDisp && !filaItemIdFromRef) {
    return { ok: false, ignored: 'invalid_reference' }
  }

  const novoStatus = mapAckToFilaStatus(status)
  if (!novoStatus) return { ok: false, ignored: 'status_not_mapped', status }

  let item = null
  if (filaItemIdFromRef) {
    item = await carregarItemFila({ filaItemId: filaItemIdFromRef, referenceId: ref, companyId })
  }
  if (!item && pid) {
    item = await carregarItemFila({ providerMessageId: pid, companyId })
  }
  if (!item && mid) {
    item = await carregarItemFila({ mensagemId: mid, companyId })
  }
  if (!item) {
    return { ok: false, ignored: 'item_not_found', filaItemId: filaItemIdFromRef ?? null }
  }

  if (!podeAvancarStatusFila(item.status, novoStatus)) {
    return {
      ok: true,
      ignored: 'status_no_upgrade',
      item_id: item.id,
      status_atual: item.status,
      status_recebido: novoStatus,
    }
  }

  const agora = new Date().toISOString()
  const updates = {
    status: novoStatus,
    ...timestampsParaStatus(novoStatus, agora),
  }

  if (novoStatus === 'lida' && !item.entregue_em) {
    updates.entregue_em = agora
  }
  if (providerMessageId && !item.provider_message_id) {
    updates.provider_message_id = String(providerMessageId)
  }
  if (!item.reference_id && refDisp) {
    updates.reference_id = ref
  }

  const { data: atualizado, error } = await supabase
    .from('disparo_fila_itens')
    .update(updates)
    .eq('id', item.id)
    .eq('company_id', item.company_id)
    .select('id, campanha_id, execucao_id, status')
    .maybeSingle()
  if (error) throw error
  if (!atualizado) return { ok: false, ignored: 'update_failed' }

  await recalcularContadores(item.execucao_id, item.company_id)

  emitDisparo(io, item.company_id, EVENTS.ITEM_ATUALIZADO, {
    campanha_id: item.campanha_id,
    execucao_id: item.execucao_id,
    item_id: item.id,
    status: novoStatus,
    origem: 'webhook',
  })

  return {
    ok: true,
    item_id: item.id,
    status: novoStatus,
    execucao_id: item.execucao_id,
  }
}

function ackDaMensagem(msg) {
  if (!msg) return null
  return msg.status_mensagem || msg.status || null
}

/**
 * Alinha itens `enviada` da fila com o ACK já gravado em `mensagens` (ticks do chat).
 * Cobre recibos que chegaram antes do hook da campanha passar a olhar o id do provedor.
 */
async function sincronizarFilaComAckDoChat({ execucaoId, companyId, io = null, limit = 40 } = {}) {
  const cid = Number(companyId)
  const eid = Number(execucaoId)
  if (!cid || !eid) return { ok: false, ignored: 'params' }

  const cap = Math.min(80, Math.max(1, Number(limit) || 40))
  const { data: itens, error } = await supabase
    .from('disparo_fila_itens')
    .select('id, company_id, campanha_id, execucao_id, status, provider_message_id, mensagem_id')
    .eq('execucao_id', eid)
    .eq('company_id', cid)
    .eq('status', 'enviada')
    .limit(cap)
  if (error) throw error
  if (!Array.isArray(itens) || !itens.length) return { ok: true, atualizados: 0 }

  const mensagemIds = [...new Set(itens.map((i) => i.mensagem_id).filter(Boolean))]
  const pids = [...new Set(
    itens
      .map((i) => String(i.provider_message_id || '').trim())
      .filter((p) => p && !p.startsWith('dry-')),
  )]

  const porMensagemId = new Map()
  const porWhatsappId = new Map()

  if (mensagemIds.length) {
    const { data: msgs, error: e1 } = await supabase
      .from('mensagens')
      .select('id, status, status_mensagem, whatsapp_id')
      .eq('company_id', cid)
      .in('id', mensagemIds)
    if (e1) throw e1
    for (const m of msgs || []) porMensagemId.set(m.id, m)
  }

  if (pids.length) {
    const { data: msgs, error: e2 } = await supabase
      .from('mensagens')
      .select('id, status, status_mensagem, whatsapp_id')
      .eq('company_id', cid)
      .in('whatsapp_id', pids)
    if (e2) throw e2
    for (const m of msgs || []) {
      if (m.whatsapp_id) porWhatsappId.set(String(m.whatsapp_id), m)
    }
  }

  let atualizados = 0
  for (const item of itens) {
    const msg = (item.mensagem_id && porMensagemId.get(item.mensagem_id))
      || (item.provider_message_id && porWhatsappId.get(String(item.provider_message_id)))
    const ack = ackDaMensagem(msg)
    const novo = mapAckToFilaStatus(ack)
    if (!novo || novo === 'enviada') continue

    const r = await aplicarStatusDisparoFromWebhook({
      providerMessageId: item.provider_message_id || msg?.whatsapp_id || null,
      mensagemId: item.mensagem_id || msg?.id || null,
      status: ack,
      companyId: cid,
      io,
    })
    if (r.ok && r.status && r.status !== 'enviada' && r.ignored !== 'status_no_upgrade') {
      atualizados += 1
    }
  }

  return { ok: true, atualizados }
}

module.exports = {
  aplicarStatusDisparoFromWebhook,
  sincronizarFilaComAckDoChat,
  mapAckToFilaStatus,
}
