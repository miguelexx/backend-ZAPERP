/**
 * Cache de leitura com TTL curto, teto de entradas e varredura periódica.
 *
 * Mesmo padrão já usado em `services/chat/access/conversationVisibilityService.js` e
 * `services/supervisaoService.js`, extraído para um módulo só porque o caminho quente do
 * webhook inbound repetia as MESMAS leituras de configuração (`empresas`,
 * `whatsapp_instances`, `ia_config`) várias vezes por mensagem — e ACKs são 2-3× o volume
 * de mensagens (doc 29 §3 item 6).
 *
 * Regras que este módulo IMPÕE, não sugere:
 *
 *  - **A chave sempre contém o `company_id`.** `create()` exige `name` e cada operação exige
 *    `companyId`; a chave final é `name:companyId:resto`. O isolamento entre empresas aqui é
 *    exclusivamente app-layer (SERVICE_ROLE bypassa RLS), então uma chave sem tenant seria
 *    vazamento de dados de outra empresa — não só um cache errado.
 *  - **Falha NÃO é cacheada.** Se o loader rejeita, nada é gravado: um erro transitório do
 *    banco não congela por TTL inteiro.
 *  - **Teto de entradas + varredura.** Entradas vencidas só saíam ao reconsultar a MESMA
 *    chave; sem varredura isso é leak lento (uma chave por empresa/instância desde o boot).
 *  - **Coalescing.** A promessa em voo fica guardada, então N chamadas concorrentes
 *    partilham UMA consulta (rajada de webhooks do mesmo número).
 *  - O timer é `unref()`: nunca segura o processo nem o Jest.
 */

const DEFAULT_TTL_MS = 15_000
const DEFAULT_MAX = 500
const PRUNE_INTERVAL_MS = 60_000

/**
 * @param {object} opts
 * @param {string} opts.name        prefixo da chave (obrigatório) — separa os caches entre si.
 * @param {number} [opts.ttlMs]     validade de uma entrada.
 * @param {number} [opts.max]       teto de entradas antes do descarte das mais antigas.
 */
function create({ name, ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX } = {}) {
  const nome = String(name || '').trim()
  if (!nome) throw new Error('shortTtlCache.create: `name` é obrigatório')
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS
  const teto = Number(max) > 0 ? Number(max) : DEFAULT_MAX
  const store = new Map()

  function chave(companyId, sufixo) {
    const cid = Number(companyId)
    // Sem tenant não há cache: devolver uma chave global aqui misturaria empresas.
    if (!Number.isFinite(cid) || cid <= 0) return null
    return `${nome}:${cid}:${sufixo == null ? '' : String(sufixo)}`
  }

  function prune() {
    const agora = Date.now()
    for (const [k, v] of store.entries()) {
      if (v && v.promise == null && v.expiresAt != null && v.expiresAt <= agora) store.delete(k)
    }
    if (store.size > teto) {
      let excesso = store.size - teto
      for (const k of store.keys()) {
        if (excesso-- <= 0) break
        store.delete(k)
      }
    }
  }

  const timer = setInterval(prune, PRUNE_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()

  /**
   * Devolve o valor cacheado ou executa `loader()`. `companyId` inválido => sem cache
   * (executa o loader direto), nunca uma chave compartilhada entre empresas.
   */
  async function wrap(companyId, sufixo, loader) {
    const k = chave(companyId, sufixo)
    if (!k) return loader()

    const agora = Date.now()
    const atual = store.get(k)
    if (atual) {
      if (atual.promise) return atual.promise
      if (atual.expiresAt > agora) return atual.value
      store.delete(k)
    }

    const promise = (async () => loader())()
    store.set(k, { promise, expiresAt: agora + ttl })
    try {
      const value = await promise
      store.set(k, { value, promise: null, expiresAt: Date.now() + ttl })
      return value
    } catch (e) {
      // Falha não é cacheada.
      store.delete(k)
      throw e
    }
  }

  /** Invalida uma entrada (`sufixo` omitido) ou todas as da empresa. */
  function invalidate(companyId, sufixo = undefined) {
    const cid = Number(companyId)
    if (!Number.isFinite(cid) || cid <= 0) return
    if (sufixo === undefined) {
      const prefixo = `${nome}:${cid}:`
      for (const k of [...store.keys()]) if (k.startsWith(prefixo)) store.delete(k)
      return
    }
    const k = chave(cid, sufixo)
    if (k) store.delete(k)
  }

  function clear() { store.clear() }
  function size() { return store.size }

  return { wrap, invalidate, clear, size, _prune: prune, _ttlMs: ttl, _max: teto }
}

module.exports = { create, DEFAULT_TTL_MS, DEFAULT_MAX, PRUNE_INTERVAL_MS }
