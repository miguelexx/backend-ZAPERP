'use strict'

const supabase = require('../config/supabase')

/**
 * Flag por empresa que liga/desliga o módulo CRM (botão «Enviar ao CRM» no chat
 * e as APIs de CRM). É COMPLEMENTAR ao interruptor mestre por ambiente
 * (crmSyncService.isEnabled(), baseado nas envs CRM_API_URL/ZAP_SSO_SECRET):
 * o CRM só fica disponível quando o ambiente está configurado E a empresa manteve
 * o módulo ligado.
 *
 * Default = true (ligado): assim, empresas sem a coluna aplicada continuam a ver
 * o CRM como antes, e a migration pode ser aplicada sem quebrar nada.
 */

const CACHE_TTL_MS = 20_000
const cache = new Map()

function primeModuloCrmCache(companyId, habilitado, ttlMs = CACHE_TTL_MS) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) return
  cache.set(cid, {
    habilitado: habilitado !== false,
    expires: Date.now() + Math.max(0, Number(ttlMs) || CACHE_TTL_MS),
  })
}

function invalidateModuloCrmCache(companyId) {
  if (companyId == null) {
    cache.clear()
    return
  }
  cache.delete(Number(companyId))
}

/**
 * Módulo CRM ligado para a empresa (default true).
 * Falha/coluna ausente → true (não derruba o CRM por indisponibilidade de leitura).
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
async function empresaModuloCrmHabilitado(companyId) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) return true
  const now = Date.now()
  const hit = cache.get(cid)
  if (hit && hit.expires > now) return hit.habilitado
  try {
    const { data, error } = await supabase
      .from('empresas')
      .select('crm_habilitado')
      .eq('id', cid)
      .maybeSingle()
    if (error) {
      // Coluna ainda não aplicada (migration pendente) → mantém ligado.
      primeModuloCrmCache(cid, true)
      return true
    }
    const habilitado = data?.crm_habilitado !== false
    primeModuloCrmCache(cid, habilitado)
    return habilitado
  } catch (_) {
    return true
  }
}

module.exports = {
  empresaModuloCrmHabilitado,
  primeModuloCrmCache,
  invalidateModuloCrmCache,
}
