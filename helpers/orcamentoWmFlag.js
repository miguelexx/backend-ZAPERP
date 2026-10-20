'use strict'

const supabase = require('../config/supabase')

/**
 * Gate do módulo de Orçamento WM. Espelha `helpers/moduloCampanhas.js`
 * (cache em memória de 20 s por company_id), com uma diferença de default:
 *
 *   flag efetiva = WM_ORCAMENTOS_ENABLED (env, interruptor global)
 *                  E wm_orcamento_integracoes.ativo (flag da empresa)
 *
 * É o mesmo arranjo de `crm_habilitado` (env global E flag por empresa), mas **fail-closed**
 * nos dois lados: erro de leitura, tabela ausente (migration não aplicada) ou empresa sem
 * linha ⇒ `false`. Esta integração grava em ERP de terceiro; indisponibilidade de leitura
 * nunca pode "abrir" o módulo.
 *
 * A env é lida a cada chamada (não no load do módulo) para que `pm2 restart --update-env`
 * não seja a única forma de desligar, e para que o teste consiga alternar as 4 combinações.
 * Com a env desligada nem há consulta ao banco — o caminho comum hoje custa zero query.
 */

const CACHE_TTL_MS = 20_000
const cache = new Map()

/** Interruptor global por ambiente. Default: DESLIGADO. */
function wmOrcamentosEnvHabilitado() {
  const raw = String(process.env.WM_ORCAMENTOS_ENABLED ?? '').trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

function primeOrcamentoWmCache(companyId, ativo, ttlMs = CACHE_TTL_MS) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) return
  cache.set(cid, { ativo: !!ativo, expires: Date.now() + Math.max(0, Number(ttlMs) || CACHE_TTL_MS) })
}

function invalidateOrcamentoWmCache(companyId) {
  if (companyId == null) {
    cache.clear()
    return
  }
  cache.delete(Number(companyId))
}

/**
 * Flag POR EMPRESA (`wm_orcamento_integracoes.ativo`), sem considerar a env.
 * @param {number} companyId
 * @returns {Promise<boolean>} false em qualquer erro, linha ausente ou tabela ausente
 */
async function empresaOrcamentoWmAtivo(companyId) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) return false
  const now = Date.now()
  const hit = cache.get(cid)
  if (hit && hit.expires > now) return hit.ativo
  try {
    const { data, error } = await supabase
      .from('wm_orcamento_integracoes')
      .select('ativo')
      .eq('company_id', cid)
      .maybeSingle()
    if (error) {
      // Migration ainda não aplicada ou leitura indisponível → desligado, e guarda no cache
      // só o caso de tabela/coluna inexistente (erro estrutural, não transitório).
      const msg = String(error.message || '')
      if (msg.includes('does not exist') || msg.includes('wm_orcamento_integracoes')) {
        primeOrcamentoWmCache(cid, false)
      }
      return false
    }
    const ativo = !!data?.ativo
    primeOrcamentoWmCache(cid, ativo)
    return ativo
  } catch (_) {
    return false
  }
}

/**
 * Flag EFETIVA: env global E empresa ativa.
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
async function orcamentoWmHabilitado(companyId) {
  if (!wmOrcamentosEnvHabilitado()) return false
  return empresaOrcamentoWmAtivo(companyId)
}

module.exports = {
  CACHE_TTL_MS,
  wmOrcamentosEnvHabilitado,
  empresaOrcamentoWmAtivo,
  orcamentoWmHabilitado,
  primeOrcamentoWmCache,
  invalidateOrcamentoWmCache,
}
