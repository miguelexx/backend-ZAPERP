const multer = require('multer')
const path = require('path')
const fs = require('fs')

const uploadDir = path.join(__dirname, '../uploads')
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const ALLOWED_MIME = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['video/mp4', '.mp4'],
])

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // Não usar extensão do arquivo original (previne upload de .html/.svg etc).
    // A extensão é derivada do mimetype permitido.
    const mime = String(file.mimetype || '').toLowerCase().trim()
    const ext = ALLOWED_MIME.get(mime) || '.bin'
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`
    cb(null, name)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB (áudio pode ser grande)
  fileFilter: (req, file, cb) => {
    const m = String(file.mimetype || '').toLowerCase().trim()
    const ok = ALLOWED_MIME.has(m)
    if (ok) cb(null, true)
    else cb(new Error('Tipo de arquivo não permitido'), false)
  },
})

module.exports = { upload, uploadDir }
