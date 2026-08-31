const supabase = require('../../config/supabase')
const { markReabertaFaltaInteracao } = require('../../helpers/reabertaFaltaInteracaoHelper')

async function reabrirConversa(company_id, conversa_id) {
  const reabertaEm = new Date().toISOString()
  const baseUpdate = {
    status_atendimento: 'aberta',
    atendente_id: null,
    atendente_atribuido_em: null,
  }

  let { data, error } = await supabase
    .from('conversas')
    .update({ ...baseUpdate, reaberta_falta_interacao_em: reabertaEm })
    .eq('company_id', company_id)
    .eq('id', conversa_id)
    .in('status_atendimento', ['em_atendimento', 'aguardando_cliente'])
    .select('id')
    .maybeSingle()

  if (error && String(error.message || '').includes('reaberta_falta_interacao_em')) {
    ;({ data, error } = await supabase
      .from('conversas')
      .update(baseUpdate)
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .in('status_atendimento', ['em_atendimento', 'aguardando_cliente'])
      .select('id')
      .maybeSingle())
  }

  if (error) return { ok: false, error: error.message }

  if (!data?.id) {
    ;({ data, error } = await supabase
      .from('conversas')
      .update({ ...baseUpdate, reaberta_falta_interacao_em: reabertaEm })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .eq('status_atendimento', 'aberta')
      .is('atendente_id', null)
      .select('id')
      .maybeSingle())

    if (error && String(error.message || '').includes('reaberta_falta_interacao_em')) {
      ;({ data, error } = await supabase
        .from('conversas')
        .update(baseUpdate)
        .eq('company_id', company_id)
        .eq('id', conversa_id)
        .eq('status_atendimento', 'aberta')
        .is('atendente_id', null)
        .select('id')
        .maybeSingle())
    }
    if (error) return { ok: false, error: error.message }
    if (!data?.id) return { ok: false, error: 'conversa_nao_atualizada' }
  }

  await markReabertaFaltaInteracao(company_id, conversa_id, reabertaEm, reabertaEm)
  await supabase.from('historico_atendimentos').insert({
    conversa_id,
    usuario_id: null,
    acao: 'alerta_sem_resposta_reabertura',
    observacao: 'Conversa reaberta automaticamente por falta de resposta do atendente',
  }).catch(() => {})
  return { ok: true, reaberta_em: reabertaEm }
}

module.exports = {
  reabrirConversa,
}
