/**
 * Guarda anti-ban do Disparo (Whapi) — consulta os limites de "novos chats" e o timelock de
 * reachout do WhatsApp Business ANTES de disparar, e freia a instância se o número estiver
 * capado/restrito. Protege o número do cliente de banimento.
 *
 * Aditivo e opt-in:
 *  - env WHAPI_ANTIBAN_GATE_ENABLED (default false) — sem ele, comportamento idêntico ao de hoje.
 *  - provider-aware: só age se o adapter tem getNewChatLimit/getReachoutTimelock (Whapi).
 *    UltraMSG não tem esses métodos → no-op (nunca bloqueia).
 *  - cache curto por instância (TTL) para não martelar a API da Whapi a cada item da fila.
 *
 * Nunca lança: qualquer falha de rede/consulta libera o envio (fail-open) — a guarda existe para
 * FREAR quando o WhatsApp reporta risco, não para travar o disparo por instabilidade de leitura.
 * Ver doc 25 §30 (limites anti-ban) e §29-§30 (disciplina aditiva).
 */

const { getProvider } = require('./providers')
const { resolveConversationProvider } = require('./chat/identity/conversationAddressService')

const cache = new Map() // `${companyId}:${instanciaId}` -> { at, result }

function antibanEnabled() {
  return String(process.env.WHAPI_ANTIBAN_GATE_ENABLED || '').trim().toLowerCase() === 'true'
}

function cacheTtlMs() {
  const n = Number(process.env.WHAPI_ANTIBAN_CACHE_TTL_MS)
  return Number.isFinite(n) && n >= 0 ? n : 60_000
}

function unixToIso(unixSeconds) {
  const n = Number(unixSeconds)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}

function liberado() {
  return { ok: true, motivo: null, proxima_tentativa_em: null }
}

/**
 * Avalia se a instância pode iniciar novos chats agora.
 * @returns {Promise<{ ok: boolean, motivo: string|null, proxima_tentativa_em: string|null }>}
 */
async function avaliarAntiban({ companyId, instanciaId } = {}) {
  if (!antibanEnabled()) return liberado()
  if (!companyId || !instanciaId) return liberado()

  const key = `${companyId}:${instanciaId}`
  const ttl = cacheTtlMs()
  const cached = cache.get(key)
  if (cached && ttl > 0 && Date.now() - cached.at < ttl) {
    return cached.result
  }

  let result = liberado()
  try {
    const providerName = await resolveConversationProvider(companyId, instanciaId)
    const provider = getProvider({ provider: providerName })
    // Provider sem os métodos (ex. UltraMSG) → nunca freia.
    if (!provider || typeof provider.getReachoutTimelock !== 'function' || typeof provider.getNewChatLimit !== 'function') {
      cache.set(key, { at: Date.now(), result })
      return result
    }

    const opts = { companyId, whatsappInstanceId: instanciaId }

    // 1) Timelock de reachout: restrição temporária ativa = freia tudo até o fim.
    const timelock = await provider.getReachoutTimelock(opts)
    if (timelock?.ok && timelock.restricted === true) {
      result = {
        ok: false,
        motivo: `WhatsApp restringiu o início de novos chats${timelock.restrictionType ? ` (${timelock.restrictionType})` : ''}`,
        proxima_tentativa_em: unixToIso(timelock.restrictedUntil),
      }
    }

    // 2) Limite de novos chats do ciclo: capado = freia até o fim do ciclo.
    if (result.ok) {
      const novoChat = await provider.getNewChatLimit(opts)
      if (novoChat?.ok && novoChat.capped === true) {
        result = {
          ok: false,
          motivo: `Limite de novos chats atingido no ciclo${novoChat.capStatus ? ` (${novoChat.capStatus})` : ''}`,
          proxima_tentativa_em: unixToIso(novoChat.cycleEndAt),
        }
      }
    }
  } catch (e) {
    // Fail-open: instabilidade de leitura nunca trava o disparo.
    console.warn('[disparo:antiban] falha ao avaliar limites (liberando):', e?.message || e)
    result = liberado()
  }

  cache.set(key, { at: Date.now(), result })
  return result
}

/** Limpa o cache (testes / troca de configuração). */
function _resetCache() {
  cache.clear()
}

module.exports = {
  avaliarAntiban,
  antibanEnabled,
  _resetCache,
}
