const path = require('path')
const fs = require('fs')

const defaultDir = path.join(__dirname, '..', 'uploads')

/**
 * Diretório absoluto dos arquivos servidos em GET /uploads/...
 * Em produção, defina UPLOADS_DIR para um volume persistente; caso contrário,
 * cada deploy que recria o diretório do app apaga mídias antigas.
 */
function getUploadsRoot() {
  const raw = String(process.env.UPLOADS_DIR || '').trim()
  if (raw) return path.resolve(raw)
  return defaultDir
}

function ensureUploadsRootExists() {
  const root = getUploadsRoot()
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true })
  }
  return root
}

module.exports = { getUploadsRoot, ensureUploadsRootExists }
