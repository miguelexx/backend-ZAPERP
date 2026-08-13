const crypto = require('crypto')
const auth = require('./auth')

function safeEqual(received, expected) {
  const left = Buffer.from(String(received || ''))
  const right = Buffer.from(String(expected || ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function normalizeCnpj(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (digits.length !== 14) return null
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`
}

function applyIntegration(req, res) {
  const received = String(req.get('X-HelpDesk-Token') || '').trim()
  const expected = String(process.env.HELPDESK_INTEGRATION_TOKEN || '').trim()
  if (!received) return false
  if (!expected || !safeEqual(received, expected)) {
    res.status(401).json({ error: 'Token de integracao invalido' })
    return null
  }
  const clientCnpj = normalizeCnpj(req.get('X-Icthus-CNPJ'))
  if (!clientCnpj) {
    res.status(400).json({ error: 'X-Icthus-CNPJ deve conter 14 digitos' })
    return null
  }
  const companyId = Number(process.env.HELPDESK_INTEGRATION_COMPANY_ID || 1)
  if (!Number.isInteger(companyId) || companyId <= 0) {
    res.status(500).json({ error: 'Empresa da integracao nao configurada' })
    return null
  }
  req.helpDeskIntegration = true
  req.integrationCnpj = clientCnpj
  req.user = { id: null, company_id: companyId, perfil: 'integracao' }
  return true
}

exports.integrationOnly = (req, res, next) => {
  const result = applyIntegration(req, res)
  if (result === true) return next()
  if (result === false) return res.status(401).json({ error: 'Token de integracao nao informado' })
}

exports.integrationOrUser = (req, res, next) => {
  const result = applyIntegration(req, res)
  if (result === true) return next()
  if (result === null) return undefined
  return auth(req, res, next)
}
