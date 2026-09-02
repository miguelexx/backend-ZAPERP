/**
 * Classificação/detecção pura de tipo de mídia e decisões de normalização (sem FFmpeg/filesystem).
 * Extraído de controllers/chatController.js (Fase 1 da modularização) sem alteração de comportamento.
 *
 * As constantes de extensão/limites são exportadas para que os normalizadores que ainda
 * dependem de FFmpeg/filesystem (que permanecem no controller nesta fase) continuem usando os mesmos valores.
 */

const IMAGE_FILE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif'])
const VIDEO_FILE_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', '3gp', 'mpeg', 'mpg', 'ogv'])
// Contrato oficial do endpoint UltraMSG /messages/video.
const ULTRAMSG_VIDEO_FILE_EXTENSIONS = new Set(['mp4', '3gp', 'mov'])
const ULTRAMSG_VIDEO_MAX_BYTES = 32 * 1024 * 1024
// Margem para overhead do container/CDN e diferenças entre MB decimal e MiB.
const ULTRAMSG_VIDEO_TARGET_BYTES = 29 * 1024 * 1024
const AUDIO_FILE_EXTENSIONS = new Set(['ogg', 'mp3', 'wav', 'm4a', 'aac', 'opus', 'amr'])
const DOCUMENT_FILE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'csv', 'md', 'html', 'htm', 'rtf',
  'json', 'xml', 'sql', 'zip', 'rar', '7z',
])

/**
 * Duração em segundos a partir do FormData do upload de áudio/voice.
 * Usa o MENOR entre elapsed e duration: elapsed (relógio de parede) é confiável;
 * duration vem do <audio> lendo o WebM cru e pode ser inflado no container sem Duration.
 */
function parseAudioDuracaoSecFromBody(body) {
  if (!body || typeof body !== 'object') return null
  const fromMs = (raw) => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.max(1, Math.min(600, Math.round(n / 1000)))
  }
  const fromSec = (raw) => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.max(1, Math.min(600, Math.round(n)))
  }
  const elapsed = fromMs(body.audio_elapsed_ms)
  const duration = fromMs(body.audio_duration_ms)
  if (elapsed && duration) return Math.min(elapsed, duration)
  return (
    elapsed ||
    duration ||
    fromSec(body.audio_duracao_sec) ||
    fromSec(body.audio_duration_sec) ||
    null
  )
}

function mimeBase(file) {
  const m = String(file?.mimetype || '').toLowerCase().trim()
  return m.split(';')[0].trim()
}

function extBaseArquivo(file) {
  const candidates = [file?.originalname, file?.filename, file?.path]
  for (const candidate of candidates) {
    const match = String(candidate || '').toLowerCase().match(/\.([a-z0-9]{2,8})$/i)
    if (match?.[1]) return match[1].toLowerCase()
  }
  return ''
}

/**
 * Nota de voz gravada no browser: MIME costuma ser audio/webm, mas em alguns clients
 * chega vazio, application/octet-stream ou até video/webm com extensão .webm.
 * Sem este aceite, tipo=voice era ignorado e o arquivo caía como vídeo.
 */
function isForcedVoiceAudioish(file) {
  const base = mimeBase(file)
  const ext = extBaseArquivo(file)
  if (base.startsWith('audio/')) return true
  if (AUDIO_FILE_EXTENSIONS.has(ext)) return true
  if (ext === 'webm') return true
  if (base === 'video/webm') return true
  return false
}

