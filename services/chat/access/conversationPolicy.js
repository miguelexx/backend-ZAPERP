/**
 * Política de acesso canônica de conversas: quem pode VER (`assertPermissaoConversa`) e quem pode
 * ENVIAR (`assertPodeEnviarMensagem`), incluindo auto-assumir no primeiro envio e regras de perfil.
 *
 * Extraído de controllers/chatController.js (Fase 3 da modularização) sem alteração de comportamento.
 * Regras especiais preservadas: admin/supervisor/atendente, responsável, participante ativo, quem
 * transferiu, grupos por departamento, conversa encerrada (exige reabertura para enviar) e modo simples.
 * Todas as consultas continuam limitadas por `company_id`.
 */

const supabase = require('../../../config/supabase')
const { isGroupConversation, isClosedAttendanceStatus } = require('../../../helpers/conversaHelper')
const { usuarioPodeVerGrupo } = require('../../../helpers/departamentoGruposHelper')
const { empresaModoSimplesAtivo } = require('../../../helpers/empresaModoSimplesFlag')
const { executarAssumirConversa } = require('../../conversaAssumirInternoService')
const { usuarioParticipaAtivamenteDaConversa } = require('./conversationVisibilityService')
const {
  emitirRealtimeAposAssumir,
  emitirMovimentacaoInternaAtendimento,
} = require('../realtime/chatRealtimeGateway')

async function assertPermissaoConversa({ company_id, conversa_id, user_id, role, user_dep_ids }) {
  const { data: conv, error } = await supabase
    .from('conversas')
    .select('id, atendente_id, departamento_id, tipo, telefone, status_atendimento')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!conv) return { ok: false, status: 404, error: 'Conversa não encontrada' }

  const isGroup = isGroupConversation(conv)
  const r = String(role || '').toLowerCase()
  const isAssignedToUser = conv.atendente_id && Number(conv.atendente_id) === Number(user_id)
  const depIds = Array.isArray(user_dep_ids) ? user_dep_ids : []

  // REGRA PRINCIPAL: Se a conversa está assumida pelo usuário, SEMPRE permitir acesso total
  if (!isGroup && isAssignedToUser) return { ok: true, conv, reason: 'conversa_assumida_pelo_usuario' }
  if (!isGroup && conv.atendente_id && await usuarioParticipaAtivamenteDaConversa(company_id, conversa_id, user_id)) {
    return { ok: true, conv, reason: 'usuario_participante_conversa' }
  }
  if (r === 'admin') return { ok: true, conv }

  // EXCEÇÃO: usuário transferiu a conversa para outro — vê independente do setor
  const { data: transferRow } = await supabase
    .from('atendimentos')
    .select('id')
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))
    .eq('de_usuario_id', Number(user_id))
    .eq('acao', 'transferiu')
    .limit(1)
    .maybeSingle()
  if (!isGroup && transferRow) return { ok: true, conv, reason: 'usuario_transferiu_conversa' }

  // Encerrada: qualquer atendente/supervisor pode reabrir (ex.: quem finalizou em outro setor).
  if (!isGroup && (r === 'supervisor' || r === 'atendente') && isClosedAttendanceStatus(conv.status_atendimento)) {
    return { ok: true, conv, reason: 'conversa_encerrada_reabertura' }
  }

  // supervisor e atendente: conversas sem setor visíveis para TODOS; com setor só se usuário pertence
  if (r === 'supervisor' || r === 'atendente') {
    if (isGroup) {
      const podeVerGrupo = await usuarioPodeVerGrupo({
        company_id,
        conversa_id,
        role,
        departamento_ids: depIds,
      })
      if (!podeVerGrupo) {
        return { ok: false, status: 403, error: 'Grupo nao vinculado ao seu setor' }
      }
    } else {
      const convDep = conv.departamento_id ?? null
      const userSemSetor = depIds.length === 0
      if (userSemSetor && convDep != null) return { ok: false, status: 403, error: 'Conversa de outro setor' }
      if (convDep != null && !depIds.some((id) => Number(id) === Number(convDep))) return { ok: false, status: 403, error: 'Conversa de outro setor' }
    }
    return { ok: true, conv }
  }

  return { ok: true, conv }
}

/**
 * Verifica se o usuário pode ENVIAR mensagens na conversa.
 * - Grupos: qualquer usuário pode enviar sem assumir.
 * - Demais conversas: só quem assumiu (atendente_id === user_id), inclusive admin.
 * - Quando habilitado pelo caller, conversa sem atendente pode ser assumida
 *   automaticamente no primeiro envio manual, respeitando setor/perfil/limite.
 */
