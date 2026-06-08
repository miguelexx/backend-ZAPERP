'use strict'

const jwt = require('jsonwebtoken')
const { isProduction } = require('../config/env')
const { parseUploadsPathname, companyOwnsUpload, getLocalUploadFile } = require('../helpers/uploadAccess')

function legacyPublicAllowed() {
  return process.env.UPLOADS_LEGACY_PUBLIC === '1' || process.env.UPLOADS_PUBLIC === '1'
}

function requiresAuth() {
  if (legacyPublicAllowed()) return false
  if (process.env.UPLOADS_REQUIRE_AUTH === '0') return false
  if (process.env.UPLOADS_REQUIRE_AUTH === '1') return true
  return isProduction()
}

function extractToken(req) {
  const authHeader = req.headers.authorization
  if (authHeader) {
    const [scheme, token] = authHeader.split(' ')
    if (/^Bearer$/i.test(scheme) && token) return token.trim()
  }
  const q = req.query?.access_token ?? req.query?.token
  if (q && typeof q === 'string') return q.trim()
  return null
}

function verifyUser(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET)
  const companyId = Number(decoded?.company_id)
  if (!Number.isFinite(companyId) || companyId <= 0) return null
  decoded.company_id = companyId
  return decoded
}

function setMediaHeaders(res, filePath) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  const p = String(filePath || '').toLowerCase()
  const isImage = /\.(jpg|jpeg|png|webp)$/.test(p)
  const isAudio = /\.(mp3|ogg|aac|m4a|wav|opus|webm)$/.test(p)
  const isVideo = /\.(mp4|mov|avi|3gp)$/.test(p)
  const isPdf = p.endsWith('.pdf')
  const isMedia = isImage || isAudio || isVideo || isPdf
  if (!isMedia) {
    const name = p.split(/[\\/]/).pop() || 'download'
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`)
    res.setHeader('Content-Type', 'application/octet-stream')
  }
}

async function secureUploads(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const filename = parseUploadsPathname(req.path)
  if (!filename) return res.status(400).json({ error: 'Arquivo inválido' })

  if (requiresAuth()) {
    const token = extractToken(req)
    if (!token) return res.status(401).json({ error: 'Token não informado' })
    let user
    try {
      user = verifyUser(token)
    } catch {
      return res.status(401).json({ error: 'Token inválido' })
    }
    if (!user) return res.status(401).json({ error: 'Tenant inválido' })

    const allowed = await companyOwnsUpload(user.company_id, filename)
    if (!allowed) return res.status(403).json({ error: 'Acesso negado' })
  }

  const resolved = getLocalUploadFile(filename)
  if (!resolved) return res.status(404).json({ error: 'Arquivo não encontrado' })

  setMediaHeaders(res, resolved)
  if (req.method === 'HEAD') return res.status(200).end()
  return res.sendFile(resolved)
}

module.exports = secureUploads
