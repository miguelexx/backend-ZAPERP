'use strict'

/**
 * Flag `WHATSAPP_DEBUG` — diagnóstico detalhado do caminho quente do inbound.
 *
 * Motivo (doc 29 §3 item 15): o pipeline de recebimento logava ~7 linhas por mensagem
 * comum (uma por requisição, uma de pipeline, uma de resolução de chave, …), inclusive para
 * cada ACK. Em volume isso é custo de I/O síncrono no event loop e ruído no PM2. O caminho de
 * sucesso fica com 2 linhas (recebida + salva); todo o resto sai só com a flag ligada.
 *
 * A flag é lida A CADA chamada (não no load do módulo) para que `WHATSAPP_DEBUG=1` ligue o
 * detalhe sem reiniciar módulos nos testes. Aceita `1`, `true` ou `yes` — o projeto usava ora
 * `=== 'true'`, ora `=== '1'`, e a documentação fala em `WHATSAPP_DEBUG=1`.
 *
 * Mesmo com a flag ligada, telefone vai mascarado e texto só como tamanho
 * (ver `helpers/redactLogPII.js`) — a flag não é licença para logar dado pessoal.
 */
function whatsappDebugAtivo() {
  const v = String(process.env.WHATSAPP_DEBUG || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/** `console.log` só com WHATSAPP_DEBUG ligado. Para payload caro (JSON.stringify), guarde com `if (whatsappDebugAtivo())`. */
function logDebug(...args) {
  if (whatsappDebugAtivo()) console.log(...args)
}

module.exports = { whatsappDebugAtivo, logDebug }
