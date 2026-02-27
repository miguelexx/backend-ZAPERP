'use strict'

/**
 * Cliente OpenAI — validação lazy da chave + timeout de segurança.
 * Compatível com openai v4/v5/v6 (CJS).
 *
 * A validação é feita na PRIMEIRA chamada (não no carregamento do módulo)
 * para que o servidor inicie normalmente mesmo que a chave ainda não esteja
 * configurada — somente os endpoints de IA ficam indisponíveis.
 */

const openaiPkg = require('openai')
const OpenAI = openaiPkg.OpenAI || openaiPkg.default || openaiPkg

let _client = null

function getClient() {
  if (_client) return _client

  const apiKey = process.env.OPENAI_API_KEY

  if (!apiKey || apiKey === 'sk-...') {
    throw new Error('[openaiClient] OPENAI_API_KEY não configurada no .env')
  }

  if (apiKey.length < 20) {
    throw new Error('[openaiClient] OPENAI_API_KEY inválida (comprimento suspeito)')
  }

  _client = new OpenAI({
    apiKey,
    timeout: 30_000,   // 30 segundos máximo por chamada
    maxRetries: 0,     // sem retry automático; o controller decide o fallback
  })

  return _client
}

// Exporta `client` como getter lazy para manter compatibilidade com
// o código existente que usa `const { client } = require('./openaiClient')`.
Object.defineProperty(module.exports, 'client', {
  get: getClient,
  enumerable: true,
})

module.exports.getClient = getClient
