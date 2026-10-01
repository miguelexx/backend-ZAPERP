const supabase = require('../config/supabase')
const { isGroupConversation, isClosedAttendanceStatus } = require('../helpers/conversaHelper')
const { registrarAtendimento } = require('./atendimentosRegistroService')
const { clearReabertaFaltaInteracao } = require('../helpers/reabertaFaltaInteracaoHelper')
const { resetAlertaSemRespostaAoAssumirReaberta } = require('./atendimentoSemRespostaService')

/**
 * Mesma regra de POST /chats/:id/assumir — atualiza conversa e registra atendimento.
 * Emissões Socket.io ficam no caller (chatController ou clienteController).
 */
async function executarAssumirConversa({
  company_id,
  conversa_id,
  user_id,
  perfil,
  departamento_ids = [],
  observacao = null,
  /** true (rota POST /chats/:id/assumir): conversa encerrada responde 409 — reabrir é ação
   *  explícita (Reabrir / nova mensagem do cliente), não um clique de Assumir em tela defasada.
   *  false (fluxos internos, ex.: "Conversar" no cartão do cliente): mantém o comportamento
   *  de retomar a conversa encerrada como em_atendimento. */
  bloquearEncerrada = false
}) {
  const isAdmin = perfil === 'admin'

  const { data: atual, error: errAtual } = await supabase
    .from('conversas')
    .select('id, atendente_id, departamento_id, tipo, telefone, status_atendimento, reaberta_falta_interacao_em')
    .eq('company_id', company_id)
    .eq('id', conversa_id)
    .single()

  if (errAtual) return { ok: false, status: 500, error: errAtual.message, conversa: null }
  if (!atual) return { ok: false, status: 404, error: 'Conversa não encontrada', conversa: null }

  if (isGroupConversation(atual)) {
    return { ok: false, status: 400, error: 'Grupos são apenas visuais. Não é possível assumir conversa de grupo.', conversa: null }
  }

  if (bloquearEncerrada && isClosedAttendanceStatus(atual.status_atendimento)) {
    return { ok: false, status: 409, error: 'Esta conversa já foi finalizada. Use "Reabrir" para voltar a atendê-la.', conversa: null }
  }

  if (!isAdmin) {
    const convDep = atual.departamento_id ?? null
    const depIds = Array.isArray(departamento_ids) ? departamento_ids : []
    if (depIds.length === 0 && convDep != null) {
      return { ok: false, status: 403, error: 'Conversa pertence a um setor; atribua-se a um setor para assumir', conversa: null }
    }
    if (convDep != null && !depIds.some((d) => Number(d) === Number(convDep))) {
      return { ok: false, status: 403, error: 'Conversa de outro setor', conversa: null }
    }
  }

  if (atual.atendente_id && Number(atual.atendente_id) !== Number(user_id)) {
    return { ok: false, status: 409, error: 'Conversa já está em atendimento por outro usuário', conversa: null }
  }

  const { data: emp } = await supabase.from('empresas').select('limite_chats_por_atendente').eq('id', company_id).single()
  const limite = Number(emp?.limite_chats_por_atendente ?? 0)
  if (limite > 0) {
    const { count } = await supabase
      .from('conversas')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', company_id)
      .eq('atendente_id', user_id)
      .in('status_atendimento', ['em_atendimento', 'aguardando_cliente'])
    if (count >= limite) {
      return {
        ok: false,
        status: 409,
        error: `Limite de ${limite} conversas simultâneas atingido. Encerre uma antes de assumir outra.`,
        conversa: null
      }
    }
  }

  const assumidaEm = new Date().toISOString()

  await resetAlertaSemRespostaAoAssumirReaberta(company_id, conversa_id, assumidaEm, {
    reaberta_falta_interacao_em: atual.reaberta_falta_interacao_em,
  })

  let updateQuery = supabase
    .from('conversas')
    .update({
      atendente_id: user_id,
      status_atendimento: 'em_atendimento',
      lida: true,
      atendente_atribuido_em: assumidaEm,
      reaberta_falta_interacao_em: null,
    })
    .eq('company_id', company_id)
    .eq('id', conversa_id)

  if (atual.atendente_id == null) {
    updateQuery = updateQuery.is('atendente_id', null)
  } else {
    updateQuery = updateQuery.eq('atendente_id', user_id)
  }

  const { data, error } = await updateQuery
    .select()
    .maybeSingle()

  if (error) return { ok: false, status: 500, error: error.message, conversa: null }
  if (!data) {
    const { data: depois, error: errDepois } = await supabase
      .from('conversas')
      .select()
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()

    if (errDepois) return { ok: false, status: 500, error: errDepois.message, conversa: null }
    if (depois?.atendente_id && Number(depois.atendente_id) === Number(user_id)) {
      return { ok: true, status: 200, error: null, conversa: depois, already_assigned: true }
    }
    if (depois?.atendente_id) {
      return { ok: false, status: 409, error: 'Conversa ja esta em atendimento por outro usuario', conversa: null }
    }
    return { ok: false, status: 409, error: 'Nao foi possivel assumir a conversa. Tente novamente.', conversa: null }
  }

  await clearReabertaFaltaInteracao(company_id, conversa_id)

  const resultAt = await registrarAtendimento({
    conversa_id,
    company_id,
    acao: 'assumiu',
    de_usuario_id: user_id,
    para_usuario_id: user_id,
    observacao
  })
  if (resultAt.error) return { ok: false, status: 500, error: resultAt.error.message, conversa: null }

  return { ok: true, status: 200, error: null, conversa: data, atendimento: resultAt.atendimento }
}

module.exports = { executarAssumirConversa }
