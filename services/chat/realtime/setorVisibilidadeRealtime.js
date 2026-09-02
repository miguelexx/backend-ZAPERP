/**
 * Realtime de mudança de setor: quem perdeu visibilidade precisa do payload para
 * dropar o card. `emitirEventoConversaVisivel` só entrega a quem ainda pode ver.
 *
 * Payload enxuto — sem preview de mensagem — para não vazar conteúdo cross-setor.
 * Rooms: empresa (todos os sockets da tenant), conversa, departamento antigo e novo.
 */

function normalizeSetorRealtimeId(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeAtendenteRealtimeId(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function setorRealtimeMudou(anterior, proximo) {
  return normalizeSetorRealtimeId(anterior) !== normalizeSetorRealtimeId(proximo)
}

function buildMudancaSetorRealtimePayload({
  company_id,
  conversa_id,
  departamento_id,
  atendente_id,
  status_atendimento,
  motivo,
} = {}) {
  const payload = {
    id: Number(conversa_id),
    company_id: Number(company_id),
    departamento_id: normalizeSetorRealtimeId(departamento_id),
    atendente_id: normalizeAtendenteRealtimeId(atendente_id),
    lista_realtime: { minha_fila: true, motivo: motivo || 'setor_direcionado' },
    reordenar_suave: true,
  }
  if (status_atendimento != null && String(status_atendimento).trim() !== '') {
    payload.status_atendimento = status_atendimento
  }
  return payload
}

function roomsMudancaSetorRealtime({
  company_id,
  conversa_id,
  departamento_id,
  departamentoIdAnterior,
} = {}) {
  const rooms = [`empresa_${Number(company_id)}`, `conversa_${Number(conversa_id)}`]
  const antigo = normalizeSetorRealtimeId(departamentoIdAnterior)
  const novo = normalizeSetorRealtimeId(departamento_id)
  if (antigo != null) rooms.push(`departamento_${antigo}`)
  if (novo != null && novo !== antigo) rooms.push(`departamento_${novo}`)
  return rooms
}

/**
 * Emite `conversa_atualizada` para quem perdeu e para quem ganhou o setor.
 * Não emite `nova_mensagem` (evita vazar o texto da conversa).
 * @returns {boolean} true se emitiu
 */
function emitirMudancaSetorRealtime(io, company_id, conversa_id, opts = {}) {
  if (!io || company_id == null || conversa_id == null) return false
  if (!setorRealtimeMudou(opts.departamentoIdAnterior, opts.departamento_id)) return false
  const payload = buildMudancaSetorRealtimePayload({
    company_id,
    conversa_id,
    departamento_id: opts.departamento_id,
    atendente_id: opts.atendente_id,
    status_atendimento: opts.status_atendimento,
    motivo: opts.motivo,
  })
  const eventName = io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada'
  const rooms = roomsMudancaSetorRealtime({
    company_id,
    conversa_id,
    departamento_id: opts.departamento_id,
    departamentoIdAnterior: opts.departamentoIdAnterior,
  })
  for (const room of rooms) {
    io.to(room).emit(eventName, payload)
  }
  return true
}

module.exports = {
  normalizeSetorRealtimeId,
  normalizeAtendenteRealtimeId,
  setorRealtimeMudou,
  buildMudancaSetorRealtimePayload,
  roomsMudancaSetorRealtime,
  emitirMudancaSetorRealtime,
}
