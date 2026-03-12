/**
 * Sincronização progressiva de contatos.
 * Processa por lotes com checkpoint, lock e intervalo configurável.
 */

const supabase = require('../config/supabase')
const { getConfig, isProcessamentoPausado } = require('./configOperacionalService')
const { registrarEvento, TIPOS } = require('./operationalAuditService')
const { syncContactsBatch, syncMissingConversationContacts } = require('./ultramsgContactsSyncService')

const LOCK_TIPO = 'sync_contatos'
const CHECKPOINT_TIPO = 'sync_contatos'

const MAX_PAGES = parseInt(process.env.SYNC_MAX_PAGES_PER_RUN, 10) || 20

/**
 * Adquire lock para sync. Retorna true se adquirido.
 */
async function acquireLock(company_id) {
  try {
    await supabase.from('sync_locks').delete().eq('company_id', company_id).eq('tipo', LOCK_TIPO)
    const { error } = await supabase.from('sync_locks').insert({
      company_id,
      tipo: LOCK_TIPO,
      locked_by: 'sync_progressiva'
    })
    return !error
  } catch (e) {
    return false
  }
}

/**
 * Libera lock.
 */
async function releaseLock(company_id) {
  try {
    await supabase.from('sync_locks').delete().eq('company_id', company_id).eq('tipo', LOCK_TIPO)
  } catch (e) {
    console.warn('[syncProgressiva] Erro ao liberar lock:', e?.message || e)
  }
}

/**
 * Obtém checkpoint (página atual).
 */
async function getCheckpoint(company_id) {
  const { data } = await supabase
    .from('checkpoints_sync')
    .select('ultimo_offset')
    .eq('company_id', company_id)
    .eq('tipo', CHECKPOINT_TIPO)
    .maybeSingle()
  return (data?.ultimo_offset ?? 0) || 1
}

/**
 * Atualiza checkpoint.
 */
async function updateCheckpoint(company_id, page, detalhes = {}) {
  await supabase
    .from('checkpoints_sync')
    .upsert({
      company_id,
      tipo: CHECKPOINT_TIPO,
      ultimo_offset: page,
      detalhes_json: detalhes,
      atualizado_em: new Date().toISOString()
    }, { onConflict: 'company_id,tipo' })
}

/**
 * Reseta checkpoint (início de nova sync completa).
 */
async function resetCheckpoint(company_id) {
  await supabase.from('checkpoints_sync').delete().eq('company_id', company_id).eq('tipo', CHECKPOINT_TIPO)
}

/**
 * Executa um lote da sincronização progressiva.
 * @param {number} company_id
 * @param {object} opts - { reset: boolean }
 * @returns {Promise<{ ok: boolean, processados: number, criados: number, atualizados: number, temMais: boolean, checkpoint: number, locked: boolean, error?: string }>}
 */
async function syncContactsProgressiva(company_id, opts = {}) {
  if (!company_id) {
    return { ok: false, processados: 0, criados: 0, atualizados: 0, temMais: false, checkpoint: 1, locked: false, error: 'company_id ausente' }
  }

  const pausado = await isProcessamentoPausado(company_id)
  if (pausado) {
    return { ok: false, processados: 0, criados: 0, atualizados: 0, temMais: false, checkpoint: 1, locked: false, error: 'Processamento pausado' }
  }

  const config = await getConfig(company_id)
  const pageSize = Math.min(100, Math.max(10, config.lote_max || 50))

  const acquired = await acquireLock(company_id)
  if (!acquired) {
    return { ok: false, processados: 0, criados: 0, atualizados: 0, temMais: false, checkpoint: 1, locked: false, error: 'Sync já em andamento' }
  }

  try {
    let page = opts.reset ? 1 : await getCheckpoint(company_id)
    if (opts.reset) await resetCheckpoint(company_id)

    const batch = await syncContactsBatch(company_id, { page, pageSize })
    if (batch.errors?.length) {
      await registrarEvento(company_id, TIPOS.FALHA, `Sync lote página ${page} com erros`, { page, errors: batch.errors.slice(0, 5) })
    }

    const nextPage = page + 1
    await updateCheckpoint(company_id, nextPage, {
      lastProcessados: batch.processados,
      lastInserted: batch.inserted,
      lastUpdated: batch.updated
    })

    await registrarEvento(company_id, TIPOS.SYNC_LOTE, `Lote página ${page} processado`, {
      page,
      processados: batch.processados,
      inserted: batch.inserted,
      updated: batch.updated
    })

    return {
      ok: true,
      processados: batch.processados,
      criados: batch.inserted,
      atualizados: batch.updated,
      temMais: batch.hasMore && (opts.maxPagesPerRun ? page < opts.maxPagesPerRun : true),
      checkpoint: nextPage,
      locked: true
    }
  } finally {
    await releaseLock(company_id)
  }
}

/**
 * Executa sincronização completa em lotes até maxPages ou fim.
 * Usado pelo worker. Entre cada lote respeita intervalo_lotes_seg.
 */
async function syncContactsFullProgressiva(company_id, opts = {}) {
  const config = await getConfig(company_id)
  const intervaloMs = (config.intervalo_lotes_seg || 5) * 1000
  const maxPages = opts.maxPages ?? MAX_PAGES

  await registrarEvento(company_id, TIPOS.SYNC_INICIO, 'Sync progressiva iniciada', { maxPages })

  let totalProcessados = 0
  let totalCriados = 0
  let totalAtualizados = 0
  let pageCount = 0

  while (pageCount < maxPages) {
    const pausado = await isProcessamentoPausado(company_id)
    if (pausado) {
      await registrarEvento(company_id, TIPOS.PAUSA, 'Sync pausada (processamento_pausado)')
      break
    }

    const result = await syncContactsProgressiva(company_id, { maxPagesPerRun: maxPages })
    if (!result.ok) break

    totalProcessados += result.processados
    totalCriados += result.criados
    totalAtualizados += result.atualizados
    pageCount++

    if (!result.temMais) break

    await new Promise(r => setTimeout(r, intervaloMs))
  }

  if (opts.includeConversationCache === true) {
    try {
      const convResult = await syncMissingConversationContacts(company_id, { batchSize: 30, delayMs: 500 })
      await registrarEvento(company_id, TIPOS.SYNC_LOTE, 'Sync conversas sem nome/foto', {
        processadas: convResult.processadas,
        atualizadas: convResult.atualizadas,
        errors: convResult.errors?.length || 0
      })
    } catch (e) {
      console.warn('[syncProgressiva] syncMissingConversationContacts:', e?.message || e)
    }
  }

  await registrarEvento(company_id, TIPOS.SYNC_FIM, 'Sync progressiva finalizada', {
    totalProcessados,
    totalCriados,
    totalAtualizados,
    paginas: pageCount
  })

  return { totalProcessados, totalCriados, totalAtualizados, paginas: pageCount }
}

module.exports = {
  syncContactsProgressiva,
  syncContactsFullProgressiva,
  acquireLock,
  releaseLock,
  getCheckpoint,
  resetCheckpoint
}
