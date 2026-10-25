'use strict'

/**
 * Poda de mapas em memória cujo valor é um timestamp (`Date.now()`).
 *
 * Motivo (doc 29 §3 item 14): vários serviços usam `Map` por conversa como debounce ou
 * throttle e só apagam a entrada no fim do fluxo. Conversa que nunca chega ao fim deixa a
 * entrada para sempre — leak lento, estimado em 0,3–1 MB/dia.
 *
 * REGRA PARA USAR ISTO: a retenção tem de ser **confortavelmente maior que a janela que o
 * mapa protege**. Podar antes da janela expirar reintroduz exatamente o bug que o debounce
 * existe para evitar (mensagem duplicada, reconsulta em rajada ao provedor). Quando dois
 * mapas no mesmo módulo têm janelas diferentes, poda-se cada um com a sua retenção — não
 * se usa a menor das duas.
 */

/**
 * Remove de `mapa` as entradas com mais de `retencaoMs`, e as de valor não-numérico
 * (estado corrompido, que de outro modo ficaria preso para sempre).
 *
 * @param {Map<any, number>} mapa
 * @param {number} retencaoMs
 * @param {number} [agora] - injetável para teste
 * @returns {number} quantas entradas saíram
 */
function pruneMapaPorIdade(mapa, retencaoMs, agora = Date.now()) {
  if (!mapa || typeof mapa.entries !== 'function') return 0
  if (!Number.isFinite(retencaoMs) || retencaoMs <= 0) return 0
  let removidas = 0
  for (const [chave, ts] of [...mapa.entries()]) {
    if (!Number.isFinite(ts) || agora - ts > retencaoMs) {
      mapa.delete(chave)
      removidas++
    }
  }
  return removidas
}

/**
 * Agenda uma varredura periódica com `unref()`, para não manter o processo vivo nem
 * atrapalhar os testes (foi o que travou o jest quando o `unref` faltou uma vez).
 *
 * @param {() => void} varredura
 * @param {number} [intervaloMs]
 * @returns {NodeJS.Timeout}
 */
function agendarVarredura(varredura, intervaloMs = 60_000) {
  const timer = setInterval(varredura, intervaloMs)
  if (typeof timer.unref === 'function') timer.unref()
  return timer
}

module.exports = { pruneMapaPorIdade, agendarVarredura }
