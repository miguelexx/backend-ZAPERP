/**
 * Ajustes de modo simples / "aguardando cliente" aplicados ao payload de saída e recálculo do status
 * pela última mensagem (emitindo a atualização de conversa).
 * Extraído de controllers/chatController.js (Fase 6 da modularização) sem alteração de comportamento.
 */

const {
  aplicarModoSimplesNoPayload,
  recalcularStatusPorUltimaMensagem,
} = require('../../atendimentoModoSimplesService')
const { emitirConversaAtualizada } = require('../realtime/chatRealtimeGateway')

function aplicarAguardandoClienteNoPayload(payload, waitingResult, modoSimplesOpt) {
  if (!payload || !waitingResult?.marked) {
    return aplicarModoSimplesNoPayload(payload, modoSimplesOpt, modoSimplesOpt?.atendimento_modo_simples)
  }
  payload.status_atendimento = 'em_atendimento'
  payload.status_atendimento_real = 'em_atendimento'
  payload.aguardando_cliente_desde = waitingResult.aguardando_cliente_desde || new Date().toISOString()
  payload.exibir_badge_aberta = false
  payload.tem_novas_mensagens_em_atendimento = false
  return aplicarModoSimplesNoPayload(payload, modoSimplesOpt, modoSimplesOpt?.atendimento_modo_simples)
}

/** Inclui status/atendente no payload da lista após auto-assumir no envio. */
function anexarAssumirNoPayloadLista(payload, permEnvio) {
  if (!payload) return payload
  const conv = permEnvio?.conversa
  if (!conv || typeof conv !== 'object') return payload
  const status = conv.status_atendimento != null ? String(conv.status_atendimento) : ''
  if (status) {
    payload.status_atendimento = status
    payload.status_atendimento_real = conv.status_atendimento_real || status
  }
  if (Object.prototype.hasOwnProperty.call(conv, 'atendente_id')) {
    payload.atendente_id = conv.atendente_id
  }
  if (status === 'em_atendimento' || status === 'aguardando_cliente') {
    payload.exibir_badge_aberta = false
  }
  return payload
}

async function recalcularEMesclarModoSimples({
  company_id,
  conversa_id,
  mensagemNova,
  io,
  payloadBase = null,
}) {
  const result = await recalcularStatusPorUltimaMensagem({
    company_id,
    conversa_id,
    mensagemNova,
    io,
    emitirEvento: async (socket, cid, convId, recalc) => {
      if (!recalc.changed || !socket) return
      const base =
        payloadBase && typeof payloadBase === 'object'
          ? { ...payloadBase }
          : { id: convId, ultima_atividade: new Date().toISOString() }
      const eventPayload = aplicarModoSimplesNoPayload(base, recalc.conversa, true)
      emitirConversaAtualizada(socket, cid, convId, eventPayload, { skipAtualizarConversa: true })
    },
  })
  return result
}

module.exports = { aplicarAguardandoClienteNoPayload, anexarAssumirNoPayloadLista, recalcularEMesclarModoSimples }
