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
 * Segredo: WHAPI_WEBHOOK_TOKEN (próprio da Whapi), com fallback ao WHATSAPP_WEBHOOK_TOKEN
 * compartilhado durante a transição — ver `resolveExpectedTokens` abaixo e doc 33 §F1.
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
  console.warn('[WEBHOOK_WHAPI_REJECTED] 💡 Configure o canal Whapi com header X-Webhook-Token: <WHAPI_WEBHOOK_TOKEN> (POST /integrations/whatsapp/instances/:id/configure-webhooks faz isso)')
  return res.status(401).json({
    error: motivo === 'token_ausente' ? 'Token do webhook ausente' : 'Token do webhook inválido',
  })
}

/**
 * Segredos aceitos, em ordem de preferência.
 *
 * Por que a Whapi tem segredo PRÓPRIO (doc 33, F1): o `WHATSAPP_WEBHOOK_TOKEN` compartilhado é
 * aceito pela rota UltraMSG em `?token=` — a API do UltraMSG (`POST /instance/settings`) só
 * aceita `webhook_url`, sem campo de header — e, até a redação de log entrar, esse valor foi
 * escrito em claro no log de acesso. Quem lesse o log forjava `statuses[]`/`messages[]` de
 * QUALQUER canal. Separar o segredo tira o webhook Whapi desse raio.
 *
 * Transição: entre o deploy e o `configure-webhooks` do canal, a Whapi ainda manda o segredo
 * ANTIGO no header. Enquanto `WHAPI_WEBHOOK_TOKEN_ACCEPT_LEGACY` for true (padrão) o antigo
 * continua valendo, para o deploy não derrubar o recebimento. Depois de reconfigurar o canal,
 * defina `WHAPI_WEBHOOK_TOKEN_ACCEPT_LEGACY=false` — enquanto estiver true o segredo exposto
 * ainda abre o webhook, e é por isso que o aviso abaixo insiste.
 *
 * Sem `WHAPI_WEBHOOK_TOKEN` definido o comportamento é exatamente o de antes (só o compartilhado).
 */
function resolveExpectedTokens() {
  const dedicated = String(process.env.WHAPI_WEBHOOK_TOKEN || '').trim()
  const legacy = String(process.env.WHATSAPP_WEBHOOK_TOKEN || '').trim()
  if (!dedicated) return { tokens: legacy ? [legacy] : [], usingDedicated: false, legacyAccepted: Boolean(legacy) }

  const acceptLegacyRaw = String(process.env.WHAPI_WEBHOOK_TOKEN_ACCEPT_LEGACY ?? 'true').trim().toLowerCase()
  const acceptLegacy = !['0', 'false', 'no', 'off'].includes(acceptLegacyRaw)
  // Segredo legado idêntico ao dedicado não é "transição": não duplicar nem avisar.
  const legacyAccepted = acceptLegacy && Boolean(legacy) && legacy !== dedicated
  return {
    tokens: legacyAccepted ? [dedicated, legacy] : [dedicated],
    usingDedicated: true,
    legacyAccepted,
  }
}

/** Aviso de transição: 1x por processo e, depois, no máximo a cada 10 min. */
const LEGACY_WARN_INTERVAL_MS = 10 * 60_000
let _legacyWarnedAt = 0
function _warnLegacyAceito() {
  const agora = Date.now()
  if (_legacyWarnedAt && agora - _legacyWarnedAt < LEGACY_WARN_INTERVAL_MS) return
  _legacyWarnedAt = agora
  console.warn(
    '[WEBHOOK_WHAPI] ⚠️ Segredo LEGADO (WHATSAPP_WEBHOOK_TOKEN) ainda aceito no webhook Whapi. ' +
    'Ele também vale em ?token= na rota UltraMSG. Rode POST /integrations/whatsapp/instances/:id/configure-webhooks ' +
    'para o canal passar a mandar WHAPI_WEBHOOK_TOKEN no header e então defina WHAPI_WEBHOOK_TOKEN_ACCEPT_LEGACY=false.'
  )
}

function requireWhapiWebhookToken(req, res, next) {
  const { tokens, legacyAccepted } = resolveExpectedTokens()

  if (!tokens.length) {
    console.error('[WEBHOOK_WHAPI_FATAL] WHAPI_WEBHOOK_TOKEN / WHATSAPP_WEBHOOK_TOKEN ausentes')
    req.webhookLogData = { status: 'rejected_token', error: 'token_env_ausente' }
    return res.status(500).json({ error: 'Configuração de segurança do webhook inválida' })
  }

  const incoming = extractHeaderToken(req)
  if (incoming) {
    // Compara contra TODOS os candidatos sempre (sem short-circuit): o tempo de resposta não
    // revela qual dos segredos casou nem quantos estão configurados.
    let aceito = false
    let casouLegado = false
    tokens.forEach((esperado, idx) => {
      const igual = timingSafeEqual(incoming, esperado)
      if (igual) {
        aceito = true
        if (idx > 0) casouLegado = true
      }
    })
    if (aceito) {
      if (casouLegado) _warnLegacyAceito()
      return next()
    }
  }
  if (legacyAccepted) _warnLegacyAceito()
  return _reject(req, res, incoming)
}

module.exports = requireWhapiWebhookToken
module.exports.timingSafeEqual = timingSafeEqual
module.exports.extractHeaderToken = extractHeaderToken
module.exports.resolveExpectedTokens = resolveExpectedTokens
module.exports._test = { resetLegacyWarn: () => { _legacyWarnedAt = 0 } }
