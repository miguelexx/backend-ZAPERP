/**
 * Middleware de upload de mídia para variações do Disparo.
 * Usa memoryStorage — o arquivo fica em memória e é salvo via controller (R2 ou disco).
 * Valida: extensão, MIME declarado, magic bytes e tamanho máximo.
 * Suporta apenas formatos compatíveis com o envio via UltraMSG/WhatsApp.
 */

const multer = require('multer')
const path = require('path')

// ── Limites por tipo (em MB) ───────────────────────────────────────────────────
const MAX_IMAGEM_MB   = Number(process.env.DISPARO_IMAGEM_MAX_MB  || 5)
const MAX_VIDEO_MB    = Number(process.env.DISPARO_VIDEO_MAX_MB   || 32)
const MAX_AUDIO_MB    = Number(process.env.DISPARO_AUDIO_MAX_MB   || 16)
const MAX_DOC_MB      = Number(process.env.DISPARO_DOC_MAX_MB     || 100)
const MAX_GLOBAL_MB   = Math.max(MAX_IMAGEM_MB, MAX_VIDEO_MB, MAX_AUDIO_MB, MAX_DOC_MB)

const MB = 1024 * 1024

// ── MIME aceitos por tipo de mensagem ─────────────────────────────────────────
const MIME_IMAGEM = new Set(['image/jpeg','image/png','image/webp','image/gif'])
const MIME_VIDEO  = new Set(['video/mp4','video/3gpp','video/quicktime','video/x-msvideo'])
const MIME_AUDIO  = new Set(['audio/mpeg','audio/mp3','audio/ogg','audio/aac','audio/opus','audio/x-m4a','audio/mp4','audio/wav','audio/x-wav','audio/webm'])
const MIME_DOC    = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint',
  'text/plain','text/csv','application/rtf','application/zip','application/x-zip-compressed',
])

const EXT_IMAGEM = new Set(['jpg','jpeg','png','webp','gif'])
const EXT_VIDEO  = new Set(['mp4','3gp','mov','avi'])
const EXT_AUDIO  = new Set(['mp3','ogg','aac','opus','m4a','wav','webm'])
const EXT_DOC    = new Set(['pdf','docx','doc','xlsx','xls','pptx','ppt','txt','csv','rtf','zip'])

const TODOS_MIMES = new Set([...MIME_IMAGEM,...MIME_VIDEO,...MIME_AUDIO,...MIME_DOC])
const TODAS_EXTS  = new Set([...EXT_IMAGEM,...EXT_VIDEO,...EXT_AUDIO,...EXT_DOC])

// ── Magic bytes ───────────────────────────────────────────────────────────────

/** Detecta o formato real pelos primeiros bytes. */
function detectarTipoRealMidia(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null
  const b = buffer
  // JPEG
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'imagem'
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'imagem'
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'imagem'
  // WebP (RIFF....WEBP)
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'imagem'
  // MP4 / 3GP: ftyp box at offset 4
  if (buffer.length >= 12) {
    const ftyp = buffer.slice(4, 8).toString('ascii')
    if (ftyp === 'ftyp') return 'video'
    // MOV
    if (ftyp === 'mdat' || ftyp === 'moov' || ftyp === 'free') return 'video'
  }
  // OGG (video or audio)
  if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio_ou_video'
  // ID3 tag (MP3)
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio'
  // MP3 sync
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'audio'
  // AAC ADTS
  if (b[0] === 0xFF && b[1] === 0xF1) return 'audio'
  // PDF
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'documento'
  // ZIP / DOCX / XLSX / PPTX
  if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) return 'documento'
  // OLE2 (DOC, XLS, PPT)
  if (b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) return 'documento'
  // plain text (CSV, TXT)
  const sample = buffer.slice(0, Math.min(512, buffer.length))
  if (sample.every(byte => (byte >= 0x09 && byte <= 0x0D) || (byte >= 0x20 && byte <= 0x7E) || byte >= 0x80)) {
    return 'documento'
  }
  return null
}

/** Tipo de mensagem que o MIME declarado implica. */
function tipoMensagemPorMime(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim()
  if (MIME_IMAGEM.has(m)) return 'imagem'
  if (MIME_VIDEO.has(m)) return 'video'
  if (MIME_AUDIO.has(m)) return 'audio'
  if (MIME_DOC.has(m)) return 'documento'
  return null
}

