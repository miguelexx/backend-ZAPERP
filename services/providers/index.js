/**
 * Padrão provider WhatsApp: permite trocar entre meta (Cloud API) e zapi
 * sem alterar o restante do sistema.
 *
 * Variável .env: WHATSAPP_PROVIDER = "meta" | "zapi" (default: "meta")
 */

const meta = require('./meta')
const zapi = require('./zapi')

const PROVIDER = (process.env.WHATSAPP_PROVIDER || 'meta').toLowerCase()

function getProvider() {
  if (PROVIDER === 'zapi') return zapi
  return meta
}

module.exports = {
  getProvider,
  meta,
  zapi
}
