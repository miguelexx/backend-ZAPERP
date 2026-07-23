/**
 * Fila serial em memória por chave (ex.: `${company_id}:${conversa_id}`).
 *
 * Motivo: o despacho de mídia ao WhatsApp é assíncrono (upload CDN → envio). Dois áudios enviados
 * em sequência disparavam pipelines paralelos e o que subisse primeiro era entregue primeiro —
 * risco de ordem trocada ao contato. Esta fila garante que, PARA A MESMA conversa, o próximo
 * despacho só começa depois que o anterior termina (incluindo o POST ao provider). Conversas
 * diferentes continuam em paralelo (chaves distintas).
 *
 * Escopo: ordena despachos originados NESTE processo. Deploy single-instance fica 100% ordenado;
 * multi-instância sem sticky ainda pode intercalar entre instâncias (aceitável — a fila sequencial
 * do frontend já emite o POST seguinte só após a resposta do anterior).
 */

const _chains = new Map() // key -> Promise (cauda da cadeia, sempre "silenciada")

/**
 * Enfileira `taskFn` para rodar em série por `key`. Não bloqueia o chamador (retorna a promise da
 * task). Falha de uma task NÃO impede a próxima (isolamento). Limpa a entrada quando a cadeia esvazia.
 * @param {string|number} key
 * @param {() => (Promise<any>|any)} taskFn
 * @returns {Promise<any>} resultado da própria task (pode rejeitar; o chamador que trate se quiser)
 */
function enqueueSerialByKey(key, taskFn) {
  const k = String(key)
  const prev = _chains.get(k) || Promise.resolve()
  // roda a task independentemente de a anterior ter resolvido ou rejeitado (isolamento de falha)
  const runNext = prev.then(() => taskFn(), () => taskFn())
  // cauda silenciada: mantém a cadeia viva sem vazar unhandledRejection
  const tail = runNext.then(() => undefined, () => undefined)
  _chains.set(k, tail)
  tail.then(() => {
    // só remove se ninguém encadeou depois (senão a nova task vira a cauda atual)
    if (_chains.get(k) === tail) _chains.delete(k)
  })
  return runNext
}

/** Nº de conversas com cadeia ativa (para testes/observabilidade). */
function activeKeyCount() {
  return _chains.size
}

module.exports = { enqueueSerialByKey, activeKeyCount, _chains }
