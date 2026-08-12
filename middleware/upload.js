const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { ensureUploadsRootExists, getUploadsRoot } = require('../config/uploadsRoot')

const uploadDir = ensureUploadsRootExists()

// A UltraMSG aceita vídeo final de até 32 MB. O arquivo-fonte precisa poder ser maior
// para que o backend tenha a oportunidade de compactá-lo antes do envio.
const DEFAULT_UPLOAD_MAX_BYTES = 32 * 1024 * 1024
const VIDEO_SOURCE_UPLOAD_MAX_BYTES = 128 * 1024 * 1024

const logosDir = path.join(getUploadsRoot(), 'logos')
if (!fs.existsSync(logosDir)) {
  fs.mkdirSync(logosDir, { recursive: true })
}

/** MIME permitidos → extensão no disco. */
const ALLOWED_MIME = new Map([
  // Imagens
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
  // Áudio
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/aac', '.aac'],
  ['audio/x-m4a', '.m4a'],
  ['audio/webm', '.webm'],
  ['audio/opus', '.opus'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/mp4', '.m4a'],
  // Vídeo
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
  ['video/x-msvideo', '.avi'],
  ['video/3gpp', '.3gp'],
  ['video/x-m4v', '.m4v'],
  ['video/x-matroska', '.mkv'],
  ['video/mpeg', '.mpeg'],
  ['video/ogg', '.ogv'],
  // Documentos (UltraMsg: até 30MB)
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/msword', '.doc'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['text/markdown', '.md'],
  ['text/html', '.html'],
  ['application/json', '.json'],
  ['application/xml', '.xml'],
  ['text/xml', '.xml'],
  ['application/rtf', '.rtf'],
  ['application/zip', '.zip'],
  ['application/x-zip-compressed', '.zip'],
  ['application/vnd.rar', '.rar'],
  ['application/x-rar-compressed', '.rar'],
  ['application/x-7z-compressed', '.7z'],
  ['application/sql', '.sql'],
  ['application/octet-stream', '.bin'],
])

/** Extensões aceitas quando o navegador envia MIME genérico (octet-stream) ou vazio. */
const ALLOWED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif',
  'mp3', 'ogg', 'aac', 'm4a', 'webm', 'opus', 'wav',
  'mp4', 'mov', 'avi', '3gp', 'webm', 'm4v', 'mkv', 'mpeg', 'mpg', 'ogv',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'csv', 'md', 'html', 'htm', 'rtf',
  'json', 'xml', 'sql',
  'zip', 'rar', '7z',
])

/**
 * Extensões de alto risco: WhatsApp/UltraMsg costumam recusar e podem aumentar chance de restrição na conta.
 * Upload e envio são bloqueados no CRM (use ZIP apenas com documentos permitidos, se necessário).
 */
const EXTENSOES_BLOQUEADAS_WHATSAPP = new Set([
  'exe', // executável Windows
  'msi', // instalador Windows
  'apk', // app Android
  'bat', // script batch
  'cmd', // script de comando
  'com', // executável legado DOS/Windows
  'scr', // protetor de tela / vetor comum de malware
  'ps1', // PowerShell
  'sh', // Shell script
  'vbs', // VBScript
  'reg', // registro Windows
  'dll', // biblioteca executável
  'jar', // arquivo Java executável
])

/** @deprecated Use EXTENSOES_BLOQUEADAS_WHATSAPP — mantido vazio para compat de import. */
const EXTENSOES_AVISO_WHATSAPP = new Set()

function isBlockedRiskExtension(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '')
  return e.length > 0 && EXTENSOES_BLOQUEADAS_WHATSAPP.has(e)
}

function blockedUploadErrorMessage(ext) {
  const label = ext ? `.${String(ext).toLowerCase()}` : 'deste tipo'
  return (
    `Arquivos ${label} não podem ser enviados pelo WhatsApp (alto risco de bloqueio). ` +
    'Se precisar compartilhar, coloque o conteúdo dentro de um .zip com PDF, planilha ou documento permitido.'
  )
}

function uploadValidationError(message, code = 'UPLOAD_VALIDATION_ERROR') {
  const err = new Error(message)
  err.status = 400
  err.code = code
  return err
}

const AUDIO_FIELD_NAMES = ['audio', 'recording', 'voice', 'blob', 'media', 'file', 'arquivo', 'attachment']

function getBaseMime(mimetype) {
  const m = String(mimetype || '').toLowerCase().trim()
  return m.split(';')[0].trim()
}

function extFromOriginalName(originalname) {
  const base = path.basename(String(originalname || ''))
  const m = base.match(/\.([a-z0-9]{2,8})$/i)
  return m ? m[1].toLowerCase() : ''
}

