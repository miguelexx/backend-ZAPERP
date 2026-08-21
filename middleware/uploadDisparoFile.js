/**
 * Upload em memória para o módulo Disparo de Mensagens.
 * Aceita .xlsx, .xls e .csv.
 * Tamanho máximo configurável por env DISPARO_UPLOAD_MAX_MB (default 20 MB).
 * Não persiste o arquivo em disco — o processamento ocorre na mesma requisição.
 */

const multer = require('multer')
const path = require('path')

function maxBytes() {
  const mb = Number(process.env.DISPARO_UPLOAD_MAX_MB)
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 20 * 1024 * 1024
}

const ALLOWED_EXTENSIONS = new Set(['xlsx', 'xls', 'csv'])

const ALLOWED_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel',                                           // xls
  'text/csv',
  'text/plain',
  'text/comma-separated-values',
  'application/csv',
  'application/octet-stream', // fallback genérico de alguns browsers
  '',                          // sem MIME (aceitamos; validamos por extensão)
])

function extOf(filename) {
  const ext = path.extname(String(filename ?? '')).toLowerCase().slice(1)
  return ext
}

function validationError(message, code) {
  const err = new Error(message)
  err.status = 400
  err.code = code ?? 'UPLOAD_DISPARO_INVALIDO'
  return err
}

const disparoMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxBytes(), files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = extOf(file.originalname)
    const mime = String(file.mimetype ?? '').split(';')[0].trim().toLowerCase()

    // Bloqueia nomes com path traversal ou caracteres perigosos
    if (/[/\\]/.test(file.originalname)) {
      return cb(validationError('Nome de arquivo inválido.', 'UPLOAD_NOME_INVALIDO'), false)
    }

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(
        validationError(
          `Formato não aceito: .${ext}. Use .xlsx, .xls ou .csv.`,
          'UPLOAD_EXTENSAO_INVALIDA',
        ),
        false,
      )
    }
    if (mime && !ALLOWED_MIMES.has(mime)) {
      return cb(
        validationError('Tipo MIME inválido para planilha.', 'UPLOAD_MIME_INVALIDO'),
        false,
      )
    }
    cb(null, true)
  },
})

/**
 * Middleware: aceita arquivo nos campos 'arquivo' ou 'file'.
 * Normaliza para req.file após o upload.
 */
function uploadDisparoFile(req, res, next) {
  const mw = disparoMulter.fields([
    { name: 'arquivo', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ])
  mw(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxMb = (maxBytes() / 1024 / 1024).toFixed(0)
        return next(
          validationError(
            `Arquivo maior que ${maxMb} MB. Reduza a planilha e tente novamente.`,
            'UPLOAD_TAMANHO_EXCEDIDO',
          ),
        )
      }
      return next(err)
    }
    const arquivo = req.files?.arquivo?.[0] ?? req.files?.file?.[0] ?? null
    if (arquivo) req.file = arquivo
    next()
  })
}

module.exports = { uploadDisparoFile, ALLOWED_EXTENSIONS, maxBytes }
