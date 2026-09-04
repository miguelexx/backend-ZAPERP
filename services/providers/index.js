/**
 * Fachada de providers WhatsApp.
 * getProvider(opts) roteia pelo provider da instância.
 * DEFAULT OBRIGATÓRIO: UltraMSG — no-arg, opts vazio, provider ausente/desconhecido
 * ou 'ultramsg' → sempre UltraMSG (comportamento idêntico ao histórico).
 * Só provider==='whapi' roteia o adapter Whapi. Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md
 */

const ultramsg = require('./ultramsg')
const whapi = require('./whapi')

function getProvider(opts = {}) {
  const p = String((opts && opts.provider) || '').trim().toLowerCase()
  if (p === 'whapi') return whapi
  return ultramsg
}

module.exports = {
  getProvider,
  ultramsg,
  whapi,
}
