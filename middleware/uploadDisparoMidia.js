/**
 * Middleware de upload de mídia para variações do Disparo.
 * Usa diskStorage em arquivo temporário — nunca carrega documentos grandes inteiros na RAM.
 * Valida: extensão, MIME, magic bytes, estrutura Office/ZIP, tamanho e concorrência.
 */

const multer = require('multer')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { validarOfficeOuZip } = require('../helpers/disparoZipInspector')

const MAX_IMAGEM_MB = Number(process.env.DISPARO_IMAGEM_MAX_MB || 5)
const MAX_VIDEO_MB = Number(process.env.DISPARO_VIDEO_MAX_MB || 32)
const MAX_AUDIO_MB = Number(process.env.DISPARO_AUDIO_MAX_MB || 16)
const MAX_DOC_MB = Number(process.env.DISPARO_DOC_MAX_MB || 100)
const MAX_GLOBAL_MB = Math.max(MAX_IMAGEM_MB, MAX_VIDEO_MB, MAX_AUDIO_MB, MAX_DOC_MB)
const MAX_CONCURRENT = Math.max(1, Number(process.env.DISPARO_MIDIA_MAX_CONCURRENT || 3))
const MB = 1024 * 1024

const MIME_IMAGEM = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MIME_VIDEO = new Set(['video/mp4', 'video/3gpp', 'video/quicktime', 'video/x-msvideo'])
const MIME_AUDIO = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/aac', 'audio/opus',
  'audio/x-m4a', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/webm',
])
const MIME_DOC = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'text/plain', 'text/csv', 'application/rtf',
  'application/zip', 'application/x-zip-compressed',
])

const EXT_IMAGEM = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])
const EXT_VIDEO = new Set(['mp4', '3gp', 'mov', 'avi'])
const EXT_AUDIO = new Set(['mp3', 'ogg', 'aac', 'opus', 'm4a', 'wav', 'webm'])
const EXT_DOC = new Set(['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'csv', 'rtf', 'zip'])
const EXT_OFFICE_ZIP = new Set(['docx', 'xlsx', 'pptx', 'zip'])

const TODOS_MIMES = new Set([...MIME_IMAGEM, ...MIME_VIDEO, ...MIME_AUDIO, ...MIME_DOC])
const TODAS_EXTS = new Set([...EXT_IMAGEM, ...EXT_VIDEO, ...EXT_AUDIO, ...EXT_DOC])

let uploadsAtivos = 0

function detectarTipoRealMidia(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null
  const b = buffer
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'imagem'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'imagem'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'imagem'
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    buffer.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'imagem'
  if (buffer.length >= 12) {
    const ftyp = buffer.slice(4, 8).toString('ascii')
    if (ftyp === 'ftyp' || ftyp === 'mdat' || ftyp === 'moov' || ftyp === 'free') return 'video'
  }
  if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio_ou_video'
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio'
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'audio'
  if (b[0] === 0xFF && b[1] === 0xF1) return 'audio'
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'documento'
  if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) return 'documento'
  if (b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) return 'documento'
  const sample = buffer.slice(0, Math.min(512, buffer.length))
  if (sample.every((byte) => (byte >= 0x09 && byte <= 0x0D) || (byte >= 0x20 && byte <= 0x7E) || byte >= 0x80)) {
    return 'documento'
  }
  return null
}

function tipoMensagemPorMime(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim()
  if (MIME_IMAGEM.has(m)) return 'imagem'
  if (MIME_VIDEO.has(m)) return 'video'
  if (MIME_AUDIO.has(m)) return 'audio'
  if (MIME_DOC.has(m)) return 'documento'
  return null
}

function tipoMensagemPorExt(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '')
  if (EXT_IMAGEM.has(e)) return 'imagem'
  if (EXT_VIDEO.has(e)) return 'video'
  if (EXT_AUDIO.has(e)) return 'audio'
  if (EXT_DOC.has(e)) return 'documento'
  return null
}

function limitePorTipo(tipo) {
  if (tipo === 'imagem') return MAX_IMAGEM_MB * MB
  if (tipo === 'video') return MAX_VIDEO_MB * MB
  if (tipo === 'audio') return MAX_AUDIO_MB * MB
  if (tipo === 'documento') return MAX_DOC_MB * MB
  return MAX_GLOBAL_MB * MB
}

function limparTemp(filePath) {
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch (_) { /* ignore */ }
}

const TMP_DIR = path.join(os.tmpdir(), 'zaperp-disparo-midia')
try { fs.mkdirSync(TMP_DIR, { recursive: true }) } catch (_) { /* ignore */ }

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12)
    const safe = `disp_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext || '.bin'}`
    cb(null, safe)
  },
})

const uploadDisparoMidiaMulter = multer({
  storage,
  limits: { fileSize: MAX_GLOBAL_MB * MB, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().replace('.', '')
    const mime = String(file.mimetype || '').split(';')[0].trim().toLowerCase()
    const mimeOk = TODOS_MIMES.has(mime) && mime !== 'application/octet-stream'
    const extOk = TODAS_EXTS.has(ext)
    if (!mimeOk && !extOk) {
      const err = new Error(`Formato não suportado para disparo: .${ext || '?'} (${mime || '?'})`)
      err.status = 400
      err.code = 'DISPARO_MIDIA_TIPO_INVALIDO'
      return cb(err, false)
    }
    if (/[/\\]/.test(file.originalname || '')) {
      const err = new Error('Nome de arquivo inválido.')
      err.status = 400
      err.code = 'UPLOAD_NOME_INVALIDO'
      return cb(err, false)
    }
    cb(null, true)
  },
})

