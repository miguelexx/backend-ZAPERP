const supabase = require('../config/supabase')

/**
 * Badge azul na lista: somente quando gestor foi notificado E conversa reaberta automaticamente.
 */

function isMissingColumnError(err, column) {
  const msg = String(err?.message || err || '').toLowerCase()
  return msg.includes(String(column).toLowerCase()) && (msg.includes('column') || msg.includes('schema cache'))
}

function resolveReabertaPorFaltaInteracao(row = {}) {
  if (row.reaberta_por_falta_interacao === true) return true
  if (row.reaberta_falta_interacao_em) return true
  if (row.reaberta_em && row.gestor_notificado_em) return true
  return false
}

async function markReabertaFaltaInteracao(
  company_id,
  conversa_id,
  reabertaEm = new Date().toISOString(),
  gestorNotificadoEm = null
) {
  let marked = false
  const gestorEm = gestorNotificadoEm || reabertaEm

  const { data, error } = await supabase
    .from('conversas')
    .update({ reaberta_falta_interacao_em: reabertaEm })
    .eq('company_id', company_id)
    .eq('id', conversa_id)
    .is('atendente_id', null)
    .select('id')
    .maybeSingle()

  if (!error && data?.id) marked = true
  else if (error && !isMissingColumnError(error, 'reaberta_falta_interacao_em')) {
    console.warn('[reabertaFaltaInteracao] mark conversas:', error.message)
  }

  try {
    await supabase.from('alerta_atendimento_sem_resposta_estado').upsert(
      {
        company_id,
        conversa_id,
        reaberta_em: reabertaEm,
        gestor_notificado_em: gestorEm,
        atualizado_em: new Date().toISOString(),
      },
      { onConflict: 'company_id,conversa_id' }
    )
    marked = true
  } catch (e) {
    if (!String(e?.message || '').toLowerCase().includes('reaberta_em')) {
      console.warn('[reabertaFaltaInteracao] mark estado:', e?.message || e)
    }
  }

  return { ok: marked, reaberta_em: reabertaEm, gestor_notificado_em: gestorEm }
}

async function clearReabertaFaltaInteracao(company_id, conversa_id) {
  const { error } = await supabase
    .from('conversas')
    .update({ reaberta_falta_interacao_em: null })
    .eq('company_id', company_id)
    .eq('id', conversa_id)

  if (error && !isMissingColumnError(error, 'reaberta_falta_interacao_em')) {
    console.warn('[reabertaFaltaInteracao] clear conversas:', error.message)
  }

  try {
    await supabase
      .from('alerta_atendimento_sem_resposta_estado')
      .update({ reaberta_em: null, atualizado_em: new Date().toISOString() })
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
  } catch (_) {}
}

async function fetchReabertaGestorConversaIds(company_id, conversaIds) {
  const flagged = new Set()
  if (!Array.isArray(conversaIds) || !conversaIds.length) return flagged

  const ids = [...new Set(conversaIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))]
  if (!ids.length) return flagged

  try {
    const { data: rows, error } = await supabase
      .from('conversas')
      .select('id, reaberta_falta_interacao_em')
      .eq('company_id', company_id)
      .in('id', ids)
      .not('reaberta_falta_interacao_em', 'is', null)
    if (!error) {
      for (const row of rows || []) flagged.add(Number(row.id))
    }
  } catch (_) {}

  const pending = ids.filter((id) => !flagged.has(id))
  if (pending.length) {
    try {
      const { data: estados, error } = await supabase
        .from('alerta_atendimento_sem_resposta_estado')
        .select('conversa_id, reaberta_em, gestor_notificado_em')
        .eq('company_id', company_id)
        .in('conversa_id', pending)
        .not('reaberta_em', 'is', null)
        .not('gestor_notificado_em', 'is', null)
      if (!error) {
        for (const row of estados || []) flagged.add(Number(row.conversa_id))
      }
    } catch (_) {}
  }

  const stillPending = ids.filter((id) => !flagged.has(id))
  if (stillPending.length) {
    try {
      const { data: eventos, error } = await supabase
        .from('alerta_atendimento_sem_resposta_eventos')
        .select('conversa_id, tipo')
        .eq('company_id', company_id)
        .in('conversa_id', stillPending)
        .in('tipo', ['conversa_reaberta', 'gestor_notificado'])
      if (!error) {
        const reabertas = new Set()
        const gestores = new Set()
        for (const row of eventos || []) {
          const cid = Number(row.conversa_id)
          if (!Number.isFinite(cid)) continue
          if (row.tipo === 'conversa_reaberta') reabertas.add(cid)
          if (row.tipo === 'gestor_notificado') gestores.add(cid)
        }
        for (const cid of reabertas) {
          if (gestores.has(cid)) flagged.add(cid)
        }
      }
    } catch (_) {}
  }

  return flagged
}

async function enrichConversasReabertaFaltaInteracao(company_id, conversas) {
  if (!Array.isArray(conversas) || !conversas.length) return conversas

  for (const c of conversas) {
    if (c.is_group || c.sem_conversa) continue
    if (resolveReabertaPorFaltaInteracao(c)) {
      c.reaberta_por_falta_interacao = true
    }
  }

  const candidates = conversas.filter(
    (c) =>
      !c.is_group &&
      !c.sem_conversa &&
      !c.reaberta_por_falta_interacao &&
      String(c.status_atendimento_real || c.status_atendimento || '') === 'aberta' &&
      !c.atendente_id
  )
  if (!candidates.length) return conversas

  const flagged = await fetchReabertaGestorConversaIds(
    company_id,
    candidates.map((c) => c.id)
  )

  for (const c of conversas) {
    if (flagged.has(Number(c.id))) c.reaberta_por_falta_interacao = true
  }

  return conversas
}

module.exports = {
  resolveReabertaPorFaltaInteracao,
  markReabertaFaltaInteracao,
  clearReabertaFaltaInteracao,
  fetchReabertaGestorConversaIds,
  enrichConversasReabertaFaltaInteracao,
}
