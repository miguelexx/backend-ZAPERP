const crypto = require('crypto')
const supabase = require('../config/supabase')

const SENHA_PADRAO = 'Zap@019866'
const CACHE_TTL_MS = 20_000
const cache = new Map()

function getModuloCampanhasSenha() {
  const fromEnv = process.env.MODULO_CAMPANHAS_SENHA
  if (fromEnv != null && String(fromEnv).length > 0) return String(fromEnv)
  return SENHA_PADRAO
}

function senhaModuloCampanhasValida(input) {
  const expected = getModuloCampanhasSenha()
  const a = crypto.createHash('sha256').update(String(input ?? ''), 'utf8').digest()
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

function primeModuloCampanhasCache(companyId, ativo, ttlMs = CACHE_TTL_MS) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) return
  cache.set(cid, { ativo: !!ativo, expires: Date.now() + Math.max(0, Number(ttlMs) || CACHE_TTL_MS) })
}

function invalidateModuloCampanhasCache(companyId) {
  if (companyId == null) {
    cache.clear()
    return
  }
  cache.delete(Number(companyId))
}

/**
 * Módulo Campanhas/Disparo ativo para a empresa (default false).
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
async function empresaModuloCampanhasAtivo(companyId) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) return false
  const now = Date.now()
  const hit = cache.get(cid)
  if (hit && hit.expires > now) return hit.ativo
  try {
    const { data, error } = await supabase
      .from('empresas')
      .select('modulo_campanhas_ativo')
      .eq('id', cid)
      .maybeSingle()
    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('modulo_campanhas_ativo') || msg.includes('does not exist')) {
        primeModuloCampanhasCache(cid, false)
        return false
      }
      return false
    }
    const ativo = !!data?.modulo_campanhas_ativo
    primeModuloCampanhasCache(cid, ativo)
    return ativo
  } catch (_) {
    return false
  }
}

module.exports = {
  SENHA_PADRAO,
  getModuloCampanhasSenha,
  senhaModuloCampanhasValida,
  empresaModuloCampanhasAtivo,
  primeModuloCampanhasCache,
  invalidateModuloCampanhasCache,
}
