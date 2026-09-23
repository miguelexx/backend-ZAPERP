'use strict'

/**
 * Cálculo do prazo do alarme "Aguardar cliente".
 * Espelha a ideia do fluxo financeiro (conversaPagamentoFinanceiroService), mas
 * com opções próprias voltadas ao acompanhamento de resposta do cliente.
 */

const PRAZOS_VALIDOS = new Set(['1h', '2h', '4h', 'hoje', 'amanha', 'data'])

function endOfLocalDay(date) {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d
}

/**
 * @param {string} prazo - 1h | 2h | 4h | hoje | amanha | data
 * @param {string} [dataIso] - YYYY-MM-DD quando prazo=data
 * @returns {Date|null}
 */
function calcularAguardarClientePrazoAte(prazo, dataIso) {
  const key = String(prazo || '').trim().toLowerCase()
  const now = new Date()

  if (key === '1h') return new Date(now.getTime() + 1 * 60 * 60 * 1000)
  if (key === '2h') return new Date(now.getTime() + 2 * 60 * 60 * 1000)
  if (key === '4h') return new Date(now.getTime() + 4 * 60 * 60 * 1000)
  if (key === 'hoje') return endOfLocalDay(now)
  if (key === 'amanha') {
    const amanha = new Date(now)
    amanha.setDate(amanha.getDate() + 1)
    return endOfLocalDay(amanha)
  }
  if (key === 'data') {
    const raw = String(dataIso || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
    const parsed = new Date(`${raw}T12:00:00`)
    if (Number.isNaN(parsed.getTime())) return null
    return endOfLocalDay(parsed)
  }
  return null
}

module.exports = {
  PRAZOS_VALIDOS,
  calcularAguardarClientePrazoAte,
}
