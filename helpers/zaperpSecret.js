'use strict'

// Comparação em tempo constante do header `x-zaperp-secret` contra ZAP_SSO_SECRET,
// usada por todas as rotas /crm server-to-server (enviar-mensagem, instancia-status, …).
// Comparamos o comprimento antes (isso não vaza o segredo — só o tamanho do header
// recebido) porque crypto.timingSafeEqual exige buffers de mesmo tamanho.

const crypto = require('crypto')

function segredoConfere(recebido, esperado) {
  if (!esperado) return false
  const a = Buffer.from(String(recebido == null ? '' : recebido), 'utf8')
  const b = Buffer.from(String(esperado), 'utf8')
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch (_err) {
    return false
  }
}

module.exports = { segredoConfere }