/**
 * Middleware principal: grava em temp, valida magic + Office, popula req.disparoMidia.
 * Sempre tenta limpar o temp em caso de rejeição; em sucesso o controller limpa após persistir.
 */
function uploadDisparoMidia(req, res, next) {
  if (uploadsAtivos >= MAX_CONCURRENT) {
    return res.status(429).json({
      error: `Muitos uploads simultâneos. Aguarde (máx ${MAX_CONCURRENT}).`,
      code: 'DISPARO_MIDIA_CONCORRENCIA',
    })
  }

  uploadsAtivos += 1
  let released = false
  const release = () => {
    if (!released) {
      released = true
      uploadsAtivos = Math.max(0, uploadsAtivos - 1)
    }
  }

  uploadDisparoMidiaMulter.single('midia')(req, res, (err) => {
    const tempPath = req.file?.path || null

    if (err) {
      release()
      limparTemp(tempPath)
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: `Arquivo excede o limite máximo de ${MAX_GLOBAL_MB} MB.`,
          code: 'DISPARO_MIDIA_MUITO_GRANDE',
        })
      }
      return res.status(err.status || 400).json({ error: err.message, code: err.code })
    }

    if (!req.file) {
      release()
      return next()
    }

    try {
      const { originalname, mimetype, size, path: filePath } = req.file
      const ext = path.extname(originalname || '').toLowerCase().replace('.', '')
      const mime = String(mimetype || '').split(';')[0].trim().toLowerCase()

      // Lê apenas o cabeçalho (não o arquivo inteiro) para magic bytes
      const fd = fs.openSync(filePath, 'r')
      const header = Buffer.alloc(Math.min(64, size))
      fs.readSync(fd, header, 0, header.length, 0)
      fs.closeSync(fd)

      const tipoPorMime = tipoMensagemPorMime(mime)
      const tipoPorExt = tipoMensagemPorExt(ext)
      const tipoDeclarado = tipoPorMime || tipoPorExt
      const tipoReal = detectarTipoRealMidia(header)

      if (tipoReal && tipoDeclarado && tipoDeclarado !== 'documento' && tipoReal !== 'audio_ou_video') {
        const tipoRealNorm = tipoReal === 'audio' ? 'audio' : tipoReal
        if (tipoRealNorm !== tipoDeclarado && !(tipoDeclarado === 'video' && tipoRealNorm === 'audio')) {
          limparTemp(filePath)
          release()
          return res.status(400).json({
            error: `O conteúdo do arquivo não corresponde ao tipo declarado (${tipoDeclarado}).`,
            code: 'DISPARO_MIDIA_FORMATO_MISMATCH',
          })
        }
      }

      // Office / ZIP: inspeção da estrutura interna (central directory)
      if (tipoReal === 'documento' && EXT_OFFICE_ZIP.has(ext)) {
        const office = validarOfficeOuZip(filePath, ext)
        if (!office.ok) {
          limparTemp(filePath)
          release()
          return res.status(400).json({
            error: office.error,
            code: office.code,
            formato_real: office.formatoReal,
          })
        }
      } else if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') {
        // Extensão Office sem magic ZIP → inválido
        if (tipoReal !== 'documento') {
          limparTemp(filePath)
          release()
          return res.status(400).json({
            error: `Extensão .${ext} exige arquivo Office Open XML (ZIP) válido.`,
            code: 'DISPARO_OFFICE_MISMATCH',
          })
        }
      }

      const tipoFinal = tipoDeclarado || (tipoReal === 'audio_ou_video' ? 'audio' : tipoReal) || 'documento'
      const limite = limitePorTipo(tipoFinal)
      if (size > limite) {
        limparTemp(filePath)
        release()
        return res.status(400).json({
          error: `Arquivo ${tipoFinal} maior que ${limite / MB} MB.`,
          code: 'DISPARO_MIDIA_MUITO_GRANDE',
        })
      }

      const nomeOriginalSafe = path.basename(originalname || 'arquivo').replace(/[^\w.\-]/g, '_').slice(0, 255)

      req.disparoMidia = {
        tempPath: filePath,
        buffer: null, // não carrega na memória
        nomeOriginal: nomeOriginalSafe,
        mime,
        ext,
        tamanho: size,
        tipoMensagem: tipoFinal,
        cleanup: () => {
          limparTemp(filePath)
          release()
        },
      }

      // Libera o slot de concorrência quando a resposta terminar
      res.on('finish', () => {
        if (req.disparoMidia?.tempPath) limparTemp(req.disparoMidia.tempPath)
        release()
      })
      res.on('close', () => {
        if (req.disparoMidia?.tempPath) limparTemp(req.disparoMidia.tempPath)
        release()
      })

      next()
    } catch (e) {
      limparTemp(tempPath)
      release()
      return res.status(400).json({
        error: e.message || 'Falha ao validar mídia.',
        code: e.code || 'DISPARO_MIDIA_VALIDACAO',
      })
    }
  })
}

module.exports = {
  uploadDisparoMidia,
  detectarTipoRealMidia,
  tipoMensagemPorMime,
  tipoMensagemPorExt,
  limitePorTipo,
  limparTemp,
  MIME_IMAGEM, MIME_VIDEO, MIME_AUDIO, MIME_DOC,
  EXT_IMAGEM, EXT_VIDEO, EXT_AUDIO, EXT_DOC,
  MAX_IMAGEM_MB, MAX_VIDEO_MB, MAX_AUDIO_MB, MAX_DOC_MB,
  MAX_CONCURRENT,
  _getUploadsAtivos: () => uploadsAtivos,
  _setUploadsAtivos: (n) => { uploadsAtivos = n },
}
