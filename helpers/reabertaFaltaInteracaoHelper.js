const supabase = require('../config/supabase')

const REABERTA_TAG_RE = /reabert/i
const REABERTA_TAG_CTX = /falta|resposta|interac|inativid/i

function normalizeTagName(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

function tagIndicaReabertaFaltaInteracao(tagOrNome) {
  const nome = typeof tagOrNome === 'string' ? tagOrNome : tagOrNome?.nome
  const norm = normalizeTagName(nome)
  if (!norm) return false
  return REABERTA_TAG_RE.test(norm) && REABERTA_TAG_CTX.test(norm)
}

function tagsIndicamReabertaFaltaInteracao(tags) {
  const list = Array.isArray(tags) ? tags : []
  return list.some((t) => tagIndicaReabertaFaltaInteracao(t))
}

function resolveReabertaPorFaltaInteracao(row = {}) {
  if (row.reaberta_por_falta_interacao === true) return true
  if (row.reaberta_falta_interacao_em) return true
  if (row.reaberta_em) return true
  const tagsFromJoin = (row.conversa_tags || []).map((ct) => ct?.tags).filter(Boolean)
  const tags = Array.isArray(row.tags) && row.tags.length ? row.tags : tagsFromJoin
  return tagsIndicamReabertaFaltaInteracao(tags)
}

function isMissingColumnError(err, column) {
  const msg = String(err?.message || err || '').toLowerCase()
  return msg.includes(String(column).toLowerCase()) && (msg.includes('column') || msg.includes('schema cache'))
}

async function markReabertaFaltaInteracao(company_id, conversa_id, reabertaEm = new Date().toISOString()) {
  let marked = false

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

  return { ok: marked, reaberta_em: reabertaEm }
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

  const ids = [...new Set(candidates.map((c) => Number(c.id)).filter((n) => Number.isFinite(n) && n > 0))]
  if (!ids.length) return conversas

  const flagged = new Set()

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

  if (flagged.size < ids.length) {
    try {
      const { data: estados, error } = await supabase
        .from('alerta_atendimento_sem_resposta_estado')
        .select('conversa_id, reaberta_em')
        .eq('company_id', company_id)
        .in('conversa_id', ids)
        .not('reaberta_em', 'is', null)
      if (!error) {
        for (const row of estados || []) flagged.add(Number(row.conversa_id))
      }
    } catch (_) {}
  }

  if (flagged.size < ids.length) {
    try {
      const { data: eventos, error } = await supabase
        .from('alerta_atendimento_sem_resposta_eventos')
        .select('conversa_id')
        .eq('company_id', company_id)
        .eq('tipo', 'conversa_reaberta')
        .in('conversa_id', ids)
      if (!error) {
        for (const row of eventos || []) flagged.add(Number(row.conversa_id))
      }
    } catch (_) {}
  }

  for (const c of conversas) {
    if (flagged.has(Number(c.id))) c.reaberta_por_falta_interacao = true
  }

  return conversas
}

module.exports = {
  tagIndicaReabertaFaltaInteracao,
  tagsIndicamReabertaFaltaInteracao,
  resolveReabertaPorFaltaInteracao,
  markReabertaFaltaInteracao,
  clearReabertaFaltaInteracao,
  enrichConversasReabertaFaltaInteracao,
}
