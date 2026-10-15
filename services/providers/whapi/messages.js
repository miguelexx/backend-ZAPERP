/**
 * Mensagens Whapi — arquivos próprios (não misturar com UltraMSG).
 * Delete: DELETE /messages/{MessageID}
 * Edit:   POST /messages/text { to, body, edit }  (OpenAPI Sender.edit; janela ~15 min)
 * Read:   PUT /messages/{MessageID}
 * List:   GET /messages/list e GET /messages/{MessageID}
 */

const { buildSendMeta } = require('../../whatsappSendGuardService')
const { BODY_MAX_LEN } = require('./constants')
const { normalizeWhapiSendResult } = require('./result')
const { toWhapiRecipient } = require('./phones')
const { resolveConfig } = require('./config')
const { post, put, del, get, maskToken } = require('./http')
const { isWhapiSuccessBody } = require('./parse')
const { resolveWhapiSendRecipient } = require('../../whapiRecipientResolverService')

function applyQuoted(body, opts) {
  const replyMessageId = opts?.replyMessageId ? String(opts.replyMessageId).trim() : null
  if (replyMessageId) body.quoted = replyMessageId
  return body
}

/** Texto do erro que o provedor devolveu, para o log e para a tela. */
function motivoDoProvedor(data, text) {
  const e = data && typeof data === 'object' ? data.error : null
  if (e && typeof e === 'object') {
    const m = e.message || e.detail || e.code
    if (m) return String(m).slice(0, 300)
  }
  if (typeof e === 'string' && e.trim()) return e.trim().slice(0, 300)
  if (data && typeof data === 'object' && data.message) return String(data.message).slice(0, 300)
  const t = String(text || '').trim()
  return t ? t.slice(0, 300) : null
}

/**
 * 4xx (menos 429) = o provedor recusou e repetir nao muda nada. 429/5xx/sem status = passageiro.
 */
function recusaDefinitiva(status) {
  const s = Number(status)
  if (!Number.isFinite(s)) return false
  if (s === 429) return false
  return s >= 400 && s < 500
}

/**
 * Apaga mensagem no WhatsApp. DELETE /messages/{MessageID}
 *
 * Devolve `{ ok, httpStatus, error, permanente }` em vez do boolean antigo. O boolean
 * escondia POR QUE a remocao falhou: o controller so podia responder "tente novamente", o
 * atendente tentava de novo e falhava igual (observado em 13/10/2026 no console: a mesma
 * mensagem 775950 recusada duas vezes seguidas). `permanente` separa a recusa definitiva
 * (4xx: fora da janela que o WhatsApp permite apagar para todos, id fora do channel-store)
 * da falha passageira (429/5xx/timeout), em que repetir faz sentido.
 *
 * Compativel com o chamador antigo, que aceita `=== true || .ok === true`.
 */
