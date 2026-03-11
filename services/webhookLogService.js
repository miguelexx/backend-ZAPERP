/**
 * Serviço de log para webhooks.
 * Registra todos os webhooks recebidos no banco (webhook_logs).
 * Não bloqueia o fluxo — falhas são apenas logadas no console.
 */

const supabase = require('../config/supabase')

const MAX_PAYLOAD_SIZE = 50000 // ~50KB para evitar payloads gigantes

/**
 * Sanitiza o payload removendo ou mascarando dados sensíveis.
 */
function sanitizePayload(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const str = JSON.stringify(obj)
  if (str.length > MAX_PAYLOAD_SIZE) {
    return { _truncated: true, _size: str.length, _preview: str.slice(0, 2000) }
  }
  return obj
}

/**
 * Registra um webhook no banco.
 * @param {object} opts
 * @param {string} opts.provider - 'ultramsg' | 'meta'
 * @param {string} opts.path - Path da requisição
 * @param {string} [opts.method='POST']
 * @param {string} [opts.instance_id]
 * @param {number|null} [opts.company_id]
 * @param {string} [opts.event_type]
 * @param {string} opts.status - received | processed | ignored_missing_instance | ignored_not_mapped | rejected_token | error
 * @param {object} [opts.payload] - Body da requisição (sanitizado)
 * @param {string} [opts.ip]
 * @param {string} [opts.user_agent]
 * @param {number} [opts.response_status]
 * @param {object} [opts.response_body]
 * @param {string} [opts.error_message]
 * @param {number} [opts.processing_ms]
 */
async function log(opts) {
  try {
    const row = {
      provider: String(opts.provider || 'unknown').slice(0, 30),
      path: String(opts.path || '/').slice(0, 255),
      method: String(opts.method || 'POST').toUpperCase().slice(0, 10),
      instance_id: opts.instance_id ? String(opts.instance_id).slice(0, 64) : null,
      company_id: opts.company_id != null ? opts.company_id : null,
      event_type: opts.event_type ? String(opts.event_type).slice(0, 100) : null,
      status: String(opts.status || 'received').slice(0, 50),
      payload: typeof opts.payload === 'object' ? sanitizePayload(opts.payload) : {},
      ip: opts.ip ? String(opts.ip).slice(0, 45) : null,
      user_agent: opts.user_agent ? String(opts.user_agent).slice(0, 500) : null,
      response_status: opts.response_status ?? null,
      response_body: typeof opts.response_body === 'object' ? opts.response_body : null,
      error_message: opts.error_message ? String(opts.error_message).slice(0, 1000) : null,
      processing_ms: opts.processing_ms ?? null,
    }
    const { error } = await supabase.from('webhook_logs').insert(row)
    if (error) {
      console.warn('[webhookLogService] Erro ao inserir:', error.message)
    }
  } catch (e) {
    console.warn('[webhookLogService] Falha:', e?.message || e)
  }
}

/**
 * Log assíncrono sem await — fire-and-forget.
 */
function logAsync(opts) {
  setImmediate(() => log(opts))
}

module.exports = { log, logAsync, sanitizePayload }
