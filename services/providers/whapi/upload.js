/**
 * Mídia Whapi: POST /media (upload) · GET /media · GET/DELETE /media/{id}.
 * Não dispara mensagem WhatsApp — skipSendGuard. Upload: data URI; o id/link vira o `media` do send.
 */

const fs = require('fs')
const path = require('path')
const { FILENAME_MAX_LEN } = require('./constants')
const { resolveConfig } = require('./config')
const { get, post, del, getBinary, maskToken } = require('./http')

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

/**
 * GET /media — lista arquivos no cloud do canal.
 * Query: count, offset, time_from, time_to, sort (asc|desc).
 */
async function getMediaFiles(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, files: [], error: 'Instância Whapi não configurada' }
  const extraParams = {}
  const count = Number(opts.count)
  const offset = Number(opts.offset)
  if (Number.isFinite(count) && count > 0) extraParams.count = String(Math.min(500, Math.max(1, Math.trunc(count))))
  if (Number.isFinite(offset) && offset >= 0) extraParams.offset = String(Math.trunc(offset))
  if (opts.time_from != null) extraParams.time_from = String(opts.time_from)
  if (opts.time_to != null) extraParams.time_to = String(opts.time_to)
  const sort = String(opts.sort || '').toLowerCase()
  if (sort === 'asc' || sort === 'desc') extraParams.sort = sort
  try {
    const { ok, status, data } = await get({
      token: cfg.token,
      endpoint: '/media',
      extraParams,
    })
    if (!ok || data?.error) {
      return {
        ok: false,
        files: [],
        httpStatus: status,
        error: String(data?.error?.message || data?.error || `HTTP ${status}`),
      }
    }
    const files = Array.isArray(data?.files) ? data.files : (Array.isArray(data) ? data : [])
    return {
      ok: true,
      files,
      total: Number.isFinite(Number(data?.total)) ? Number(data.total) : files.length,
      count: Number.isFinite(Number(data?.count)) ? Number(data.count) : files.length,
      offset: Number.isFinite(Number(data?.offset)) ? Number(data.offset) : 0,
    }
  } catch (e) {
    return { ok: false, files: [], error: `Falha de conexão ao listar mídia (Whapi): ${e?.message || e}` }
  }
}

/**
 * GET /media/{MediaID} — baixa o arquivo (bytes) ou devolve { link } se a origem responder JSON.
 */
async function getMedia(mediaId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const id = String(mediaId || '').trim()
  if (!id) return { ok: false, error: 'MediaID obrigatório' }
  try {
    const { ok, status, buffer, contentType } = await getBinary({
      token: cfg.token,
      endpoint: `/media/${encodeURIComponent(id)}`,
    })
    if (!ok) {
      let data = null
      try { data = buffer && buffer.length ? JSON.parse(buffer.toString('utf8')) : null } catch { data = null }
      return {
        ok: false,
        httpStatus: status,
        error: String(data?.error?.message || data?.error || `HTTP ${status}`),
      }
    }
    const ct = String(contentType || '')
    if (buffer && (ct.includes('json') || buffer[0] === 0x7b)) {
      let data = null
      try { data = JSON.parse(buffer.toString('utf8')) } catch { data = null }
      const link = data?.link || data?.url || data?.media?.link || null
      return { ok: true, httpStatus: status, data, link, buffer: null, contentType: ct || 'application/json' }
    }
    return { ok: true, httpStatus: status, buffer, contentType: ct || 'application/octet-stream', data: null, link: null }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao obter mídia (Whapi): ${e?.message || e}` }
  }
}

/**
 * DELETE /media/{MediaID} — remove do cloud Whapi (não apaga a cópia no ZapERP).
 */
async function deleteMedia(mediaId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const id = String(mediaId || '').trim()
  if (!id) return { ok: false, error: 'MediaID obrigatório' }
  try {
    const { ok, status, data } = await del({
      token: cfg.token,
      endpoint: `/media/${encodeURIComponent(id)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error) {
      return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
    }
    return { ok: true, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao excluir mídia (Whapi): ${e?.message || e}` }
  }
}

module.exports = {
  uploadMedia,
  getMediaFiles,
  getMedia,
  deleteMedia,
  extractUploadedMediaRef,
  contentTypeForUploadFilename,
}