function aplicarTipoForcadoSticker(file, tipoInferido) {
  const forced = String(file?.__tipoForcado || '').toLowerCase().trim()
  if (forced === 'video' || forced === 'vídeo') {
    const base = mimeBase(file)
    const ext = extBaseArquivo(file)
    // Aceita MIME video/* e extensões de vídeo conhecidas.
    // Também aceita application/octet-stream e MIME ausente: browsers Android/iOS
    // frequentemente enviam MIME genérico para vídeos de câmera — o frontend
    // já validou via isVideoFile (extensão/tipo) antes de forçar tipo=video.
    // Rejeita apenas tipos que são claramente não-vídeo (ex.: application/pdf).
    const videoish =
      base.startsWith('video/') ||
      VIDEO_FILE_EXTENSIONS.has(ext) ||
      base === 'application/octet-stream' ||
      !base
    return videoish ? 'video' : tipoInferido
  }
  if (forced === 'voice' || forced === 'ptt') {
    return isForcedVoiceAudioish(file) ? 'voice' : tipoInferido
  }
  if (forced !== 'sticker') return tipoInferido
  const base = mimeBase(file)
  const ext = extBaseArquivo(file)
  const stickerish =
    ['image/webp', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif'].includes(base) ||
    ['webp', 'png', 'jpg', 'jpeg', 'gif'].includes(ext)
  return stickerish ? 'sticker' : tipoInferido
}

function inferirTipoArquivo(file) {
  const m = mimeBase(file)
  const ext = extBaseArquivo(file)

  if (m.startsWith('image/')) return 'imagem'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'

  if (IMAGE_FILE_EXTENSIONS.has(ext)) return 'imagem'
  if (VIDEO_FILE_EXTENSIONS.has(ext)) return 'video'
  if (AUDIO_FILE_EXTENSIONS.has(ext)) return 'audio'
  if (DOCUMENT_FILE_EXTENSIONS.has(ext)) return 'arquivo'

  return 'arquivo'
}

function getAudioFileExtension(file) {
  const byOriginal = String(file?.originalname || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/i)
  if (byOriginal?.[1]) return byOriginal[1].toLowerCase()
  const byStored = String(file?.filename || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/i)
  if (byStored?.[1]) return byStored[1].toLowerCase()
  return ''
}

function shouldAbortAudioAfterNormalize(tipo, normalized) {
  if (tipo !== 'voice' && tipo !== 'audio') return false
  if (normalized?.converted) return false
  if (!normalized?.required) return false
  return !!normalized?.error
}

function shouldNormalizeVideoForUltraMsg(file, tipo) {
  if (tipo !== 'video' || !file?.path) return false
  // Todo vídeo enviado pelo painel passa pela preparação determinística:
  // garante H.264/AAC dentro de um MP4 compatível com WhatsApp independente do
  // MIME ou extensão original (inclusive application/octet-stream de alguns browsers).
  return true
}

function shouldForceProviderUploadForMedia(tipo) {
  const normalized = String(tipo || '').toLowerCase().trim()
  // imagem/arquivo também sobem para o CDN do UltraMsg em vez de serem enviados como URL
  // pública do backend. Enviar por URL faz o UltraMsg ter que baixar o arquivo do nosso
  // servidor antes de entregar — round-trip lento/instável que deixa foto/PDF muito tempo
  // no relógio (pending) até o ACK. Com uploadMedia o provedor já recebe os bytes na hora.
  // Áudio/vídeo já faziam isso. Há fallback para URL pública se o uploadMedia falhar
  // (ver mediaMessageController), então não há regressão quando o CDN estiver indisponível.
  return (
    normalized === 'audio' ||
    normalized === 'voice' ||
    normalized === 'video' ||
    normalized === 'imagem' ||
    normalized === 'arquivo'
  )
}

function buildVideoTranscodeProfile(durationSec, opts = {}) {
  const duration = Number(durationSec)
  if (!Number.isFinite(duration) || duration <= 0) return null

  const targetBytes = Math.max(4 * 1024 * 1024, Number(opts.targetBytes) || ULTRAMSG_VIDEO_TARGET_BYTES)
  // Reserva 6% para índices/metadata do MP4. O áudio reduz dinamicamente em vídeos longos.
  const totalKbps = Math.max(48, Math.floor((targetBytes * 8 * 0.94) / duration / 1000))
  const audioKbps = totalKbps >= 500 ? 64 : totalKbps >= 260 ? 48 : totalKbps >= 120 ? 32 : 24
  const videoKbps = Math.max(24, Math.min(4000, totalKbps - audioKbps))
  const maxWidth = videoKbps >= 1800 ? 1280 : videoKbps >= 900 ? 960 : videoKbps >= 450 ? 720 : videoKbps >= 240 ? 540 : 360

  return {
    durationSec: duration,
    targetBytes,
    totalKbps,
    videoKbps,
    audioKbps,
    maxWidth,
  }
}

function shouldNormalizeImageForWhatsapp(file, tipo) {
  if (tipo !== 'imagem' || !file?.path) return false
  const base = mimeBase(file)
  const ext = extBaseArquivo(file)
  if (base === 'image/gif' || ext === 'gif') return false
  return base.startsWith('image/') || IMAGE_FILE_EXTENSIONS.has(ext)
}

module.exports = {
  IMAGE_FILE_EXTENSIONS,
  VIDEO_FILE_EXTENSIONS,
  ULTRAMSG_VIDEO_FILE_EXTENSIONS,
  ULTRAMSG_VIDEO_MAX_BYTES,
  ULTRAMSG_VIDEO_TARGET_BYTES,
  AUDIO_FILE_EXTENSIONS,
  DOCUMENT_FILE_EXTENSIONS,
  parseAudioDuracaoSecFromBody,
  mimeBase,
  extBaseArquivo,
  isForcedVoiceAudioish,
  aplicarTipoForcadoSticker,
  inferirTipoArquivo,
  getAudioFileExtension,
  shouldAbortAudioAfterNormalize,
  shouldNormalizeVideoForUltraMsg,
  shouldForceProviderUploadForMedia,
  buildVideoTranscodeProfile,
  shouldNormalizeImageForWhatsapp,
}
