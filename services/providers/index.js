/**
 * Provider WhatsApp: UltraMsg (único suportado).
 */

const ultramsg = require('./ultramsg')

function getProvider() {
  return ultramsg
}

module.exports = {
  getProvider,
  ultramsg
}
