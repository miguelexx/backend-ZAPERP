/**
 * Helpers puros de idempotência/deduplicação por `client_temp_id` e detecção de erros de coluna/tabela ausente.
 * Extraído de controllers/chatController.js (Fase 1 da modularização) sem alteração de comportamento.
 *
 * Observação: o mapa de deduplicação em memória, o timer de limpeza e as consultas persistentes
 * (findMensagemByClientTempId) permanecem no controller — dependem de estado de processo e do supabase.
 */

function normalizeClientTempId(value) {
  const normalized = value != null ? String(value).trim().slice(0, 64) : ''
  return normalized || null
}

function clientTempIdDedupeKey(company_id, conversa_id, clientTempId) {
  return `${company_id}:${conversa_id}:${clientTempId}`
}

function isMissingMensagemColumnError(error, columnName) {
  const text = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(' ').toLowerCase()
  return text.includes(String(columnName).toLowerCase())
}

function isGenericMissingColumnError(error) {
  const text = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(' ').toLowerCase()
  return text.includes('does not exist') || text.includes('schema cache') || text.includes('could not find')
}

function isClientTempIdUniqueViolation(error) {
  const text = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(' ').toLowerCase()
  return String(error?.code || '') === '23505' && (
    text.includes('client_temp_id') ||
    text.includes('idx_mensagens_client_temp_id_unique')
  )
}

function buildClientTempIdDedupResponse(row, conversa_id, clientTempId) {
  if (!row?.id) return null
  return {
    ok: true,
    id: row.id,
    conversa_id: Number(row.conversa_id ?? conversa_id),
    client_temp_id: clientTempId,
    status: row.status || row.status_mensagem || 'pending',
    ...(row.whatsapp_id ? { whatsapp_id: row.whatsapp_id } : {}),
    deduplicated: true,
  }
}

module.exports = {
  normalizeClientTempId,
  clientTempIdDedupeKey,
  isMissingMensagemColumnError,
  isGenericMissingColumnError,
  isClientTempIdUniqueViolation,
  buildClientTempIdDedupResponse,
}
