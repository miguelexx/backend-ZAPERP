const multer = require('multer')
const path = require('path')
const fs = require('fs')

const uploadDir = path.join(__dirname, '../uploads')
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin'
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`
    cb(null, name)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB (áudio pode ser grande)
  fileFilter: (req, file, cb) => {
    const m = (file.mimetype || '').toLowerCase()
    const allowed = [
      'image/', 'audio/', 'video/',
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument',
      'text/',
    ]
    const ok = allowed.some(p => m.startsWith(p) || m === p)
    if (ok) cb(null, true)
    else cb(new Error('Tipo de arquivo não permitido'), false)
  },
})

module.exports = { upload, uploadDir }
