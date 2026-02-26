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
 * Diagnóstico: rejeições são gravadas no buffer _rejectedLog do webhookZapiController.
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

  const motivo = !incoming ? 'token_ausente' : 'token_invalido'

  if (!incoming || !timingSafeEqual(incoming, expected)) {
    const logEntry = {
      motivo,
      method: req.method,
      path: req.path,
      ip: req.ip || '?',
      // Mostra apenas se o token veio ou não, sem expor o valor
      token_recebido: incoming ? `(${incoming.length} chars)` : '(nenhum)',
      body_preview: req.body ? JSON.stringify(req.body).slice(0, 300) : '(vazio)',
    }
    const label = motivo === 'token_ausente' ? 'Token ausente' : 'Token inválido'
    console.warn(`[WEBHOOK_REJECTED] ${label} — ${req.method} ${req.path} | IP: ${req.ip || '?'}`)
    console.warn(`[WEBHOOK_REJECTED] 💡 Dica: URL correta = APP_URL/webhooks/zapi${req.path === '/' ? '' : req.path}?token=<ZAPI_WEBHOOK_TOKEN>`)

    // Registra no buffer de diagnóstico do webhookZapiController
    try {
      const ctrl = require('../controllers/webhookZapiController')
      if (ctrl._logRejected) ctrl._logRejected(logEntry)
    } catch (_) {}

    const statusCode = motivo === 'token_ausente' ? 401 : 401
    return res.status(statusCode).json({ error: motivo === 'token_ausente' ? 'Token do webhook ausente' : 'Token do webhook inválido' })
  }

  return next()
}

module.exports = requireWebhookToken
