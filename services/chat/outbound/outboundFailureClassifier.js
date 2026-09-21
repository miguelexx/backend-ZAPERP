/**
 * Classifica falhas de envio outbound entre TRANSITÓRIAS (retryáveis) e DEFINITIVAS.
 *
 * Motivação (auditoria set/2026): uma falha na 1ª tentativa gravava `status = 'erro'`,
 * mas o sweep de reconciliação (services/pendingOutboundReconciliationService.js) só
 * seleciona `pending`/`sending`. A mensagem em `erro` saía do alcance do retry automático
 * e só voltava por clique manual em "Reenviar". Mantendo falhas transitórias como `pending`,
 * a mensagem continua elegível ao sweep (que consulta o provedor por `referenceId=crm-{id}`
 * antes de reenviar — sem duplicar).
 *
 * Conservador de propósito: só classifica como transitória quando há forte indício de
 * problema momentâneo:
 *   - exceção de transporte (timeout/rede) — `isException = true`;
 *   - HTTP 408 (Request Timeout), 425 (Too Early), 429 (Too Many Requests);
 *   - HTTP 5xx (erro no lado do provedor).
 *
 * Permanecem DEFINITIVAS (retornam false → status `erro`):
 *   - recusas com corpo de erro em HTTP 200 (ex.: `sent=false`, token inválido) → sem httpStatus 5xx;
 *   - 4xx de validação/permissão (400/401/403/404/409/422);
 *   - ausência de instância/configuração (result sem httpStatus).
 * Nesses casos retentar não mudaria o resultado.
 */

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429])

/**
 * @param {{ httpStatus?: number|null, isException?: boolean }} [params]
 * @returns {boolean} true quando a falha é transitória/retryável.
 */
function isTransientOutboundFailure({ httpStatus = null, isException = false } = {}) {
  if (isException) return true
  const status = Number(httpStatus)
  if (!Number.isFinite(status)) return false
  if (TRANSIENT_HTTP_STATUSES.has(status)) return true
  if (status >= 500 && status <= 599) return true
  return false
}

module.exports = { isTransientOutboundFailure, TRANSIENT_HTTP_STATUSES }
