function normalizePositiveId(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function empresaRoom(companyId) {
  const cid = normalizePositiveId(companyId)
  return cid ? `empresa_${cid}` : null
}

function usuarioRoom(usuarioId) {
  const uid = normalizePositiveId(usuarioId)
  return uid ? `usuario_${uid}` : null
}

function conversaRoom(conversaId) {
  const cid = normalizePositiveId(conversaId)
  return cid ? `conversa_${cid}` : null
}

function departamentoRoom(companyId, departamentoId) {
  const cid = normalizePositiveId(companyId)
  const depId = normalizePositiveId(departamentoId)
  return cid && depId ? `empresa_${cid}_departamento_${depId}` : null
}

module.exports = {
  empresaRoom,
  usuarioRoom,
  conversaRoom,
  departamentoRoom,
  normalizePositiveId,
}
