/**
 * Resolução de status ACK do webhook — parte PURA. Extraído verbatim de receberZapi (Fase 5 — doc 24).
 *
 * `resolveEffectiveStatus(current, next)`: decide o status resultante SEM permitir REGRESSÃO — um ACK
 * atrasado (ex. `sent` chegando depois de `read`) nunca rebaixa o status já registrado. `erro`/`failed`
 * só sobrescrevem enquanto a mensagem ainda não passou de `delivered` (falha tardia não apaga entrega/leitura).
 * Invariante crítico: ver [24](../../docs/ai-handoff/24-WEBHOOK-INBOUND-MODULARIZACAO.md) §4 (ACK sem regressão).
 */

const { statusRank } = require('../../helpers/messageStatusHelper')

function resolveEffectiveStatus(current, next) {
  const currentStatus = current || 'pending'
  if (next === 'erro' || next === 'failed') {
    return statusRank(currentStatus) >= statusRank('delivered') ? currentStatus : next
  }
  return statusRank(currentStatus) > statusRank(next) ? currentStatus : next
}

module.exports = { resolveEffectiveStatus }