function isAllowedUploadFile(file) {
  const ext = extFromOriginalName(file?.originalname)
  if (isBlockedRiskExtension(ext)) return false

  const baseMime = getBaseMime(file?.mimetype)
  if (ALLOWED_MIME.has(baseMime) && baseMime !== 'application/octet-stream') return true

  if (ext && ALLOWED_EXTENSIONS.has(ext)) return true

  if ((!baseMime || baseMime === 'application/octet-stream') && AUDIO_FIELD_NAMES.includes(file?.fieldname)) {
    return true
  }

  return false
}

function isVideoUploadFile(file) {
  const baseMime = getBaseMime(file?.mimetype)
  const ext = extFromOriginalName(file?.originalname)
  return baseMime.startsWith('video/') || [
    'mp4', 'mov', 'avi', '3gp', 'webm', 'm4v', 'mkv', 'mpeg', 'mpg', 'ogv',
  ].includes(ext)
}

function resolveStorageExtension(file) {
  const baseMime = getBaseMime(file?.mimetype)
  let ext = ALLOWED_MIME.get(baseMime)
  if (ext === '.bin' || !ext) {
    const fromName = extFromOriginalName(file?.originalname)
    if (fromName) ext = `.${fromName}`
  }
  if (!ext && AUDIO_FIELD_NAMES.includes(file?.fieldname)) ext = '.webm'
  return ext || '.bin'
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = resolveStorageExtension(file)
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`
    cb(null, name)
  },
})

const upload = multer({
  storage,
  // Limite físico do parser. Tipos não-vídeo continuam limitados a 32 MB logo abaixo.
  limits: { fileSize: VIDEO_SOURCE_UPLOAD_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = extFromOriginalName(file.originalname)
    if (isBlockedRiskExtension(ext)) {
      return cb(uploadValidationError(blockedUploadErrorMessage(ext), 'UPLOAD_BLOCKED_EXTENSION'), false)
    }
    if (isAllowedUploadFile(file)) return cb(null, true)
    const baseMime = getBaseMime(file.mimetype)
    cb(
      uploadValidationError(
        `Tipo de arquivo não permitido${ext ? ` (.${ext})` : ''}${baseMime ? `: ${baseMime}` : ''}. Use documentos, planilhas, PDF, JSON, ZIP, imagens ou vídeos.`,
        'UPLOAD_UNSUPPORTED_TYPE'
      ),
      false
    )
  },
})

const uploadArquivo = (req, res, next) => {
  const mw = upload.any()
  mw(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        err.uploadLimitMessage = 'Vídeo maior que 128 MB. Reduza o arquivo original e tente novamente.'
      }
      return next(err)
    }
    if (!req.file && req.files && Array.isArray(req.files) && req.files.length > 0) {
      req.file = req.files[0]
    }

    const requestFiles = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : [])
    // Respeita tipo explícito do body: quando o cliente envia tipo=video (ex.: MIME genérico
    // de alguns browsers/Android), o backend irá transcodificar — não rejeitar.
    const explicitTipo = String(req.body?.tipo || req.query?.tipo || '').toLowerCase().trim()
    const clientForcedVideo = explicitTipo === 'video' || explicitTipo === 'vídeo'
    const oversizedNonVideo = requestFiles.find(
      (file) => Number(file?.size) > DEFAULT_UPLOAD_MAX_BYTES && !isVideoUploadFile(file) && !clientForcedVideo
    )
    if (oversizedNonVideo) {
      // O multer já gravou os arquivos em disco; remova todo o lote antes de rejeitar.
      for (const file of requestFiles) {
        try {
          if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path)
        } catch (_) {}
      }
      return next(uploadValidationError(
        'Arquivo maior que 32 MB. Apenas vídeos podem ultrapassar esse tamanho para compactação automática.',
        'UPLOAD_NON_VIDEO_TOO_LARGE'
      ))
    }
    next()
  })
}

const LOGO_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, logosDir),
  filename: (req, file, cb) => {
    const baseMime = getBaseMime(file?.mimetype)
    const ext = ALLOWED_MIME.get(baseMime) || `.${extFromOriginalName(file?.originalname) || 'png'}`
    const name = `company_${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
    cb(null, name)
  },
})

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const baseMime = getBaseMime(file?.mimetype)
    const ext = extFromOriginalName(file?.originalname)
    if (LOGO_MIME.has(baseMime)) return cb(null, true)
    if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return cb(null, true)
    cb(uploadValidationError('Apenas imagens são permitidas para o logo (JPEG, PNG, WebP, GIF — máx. 5 MB).', 'UPLOAD_NOT_IMAGE'), false)
  },
})

module.exports = {
  upload,
  uploadDir,
  uploadArquivo,
  uploadLogo,
  logosDir,
  isAllowedUploadFile,
  extFromOriginalName,
  EXTENSOES_BLOQUEADAS_WHATSAPP,
  EXTENSOES_AVISO_WHATSAPP,
  isBlockedRiskExtension,
  blockedUploadErrorMessage,
  uploadValidationError,
  isVideoUploadFile,
  DEFAULT_UPLOAD_MAX_BYTES,
  VIDEO_SOURCE_UPLOAD_MAX_BYTES,
}
