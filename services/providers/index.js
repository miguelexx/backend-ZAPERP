/**
 * Padrão provider WhatsApp: permite trocar entre meta (Cloud API), zapi e ultramsg.
 *
 * Variável .env: WHATSAPP_PROVIDER = "ultramsg" | "zapi" | "meta"
 */

const meta = require('./meta')
const zapi = require('./zapi')
const ultramsg = require('./ultramsg')

const PROVIDER = (process.env.WHATSAPP_PROVIDER || 'ultramsg').toLowerCase()

function getProvider() {
  if (PROVIDER === 'ultramsg') return ultramsg
  if (PROVIDER === 'zapi') return zapi
  return meta
}

module.exports = {
  getProvider,
  meta,
  zapi,
  ultramsg
}
