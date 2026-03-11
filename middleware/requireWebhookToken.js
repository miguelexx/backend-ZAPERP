'use strict'

/**
 * Middleware FAIL-CLOSED para webhooks Z-API.
 *
 * Exige o token em TODOS os ambientes (sem dependência de NODE_ENV).
 * O servidor não inicia se ZAPI_WEBHOOK_TOKEN não estiver definido (ver index.js).
 *
 * Aceita o token via:
 *   1. Header  X-Webhook-Token: <token>   ← preferencial
 *   2. Header  Authorization: Bearer <token>
 *   3. Query   ?token=<token>             ← compatibilidade Z-API (appenda na URL)
 *
 * FALLBACK quando token ausente: se o payload contém instanceId registrado em empresa_zapi,
 * aceita a requisição (Z-API às vezes envia sem token em /webhooks/zapi ou /status).
 *
 * Logging: registra rejeições sem expor o valor do token recebido.
 * Diagnóstico: rejeições são gravadas no buffer _rejectedLog do webhookZapiController.
 */

const crypto = require('crypto')
const { getCompanyIdByInstanceId } = require('../services/zapiIntegrationService')

/**
 * Extrai instanceId do payload Z-API (body.instanceId, instance_id, instance.id, instance).
 */
function extractInstanceId(body) {
  if (!body || typeof body !== 'object') return ''
  const v = body.instanceId ?? body.instance_id ?? body.instance?.id ?? body.instance
  if (v == null) return ''
  if (typeof v === 'object' && v != null && typeof v.id === 'string') return String(v.id).trim()
  if (typeof v === 'object' && v != null && v.instance_id != null) return String(v.instance_id).trim()
  return String(v).trim()
}

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

  const authHeader = req.get('Authorization') || ''
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i)
  const bearer = bearerMatch ? bearerMatch[1].trim() : ''
  const incoming = String(
    req.get('X-Webhook-Token') || bearer || req.query?.token || ''
  ).trim()

  // Token presente e válido → permite
  if (incoming && timingSafeEqual(incoming, expected)) {
    return next()
  }

  // Token ausente ou inválido → tenta fallback via instanceId registrado
  const instanceId = extractInstanceId(req.body)
  if (instanceId) {
    return getCompanyIdByInstanceId(instanceId)
      .then((companyId) => {
        if (companyId != null) {
          console.info(`[WEBHOOK_TOKEN_FALLBACK] Aceito via instanceId registrado — ${req.method} ${req.path} | instanceId: ${instanceId.slice(0, 16)}…`)
          return next()
        }
        _reject(req, res, incoming)
      })
      .catch((err) => {
        console.error('[requireWebhookToken] Fallback instanceId:', err?.message || err)
        _reject(req, res, incoming)
      })
  }

  _reject(req, res, incoming)
}

function _reject(req, res, incoming) {
  const motivo = !incoming ? 'token_ausente' : 'token_invalido'
  const logEntry = {
    motivo,
    method: req.method,
    path: req.path,
    ip: req.ip || '?',
    token_recebido: incoming ? `(${incoming.length} chars)` : '(nenhum)',
  }
  const label = motivo === 'token_ausente' ? 'Token ausente' : 'Token inválido'
  console.warn(`[WEBHOOK_REJECTED] ${label} — ${req.method} ${req.path} | IP: ${req.ip || '?'}`)
  console.warn(`[WEBHOOK_REJECTED] 💡 Dica: URL correta = APP_URL/webhooks/zapi${req.path === '/' ? '' : req.path}?token=<ZAPI_WEBHOOK_TOKEN>`)

  try {
    const ctrl = require('../controllers/webhookZapiController')
    if (ctrl._logRejected) ctrl._logRejected(logEntry)
  } catch (_) {}

  res.status(401).json({ error: motivo === 'token_ausente' ? 'Token do webhook ausente' : 'Token do webhook inválido' })
}

module.exports = requireWebhookToken
