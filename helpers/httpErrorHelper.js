'use strict'

const { isProduction } = require('../config/env')

function clientErrorMessage(status, fallback = 'Erro interno') {
  if (status >= 500 && isProduction()) return 'Erro interno'
  return fallback
}

function sendError(res, status, message, logPrefix, err) {
  if (logPrefix) {
    console.error(logPrefix, err?.message || message || err)
  }
  return res.status(status).json({ error: clientErrorMessage(status, message || 'Erro') })
}

function sendInternalError(res, logPrefix, err) {
  return sendError(res, 500, 'Erro interno', logPrefix, err)
}

module.exports = {
  clientErrorMessage,
  sendError,
  sendInternalError,
}
