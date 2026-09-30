/**
 * Status / Stories do WhatsApp (Whapi). Recurso da conta conectada; status somem em 24h.
 *   POST   /stories               → cria status
 *       texto:  { caption, background_color?, caption_color? }
 *       mídia:  { media (URL http(s) ou base64), caption?, mime_type?, width?, height? }
 *   GET    /stories?from_me=true  → lista os status publicados pela própria conta
 *   DELETE /messages/{MessageID}  → remove um status (status é uma mensagem)
 *
 * Contrato confirmado via MCP Whapi (createStory/createStoryText/createStoryMedia/getStories).
 * Nenhuma dessas chamadas é envio direcionado a um contato → skipSendGuard.
 * UltraMSG não tem stories (não implementa). Ver doc 25.
 */

const { get, post, del } = require('./http')
const { resolveConfig } = require('./config')

function cfgMissing() {
  return { ok: false, error: 'Instância Whapi não configurada' }
}

function apiError(status, data, text) {
  const providerError = data?.error
  const message = providerError?.message
    || (typeof providerError === 'string' ? providerError : null)
    || (typeof data?.message === 'string' ? data.message : null)
    || (typeof text === 'string' && text.trim() ? text.trim() : null)
    || `HTTP ${status}`
  return {
    ok: false,
    httpStatus: Number(status) || null,
    providerCode: providerError?.code ?? data?.code ?? null,
    error: String(message),
  }
}

/** Lista os status publicados pela própria conta (from_me). */
async function getStories(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const extraParams = { from_me: 'true' }
  if (opts.count != null && String(opts.count).trim() !== '') extraParams.count = String(opts.count)
  if (opts.offset != null && String(opts.offset).trim() !== '') extraParams.offset = String(opts.offset)
  try {
    const { ok, status, data, text } = await get({ token: cfg.token, endpoint: '/stories', extraParams })
    if (!ok || data?.error) return apiError(status, data, text)
    const arr = Array.isArray(data?.stories)
      ? data.stories
      : Array.isArray(data?.messages)
        ? data.messages
        : Array.isArray(data)
          ? data
          : []
    return { ok: true, stories: arr, total: data?.total ?? arr.length }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao listar status (Whapi): ${e?.message || e}` }
  }
}

/**
 * Cria um status.
 * Texto:  passe { caption } (+ background_color, caption_color em ARGB "#AARRGGBB").
 * Mídia:  passe { media } (URL http(s) ou base64) (+ caption, mime_type, width, height).
 */
async function createStory(payload = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()

  const caption = payload.caption != null ? String(payload.caption) : ''
  const media = payload.media != null ? String(payload.media).trim() : ''
  if (!media && !caption.trim()) {
    return { ok: false, httpStatus: 400, error: 'Informe um texto ou uma mídia para o status.' }
  }

  const body = {}
  if (caption) body.caption = caption
  if (media) body.media = media
  if (payload.mime_type) body.mime_type = String(payload.mime_type)
  if (payload.background_color) body.background_color = String(payload.background_color)
  if (payload.caption_color) body.caption_color = String(payload.caption_color)
  if (payload.font_type != null && payload.font_type !== '') body.font_type = payload.font_type
  if (payload.width != null && Number.isFinite(Number(payload.width))) body.width = Number(payload.width)
  if (payload.height != null && Number.isFinite(Number(payload.height))) body.height = Number(payload.height)
  if (typeof payload.allow_reshare === 'boolean') body.allow_reshare = payload.allow_reshare
  if (Array.isArray(payload.contacts) && payload.contacts.length) body.contacts = payload.contacts
  if (Array.isArray(payload.exclude_contacts) && payload.exclude_contacts.length) body.exclude_contacts = payload.exclude_contacts

  try {
    const { ok, status, data, text } = await post({
      token: cfg.token,
      endpoint: '/stories',
      body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
      // Mídia (URL remota / base64) pode passar dos 30s padrão em uplink lento.
      timeoutMs: media ? 120000 : null,
    })
    if (!ok || data?.error) return apiError(status, data, text)
    const message = data?.message || data?.story || (data && typeof data === 'object' ? data : null)
    return { ok: true, story: message, id: message?.id || data?.id || null }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao publicar status (Whapi): ${e?.message || e}` }
  }
}

/** Remove um status publicado (status é uma mensagem: DELETE /messages/{id}). */
async function deleteStory(messageId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const id = String(messageId || '').trim()
  if (!id) return { ok: false, httpStatus: 400, error: 'MessageID é obrigatório.' }
  try {
    const { ok, status, data, text } = await del({
      token: cfg.token,
      endpoint: `/messages/${encodeURIComponent(id)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error) return apiError(status, data, text)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao remover status (Whapi): ${e?.message || e}` }
  }
}

module.exports = { getStories, createStory, deleteStory }
