/**
 * Hook de status UltraMSG → fila do Disparo (referenceId disp-{filaItemId}).
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

const FILA_ITEM_SELECT = 'id, company_id, campanha_id, execucao_id, status, reference_id, provider_message_id'

async function carregarItemFila({ filaItemId, referenceId, providerMessageId, companyId }) {
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

  return null
}

/**
 * Aplica ACK de webhook UltraMSG a um item da fila de disparo.
 */
async function aplicarStatusDisparoFromWebhook({
  referenceId,
  providerMessageId,
  status,
  companyId,
  io = null,
}) {
  const ref = String(referenceId ?? '').trim()
  const refDisp = ref.startsWith('disp-')
  const pid = providerMessageId ? String(providerMessageId).trim() : ''

  if (!refDisp && !pid) {
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

module.exports = {
  aplicarStatusDisparoFromWebhook,
  mapAckToFilaStatus,
}
