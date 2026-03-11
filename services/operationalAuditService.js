/**
 * Serviço de auditoria de eventos operacionais.
 * Registra em auditoria_eventos: conexão, sync, falhas, pausas, alterações de config.
 */

const supabase = require('../config/supabase')

const TIPOS = {
  CONEXAO: 'conexao',
  SYNC_INICIO: 'sync_inicio',
  SYNC_FIM: 'sync_fim',
  SYNC_LOTE: 'sync_lote',
  FALHA: 'falha',
  PAUSA: 'pausa',
  CONFIG_ALTERADA: 'config_alterada',
  JOB_ENFILEIRADO: 'job_enfileirado',
  JOB_CONCLUIDO: 'job_concluido',
  JOB_FALHOU: 'job_falhou',
  CIRCUIT_OPEN: 'circuit_open'
}

/**
 * Registra evento operacional.
 * Fail-open: não bloqueia fluxo; loga e continua.
 * @param {number} company_id
 * @param {string} tipo - TIPOS.CONEXAO, TIPOS.SYNC_INICIO, etc.
 * @param {string} evento - descrição curta
 * @param {object} [detalhes] - dados adicionais
 */
async function registrarEvento(company_id, tipo, evento, detalhes = {}) {
  if (!company_id) return

  try {
    await supabase.from('auditoria_eventos').insert({
      company_id: Number(company_id),
      tipo: String(tipo).slice(0, 50),
      evento: String(evento).slice(0, 100),
      detalhes_json: typeof detalhes === 'object' ? detalhes : {}
    })
  } catch (e) {
    console.warn('[operationalAuditService] Erro ao registrar:', e?.message || e)
  }
}

/**
 * Lista eventos operacionais (paginado).
 * @param {number} company_id
 * @param {object} opts - { limit, offset, tipo }
 */
async function listarEventos(company_id, opts = {}) {
  const limit = Math.min(100, Math.max(1, opts.limit || 50))
  const offset = Math.max(0, opts.offset || 0)

  let q = supabase
    .from('auditoria_eventos')
    .select('*')
    .eq('company_id', company_id)
    .order('criado_em', { ascending: false })
    .range(offset, offset + limit - 1)

  if (opts.tipo) {
    q = q.eq('tipo', opts.tipo)
  }

  const { data, error } = await q

  if (error) return { ok: false, error: error.message, eventos: [] }
  return { ok: true, eventos: data || [] }
}

module.exports = {
  registrarEvento,
  listarEventos,
  TIPOS
}
