/**
 * Upload de mídia para a CDN Whapi (POST /media). Não dispara mensagem WhatsApp —
 * retry de conexão/HTTP é seguro. Retorno { ok, url } para usar em sendImage/sendFile/etc.
 * Campo `media`: data URI (MCP/OpenAPI: string). O id/link da resposta vira o `media` do send.
 */

const fs = require('fs')
const path = require('path')
const { FILENAME_MAX_LEN } = require('./constants')
const { resolveConfig } = require('./config')
const { post, maskToken } = require('./http')

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

function extractUploadedMediaRef(data) {
  if (!data || typeof data !== 'object') return null
  const v = data.link || data.url || data.id
    || data.media?.link || data.media?.url || data.media?.id
    || (Array.isArray(data.files) ? (data.files[0]?.link || data.files[0]?.id) : null)
  const s = v != null ? String(v).trim() : ''
  return s || null
}

async function uploadMedia(filePath, filename, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg || !filePath) return { ok: false, url: null, error: 'Config ou arquivo indisponível' }
  if (!fs.existsSync(filePath)) return { ok: false, url: null, error: 'Arquivo não encontrado' }
  const safeFilename = String(filename || path.basename(filePath) || 'file').slice(0, FILENAME_MAX_LEN)
  const mime = contentTypeForUploadFilename(safeFilename)
  let dataUri
  try {
    const buf = await fs.promises.readFile(filePath)
    dataUri = `data:${mime};base64,${buf.toString('base64')}`
  } catch (e) {
    return { ok: false, url: null, error: `Falha ao ler arquivo: ${e?.message || e}` }
  }
  try {
    const { ok, status, data, text } = await post({
      token: cfg.token,
      endpoint: '/media',
      body: { media: dataUri },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    const ref = extractUploadedMediaRef(data)
    if (!ok || !ref) {
      const err = String(data?.error?.message || data?.error || text || `HTTP ${status}`).slice(0, 300)
      console.warn('❌ Whapi uploadMedia falhou:', err, '| token:', maskToken(cfg.token))
      return { ok: false, url: null, error: err }
    }
    return { ok: true, url: ref, error: null }
  } catch (e) {
    return { ok: false, url: null, error: `Falha de conexão no upload (Whapi): ${e?.message || e}` }
  }
}

module.exports = {
  uploadMedia,
  extractUploadedMediaRef,
  contentTypeForUploadFilename,
}
