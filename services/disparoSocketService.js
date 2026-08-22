/**
 * Emissão Socket.IO para eventos do módulo Disparo (Etapa 7).
 */

const EVENTS = {
  CAMPANHA_INICIADA: 'disparo_campanha_iniciada',
  CAMPANHA_PAUSADA: 'disparo_campanha_pausada',
  CAMPANHA_RETOMADA: 'disparo_campanha_retomada',
  CAMPANHA_CANCELADA: 'disparo_campanha_cancelada',
  CAMPANHA_CONCLUIDA: 'disparo_campanha_concluida',
  ITEM_ATUALIZADO: 'disparo_item_atualizado',
  INSTANCIA_DESCONECTADA: 'disparo_instancia_desconectada',
  LIMITE_ATINGIDO: 'disparo_limite_atingido',
}

function emitDisparo(io, companyId, event, payload) {
  if (!io || !companyId) return
  io.to(`empresa_${Number(companyId)}`).emit(event, {
    ...payload,
    company_id: Number(companyId),
    ts: new Date().toISOString(),
  })
}

module.exports = {
  emitDisparo,
  EVENTS,
}
