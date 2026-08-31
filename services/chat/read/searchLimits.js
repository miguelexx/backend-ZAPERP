/**
 * Limites configuráveis (via env) da busca de conversas/mensagens.
 * Extraído de controllers/chatController.js (Fase 1 da modularização) sem alteração de comportamento.
 */

function getSearchMessagesPageSize() {
  const raw = Number(process.env.CHAT_SEARCH_MESSAGES_PAGE_SIZE)
  if (!Number.isFinite(raw) || raw <= 0) return 1000
  return Math.min(Math.max(Math.floor(raw), 100), 5000)
}

function getChatSearchScanLimit() {
  const raw = Number(process.env.CHAT_SEARCH_SCAN_LIMIT)
  if (!Number.isFinite(raw) || raw <= 0) return 2000
  return Math.min(Math.max(Math.floor(raw), 100), 2000)
}

function getChatSearchIdLimit() {
  const raw = Number(process.env.CHAT_SEARCH_ID_LIMIT)
  if (!Number.isFinite(raw) || raw <= 0) return 1000
  return Math.min(Math.max(Math.floor(raw), 100), 3000)
}

function getChatFilterIdLimit() {
  const raw = Number(process.env.CHAT_FILTER_ID_LIMIT)
  if (!Number.isFinite(raw) || raw <= 0) return 2000
  return Math.min(Math.max(Math.floor(raw), 100), 5000)
}

function getConversaMessagesSearchLimit(rawLimit) {
  const raw = Number(rawLimit)
  if (!Number.isFinite(raw) || raw <= 0) return 30
  return Math.min(Math.max(Math.floor(raw), 1), 100)
}

module.exports = {
  getSearchMessagesPageSize,
  getChatSearchScanLimit,
  getChatSearchIdLimit,
  getChatFilterIdLimit,
  getConversaMessagesSearchLimit,
}
