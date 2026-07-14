'use strict'

/**
 * Revogação de acesso para usuário desativado (usuarios.ativo = false).
 *
 * O JWT vive até 30 dias e não há blacklist: sem esta verificação, um usuário
 * desativado (DELETE /usuarios/:id faz soft-delete) mantém acesso à API e ao
 * socket até o token expirar.
 *
 * Regras de segurança/disponibilidade:
 * - Cache em memória com TTL curto: no máximo 1 query por usuário por janela,
 *   não 1 por request.
 * - Fail-open: erro de banco ou linha ausente NÃO bloqueia (indisponibilidade
 *   do Supabase não pode derrubar toda a autenticação). Só bloqueia quando o
 *   banco afirma explicitamente ativo === false.
 */

const CACHE_TTL_MS = Math.max(5_000, Number(process.env.USUARIO_ATIVO_CACHE_TTL_MS) || 60_000)
const cache = new Map() // `${company_id}:${user_id}` -> { ativo, expiresAt }

function getSupabase() {
  return require('../config/supabase')
}

/** @returns {Promise<boolean>} false somente quando o banco confirma usuário inativo */
async function usuarioEstaAtivo(user_id, company_id) {
  const uid = Number(user_id)
  const cid = Number(company_id)
  if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(cid) || cid <= 0) return true

  const key = `${cid}:${uid}`
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) return cached.ativo

  let ativo = true
  try {
    const { data, error } = await getSupabase()
      .from('usuarios')
      .select('ativo')
      .eq('id', uid)
      .eq('company_id', cid)
      .maybeSingle()
    if (!error && data && data.ativo === false) ativo = false
  } catch (_) {
    ativo = true
  }

  cache.set(key, { ativo, expiresAt: now + CACHE_TTL_MS })
  if (cache.size > 10_000) {
    for (const [k, v] of cache) {
      if (v.expiresAt <= now) cache.delete(k)
    }
  }
  return ativo
}

/** Invalida o cache após ativar/desativar usuário — revogação imediata nesta instância. */
function invalidateUsuarioAtivoCache(user_id, company_id) {
  cache.delete(`${Number(company_id)}:${Number(user_id)}`)
}

module.exports = { usuarioEstaAtivo, invalidateUsuarioAtivoCache, _test: { cache, CACHE_TTL_MS } }
