/**
 * Helpers de log/diagnóstico do webhook inbound (sem tokens nem conteúdo sensível).
 * Extraído de controllers/webhookZapiController.js (Fase 4 — doc 24) sem alteração de comportamento.
 */

const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'

/** Log [ZAPI_CERT] uma linha por ação — só quando WHATSAPP_DEBUG=true (apenas dev). Sem token, sem conteúdo da msg. */
function logZapiCert(opts) {
  if (!WHATSAPP_DEBUG) return
  const ts = new Date().toISOString()
  const line = JSON.stringify({
    ts,
    companyId: opts.companyId ?? null,
    instanceId: opts.instanceId ? String(opts.instanceId).slice(0, 24) + (opts.instanceId.length > 24 ? '…' : '') : null,
    type: opts.type ?? null,
    fromMe: opts.fromMe ?? null,
    hasDest: opts.hasDest ?? null,
    phoneTail: opts.phoneTail ?? null,
    connectedTail: opts.connectedTail ?? null,
    messageId: opts.messageId ? String(opts.messageId).slice(0, 24) + (String(opts.messageId).length > 24 ? '…' : '') : null,
    resolvedKeyType: opts.resolvedKeyType ?? null,
    conversaId: opts.conversaId ?? null,
    action: opts.action ?? 'unknown'
  })
  console.log('[ZAPI_CERT]', line)
}

// Buffer em memória das últimas 30 requisições webhook recebidas (diagnóstico)
const _webhookLog = []
function _logWebhook(entry) {
  _webhookLog.unshift({ ts: new Date().toISOString(), ...entry })
  if (_webhookLog.length > 30) _webhookLog.pop()
}

/** Log seguro (sem tokens/conteúdo sensível) — diagnóstico end-to-end webhook. Nunca logar tokens nem URL com /token/ */
function _logWebhookSafe(entry) {
  const safe = { ts: new Date().toISOString(), received: true, ...entry }
  console.log('[Z-API-WEBHOOK]', JSON.stringify(safe))
}

module.exports = { logZapiCert, _logWebhook, _logWebhookSafe, _webhookLog }
