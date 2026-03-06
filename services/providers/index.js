/**
 * Padrão provider WhatsApp: permite trocar entre meta (Cloud API) e zapi
 * sem alterar o restante do sistema.
 *
 * ZapERP usa Z-API apenas. Variável .env: WHATSAPP_PROVIDER = "zapi" (default: "zapi")
 */

const meta = require('./meta')
const zapi = require('./zapi')

const PROVIDER = (process.env.WHATSAPP_PROVIDER || 'zapi').toLowerCase()

function getProvider() {
  if (PROVIDER === 'zapi') return zapi
  return meta
}

module.exports = {
  getProvider,
  meta,
  zapi
}
