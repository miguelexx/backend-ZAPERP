'use strict'

/**
 * Redige dados pessoais antes de qualquer log.
 *
 * Motivo (doc 29 §3 item 15): o caminho de inbound logava, em TODA mensagem recebida, o
 * telefone COMPLETO do cliente e os primeiros 50 caracteres do texto da mensagem. Isto é
 * conteúdo de conversa de cliente — dado pessoal — replicado no log, onde fica fora de
 * qualquer controle de acesso do produto e sem retenção definida.
 *
 * O conteúdo da mensagem **já está** na tabela `mensagens`: logá-lo outra vez não
 * acrescenta informação de diagnóstico, só exposição. Para diagnosticar basta saber que
 * chegou texto e qual o tamanho — é o mesmo princípio já documentado em
 * `redactUrlSecrets.js` ("o par nome-do-parâmetro + tamanho já basta").
 *
 * A convenção dos 4 últimos dígitos já existia em `services/disparoSendService.js`
 * (`phoneLast4` + `tel=****`); aqui ela fica num só lugar, para o caminho quente.
 *
 * NUNCA relaxar isto para "facilitar debug": o telefone completo identifica a pessoa, e os
 * 4 últimos dígitos bastam para correlacionar com a conversa no banco.
 */

/**
 * Telefone para log: só os 4 últimos dígitos.
 * `5511987654321` → `'****4321'`; vazio/ausente → `'****????'`.
 */
function telefoneParaLog(valor) {
  const digitos = String(valor == null ? '' : valor).replace(/\D/g, '')
  return `****${digitos.slice(-4) || '????'}`
}

/**
 * Texto de mensagem para log: NUNCA o conteúdo, só a forma.
 * `'bom dia'` → `'txt:7'`; `''` → `'txt:0'`; ausente → `'txt:-'`.
 */
function textoParaLog(valor) {
  if (valor == null) return 'txt:-'
  const s = typeof valor === 'string' ? valor : String(valor)
  return `txt:${s.length}`
}

/**
 * Nome de contato para log: inicial + tamanho, nunca o nome completo.
 * `'Claudia DB'` → `'C.(10)'`; ausente → `'-'`.
 */
function nomeParaLog(valor) {
  if (valor == null || valor === '') return '-'
  const s = typeof valor === 'string' ? valor : String(valor)
  return `${s.trim().charAt(0) || '?'}.(${s.length})`
}

module.exports = { telefoneParaLog, textoParaLog, nomeParaLog }
