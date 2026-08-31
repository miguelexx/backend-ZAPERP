function buildAlertaSemRespostaResetPatch(assumidaEm) {
  return {
    ultimo_cliente_msg_em: assumidaEm,
    primeiro_alerta_em: null,
    alerta_critico_em: null,
    gestor_notificado_em: null,
    reaberta_em: null,
  }
}

function resolveAlertaSemRespostaCycleAnchor({ ultima, estado = {}, conv = {} } = {}) {
  const ultimaEm = ultima?.criado_em ? String(ultima.criado_em) : null
  if (!ultimaEm) return null

  const ultimoClienteMs = new Date(ultimaEm).getTime()
  const estadoAnchor = estado?.ultimo_cliente_msg_em ? String(estado.ultimo_cliente_msg_em) : null
  const estadoAnchorMs = estadoAnchor ? new Date(estadoAnchor).getTime() : NaN
  const assumidaMs = conv?.atendente_atribuido_em ? new Date(conv.atendente_atribuido_em).getTime() : NaN

  if (
    estadoAnchor &&
    Number.isFinite(estadoAnchorMs) &&
    Number.isFinite(ultimoClienteMs) &&
    Number.isFinite(assumidaMs) &&
    estadoAnchorMs > ultimoClienteMs &&
    Math.abs(estadoAnchorMs - assumidaMs) <= 60 * 1000
  ) {
    return estadoAnchor
  }

  return ultimaEm
}

module.exports = {
  buildAlertaSemRespostaResetPatch,
  resolveAlertaSemRespostaCycleAnchor,
}
