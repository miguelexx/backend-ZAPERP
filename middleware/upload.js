const multer = require('multer')
const path = require('path')
const { ensureUploadsRootExists } = require('../config/uploadsRoot')

const uploadDir = ensureUploadsRootExists()

/** MIME permitidos → extensão no disco. */
const ALLOWED_MIME = new Map([
  // Imagens
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp'],
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
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp',
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
  limits: { fileSize: 32 * 1024 * 1024 },
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
    if (err) return next(err)
    if (!req.file && req.files && Array.isArray(req.files) && req.files.length > 0) {
      req.file = req.files[0]
    }
    next()
  })
}

module.exports = {
  upload,
  uploadDir,
  uploadArquivo,
  isAllowedUploadFile,
  extFromOriginalName,
  EXTENSOES_BLOQUEADAS_WHATSAPP,
  EXTENSOES_AVISO_WHATSAPP,
  isBlockedRiskExtension,
  blockedUploadErrorMessage,
  uploadValidationError,
}
