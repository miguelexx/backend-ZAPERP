const supabase = require('../../config/supabase')
const { isMissingTableError, duplicateKeyError } = require('./errors')
const { buildAlertaSemRespostaResetPatch } = require('./cycle')

async function listAlertaSemRespostaEventos(company_id, { limit = 20, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 20))
  const off = Math.max(0, Number(offset) || 0)
  try {
    const { data, error } = await supabase
      .from('alerta_atendimento_sem_resposta_eventos')
      .select('id, conversa_id, atendente_id, tipo, nivel, mensagem, metadata, criado_em')
      .eq('company_id', company_id)
      .order('criado_em', { ascending: false })
      .range(off, off + lim - 1)
    if (error) {
      if (isMissingTableError(error)) {
        if (String(error.message || '').toLowerCase().includes('permission denied')) {
          console.warn('[atendimentoSemResposta] permissão negada em eventos — aplique GRANT/migration 20260608130000')
        }
        return { ok: true, eventos: [] }
      }
      return { ok: false, error: error.message, eventos: [] }
    }
    const eventos = (data || []).map((e) => ({
      ...e,
      detalhes: e?.metadata && typeof e.metadata === 'object' ? e.metadata : {},
    }))
    return { ok: true, eventos }
  } catch (e) {
    if (isMissingTableError(e)) return { ok: true, eventos: [] }
    return { ok: false, error: e?.message || String(e), eventos: [] }
  }
}

async function recordEvento(company_id, row) {
  try {
    const { error } = await supabase.from('alerta_atendimento_sem_resposta_eventos').insert({
      company_id,
      conversa_id: row.conversa_id,
      atendente_id: row.atendente_id ?? null,
      tipo: row.tipo,
      nivel: row.nivel ?? null,
      mensagem: row.mensagem ?? null,
      metadata: {
        ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
        ...(row.detalhes && typeof row.detalhes === 'object' ? row.detalhes : {}),
      },
    })
    if (error && !isMissingTableError(error)) {
      console.warn('[atendimentoSemResposta] recordEvento:', error.message)
    }
  } catch (e) {
    if (!isMissingTableError(e)) console.warn('[atendimentoSemResposta] recordEvento:', e?.message || e)
  }
}

async function getEstado(company_id, conversa_id) {
  try {
    const { data, error } = await supabase
      .from('alerta_atendimento_sem_resposta_estado')
      .select('*')
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .maybeSingle()
    if (error) {
      if (isMissingTableError(error)) return null
      console.warn('[atendimentoSemResposta] getEstado:', error.message)
      return null
    }
    return data
  } catch (e) {
    return null
  }
}

async function upsertEstado(company_id, conversa_id, patch) {
  try {
    const { error } = await supabase.from('alerta_atendimento_sem_resposta_estado').upsert(
      {
        company_id,
        conversa_id,
        ...patch,
        atualizado_em: new Date().toISOString(),
      },
      { onConflict: 'company_id,conversa_id' }
    )
    if (error && !isMissingTableError(error)) {
      console.warn('[atendimentoSemResposta] upsertEstado:', error.message)
    }
  } catch (e) {
    if (!isMissingTableError(e)) console.warn('[atendimentoSemResposta] upsertEstado:', e?.message || e)
  }
}

async function clearEstado(company_id, conversa_id) {
  try {
    await supabase
      .from('alerta_atendimento_sem_resposta_estado')
      .delete()
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
  } catch (_) {}
}