function podeAssumirConversaPorPerfil(role) {
  const r = String(role || '').toLowerCase()
  return r === 'admin' || r === 'supervisor' || r === 'atendente'
}

async function assertPodeEnviarMensagem({
  company_id,
  conversa_id,
  user_id,
  role = null,
  user_dep_ids = [],
  autoAssumirUra = false,
  autoAssumirAoEnviar = false,
  io = null,
}) {
  const { data: conv, error } = await supabase
    .from('conversas')
    .select('id, atendente_id, departamento_id, tipo, telefone, status_atendimento, whatsapp_instance_id')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!conv) return { ok: false, status: 404, error: 'Conversa não encontrada' }

  if (isGroupConversation(conv)) {
    const podeVerGrupo = await usuarioPodeVerGrupo({
      company_id,
      conversa_id,
      role,
      departamento_ids: user_dep_ids,
    })
    if (!podeVerGrupo) {
      return { ok: false, status: 403, error: 'Grupo nao vinculado ao seu setor' }
    }
    return { ok: true, reason: 'grupo_sem_exigir_assumir' }
  }

  if (isClosedAttendanceStatus(conv.status_atendimento)) {
    return {
      ok: false,
      status: 409,
      error: 'Reabra a conversa antes de enviar mensagens.',
    }
  }

  const isAssignedToUser = conv.atendente_id && Number(conv.atendente_id) === Number(user_id)
  if (isAssignedToUser) {
    const statusAtual = String(conv.status_atendimento || '').toLowerCase()
    if (autoAssumirAoEnviar && statusAtual === 'aberta') {
      const result = await executarAssumirConversa({
        company_id,
        conversa_id,
        user_id,
        perfil: role,
        departamento_ids: user_dep_ids,
        observacao: 'Conversa assumida automaticamente no primeiro envio manual.'
      })
      if (result.ok && result.conversa) {
        if (io) {
          emitirRealtimeAposAssumir(io, company_id, conversa_id, user_id, result.conversa)
          if (result.atendimento) {
            await emitirMovimentacaoInternaAtendimento(io, {
              company_id,
              conversa: result.conversa,
              atendimento: result.atendimento,
            })
          }
        }
        return {
          ok: true,
          reason: 'promovida_aberta_ao_enviar',
          conversa: result.conversa,
        }
      }
    }
    return { ok: true, reason: 'conversa_assumida_pelo_usuario', conversa: conv }
  }

  if (conv.atendente_id && await usuarioParticipaAtivamenteDaConversa(company_id, conversa_id, user_id)) {
    return { ok: true, reason: 'usuario_participante_conversa' }
  }

  if (!conv.atendente_id) {
    const modoSimplesAtivo = await empresaModoSimplesAtivo(company_id)
    const deveAutoAssumir = autoAssumirAoEnviar || autoAssumirUra
    if (modoSimplesAtivo && !deveAutoAssumir) {
      const permVer = await assertPermissaoConversa({
        company_id,
        conversa_id,
        user_id,
        role,
        user_dep_ids,
      })
      if (permVer.ok) {
        return { ok: true, reason: 'modo_simples_sem_assumir', conversa: permVer.conv, modo_simples: true }
      }
      return { ok: false, status: permVer.status || 403, error: permVer.error || 'Sem permissão para esta conversa' }
    }
    if (deveAutoAssumir) {
      if (!podeAssumirConversaPorPerfil(role)) {
        return { ok: false, status: 403, error: 'Seu perfil não permite assumir conversas' }
      }
      const result = await executarAssumirConversa({
        company_id,
        conversa_id,
        user_id,
        perfil: role,
        departamento_ids: user_dep_ids,
        observacao: 'Conversa assumida automaticamente no primeiro envio manual.'
      })
      if (!result.ok) return { ok: false, status: result.status, error: result.error }

      if (io) {
        emitirRealtimeAposAssumir(io, company_id, conversa_id, user_id, result.conversa)
        if (result.atendimento) {
          await emitirMovimentacaoInternaAtendimento(io, {
            company_id,
            conversa: result.conversa,
            atendimento: result.atendimento,
          })
        }
      }

      return {
        ok: true,
        reason: result.already_assigned ? 'auto_assumida_ja_estava_com_usuario' : 'auto_assumida_envio_manual',
        conversa: result.conversa,
      }
    }
    return { ok: false, status: 403, error: 'Assuma a conversa antes de enviar mensagens' }
  }

  return {
    ok: false,
    status: 403,
    error: 'Esta conversa está com outro atendente. Assuma a conversa para enviar mensagens.',
  }
}

module.exports = {
  assertPermissaoConversa,
  podeAssumirConversaPorPerfil,
  assertPodeEnviarMensagem,
}
