/**
 * Normalização de status de mensagem (ACK UltraMSG / Z-API / CRM).
 * Valores canônicos: pending, sent, delivered, read, played, erro
 */

const STATUS_RANK = { pending: 0, sending: 0, sent: 1, delivered: 2, read: 3, played: 4, erro: -1, failed: -1 }

const CANONICAL_STATUSES = new Set(['pending', 'sending', 'sent', 'delivered', 'read', 'played', 'erro', 'failed'])

function normalizeRawAckStatus(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return null

  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (n <= 0) return 'pending'
    if (n === 1) return 'sent'
    if (n === 2) return 'delivered'
    if (n === 3) return 'read'
    if (n >= 4) return 'played'
  }

  // UltraMSG: pending, server, device, read, played
  if (s === 'server' || s === 'sent' || s === 'enviada' || s === 'enviado') return 'sent'
  if (s === 'device' || s === 'delivered' || s === 'received' || s === 'entregue') return 'delivered'
  if (s === 'read' || s === 'read_by_me' || s === 'seen' || s === 'visualizada' || s === 'lida') return 'read'
  if (s === 'played') return 'played'
  if (s === 'pending' || s === 'enviando' || s === 'sending') return 'pending'
  if (s === 'erro' || s === 'error' || s === 'failed') return 'erro'

  if (CANONICAL_STATUSES.has(s)) {
    if (s === 'failed') return 'erro'
    if (s === 'sending') return 'pending'
    return s
  }

  return null
}

/**
 * Normaliza status a partir do body de webhook (ACK/status).
 * Prioriza body.status já mapeado (ex.: ultramsgController) e depois body.ack bruto.
 */
function normalizeMessageAckStatus(body) {
  if (!body || typeof body !== 'object') return null

  const statusField = String(body.status ?? '').trim().toLowerCase()
  if (statusField) {
    const fromStatus = normalizeRawAckStatus(statusField)
    if (fromStatus) return fromStatus
  }

  if (body.ack != null) {
    const fromAck = normalizeRawAckStatus(body.ack)
    if (fromAck) return fromAck
  }

  return null
}

/** Status canônico para emitir ao frontend (ticks ✓ / ✓✓). */
function canonStatusForEmit(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  const norm = normalizeRawAckStatus(s)
  if (norm) return norm
  return s || 'pending'
}

function statusRank(status) {
  const s = canonStatusForEmit(status)
  return STATUS_RANK[s] ?? -1
}

function shouldUpgradeStatus(current, next) {
  return statusRank(next) >= statusRank(current)
}

module.exports = {
  STATUS_RANK,
  normalizeRawAckStatus,
  normalizeMessageAckStatus,
  canonStatusForEmit,
  statusRank,
  shouldUpgradeStatus,
}
