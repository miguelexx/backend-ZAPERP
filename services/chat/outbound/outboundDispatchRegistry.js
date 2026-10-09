/**
 * Registro (em memória, por processo) dos despachos de mídia ao provedor.
 *
 * A mídia é gravada como pending e despachada depois, em segundo plano (upload ao CDN do
 * provedor + envio), o que pode levar de segundos (voz) a minutos (vídeo). Dois problemas
 * dependiam de saber "este despacho ainda está rodando?":
 *
 *  1. A varredura de reconciliação, vendo a linha pending sem id após a carência, podia
 *     REENVIAR uma mídia cujo primeiro envio ainda estava em andamento → duplicata no cliente.
 *  2. Um restart do backend (todo deploy) mata o despacho em andamento. A nova tentativa do
 *     navegador, com o mesmo client_temp_id, era respondida como "já existe" e ninguém enviava.
 *
 * `emAndamento` responde à (1). `conhecido` responde à (2): se a linha existe mas ESTE processo
 * nunca a despachou, o despacho morreu com o processo anterior e pode ser refeito com segurança.
 *
 * PM2 roda 1 instância (fork) — ver ecosystem.config.js; em cluster este registro não valeria.
 */

/** Teto de segurança: um despacho que nunca sinalizar o fim deixa de bloquear a varredura. */
const TTL_EM_ANDAMENTO_MS = 20 * 60 * 1000
const MAX_CONHECIDOS = 5000

const emAndamento = new Map()
const conhecidos = new Set()

function chave(mensagemId) {
  const n = Number(mensagemId)
  return Number.isFinite(n) && n > 0 ? n : null
}

function iniciarDespacho(mensagemId) {
  const id = chave(mensagemId)
  if (id == null) return
  emAndamento.set(id, Date.now())
  conhecidos.add(id)
  if (conhecidos.size > MAX_CONHECIDOS) {
    const primeiro = conhecidos.values().next().value
    if (primeiro !== undefined) conhecidos.delete(primeiro)
  }
}

function concluirDespacho(mensagemId) {
  const id = chave(mensagemId)
  if (id != null) emAndamento.delete(id)
}

function despachoEmAndamento(mensagemId) {
  const id = chave(mensagemId)
  if (id == null) return false
  const desde = emAndamento.get(id)
  if (desde == null) return false
  if (Date.now() - desde > TTL_EM_ANDAMENTO_MS) {
    emAndamento.delete(id)
    return false
  }
  return true
}

/** true quando este processo iniciou (em algum momento) o despacho desta mensagem. */
function despachoConhecido(mensagemId) {
  const id = chave(mensagemId)
  return id != null && conhecidos.has(id)
}

function _resetParaTestes() {
  emAndamento.clear()
  conhecidos.clear()
}

module.exports = {
  iniciarDespacho,
  concluirDespacho,
  despachoEmAndamento,
  despachoConhecido,
  TTL_EM_ANDAMENTO_MS,
  _resetParaTestes,
}
