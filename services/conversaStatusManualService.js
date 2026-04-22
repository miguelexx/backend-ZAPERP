const supabase = require('../config/supabase')

const ACAO_MANUAL_AGUARDANDO = 'manual_aguardando_cliente'
const ACAO_MANUAL_RETOMAR = 'manual_retomar_em_atendimento'

/**
 * Marca conversa como aguardando cliente (manual). Só a partir de em_atendimento com atendente.
 * Limpa aguardando_cliente_desde (uso legado do job de ausência) para não misturar com o estado manual.
 */
async function marcarAguardandoClienteManual({
  company_id,
  conversa_id,
  usuario_id,
}) {
  const cid = Number(company_id)
  const convId = Number(conversa_id)
  const uid = Number(usuario_id)
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(convId) || convId <= 0) {
    return { ok: false, status: 400, error: 'Parâmetros inválidos', conversa: null }
  }

  const { data: row, error: fetchErr } = await supabase
    .from('conversas')
    .select('id, tipo, telefone, status_atendimento, atendente_id')
    .eq('company_id', cid)
    .eq('id', convId)
    .maybeSingle()

  if (fetchErr) return { ok: false, status: 500, error: fetchErr.message, conversa: null }
  if (!row) return { ok: false, status: 404, error: 'Conversa não encontrada', conversa: null }

  const tipo = String(row.tipo || '').toLowerCase()
  const tel = String(row.telefone || '')
  if (tipo === 'grupo' || tel.includes('@g.us')) {
    return { ok: false, status: 400, error: 'Indisponível para conversas de grupo', conversa: null }
  }

  if (row.status_atendimento === 'aguardando_cliente') {
    const { data: atual } = await supabase
      .from('conversas')
      .select('*')
      .eq('company_id', cid)
      .eq('id', convId)
      .maybeSingle()
    return { ok: true, status: 200, error: null, conversa: atual, idempotent: true }
  }

  if (row.status_atendimento !== 'em_atendimento') {
    return {
      ok: false,
      status: 409,
      error: 'Só é possível marcar como aguardando cliente a partir de em atendimento',
      conversa: null,
    }
  }
  if (row.atendente_id == null) {
    return { ok: false, status: 409, error: 'Conversa sem atendente atribuído', conversa: null }
  }

  const { data: updated, error: updErr } = await supabase
    .from('conversas')
    .update({
      status_atendimento: 'aguardando_cliente',
      aguardando_cliente_desde: null,
      ausencia_mensagem_enviada_em: null,
    })
    .eq('company_id', cid)
    .eq('id', convId)
    .eq('status_atendimento', 'em_atendimento')
    .select()
    .maybeSingle()

  if (updErr) return { ok: false, status: 500, error: updErr.message, conversa: null }
  if (!updated) {
    return {
      ok: false,
      status: 409,
      error: 'Não foi possível atualizar (estado da conversa pode ter mudado)',
      conversa: null,
    }
  }

  await supabase.from('historico_atendimentos').insert({
    conversa_id: convId,
    usuario_id: Number.isFinite(uid) && uid > 0 ? uid : null,
    acao: ACAO_MANUAL_AGUARDANDO,
    observacao:
      'Conversa marcada manualmente como aguardando cliente (excluída do encerramento automático por ausência)',
  })

  return { ok: true, status: 200, error: null, conversa: updated, idempotent: false }
}

/**
 * Volta de aguardando cliente (manual) para em_atendimento.
 */
async function retomarEmAtendimentoManual({
  company_id,
  conversa_id,
  usuario_id,
}) {
  const cid = Number(company_id)
  const convId = Number(conversa_id)
  const uid = Number(usuario_id)
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(convId) || convId <= 0) {
    return { ok: false, status: 400, error: 'Parâmetros inválidos', conversa: null }
  }

  const { data: row, error: fetchErr } = await supabase
    .from('conversas')
    .select('id, tipo, telefone, status_atendimento')
    .eq('company_id', cid)
    .eq('id', convId)
    .maybeSingle()

  if (fetchErr) return { ok: false, status: 500, error: fetchErr.message, conversa: null }
  if (!row) return { ok: false, status: 404, error: 'Conversa não encontrada', conversa: null }

  const tipo = String(row.tipo || '').toLowerCase()
  const tel = String(row.telefone || '')
  if (tipo === 'grupo' || tel.includes('@g.us')) {
    return { ok: false, status: 400, error: 'Indisponível para conversas de grupo', conversa: null }
  }

  if (row.status_atendimento === 'em_atendimento') {
    const { data: atual } = await supabase
      .from('conversas')
      .select('*')
      .eq('company_id', cid)
      .eq('id', convId)
      .maybeSingle()
    return { ok: true, status: 200, error: null, conversa: atual, idempotent: true }
  }

  if (row.status_atendimento !== 'aguardando_cliente') {
    return {
      ok: false,
      status: 409,
      error: 'A conversa não está em aguardando cliente (manual)',
      conversa: null,
    }
  }

  const { data: updated, error: updErr } = await supabase
    .from('conversas')
    .update({
      status_atendimento: 'em_atendimento',
      aguardando_cliente_desde: null,
    })
    .eq('company_id', cid)
    .eq('id', convId)
    .eq('status_atendimento', 'aguardando_cliente')
    .select()
    .maybeSingle()

  if (updErr) return { ok: false, status: 500, error: updErr.message, conversa: null }
  if (!updated) {
    return {
      ok: false,
      status: 409,
      error: 'Não foi possível atualizar (estado da conversa pode ter mudado)',
      conversa: null,
    }
  }

  await supabase.from('historico_atendimentos').insert({
    conversa_id: convId,
    usuario_id: Number.isFinite(uid) && uid > 0 ? uid : null,
    acao: ACAO_MANUAL_RETOMAR,
    observacao: 'Conversa retirada de aguardando cliente (manual) e retornada para em atendimento',
  })

  return { ok: true, status: 200, error: null, conversa: updated, idempotent: false }
}

module.exports = {
  marcarAguardandoClienteManual,
  retomarEmAtendimentoManual,
  ACAO_MANUAL_AGUARDANDO,
  ACAO_MANUAL_RETOMAR,
}
