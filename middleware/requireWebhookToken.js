'use strict'

/**
 * Middleware FAIL-CLOSED para webhooks Z-API.
 *
 * Exige o token em TODOS os ambientes (sem dependência de NODE_ENV).
 * O servidor não inicia se ZAPI_WEBHOOK_TOKEN não estiver definido (ver index.js).
 *
 * Aceita o token via:
 *   1. Header  X-Webhook-Token: <token>   ← forma preferencial
 *   2. Query   ?token=<token>             ← compatibilidade Z-API (appenda na URL registrada)
 *
 * Logging: registra rejeições sem expor o valor do token recebido.
 */

const crypto = require('crypto')

/**
 * Comparação em tempo constante — previne timing-attacks.
 * Sempre compara buffers de mesmo comprimento (zeroed padding interno do Node).
 */
function timingSafeEqual(a, b) {
  const sa = String(a || '')
  const sb = String(b || '')
  // Se tamanhos diferentes, cria buffer maior para comparação (sempre constante)
  const maxLen = Math.max(Buffer.byteLength(sa, 'utf8'), Buffer.byteLength(sb, 'utf8'))
  const ba = Buffer.alloc(maxLen)
  const bb = Buffer.alloc(maxLen)
  ba.write(sa, 'utf8')
  bb.write(sb, 'utf8')
  return crypto.timingSafeEqual(ba, bb) && sa.length === sb.length
}

function requireWebhookToken(req, res, next) {
  const expected = String(process.env.ZAPI_WEBHOOK_TOKEN || '').trim()

  // Defesa em profundidade: se o boot não bloqueou e chegou aqui sem token configurado,
  // rejeita com 500 (misconfiguration), não 401.
  if (!expected) {
    console.error('[WEBHOOK_FATAL] ZAPI_WEBHOOK_TOKEN ausente — rejeitando requisição (misconfiguration)')
    return res.status(500).json({ error: 'Configuração de segurança do webhook inválida' })
  }

  // req.get() em Express é case-insensitive; a versão capitalizada é apenas segurança extra.
  const incoming = String(
    req.get('X-Webhook-Token') || req.query?.token || ''
  ).trim()

  if (!incoming) {
    console.warn('[WEBHOOK_REJECTED] Token ausente —', req.method, req.path, '| IP:', req.ip || '?')
    return res.status(401).json({ error: 'Token do webhook ausente' })
  }

  if (!timingSafeEqual(incoming, expected)) {
    console.warn('[WEBHOOK_REJECTED] Token inválido —', req.method, req.path, '| IP:', req.ip || '?')
    return res.status(401).json({ error: 'Token do webhook inválido' })
  }

  return next()
}

module.exports = requireWebhookToken
