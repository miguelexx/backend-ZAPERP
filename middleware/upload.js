const multer = require('multer')
const path = require('path')
const fs = require('fs')

const uploadDir = path.join(__dirname, '../uploads')
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

/** MIME permitidos → extensão. Usa base MIME (sem parâmetros) para lookup. */
const ALLOWED_MIME = new Map([
  // Imagens
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp'],
  // Áudio (incl. gravação do navegador: webm, ogg; codecs=opus)
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/aac', '.aac'],
  ['audio/x-m4a', '.m4a'],
  ['audio/webm', '.webm'],
  ['audio/opus', '.opus'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/mp4', '.m4a'], // Safari/iOS às vezes envia m4a como audio/mp4
  // Vídeo
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
  ['video/x-msvideo', '.avi'],
  ['video/3gpp', '.3gp'],
  // Documentos (UltraMsg aceita até 30MB)
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/msword', '.doc'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['application/zip', '.zip'],
  ['application/x-zip-compressed', '.zip'],
])

/** Extrai base MIME (sem parâmetros como ; codecs=opus). */
function getBaseMime(mimetype) {
  const m = String(mimetype || '').toLowerCase().trim()
  return m.split(';')[0].trim()
}

// Campos tipicamente usados para áudio (fallback quando mimetype vazio)
const AUDIO_FIELD_NAMES = ['audio', 'recording', 'voice', 'blob', 'media', 'file', 'arquivo', 'attachment']

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const mime = getBaseMime(file.mimetype)
    let ext = ALLOWED_MIME.get(mime)
    if (!ext && AUDIO_FIELD_NAMES.includes(file.fieldname)) ext = '.webm' // Blob áudio sem mimetype
    ext = ext || '.bin'
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`
    cb(null, name)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 32 * 1024 * 1024 }, // 32MB (vídeo UltraMsg; docs até 30MB)
  fileFilter: (req, file, cb) => {
    const baseMime = getBaseMime(file.mimetype)
    let ok = ALLOWED_MIME.has(baseMime)
    // Fallback: Blob de áudio sem mimetype explícito (alguns navegadores/MediaRecorder)
    if (!ok && (!baseMime || baseMime === 'application/octet-stream')) {
      if (AUDIO_FIELD_NAMES.includes(file.fieldname)) ok = true
    }
    if (ok) cb(null, true)
    else cb(new Error(`Tipo de arquivo não permitido: ${baseMime || file.mimetype}`), false)
  },
})

/**
 * Upload para rota /arquivo: aceita QUALQUER nome de campo (file, audio, recording, etc).
 * Usa upload.any() para não rejeitar campos inesperados enviados pelo frontend.
 * Retorna req.file populado para compatibilidade com enviarArquivo.
 */
const uploadArquivo = (req, res, next) => {
  const mw = upload.any()
  mw(req, res, (err) => {
    if (err) return next(err)
    // Normaliza: enviarArquivo espera req.file (singular)
    if (!req.file && req.files && Array.isArray(req.files) && req.files.length > 0) {
      req.file = req.files[0]
    }
    next()
  })
}

module.exports = { upload, uploadDir, uploadArquivo }
