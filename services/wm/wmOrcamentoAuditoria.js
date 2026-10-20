'use strict'

const auditoriaLog = require('../../helpers/auditoriaLog')

/**
 * Ponto único de auditoria do Orçamento WM.
 *
 * Existe por uma razão concreta: `auditoria_log.entidade_id` é **integer**
 * (migration 20260310000000_opt_in_opt_out_campanhas_auditoria.sql:72) e a operação de
 * orçamento é **UUID**. Passar o UUID ali faz o insert falhar — e `auditoriaLog.registrar`
 * é best-effort, engole o erro num `console.warn` e segue. O resultado seria auditoria
 * silenciosamente vazia justamente na integração que grava em ERP de terceiro.
 *
 * Portanto, invariante fixada aqui e coberta por teste:
 *   entidade    = 'wm_orcamento'
 *   entidade_id = null            (sempre; nunca o UUID)
 *   detalhes_json.operacao_id = <uuid da operação>
 *
 * Nunca logar: Bearer WM, telefone autorizado completo, body cru, CPF/CNPJ/IE,
 * payload de criação completo, resposta bruta de erro do Worker/SQL, URL com segredo.
 * Os detalhes passam por uma allowlist rasa abaixo — campo desconhecido não entra.
 */

const ENTIDADE = 'wm_orcamento'

const EVENTOS = Object.freeze({
  CONFIG_VALIDADA: 'wm_orcamento_config_validada',
  PREPARADO: 'wm_orcamento_preparado',
  CONFIRMADO: 'wm_orcamento_confirmado',
  CRIADO: 'wm_orcamento_criado',
  RESULTADO_INCERTO: 'wm_orcamento_resultado_incerto',
  FALHA_SEGURA: 'wm_orcamento_falha_segura',
})

/** Campos permitidos em detalhes_json. Tudo fora desta lista é descartado. */
const DETALHES_PERMITIDOS = Object.freeze([
  'operacao_id',
  'comando_id',
  'estado_anterior',
  'estado',
  'payload_hash',
  'http_status',
  'erro_codigo',
  'tentativas',
  'conversa_id',
  'itens_total',
  'validacao_status',
  'telefone_ultimos4',
])

function filtrarDetalhes(detalhes) {
  const out = {}
  if (!detalhes || typeof detalhes !== 'object') return out
  for (const chave of DETALHES_PERMITIDOS) {
    const valor = detalhes[chave]
    if (valor === undefined) continue
    out[chave] = valor
  }
  return out
}

/**
 * @param {object} opts
 * @param {number} opts.company_id            sempre do JWT
 * @param {number|null} [opts.usuario_id]
 * @param {string} opts.acao                  um valor de EVENTOS
 * @param {string|null} [opts.operacao_id]    UUID da operação — vai em detalhes_json
 * @param {object} [opts.detalhes]            campos extras (allowlist acima)
 */
async function registrarEventoOrcamento({ company_id, usuario_id = null, acao, operacao_id = null, detalhes = {} } = {}) {
  const detalhes_json = filtrarDetalhes(detalhes)
  if (operacao_id != null) detalhes_json.operacao_id = String(operacao_id)

  await auditoriaLog.registrar({
    company_id,
    usuario_id: usuario_id ?? null,
    acao,
    entidade: ENTIDADE,
    entidade_id: null, // integer na tabela; o UUID vive em detalhes_json.operacao_id
    detalhes_json,
  })
}

module.exports = {
  ENTIDADE,
  EVENTOS,
  DETALHES_PERMITIDOS,
  registrarEventoOrcamento,
}
