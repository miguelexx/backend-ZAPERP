/**
 * Referência UltraMSG para itens da fila de disparo (disp-{filaItemId}).
 */

function buildDispReferenceId(filaItemId) {
  const id = Number(filaItemId)
  if (!Number.isInteger(id) || id <= 0) return null
  return `disp-${id}`
}

function parseDispReferenceId(ref) {
  const m = String(ref ?? '').trim().match(/^disp-(\d+)$/)
  if (!m) return null
  const id = Number(m[1])
  return Number.isInteger(id) && id > 0 ? id : null
}

module.exports = {
  buildDispReferenceId,
  parseDispReferenceId,
}
