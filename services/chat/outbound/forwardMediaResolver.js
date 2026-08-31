/**
 * Resolução da mídia de origem para encaminhamento via provider WhatsApp: descobre a URL/candidata,
 * resolve arquivo local em /uploads, baixa do R2 quando necessário, normaliza vídeo/imagem e decide
 * entre upload ao CDN do provider e URL pública.
 *
 * Extraído de controllers/chatController.js (Fase 7 da modularização) sem alteração de comportamento.
 */

const { normalizeForwardTipo } = require('./messageNormalizers')
const { normalizeVideoForUltraMsg, normalizeImageForWhatsapp } = require('../media/mediaNormalizers')

function getForwardMediaUrlCandidate(mensagem) {
  return String(
    mensagem?.url ||
    mensagem?.url_absoluta ||
    mensagem?.media_url ||
    mensagem?.mediaUrl ||
    ''
  ).trim()
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function resolveLocalUploadPathFromMediaUrl(mediaUrl) {
  const raw = String(mediaUrl || '').trim()
  if (!raw) return null
  let pathname = raw
  if (/^https?:\/\//i.test(raw)) {
    try {
      pathname = new URL(raw).pathname
    } catch {
      return null
    }
  }
  pathname = safeDecodeURIComponent(String(pathname || '').split('?')[0])
  if (!pathname.startsWith('/uploads/')) return null

  const path = require('path')
  const fs = require('fs')
  const { getUploadsRoot } = require('../../../config/uploadsRoot')
  const uploadsRoot = path.resolve(getUploadsRoot())
  const rel = pathname.replace(/^\/uploads\//, '').replace(/^[\\/]+/, '')
  const full = path.resolve(uploadsRoot, rel)
  if (full !== uploadsRoot && !full.startsWith(`${uploadsRoot}${path.sep}`)) return null
  if (!fs.existsSync(full)) return null
  return full
}

/**
 * Baixa mídia armazenada no R2 (url "/media/r2/<key>") para um arquivo temporário efêmero em
 * os.tmpdir(). Usado no encaminhamento quando a empresa usa R2 como armazenamento único (sem
 * cópia local). Retorna o caminho do temporário, ou null se o R2 não estiver configurado / chave
 * inválida. O chamador é responsável por remover o temporário (try/finally).
 */
async function downloadR2MediaToTemp(mediaUrl) {
  const os = require('os')
  const path = require('path')
  const fs = require('fs')
  const { isR2Configured, getPresignExpiresSeconds } = require('../../../config/r2')
  if (!isR2Configured()) return null

  const key = String(mediaUrl || '').replace(/^\/media\/r2\//, '').split('?')[0]
  if (!key || key.includes('..') || !key.startsWith('media/')) return null

  const { presignGetUrl } = require('../../storage/r2Client')
  const signed = presignGetUrl(key, Math.min(120, getPresignExpiresSeconds()))
  const res = await fetch(signed)
  if (!res.ok) throw new Error(`R2 GET ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('R2 corpo vazio')

  const base = path.basename(key).replace(/[^A-Za-z0-9._-]/g, '_') || 'midia'
  const tmp = path.join(os.tmpdir(), `zaperp-fwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}`)
  await fs.promises.writeFile(tmp, buf)
  return tmp
}

async function resolveForwardMediaForProvider({ provider, mensagemOriginal, company_id, whatsappInstanceId, baseUrl }) {
  const rawUrl = getForwardMediaUrlCandidate(mensagemOriginal)
  if (!rawUrl) return { ok: false, error: 'Mensagem sem URL de mídia para encaminhamento.' }

  const isLocalBase = !baseUrl || /localhost|127\.0\.0\.1/i.test(baseUrl)
  let publicUrl = rawUrl.startsWith('http')
    ? rawUrl
    : baseUrl
      ? `${baseUrl}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`
      : null

  const tipo = normalizeForwardTipo(mensagemOriginal.tipo)
  let localPath = resolveLocalUploadPathFromMediaUrl(rawUrl)
  let uploadName = mensagemOriginal.nome_arquivo || 'arquivo'

  // R2 como armazenamento único (empresa 1): quando não há arquivo local mas a mídia está no R2,
  // baixa os bytes para um temporário efêmero. Assim uploadMedia/normalização funcionam sem
  // depender de o provedor seguir o redirect 302. Removido no finally.
  let tempR2Path = null
  if (!localPath && rawUrl.startsWith('/media/r2/')) {
    tempR2Path = await downloadR2MediaToTemp(rawUrl).catch((e) => {
      console.warn('[ULTRAMSG][FORWARD] download do R2 para encaminhamento falhou:', e?.message || e)
      return null
    })
    if (tempR2Path) localPath = tempR2Path
  }

  try {
  if (tipo === 'video' && localPath) {
    const path = require('path')
    const normalizedVideo = await normalizeVideoForUltraMsg({
      path: localPath,
      filename: path.basename(localPath),
      originalname: uploadName,
      mimetype: '',
    }, 'video', { removeSource: false })
    if (normalizedVideo?.converted && normalizedVideo?.file) {
      localPath = normalizedVideo.file.path
      uploadName = normalizedVideo.file.originalname
      if (baseUrl && !isLocalBase) {
        publicUrl = `${baseUrl}/uploads/${encodeURIComponent(normalizedVideo.file.filename)}`
      }
    } else if (normalizedVideo?.required && normalizedVideo?.error) {
      return { ok: false, error: 'Não foi possível preparar o vídeo para encaminhamento.' }
    }

    // O MP4 preparado segue primeiro para o CDN da UltraMSG com MIME video/mp4.
    // A URL própria permanece abaixo apenas como fallback se o upload falhar.
  }

  if (provider?.uploadMedia && localPath) {
    try {
      let uploadPath = localPath
      if (tipo === 'imagem') {
        const path = require('path')
        const normalizedImage = await normalizeImageForWhatsapp({
          path: localPath,
          filename: path.basename(localPath),
          originalname: uploadName,
          mimetype: '',
        }, 'imagem')
        if (normalizedImage?.converted && normalizedImage?.file) {
          uploadPath = normalizedImage.file.path
          uploadName = normalizedImage.file.originalname
          console.log('[ULTRAMSG][FORWARD_IMAGE] Imagem encaminhada normalizada para JPEG:', {
            from: mensagemOriginal.nome_arquivo || path.basename(localPath),
            to: uploadName,
          })
        } else if (normalizedImage?.error) {
          console.warn('[ULTRAMSG][FORWARD_IMAGE] Normalização JPEG indisponível:', normalizedImage.error)
        }
      }
      const providerUploadName = tipo === 'video'
        ? require('path').basename(uploadPath)
        : uploadName
      const upload = await provider.uploadMedia(
        uploadPath,
        providerUploadName,
        { companyId: company_id, whatsappInstanceId: whatsappInstanceId || undefined }
      )
      if (upload?.ok && upload?.url) return { ok: true, url: upload.url, source: 'provider_upload' }
      if (tipo === 'video' || !publicUrl || isLocalBase) {
        return { ok: false, error: upload?.error || 'Falha ao preparar mídia para encaminhamento.' }
      }
    } catch (error) {
      if (tipo === 'video' || !publicUrl || isLocalBase) {
        return { ok: false, error: error?.message || 'Falha ao preparar mídia para encaminhamento.' }
      }
    }
  }

  if (publicUrl && !isLocalBase) return { ok: true, url: publicUrl, source: 'public_url' }
  if (publicUrl && rawUrl.startsWith('http')) return { ok: true, url: publicUrl, source: 'remote_url' }
  return {
    ok: false,
    error: provider?.uploadMedia
      ? 'URL local da mídia indisponível para encaminhamento.'
      : 'Provider não suporta uploadMedia e a URL pública da mídia não está configurada.',
  }
  } finally {
    // Remove o temporário baixado do R2 (se houver). Só chega aqui após uploadMedia ter lido o arquivo.
    if (tempR2Path) {
      try { require('fs').unlinkSync(tempR2Path) } catch (_) { /* já removido */ }
    }
  }
}

module.exports = {
  getForwardMediaUrlCandidate,
  safeDecodeURIComponent,
  resolveLocalUploadPathFromMediaUrl,
  downloadR2MediaToTemp,
  resolveForwardMediaForProvider,
}