/** Tipo de mensagem que a extensão implica. */
function tipoMensagemPorExt(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '')
  if (EXT_IMAGEM.has(e)) return 'imagem'
  if (EXT_VIDEO.has(e)) return 'video'
  if (EXT_AUDIO.has(e)) return 'audio'
  if (EXT_DOC.has(e)) return 'documento'
  return null
}

/** Limite de tamanho em bytes por tipo. */
function limitePorTipo(tipo) {
  if (tipo === 'imagem')    return MAX_IMAGEM_MB * MB
  if (tipo === 'video')     return MAX_VIDEO_MB * MB
  if (tipo === 'audio')     return MAX_AUDIO_MB * MB
  if (tipo === 'documento') return MAX_DOC_MB * MB
  return MAX_GLOBAL_MB * MB
}

// ── Multer memoryStorage ──────────────────────────────────────────────────────

const uploadDisparoMidiaMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_GLOBAL_MB * MB },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().replace('.', '')
    const mime = String(file.mimetype || '').split(';')[0].trim().toLowerCase()
    const mimeOk  = TODOS_MIMES.has(mime) && mime !== 'application/octet-stream'
    const extOk   = TODAS_EXTS.has(ext)
    if (!mimeOk && !extOk) {
      const err = new Error(`Formato não suportado para disparo: .${ext || '?'} (${mime || '?'})`)
      err.status = 400; err.code = 'DISPARO_MIDIA_TIPO_INVALIDO'
      return cb(err, false)
    }
    cb(null, true)
  },
})

/**
 * Middleware principal: faz parse do campo 'midia' e valida magic bytes.
 * Popula req.disparoMidia com metadados extraídos.
 */
function uploadDisparoMidia(req, res, next) {
  uploadDisparoMidiaMulter.single('midia')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: `Arquivo excede o limite máximo de ${MAX_GLOBAL_MB} MB.`,
          code: 'DISPARO_MIDIA_MUITO_GRANDE',
        })
      }
      return res.status(err.status || 400).json({ error: err.message, code: err.code })
    }

    if (!req.file) return next()

    const { buffer, originalname, mimetype, size } = req.file
    const ext = path.extname(originalname || '').toLowerCase().replace('.', '')
    const mime = String(mimetype || '').split(';')[0].trim().toLowerCase()

    const tipoPorMime = tipoMensagemPorMime(mime)
    const tipoPorExt  = tipoMensagemPorExt(ext)
    const tipoDeclarado = tipoPorMime || tipoPorExt

    // Valida magic bytes
    const tipoReal = detectarTipoRealMidia(buffer)
    if (tipoReal && tipoDeclarado && tipoDeclarado !== 'documento' && tipoReal !== 'audio_ou_video') {
      const tipoRealNorm = tipoReal === 'audio' ? 'audio' : tipoReal
      if (tipoRealNorm !== tipoDeclarado && !(tipoDeclarado === 'video' && tipoRealNorm === 'audio')) {
        return res.status(400).json({
          error: `O conteúdo do arquivo não corresponde ao tipo declarado (${tipoDeclarado}). Verificação de segurança falhou.`,
          code: 'DISPARO_MIDIA_FORMATO_MISMATCH',
        })
      }
    }

    const tipoFinal = tipoDeclarado || tipoReal || 'documento'
    const limite = limitePorTipo(tipoFinal)

    if (size > limite) {
      return res.status(400).json({
        error: `Arquivo ${tipoFinal} maior que ${limite / MB} MB.`,
        code: 'DISPARO_MIDIA_MUITO_GRANDE',
      })
    }

    // Nome seguro: sem path traversal
    const nomeOriginalSafe = path.basename(originalname || 'arquivo').replace(/[^\w.\-]/g, '_').slice(0, 255)

    req.disparoMidia = {
      buffer,
      nomeOriginal: nomeOriginalSafe,
      mime,
      ext,
      tamanho: size,
      tipoMensagem: tipoFinal,
    }

    next()
  })
}

module.exports = {
  uploadDisparoMidia,
  detectarTipoRealMidia,
  tipoMensagemPorMime,
  tipoMensagemPorExt,
  limitePorTipo,
  MIME_IMAGEM, MIME_VIDEO, MIME_AUDIO, MIME_DOC,
  EXT_IMAGEM, EXT_VIDEO, EXT_AUDIO, EXT_DOC,
  MAX_IMAGEM_MB, MAX_VIDEO_MB, MAX_AUDIO_MB, MAX_DOC_MB,
}
