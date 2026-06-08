'use strict'

const path = require('path')
const fs = require('fs')
const supabase = require('../config/supabase')
const { getUploadsRoot } = require('../config/uploadsRoot')

const ACCESS_CACHE = new Map()
const CACHE_TTL_OK_MS = 60_000
const CACHE_TTL_MISS_MS = 15_000

function safeFilename(raw) {
  const base = path.basename(String(raw || ''))
  if (!base || base === '.' || base === '..' || base.includes('..')) return null
  return base
}

function resolveUploadPath(root, filename) {
  const filePath = path.join(root, filename)
  const resolved = path.resolve(filePath)
  const rootResolved = path.resolve(root)
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null
  return resolved
}

function parseUploadsPathname(pathname) {
  const p = String(pathname || '')
  const idx = p.indexOf('/uploads/')
  const rel = idx >= 0 ? p.slice(idx + '/uploads/'.length) : p.replace(/^\//, '')
  return safeFilename(rel)
}

async function companyOwnsUpload(companyId, filename) {
  const cacheKey = `${companyId}:${filename}`
  const cached = ACCESS_CACHE.get(cacheKey)
  if (cached && cached.exp > Date.now()) return cached.ok

  const url = `/uploads/${filename}`
  const { data: msg } = await supabase
    .from('mensagens')
    .select('id')
    .eq('company_id', companyId)
    .eq('url', url)
    .limit(1)
    .maybeSingle()

  if (msg?.id) {
    ACCESS_CACHE.set(cacheKey, { ok: true, exp: Date.now() + CACHE_TTL_OK_MS })
    return true
  }

  let icOk = false
  const { data: ic1 } = await supabase
    .from('internal_chat_messages')
    .select('id')
    .eq('company_id', companyId)
    .eq('media_url', url)
    .limit(1)
    .maybeSingle()
  if (ic1?.id) icOk = true
  if (!icOk) {
    const { data: ic2 } = await supabase
      .from('internal_chat_messages')
      .select('id')
      .eq('company_id', companyId)
      .eq('url', url)
      .limit(1)
      .maybeSingle()
    icOk = Boolean(ic2?.id)
  }

  ACCESS_CACHE.set(cacheKey, { ok: icOk, exp: Date.now() + (icOk ? CACHE_TTL_OK_MS : CACHE_TTL_MISS_MS) })
  return icOk
}

function getLocalUploadFile(filename) {
  const root = getUploadsRoot()
  const resolved = resolveUploadPath(root, filename)
  if (!resolved || !fs.existsSync(resolved)) return null
  return resolved
}

module.exports = {
  safeFilename,
  parseUploadsPathname,
  companyOwnsUpload,
  getLocalUploadFile,
}
