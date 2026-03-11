/**
 * Serviço de configurações operacionais.
 * Usa tabela configuracoes_operacionais com fallback para ENV/defaults.
 */

const supabase = require('../config/supabase')

const DEFAULTS = {
  sync_auto: false,
  lote_max: parseInt(process.env.SYNC_BATCH_SIZE, 10) || 50,
  intervalo_lotes_seg: Math.max(1, Math.min(60, parseInt(process.env.SYNC_INTERVAL_BETWEEN_BATCHES_MS, 10) / 1000 || 5)),
  pausa_blocos_seg: 30,
  concorrencia_max: parseInt(process.env.QUEUE_MAX_CONCURRENT_JOBS, 10) || 2,
  retry_max: parseInt(process.env.QUEUE_MAX_RETRIES, 10) || 3,
  cooldown_erro_seg: 60,
  modo_seguro: String(process.env.OPERATIONAL_SAFE_MODE_DEFAULT || 'true').toLowerCase() !== 'false',
  somente_atendimento_humano: false,
  processamento_pausado: false
}

/**
 * Obtém configuração operacional da empresa. Cria registro com defaults se não existir.
 * @param {number} company_id
 * @returns {Promise<{ sync_auto, lote_max, intervalo_lotes_seg, pausa_blocos_seg, concorrencia_max, retry_max, cooldown_erro_seg, modo_seguro, somente_atendimento_humano, processamento_pausado }>}
 */
async function getConfig(company_id) {
  if (!company_id) return DEFAULTS

  const { data, error } = await supabase
    .from('configuracoes_operacionais')
    .select('*')
    .eq('company_id', company_id)
    .maybeSingle()

  if (error) {
    console.warn('[configOperacionalService] getConfig:', error.message)
    return DEFAULTS
  }

  if (!data) {
    // Cria registro com defaults
    const { data: inserted, error: insertErr } = await supabase
      .from('configuracoes_operacionais')
      .insert({ company_id, ...DEFAULTS })
      .select()
      .single()

    if (insertErr) return DEFAULTS
    return { ...DEFAULTS, ...inserted }
  }

  return {
    ...DEFAULTS,
    ...data
  }
}

/**
 * Atualiza configuração operacional.
 * @param {number} company_id
 * @param {object} updates - Campos a atualizar
 */
async function updateConfig(company_id, updates) {
  if (!company_id) return { ok: false, error: 'company_id ausente' }

  const allowed = [
    'sync_auto', 'lote_max', 'intervalo_lotes_seg', 'pausa_blocos_seg',
    'concorrencia_max', 'retry_max', 'cooldown_erro_seg', 'modo_seguro',
    'somente_atendimento_humano', 'processamento_pausado'
  ]

  const update = {}
  for (const k of allowed) {
    if (updates[k] !== undefined) {
      if (k === 'sync_auto' || k === 'modo_seguro' || k === 'somente_atendimento_humano' || k === 'processamento_pausado') {
        update[k] = !!updates[k]
      } else {
        const v = Number(updates[k])
        if (!isNaN(v) && v >= 0) update[k] = v
      }
    }
  }

  if (Object.keys(update).length === 0) return { ok: true }

  update.atualizado_em = new Date().toISOString()

  const { data, error } = await supabase
    .from('configuracoes_operacionais')
    .upsert({ company_id, ...update }, { onConflict: 'company_id' })
    .select()
    .single()

  if (error) return { ok: false, error: error.message }
  return { ok: true, data }
}

/**
 * Verifica se processamento está pausado.
 */
async function isProcessamentoPausado(company_id) {
  const config = await getConfig(company_id)
  return config.processamento_pausado === true
}

/**
 * Verifica se modo seguro está ativo.
 */
async function isModoSeguro(company_id) {
  const config = await getConfig(company_id)
  return config.modo_seguro === true
}

module.exports = {
  getConfig,
  updateConfig,
  isProcessamentoPausado,
  isModoSeguro,
  DEFAULTS
}
