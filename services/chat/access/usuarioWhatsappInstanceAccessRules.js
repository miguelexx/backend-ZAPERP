/**
 * Regra pura da trava de visão por número WhatsApp.
 *
 * null = usuário sem nenhuma marcação: vê como hoje (atendente, admin ou supervisor).
 * Set com ids = vê só conversas (e grupos) desses números.
 * A trava só existe para quem tem pelo menos um número marcado.
 */

function atendentePodeVerNumero(instanciasPermitidas, whatsappInstanceId) {
  if (instanciasPermitidas == null) return true
  const id = Number(whatsappInstanceId)
  if (!Number.isInteger(id) || id <= 0) return false
  return instanciasPermitidas.has(id)
}

/**
 * Restringe a query de conversas. Não altera a query quando não há trava.
 * Se o filtro manual da tela pede um número fora da trava, a lista volta vazia.
 */
function aplicarFiltroNumerosPermitidos(query, instanciasPermitidas, filtroWhatsappInstanceId) {
  if (instanciasPermitidas == null) return query
  const ids = [...instanciasPermitidas].filter((id) => Number.isInteger(Number(id)) && Number(id) > 0).map(Number)
  if (ids.length === 0) return query.in('id', [0])
  const filtro = Number(filtroWhatsappInstanceId)
  if (Number.isInteger(filtro) && filtro > 0) {
    if (!instanciasPermitidas.has(filtro)) return query.in('id', [0])
    return query
  }
  return query.in('whatsapp_instance_id', ids)
}

module.exports = {
  atendentePodeVerNumero,
  aplicarFiltroNumerosPermitidos,
}