async function deleteMessage(phone, msgId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada.', permanente: true }
  const mid = String(msgId || '').trim()
  if (!mid) return { ok: false, error: 'Mensagem sem ID do WhatsApp.', permanente: true }
  const to = toWhapiRecipient(phone)
  try {
    const { ok, status, data, text } = await del({
      token: cfg.token,
      endpoint: `/messages/${encodeURIComponent(mid)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      meta: buildSendMeta('delete', to || phone, opts),
    })
    if (isWhapiSuccessBody(ok, data)) return { ok: true, httpStatus: status ?? 200 }
    return {
      ok: false,
      httpStatus: status ?? null,
      error: motivoDoProvedor(data, text),
      permanente: recusaDefinitiva(status),
    }
  } catch (e) {
    // Excecao de transporte (timeout/rede): nunca e definitiva.
    console.warn('❌ Whapi deleteMessage falhou:', e?.message || e)
    return { ok: false, httpStatus: null, error: e?.message || String(e), permanente: false }
  }
}

/**
 * Edita texto (ou legenda) de uma mensagem já enviada.
 * POST /messages/text { to, body, edit: MessageID }.
 * Retorno { ok, messageId, error } — mesmo espírito do sendText.
 */
async function editMessage(phone, msgId, newText, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) {
    return { ok: false, messageId: null, error: 'Instância Whapi não configurada. Conecte o canal no painel de integrações.' }
  }
  const to = toWhapiRecipient(phone)
  const mid = String(msgId || '').trim()
  const allowEmpty = opts.allowEmpty === true
  const msg = String(newText ?? '').trim()
  if (!to || !mid || (!allowEmpty && !msg)) {
    return { ok: false, messageId: null, error: 'Destino, id da mensagem ou texto inválido.' }
  }
  if (msg.length > BODY_MAX_LEN) {
    return { ok: false, messageId: null, error: `body excede ${BODY_MAX_LEN} caracteres` }
  }
  const canonicalTo = await resolveWhapiSendRecipient(phone, opts)
  const body = applyQuoted({ to: canonicalTo || to, body: msg, edit: mid }, opts)
  try {
    const { ok, status, data, text } = await post({
      token: cfg.token,
      endpoint: '/messages/text',
      body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      meta: buildSendMeta('edit', canonicalTo || to, opts, { edit: mid, textLength: msg.length }),
    })
    const normalized = normalizeWhapiSendResult({
      httpOk: ok, status, data, text, fallbackError: data?.message,
    })
    if (!normalized.ok) {
      console.warn('❌ Whapi editMessage falhou:', String(to).slice(-13), String(normalized.error).slice(0, 200), '| token:', maskToken(cfg.token))
    }
    return normalized
  } catch (e) {
    return { ok: false, messageId: null, error: `Falha de conexão ao editar (Whapi): ${e?.message || e}` }
  }
}

/** Marca uma mensagem como lida. PUT /messages/{MessageID}. Boolean. */
async function markMessageAsRead(phone, msgId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const mid = String(msgId || '').trim()
  if (!mid) return false
  const to = toWhapiRecipient(phone)
  try {
    const { ok, data } = await put({
      token: cfg.token,
      endpoint: `/messages/${encodeURIComponent(mid)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
      meta: buildSendMeta('read', to || phone, opts),
    })
    return isWhapiSuccessBody(ok, data)
  } catch (e) {
    console.warn('❌ Whapi markMessageAsRead falhou:', e?.message || e)
    return false
  }
}

/**
 * Consulta mensagens. Sem ChatID: GET /messages/list.
 * Com `opts.id`: GET /messages/{MessageID} (reconciliação).
 * `referenceId` não existe na Whapi → lista vazia com ok (não dispara reenvio cego por falha de API).
 */
async function getMessages(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, data: [], error: 'Instância Whapi não configurada' }
  const referenceId = String(opts.referenceId || '').trim()
  if (referenceId) return { ok: true, data: [] }

  const id = String(opts.id || '').trim()
  if (id) {
    try {
      const { ok, status, data } = await get({
        token: cfg.token,
        endpoint: `/messages/${encodeURIComponent(id)}`,
      })
      if (status === 404) return { ok: true, data: [] }
      if (!ok) return { ok: false, data: [], error: `HTTP ${status}` }
      const msg = data?.message && typeof data.message === 'object' ? data.message : data
      if (!msg || typeof msg !== 'object') return { ok: true, data: [] }
      return { ok: true, data: [msg] }
    } catch (e) {
      return { ok: false, data: [], error: e?.message || String(e) }
    }
  }

  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 20))
  try {
    const { ok, status, data } = await get({
      token: cfg.token,
      endpoint: '/messages/list',
      extraParams: { count: String(limit) },
    })
    if (!ok) return { ok: false, data: [], error: `HTTP ${status}` }
    const messages = Array.isArray(data?.messages) ? data.messages
      : (Array.isArray(data) ? data : [])
    return { ok: true, data: messages }
  } catch (e) {
    return { ok: false, data: [], error: e?.message || String(e) }
  }
}

/**
 * Fixa uma mensagem no chat. POST /messages/{MessageID}/pin { time: day|week|month }.
 * Boolean. Não envia mensagem → skipSendGuard.
 */
async function pinMessage(messageId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const mid = String(messageId || '').trim()
  if (!mid) return false
  const time = ['day', 'week', 'month'].includes(String(opts?.time)) ? String(opts.time) : 'day'
  try {
    const { ok, data } = await post({
      token: cfg.token,
      endpoint: `/messages/${encodeURIComponent(mid)}/pin`,
      body: { time },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    return isWhapiSuccessBody(ok, data)
  } catch (e) {
    console.warn('❌ Whapi pinMessage falhou:', e?.message || e)
    return false
  }
}

/**
 * Marca/desmarca uma mensagem como favorita. PUT /messages/{MessageID}/star { starred }.
 * Boolean. Não envia mensagem → skipSendGuard.
 */
async function starMessage(messageId, starred = true, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const mid = String(messageId || '').trim()
  if (!mid) return false
  try {
    const { ok, data } = await put({
      token: cfg.token,
      endpoint: `/messages/${encodeURIComponent(mid)}/star`,
      body: { starred: starred !== false },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    return isWhapiSuccessBody(ok, data)
  } catch (e) {
    console.warn('❌ Whapi starMessage falhou:', e?.message || e)
    return false
  }
}

/**
 * Envia recibo de "reproduzido" de um áudio/voz. PUT /messages/{MessageID}/played (sem corpo).
 * Boolean. Recibo (não envia conteúdo) → skipSendGuard.
 */
async function markMessageAsPlayed(messageId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return false
  const mid = String(messageId || '').trim()
  if (!mid) return false
  try {
    const { ok, data } = await put({
      token: cfg.token,
      endpoint: `/messages/${encodeURIComponent(mid)}/played`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    return isWhapiSuccessBody(ok, data)
  } catch (e) {
    console.warn('❌ Whapi markMessageAsPlayed falhou:', e?.message || e)
    return false
  }
}

module.exports = {
  deleteMessage,
  editMessage,
  markMessageAsRead,
  getMessages,
  pinMessage,
  starMessage,
  markMessageAsPlayed,
}
