/**
 * Limitador de concorrência mínimo — sem dependência nova (doc 29 §3 item 11).
 *
 * Problema real: `schedulePersistInboundMediaIfNeeded` (download da mídia inbound) e
 * `scheduleR2MirrorIfNeeded` (espelhamento para o R2) disparavam um `setImmediate` por
 * mensagem, SEM teto. Numa rajada de N mídias o processo abria N downloads/uploads ao mesmo
 * tempo — cada um podendo chegar a ~80 MB — e o pico de memória/rede batia no processo todo
 * (PM2 roda `instances: 1`, então é o mesmo processo que serve a API e os sockets).
 *
 * As tarefas continuam assíncronas e fora do caminho síncrono do webhook: o limitador só
 * ENFILEIRA. Nada é descartado, a ordem de entrada é preservada (FIFO) e uma tarefa que
 * rejeita não derruba a fila — o `finally` sempre libera a vaga.
 */

/**
 * @param {number} max Máximo de tarefas em execução ao mesmo tempo (>= 1).
 * @returns {{ run: (fn: () => Promise<any>) => Promise<any>, emExecucao: () => number, naFila: () => number, max: number }}
 */
function criarLimiteConcorrencia(max) {
  const teto = Number.isFinite(Number(max)) && Number(max) >= 1 ? Math.floor(Number(max)) : 1
  const fila = []
  let ativos = 0

  function proximo() {
    if (ativos >= teto) return
    const item = fila.shift()
    if (!item) return
    ativos += 1
    // `Promise.resolve().then` garante que uma fn síncrona que estoura também caia no catch.
    Promise.resolve()
      .then(item.fn)
      .then(item.resolve, item.reject)
      .finally(() => {
        ativos -= 1
        proximo()
      })
  }

  function run(fn) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('limiteConcorrencia.run: fn tem de ser função'))
    return new Promise((resolve, reject) => {
      fila.push({ fn, resolve, reject })
      proximo()
    })
  }

  return {
    run,
    emExecucao: () => ativos,
    naFila: () => fila.length,
    max: teto,
  }
}

module.exports = { criarLimiteConcorrencia }
