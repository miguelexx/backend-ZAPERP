'use strict'

/**
 * Cliente OpenAI — compatível com openai v4/v5/v6 (CJS).
 * Exporta { client } para uso em aiDashboardService.js.
 */

// openai v6 pode exportar a classe como named export ou default
const openaiPkg = require('openai')
const OpenAI = openaiPkg.OpenAI || openaiPkg.default || openaiPkg

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

module.exports = { client }