async function resetAlertaSemRespostaAoAssumirReaberta(
  company_id,
  conversa_id,
  assumidaEm = new Date().toISOString(),
  opts = {}
) {
  try {
    const estado = opts.estado != null ? opts.estado : await getEstado(company_id, conversa_id)
    let foiReabertaPeloAlerta = Boolean(estado?.reaberta_em)

    if (!foiReabertaPeloAlerta && opts.reaberta_falta_interacao_em) {
      foiReabertaPeloAlerta = true
    }

    if (!foiReabertaPeloAlerta) {
      const { data: conv } = await supabase
        .from('conversas')
        .select('reaberta_falta_interacao_em')
        .eq('company_id', company_id)
        .eq('id', conversa_id)
        .maybeSingle()
      foiReabertaPeloAlerta = Boolean(conv?.reaberta_falta_interacao_em)
    }

    if (!foiReabertaPeloAlerta) {
      return { ok: true, resetado: false, reason: 'nao_reaberta_pelo_alerta' }
    }

    await upsertEstado(company_id, conversa_id, buildAlertaSemRespostaResetPatch(assumidaEm))
    return { ok: true, resetado: true, ciclo_iniciado_em: assumidaEm }
  } catch (e) {
    console.warn('[atendimentoSemResposta] reset ao assumir reaberta:', e?.message || e)
    return { ok: false, resetado: false, error: e?.message || String(e) }
  }
}

async function fetchUltimaMensagem(company_id, conversa_id) {
  const { data, error } = await supabase
    .from('mensagens')
    .select('id, conversa_id, criado_em, direcao, texto')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    .order('criado_em', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data || null
}

async function revalidateConversaElegivel(company_id, conv, anchor) {
  const { data, error } = await supabase
    .from('conversas')
    .select('id, atendente_id, status_atendimento, atendente_atribuido_em')
    .eq('company_id', company_id)
    .eq('id', conv.id)
    .eq('status_atendimento', 'em_atendimento')
    .not('atendente_id', 'is', null)
    .maybeSingle()
  if (error || !data?.id) return false
  if (Number(data.atendente_id) !== Number(conv.atendente_id)) return false

  const ultima = await fetchUltimaMensagem(company_id, conv.id)
  if (!ultima || ultima.direcao !== 'in') {
    await clearEstado(company_id, conv.id)
    return false
  }
  if (String(ultima.criado_em) === String(anchor)) return true

  const anchorMs = new Date(anchor).getTime()
  const ultimaMs = new Date(ultima.criado_em).getTime()
  const assumidaMs = new Date(data.atendente_atribuido_em || conv.atendente_atribuido_em || 0).getTime()
  return (
    Number.isFinite(anchorMs) &&
    Number.isFinite(ultimaMs) &&
    Number.isFinite(assumidaMs) &&
    anchorMs > ultimaMs &&
    Math.abs(anchorMs - assumidaMs) <= 60 * 1000
  )
}

async function claimEstadoStage(company_id, conversa_id, anchor, estadoPatch) {
  const stage = Object.keys(estadoPatch || {}).find((k) =>
    ['primeiro_alerta_em', 'alerta_critico_em', 'gestor_notificado_em'].includes(k)
  )
  if (!stage) return false

  const now = new Date().toISOString()
  const claimedAt = estadoPatch[stage] || now
  const patch = {
    ultimo_cliente_msg_em: anchor,
    [stage]: claimedAt,
    atualizado_em: now,
  }

  try {
    const { data, error } = await supabase
      .from('alerta_atendimento_sem_resposta_estado')
      .update(patch)
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .eq('ultimo_cliente_msg_em', anchor)
      .is(stage, null)
      .select('conversa_id')
      .maybeSingle()

    if (error) {
      if (isMissingTableError(error)) return true
      console.warn('[atendimentoSemResposta] claimEstadoStage:', error.message)
      return false
    }
    if (data?.conversa_id) return true

    const { error: insertError } = await supabase
      .from('alerta_atendimento_sem_resposta_estado')
      .insert({
        company_id,
        conversa_id,
        ...patch,
      })
    if (!insertError) return true
    if (isMissingTableError(insertError)) return true
    if (duplicateKeyError(insertError)) return false
    console.warn('[atendimentoSemResposta] claimEstadoStage insert:', insertError.message)
    return false
  } catch (e) {
    if (isMissingTableError(e)) return true
    console.warn('[atendimentoSemResposta] claimEstadoStage:', e?.message || e)
    return false
  }
}

module.exports = {
  listAlertaSemRespostaEventos,
  recordEvento,
  getEstado,
  upsertEstado,
  clearEstado,
  resetAlertaSemRespostaAoAssumirReaberta,
  fetchUltimaMensagem,
  revalidateConversaElegivel,
  claimEstadoStage,
}
