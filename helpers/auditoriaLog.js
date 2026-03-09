/**
 * Helper para registrar ações críticas em auditoria_log.
 * Chamadas opcionais em controllers — não bloqueia fluxo.
 */

const supabase = require('../config/supabase')

/**
 * Registra ação na auditoria.
 * @param {object} opts
 * @param {number} opts.company_id
 * @param {number|null} opts.usuario_id
 * @param {string} opts.acao
 * @param {string} [opts.entidade]
 * @param {number} [opts.entidade_id]
 * @param {object} [opts.detalhes_json]
 */
async function registrar(opts) {
  try {
    await supabase.from('auditoria_log').insert({
      company_id: opts.company_id,
      usuario_id: opts.usuario_id ?? null,
      acao: opts.acao,
      entidade: opts.entidade ?? null,
      entidade_id: opts.entidade_id ?? null,
      detalhes_json: typeof opts.detalhes_json === 'object' ? opts.detalhes_json : {},
    })
  } catch (e) {
    console.warn('[auditoriaLog] Erro ao registrar:', e?.message || e)
  }
}

module.exports = { registrar }
