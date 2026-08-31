const { fetchWithRetry, sleep, isConnectionLevelError } = require('../../../helpers/retryWithBackoff')
const { FILENAME_MAX_LEN } = require('./constants')
const { resolveConfig } = require('./config')
const { logUltramsgRequest, maskToken } = require('./http')

function isRetriableUploadHttpStatus(status) {
  const code = Number(status)
  return code >= 500 || code === 429 || code === 408
}

function isRetriableUploadError(err) {
  if (!err) return false
  if (isConnectionLevelError(err)) return true
  const name = String(err.name || '')
  if (name === 'AbortError' || name === 'TimeoutError') return true
  const msg = String(err.message || err).toLowerCase()
  return (
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up')
  )
}

function contentTypeForUploadFilename(filename) {
  const ext = String(filename || '').toLowerCase().split('?')[0].split('.').pop()
  const byExt = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    '3gp': 'video/3gpp',
    webm: 'video/webm',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    pdf: 'application/pdf',
  }
  return byExt[ext] || 'application/octet-stream'
}

/**
 * Upload de mídia para UltraMsg. POST /{instance_id}/media/upload
 * Retorna URL pública para usar em sendImage/sendFile/etc quando APP_URL não é acessível.
 *
 * Retry seguro: o upload só sobe o arquivo à CDN (não dispara mensagem WhatsApp).
 * Recria FormData/stream a cada tentativa — ReadStream não pode ser reutilizado.
 */
async function uploadMedia(filePath, filename, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || !filePath) return { ok: false, url: null, error: 'Config ou arquivo indisponível' }
  const fs = require('fs')
  const path = require('path')
  if (!fs.existsSync(filePath)) return { ok: false, url: null, error: 'Arquivo não encontrado' }
  const safeFilename = filename || path.basename(filePath) || 'file'
  // Não renomear extensão sem transcodificar bytes reais.
  const uploadFilename = String(safeFilename).slice(0, FILENAME_MAX_LEN)
  const uploadContentType = contentTypeForUploadFilename(uploadFilename)
  const uploadTimeout = 60_000
  const maxAttempts = Math.max(1, Math.min(3, Number(opts.maxAttempts) || 3))
  const rawDelay = Number(opts.baseDelayMs)
  const baseDelayMs = Number.isFinite(rawDelay) ? Math.max(0, rawDelay) : 400
  const uploadUrl = `${cfg.basePath}/media/upload`
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // `fetch` nativo do Node nao serializa o pacote npm `form-data`: ele envia
      // literalmente "[object FormData]" com um boundary que nao existe no corpo.
      // Use as implementacoes WHATWG nativas, que sao as mesmas esperadas por fetch.
      if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
        throw new Error('Runtime Node sem suporte a FormData/Blob nativos')
      }
      const fileBuffer = await fs.promises.readFile(filePath)
      const form = new FormData()
      form.append('token', cfg.token)
      form.append('file', new Blob([fileBuffer], { type: uploadContentType }), uploadFilename)
      let signal
      try {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
          signal = AbortSignal.timeout(uploadTimeout)
        }
      } catch { /* Node < 17.3 */ }
      // Nao definir Content-Type manualmente: fetch inclui o boundary real do FormData.
      const uploadHeaders = { accept: 'application/json' }
      // Uma tentativa por volta do loop: o FormData precisa ser recriado a cada retry.
      const res = await fetchWithRetry(uploadUrl, {
        method: 'POST',
        body: form,
        headers: uploadHeaders,
        ...(signal && { signal }),
      }, { maxAttempts: 1 })
      const text = await res.text().catch(() => '')
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = null }
      logUltramsgRequest({
        method: 'POST',
        url: uploadUrl,
        headers: { ...uploadHeaders, token: maskToken(cfg.token) },
        body: {
          file_original: safeFilename,
          file_upload: uploadFilename,
          content_type: uploadContentType,
          token: maskToken(cfg.token),
          attempt,
          maxAttempts,
        },
        responseStatus: res.status,
        responseData: data,
        responseText: text,
      })
      if (!res.ok) {
        const err = data?.error || data?.message || `HTTP ${res.status}`
        lastError = err
        if (attempt < maxAttempts && isRetriableUploadHttpStatus(res.status)) {
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 4000)
          console.warn('[ULTRAMSG] uploadMedia retry:', {
            attempt,
            maxAttempts,
            status: res.status,
            delay,
            file: safeFilename?.slice(-20),
          })
          if (delay > 0) await sleep(delay)
          continue
        }
        console.warn('❌ UltraMsg uploadMedia falhou:', safeFilename?.slice(-20), err, '| token:', maskToken(cfg.token))
        return { ok: false, url: null, error: err }
      }
      if (data?.error) {
        const err = typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
        // Erro semântico no body (formato/token): não retentar — não é transitório.
        console.warn('❌ UltraMsg uploadMedia respondeu erro no body:', safeFilename?.slice(-20), err, '| token:', maskToken(cfg.token))
        return { ok: false, url: null, error: err }
      }
      // UltraMsg /media/upload retorna a URL da CDN no campo `success`
      // (ex.: { "success": "https://s3.../ultramsgmedia/..." }), não em `url`.
      // Aceitar também url/link/file como fallback. `success` só vale como URL
      // quando é string http(s) — outros endpoints usam success=true booleano.
      const successUrl =
        typeof data?.success === 'string' && /^https?:\/\//i.test(data.success.trim())
          ? data.success.trim()
          : null
      const url = successUrl || data?.url || data?.link || data?.file || null
      if (!url) {
        const err = data?.message || text?.slice(0, 200) || 'Upload sem URL retornada pela UltraMsg'
        lastError = err
        if (attempt < maxAttempts) {
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 4000)
          if (delay > 0) await sleep(delay)
          continue
        }
        return { ok: false, url: null, error: err }
      }
      return { ok: true, url, error: null }
    } catch (e) {
      lastError = e?.message || 'Erro no upload'
      if (attempt < maxAttempts && isRetriableUploadError(e)) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 4000)
        console.warn('[ULTRAMSG] uploadMedia retry (rede/timeout):', {
          attempt,
          maxAttempts,
          delay,
          error: lastError,
          file: safeFilename?.slice(-20),
        })
        if (delay > 0) await sleep(delay)
        continue
      }
      console.warn('[ULTRAMSG] uploadMedia:', e?.message || e, '| token:', maskToken(cfg.token))
      return { ok: false, url: null, error: lastError }
    }
  }

  return { ok: false, url: null, error: lastError || 'Erro no upload' }
}

module.exports = { uploadMedia }
