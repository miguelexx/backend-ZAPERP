/**
 * Emissão Socket.IO para o módulo Comunidades.
 * Emite para a sala da empresa (empresa_{companyId}); o front filtra por company_id.
 */

const EVENTS = {
  OPERACAO_ATUALIZADA: 'comunidade_operacao_atualizada',
  ITEM_ATUALIZADO: 'comunidade_item_atualizado',
  OPERACAO_CONCLUIDA: 'comunidade_operacao_concluida',
  OPERACAO_PAUSADA: 'comunidade_operacao_pausada',
  COMUNIDADE_ATUALIZADA: 'comunidade_atualizada',
}

function emitComunidade(io, companyId, event, payload) {
  if (!io || !companyId) return
  io.to(`empresa_${Number(companyId)}`).emit(event, {
    ...payload,
    company_id: Number(companyId),
    ts: new Date().toISOString(),
  })
}

module.exports = {
  emitComunidade,
  EVENTS,
}
