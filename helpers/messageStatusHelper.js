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

/**
 * Status efetivo ao aplicar um ACK sobre o status atual, sem regressão de ticks.
 * Regra geral: vale o de maior rank (ack atrasado "delivered" não regride "read").
 * Exceção: ACK de FALHA explícita do provedor (erro, rank -1) APLICA quando a mensagem
 * ainda não foi confirmada (pending/sending, rank 0) — sem isso o guard de rank engolia
 * o `failed` da Whapi e a bolha ficava no relógio para sempre. Mensagem já sent/delivered/
 * read não regride para erro (falha tardia é ambígua; a reconciliação decide).
 */
function resolveAckEffectiveStatus(current, next) {
  const nextCanon = canonStatusForEmit(next)
  const currentCanon = canonStatusForEmit(current)
  if (nextCanon === 'erro' && statusRank(currentCanon) <= 0) return 'erro'
  return statusRank(currentCanon) > statusRank(nextCanon) ? currentCanon : nextCanon
}

/**
 * Todo valor que a coluna `status` pode legitimamente conter e que `normalizeRawAckStatus`
 * reconhece — canônicos, apelidos de provedor (`server`/`device`), dialeto pt e ACK numérico.
 * Serve para montar a guarda SQL de não-regressão (`statusesQueBloqueiamGravacao`).
 * `tests/messageStatusHelper.test.js` prova que cada item aqui ainda canoniza — se alguém
 * mexer em `normalizeRawAckStatus` e esta lista ficar para trás, o teste quebra.
 */
const STATUS_ALIASES = [
  'pending', 'sending', 'enviando', '0',
  'sent', 'server', 'enviada', 'enviado', '1',
  'delivered', 'device', 'received', 'entregue', 'RECEIVED', '2',
  'read', 'seen', 'lida', 'visualizada', 'read_by_me', '3',
  'played', '4',
  'erro', 'error', 'failed',
]

/**
 * Gravar `novo` sobre `atual` rebaixaria o tique?
 *
 * Definido EM CIMA de `resolveAckEffectiveStatus` de propósito: bloqueio e regra de ACK são a
 * mesma decisão, então não podem divergir. "Bloqueado" = a regra de não-regressão não escolheria
 * `novo`. Status atual desconhecido (ou vazio) nunca bloqueia — a dúvida não pode custar um ACK.
 */
function gravacaoDeStatusBloqueada(atual, novo) {
  if (novo == null || String(novo).trim() === '') return false
  if (atual == null || String(atual).trim() === '') return false
  const novoCanon = canonStatusForEmit(novo)
  return canonStatusForEmit(resolveAckEffectiveStatus(atual, novo)) !== novoCanon
}

/**
 * Valores de `status` que devem IMPEDIR a gravação de `novo` — a lista vai para o `NOT IN` do
 * UPDATE, tornando a decisão atômica (F3 do doc 33: dois ACKs concorrentes — `delivered` e
 * `read` em POSTs paralelos — liam `sent`, e o que gravava por último rebaixava o tique).
 *
 * Só entram apelidos CONHECIDOS e estritamente mais avançados. `NULL` e valor fora da lista
 * ficam de fora, então o `NOT IN` não casa com `NULL` e o chamador precisa do fallback
 * (reler e, se não houver regressão de verdade, gravar sem guarda).
 */
function statusesQueBloqueiamGravacao(novo) {
  return STATUS_ALIASES.filter((alias) => gravacaoDeStatusBloqueada(alias, novo))
}

module.exports = {
  STATUS_RANK,
  STATUS_ALIASES,
  normalizeRawAckStatus,
  normalizeMessageAckStatus,
  canonStatusForEmit,
  statusRank,
  shouldUpgradeStatus,
  resolveAckEffectiveStatus,
  gravacaoDeStatusBloqueada,
  statusesQueBloqueiamGravacao,
}
