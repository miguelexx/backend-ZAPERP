const { isClosedAttendanceStatus } = require('../helpers/conversaHelper')

function blocksTriage(conversa) {
  if (!conversa || conversa.atendente_id != null) return true
  const status = String(conversa.status_atendimento || '').trim().toLowerCase()
  return isClosedAttendanceStatus(status) || ['em_atendimento', 'aguardando_cliente', 'aguardando_pagamento'].includes(status)
}

// Consulta sempre o banco: snapshots anteriores ao throttle podem perder uma tomada humana.
function createTriageSendGuard(sb, company_id, conversa_id, { allowDepartment = false, automaticAssignment = null, expectedDepartmentId = null } = {}) {
  const assertCanSend = async () => {
    let result
    try {
      result = await sb.from('conversas')
        .select('atendente_id, departamento_id, status_atendimento, atendente_atribuido_em')
        .eq('company_id', company_id).eq('id', conversa_id).maybeSingle()
    } catch (_) {
      result = { error: true }
    }
    // Permite somente a confirmação da distribuição feita por esta execução do bot.
    // Assumir novamente (mesmo usuário) muda atendente_atribuido_em e cancela o envio.
    const ownAssignment = allowDepartment && automaticAssignment?.atendente_id != null &&
      automaticAssignment.atendente_atribuido_em &&
      result?.data?.status_atendimento === 'em_atendimento' &&
      String(result.data.atendente_id) === String(automaticAssignment.atendente_id) &&
      String(result.data.departamento_id) === String(automaticAssignment.departamento_id) &&
      Date.parse(result.data.atendente_atribuido_em) === Date.parse(automaticAssignment.atendente_atribuido_em)
    const departmentChanged = expectedDepartmentId != null && String(result?.data?.departamento_id) !== String(expectedDepartmentId)
    if (!result || result.error || departmentChanged || (!ownAssignment && blocksTriage(result.data)) || (!allowDepartment && result.data.departamento_id != null)) {
      assertCanSend.cancelled = true
      const error = new Error('Triagem cancelada: conversa indisponível ou atendimento humano iniciado/encerrado')
      error.code = 'TRIAGE_CANCELLED'
      throw error
    }
  }
  return assertCanSend
}

module.exports = { blocksTriage, createTriageSendGuard }
