const supabase = require('../config/supabase')

/**
 * Flag `empresas.atendimento_modo_simples`, cacheada por `company_id` (doc 41 §7).
 *
 * Lida em TODA chamada de GET /chats, GET /chats/:id, contadores, envio, supervisão e webhook —
 * e muda só quando o admin salva Configurações > Empresa. Chave sempre com o tenant, falha não
 * cacheada, coalescing e varredura ficam em `shortTtlCache`.
 *
 * Invalidação: `invalidateEmpresaModoSimplesCache(company_id)` em `configController.putEmpresa`
 * (único sítio que grava a flag). Ao criar outro caminho de escrita, chame-a também.
 */
const _cache = require('./shortTtlCache').create({
  name: 'empresaModoSimples',
  ttlMs: Number(process.env.EMPRESA_MODO_SIMPLES_CACHE_TTL_MS || 30_000),
  max: 500,
})

function isErroColunaAusente(error) {
  const msg = String(error?.message || '')
  return msg.includes('atendimento_modo_simples') || msg.includes('does not exist')
}

async function lerFlagDoBanco(cid) {
  const { data, error } = await supabase
    .from('empresas')
    .select('atendimento_modo_simples')
    .eq('id', cid)
    .maybeSingle()
  if (error) throw error
  return !!data?.atendimento_modo_simples
}

/**
 * Modo simples de atendimento ativo para a empresa (default false).
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
async function empresaModoSimplesAtivo(companyId) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) return false
  try {
    return await _cache.wrap(cid, '', () => lerFlagDoBanco(cid))
  } catch (error) {
    // Banco sem a coluna: comporta como "desligado", mas NÃO fica cacheado (falha não é cacheada).
    if (isErroColunaAusente(error)) return false
    throw error
  }
}

/** Invalida a flag cacheada da empresa (sem argumento: todas). */
function invalidateEmpresaModoSimplesCache(companyId) {
  if (companyId == null) { _cache.clear(); return }
  _cache.invalidate(companyId)
}

module.exports = { empresaModoSimplesAtivo, invalidateEmpresaModoSimplesCache, _empresaModoSimplesCache: _cache }
