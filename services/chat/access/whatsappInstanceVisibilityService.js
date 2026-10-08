/**
 * Visibilidade por NUMERO WhatsApp (whatsapp_instances) por usuario.
 *
 * Unidade = o numero. Quem esta marcado num numero ve as conversas daquele
 * `whatsapp_instance_id` (individual e grupo); quem nao esta nao ve nenhuma.
 *
 * Regra (gate mais externo — nao e furado por atendente_id/participante/transferencia/setor):
 *   - conversa sem whatsapp_instance_id (legado NULL) -> SEM restricao (todos), igual a hoje.
 *   - numero SEM lista salva                          -> SEM restricao (todos), igual a hoje.
 *   - numero COM lista salva                          -> somente os usuarios da lista.
 *   - lista vazia = "sem restricao", nunca "ninguem ve".
 *
 * Cache em memoria por empresa (TTL curto), espelhando conversationVisibilityService.
 * Antes da migration aplicada (tabela ausente) o mapa vem vazio => sistema identico ao de hoje.
 *
 * company_id SEMPRE do JWT no caller. Este modulo nunca deriva tenant de payload.
 */

const supabase = require('../../../config/supabase')

const companyVisibilityCache = new Map()
const CACHE_TTL_MS = 15_000
const CACHE_MAX = 500

function isMissingTableError(error) {
  const msg = String(error?.message || error?.details || error?.hint || error || '').toLowerCase()
  const code = String(error?.code || '')
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    (msg.includes('whatsapp_instance_visibilidade') &&
      (msg.includes('does not exist') ||
        msg.includes('could not find') ||
        msg.includes('schema cache')))
  )
}

function pruneCache() {
  const now = Date.now()
  for (const [k, v] of companyVisibilityCache.entries()) {
    if (v?.expiresAt != null && v.expiresAt <= now && !v.promise) companyVisibilityCache.delete(k)
  }
  if (companyVisibilityCache.size > CACHE_MAX) {
    const excess = companyVisibilityCache.size - CACHE_MAX
    let removed = 0
    for (const k of companyVisibilityCache.keys()) {
      if (removed >= excess) break
      companyVisibilityCache.delete(k)
      removed++
    }
  }
}
const _pruneTimer = setInterval(pruneCache, 60_000)
if (typeof _pruneTimer.unref === 'function') _pruneTimer.unref()

function cacheKey(company_id) {
  return String(Number(company_id))
}

function invalidateCompanyVisibilityCache(company_id) {
  if (company_id == null) return
  companyVisibilityCache.delete(cacheKey(company_id))
}

// ---------------------------------------------------------------------------
// Funcoes PURAS (sem IO) — faceis de testar. Recebem o mapa ja carregado.
// `porNumero`: Map<whatsapp_instance_id:number, Set<usuario_id:number>>
// ---------------------------------------------------------------------------

function numeroTemListaSalva(porNumero, instanceId) {
  if (!porNumero || instanceId == null) return false
  const set = porNumero.get(Number(instanceId))
  return !!set && set.size > 0
}

function usuarioPodeVerNumeroComMapa(porNumero, instanceId, usuarioId) {
  // Conversa sem numero (legado NULL) nunca e restringida.
  if (instanceId == null || instanceId === '') return true
  const inst = Number(instanceId)
  if (!Number.isFinite(inst) || inst <= 0) return true
  if (!porNumero) return true
  const set = porNumero.get(inst)
  // Numero sem lista salva = todos veem.
  if (!set || set.size === 0) return true
  return set.has(Number(usuarioId))
}

/** Numeros com lista salva onde o usuario NAO esta (para excluir da lista/contadores). */
function blockedInstanceIdsComMapa(porNumero, usuarioId) {
  const out = []
  if (!porNumero) return out
  const uid = Number(usuarioId)
  for (const [inst, set] of porNumero.entries()) {
    if (set && set.size > 0 && !set.has(uid)) out.push(inst)
  }
  return out
}

