'use strict'

/**
 * Middleware FAIL-CLOSED de autenticação do webhook Whapi (2º provider).
 *
 * Dedicado — NÃO reutiliza requireWebhookToken (UltraMSG), que aceita `?token=` na query
 * (token vai para logs via req.originalUrl) e faz fallback por instanceId na tabela empresa_zapi.
 * Aqui:
 *   - Aceita SOMENTE header `X-Webhook-Token` ou `Authorization: Bearer <token>` — NUNCA na query.
 *   - SEM fallback por instanceId — a Whapi identifica o canal por `channel_id` no corpo,
 *     resolvido depois em resolveWhapiWebhookCompany. Auth é só pelo token compartilhado.
 * Segredo: WHATSAPP_WEBHOOK_TOKEN (o mesmo que configureWebhooks grava no header do canal).
 * Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md
 */

const crypto = require('crypto')

/**
 * Comparação em tempo constante — previne timing-attacks.
 * Retorna false se qualquer lado estiver vazio após trim.
 * Buffers normalizados ao maior comprimento antes do compare (padding interno do Node);
 * o compare de comprimento fica fora do timing-safe de propósito (não vaza o segredo).
 */
function timingSafeEqual(a, b) {
  const sa = String(a ?? '').trim()
  const sb = String(b ?? '').trim()
  if (!sa || !sb) return false
  const maxLen = Math.max(Buffer.byteLength(sa, 'utf8'), Buffer.byteLength(sb, 'utf8'))
  const ba = Buffer.alloc(maxLen)
  const bb = Buffer.alloc(maxLen)
  ba.write(sa, 'utf8')
  bb.write(sb, 'utf8')
  return crypto.timingSafeEqual(ba, bb) && sa.length === sb.length
}

/** Extrai o token do header — X-Webhook-Token tem prioridade; senão Authorization: Bearer. */
function extractHeaderToken(req) {
  const headerToken = String(req.get('X-Webhook-Token') || '').trim()
  if (headerToken) return headerToken
  const authHeader = req.get('Authorization') || ''
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i)
  return bearerMatch ? bearerMatch[1].trim() : ''
}

function _reject(req, res, incoming) {
  const motivo = !incoming ? 'token_ausente' : 'token_invalido'
  req.webhookLogData = { status: 'rejected_token', error: motivo }
  const label = motivo === 'token_ausente' ? 'Token ausente' : 'Token inválido'
  console.warn(`[WEBHOOK_WHAPI_REJECTED] ${label} — ${req.method} ${req.path} | IP: ${req.ip || '?'}`)
  console.warn('[WEBHOOK_WHAPI_REJECTED] 💡 Configure o canal Whapi com header X-Webhook-Token: <WHATSAPP_WEBHOOK_TOKEN>')
  return res.status(401).json({
    error: motivo === 'token_ausente' ? 'Token do webhook ausente' : 'Token do webhook inválido',
  })
}

function requireWhapiWebhookToken(req, res, next) {
  const expected = String(process.env.WHATSAPP_WEBHOOK_TOKEN || '').trim()

  if (!expected) {
    console.error('[WEBHOOK_WHAPI_FATAL] WHATSAPP_WEBHOOK_TOKEN ausente')
    req.webhookLogData = { status: 'rejected_token', error: 'token_env_ausente' }
    return res.status(500).json({ error: 'Configuração de segurança do webhook inválida' })
  }

  const incoming = extractHeaderToken(req)
  if (incoming && timingSafeEqual(incoming, expected)) {
    return next()
  }
  return _reject(req, res, incoming)
}

module.exports = requireWhapiWebhookToken
module.exports.timingSafeEqual = timingSafeEqual
module.exports.extractHeaderToken = extractHeaderToken
