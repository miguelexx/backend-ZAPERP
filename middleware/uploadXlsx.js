/**
 * Upload em memória para importação de planilhas (.xlsx).
 *
 * Separado do middleware/upload.js (que grava mídia em disco) porque aqui o arquivo
 * é processado na hora e descartado — não deve ser persistido. Valida tipo e tamanho.
 */

const multer = require('multer')

const XLSX_MAX_BYTES = 8 * 1024 * 1024 // 8 MB — planilha de contatos é pequena

const XLSX_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/octet-stream', // alguns navegadores enviam genérico; validamos por extensão
  '', // fallback: sem MIME
])

function extOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : ''
}

function validationError(message, code) {
  const err = new Error(message)
  err.status = 400
  err.code = code || 'UPLOAD_XLSX_INVALIDO'
  return err
}

const uploadXlsxMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: XLSX_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = extOf(file.originalname)
    const mime = String(file.mimetype || '').split(';')[0].trim().toLowerCase()
    if (ext !== 'xlsx') {
      return cb(validationError('Apenas arquivos .xlsx são aceitos.', 'UPLOAD_XLSX_EXTENSAO'), false)
    }
    if (!XLSX_MIME.has(mime)) {
      return cb(validationError('Tipo de arquivo inválido. Envie uma planilha .xlsx.', 'UPLOAD_XLSX_MIME'), false)
    }
    cb(null, true)
  },
})

/**
 * Middleware: aceita um único arquivo no campo "arquivo" (ou "file").
 * Normaliza para req.file e traduz o erro de tamanho do multer.
 */
function uploadXlsx(req, res, next) {
  const mw = uploadXlsxMulter.fields([
    { name: 'arquivo', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ])
  mw(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(validationError('Arquivo maior que 8 MB. Reduza a planilha e tente novamente.', 'UPLOAD_XLSX_TAMANHO'))
      }
      return next(err)
    }
    const arquivo = req.files?.arquivo?.[0] || req.files?.file?.[0] || null
    if (arquivo) req.file = arquivo
    next()
  })
}

module.exports = { uploadXlsx, XLSX_MAX_BYTES }