/**
 * Dado o conjunto de usuarios que poderiam ver uma conversa, intersecta com a
 * lista do numero. `null` da lista = sem restricao (retorna a entrada intacta).
 */
function filtrarUsuarioIdsPorNumeroComMapa(porNumero, instanceId, usuarioIds) {
  const ids = Array.isArray(usuarioIds) ? usuarioIds : []
  if (!numeroTemListaSalva(porNumero, instanceId)) return ids
  const permitidos = porNumero.get(Number(instanceId))
  return ids.filter((id) => permitidos.has(Number(id)))
}

// ---------------------------------------------------------------------------
// Camada com IO (cacheada)
// ---------------------------------------------------------------------------

async function carregarCompanyVisibilitySemCache(company_id) {
  const cid = Number(company_id)
  const porNumero = new Map()
  if (!Number.isFinite(cid) || cid <= 0) return { porNumero }

  const { data, error } = await supabase
    .from('whatsapp_instance_visibilidade')
    .select('whatsapp_instance_id, usuario_id')
    .eq('company_id', cid)

  if (error) {
    // Tabela ausente (migration nao aplicada) => comportamento de hoje (sem restricao).
    if (isMissingTableError(error)) return { porNumero }
    throw error
  }

  for (const row of data || []) {
    const inst = Number(row.whatsapp_instance_id)
    const uid = Number(row.usuario_id)
    if (!Number.isFinite(inst) || inst <= 0 || !Number.isFinite(uid) || uid <= 0) continue
    if (!porNumero.has(inst)) porNumero.set(inst, new Set())
    porNumero.get(inst).add(uid)
  }
  return { porNumero }
}

async function getCompanyVisibilityMap(company_id) {
  const key = cacheKey(company_id)
  const now = Date.now()
  const cached = companyVisibilityCache.get(key)
  if (cached?.porNumero && cached.expiresAt > now) return cached.porNumero
  if (cached?.promise) return (await cached.promise).porNumero

  const promise = carregarCompanyVisibilitySemCache(company_id)
  companyVisibilityCache.set(key, { promise, expiresAt: now + CACHE_TTL_MS })
  try {
    const result = await promise
    companyVisibilityCache.set(key, {
      porNumero: result.porNumero,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
    return result.porNumero
  } catch (err) {
    companyVisibilityCache.delete(key)
    throw err
  }
}

async function usuarioPodeVerNumero(company_id, usuarioId, instanceId) {
  // Atalho sem tocar o banco quando nao ha numero.
  if (instanceId == null || instanceId === '') return true
  const porNumero = await getCompanyVisibilityMap(company_id)
  return usuarioPodeVerNumeroComMapa(porNumero, instanceId, usuarioId)
}

async function getBlockedInstanceIdsParaUsuario(company_id, usuarioId) {
  const porNumero = await getCompanyVisibilityMap(company_id)
  return blockedInstanceIdsComMapa(porNumero, usuarioId)
}

async function filtrarUsuarioIdsPorNumero(company_id, instanceId, usuarioIds) {
  const ids = Array.isArray(usuarioIds) ? usuarioIds : []
  if (instanceId == null || instanceId === '') return ids
  const porNumero = await getCompanyVisibilityMap(company_id)
  return filtrarUsuarioIdsPorNumeroComMapa(porNumero, instanceId, ids)
}

module.exports = {
  // IO
  getCompanyVisibilityMap,
  usuarioPodeVerNumero,
  getBlockedInstanceIdsParaUsuario,
  filtrarUsuarioIdsPorNumero,
  invalidateCompanyVisibilityCache,
  carregarCompanyVisibilitySemCache,
  isMissingTableError,
  // puras (testes)
  numeroTemListaSalva,
  usuarioPodeVerNumeroComMapa,
  blockedInstanceIdsComMapa,
  filtrarUsuarioIdsPorNumeroComMapa,
}
