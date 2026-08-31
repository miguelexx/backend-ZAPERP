/**
 * Alertas de atendimento sem resposta.
 * Fachada pública — implementação em ./atendimentoSemResposta/*.
 * Eventos: alerta_atendimento_sem_resposta_eventos
 * Estado/idempotência por conversa: alerta_atendimento_sem_resposta_estado
 * Config: ia_config.config.alerta_sem_resposta
 */

const { clearReabertaFaltaInteracao } = require('../../helpers/reabertaFaltaInteracaoHelper')
const {
  mergeScheduleSource,
  alertConfigHasOwnSchedule,
  normalizeBusinessSchedule,
  isBusinessTime,
  businessMinutesBetween,
  describeBusinessSchedule,
} = require('../../helpers/businessSchedule')
const { DEFAULT_ALERTA_SEM_RESPOSTA } = require('./constants')
const {
  resolveAlertaRuntimeConfig,
  normalizeAlertaSemResposta,
  validateAlertaSemResposta,
  getAlertaSemRespostaConfig,
  getAlertaSemRespostaConfigForApi,
  saveAlertaSemRespostaConfig,
  getBusinessScheduleInfo,
} = require('./config')
const {
  listAlertaSemRespostaEventos,
  clearEstado,
  resetAlertaSemRespostaAoAssumirReaberta,
} = require('./stateStore')
const { buildAlertaSemRespostaResetPatch, resolveAlertaSemRespostaCycleAnchor } = require('./cycle')
const {
  emitAlertaRealtime,
  resolveGestorWhatsappDestination,
  sendGestorWhatsapp,
  formatTempoSemResposta,
  buildGestorWhatsappText,
} = require('./notifications')
const {
  processCompanyAtendimentoSemResposta,
  runAtendimentoSemRespostaForAllCompanies,
} = require('./processor')

module.exports = {
  DEFAULT_ALERTA_SEM_RESPOSTA,
  normalizeAlertaSemResposta,
  validateAlertaSemResposta,
  getAlertaSemRespostaConfig,
  getAlertaSemRespostaConfigForApi,
  resolveAlertaRuntimeConfig,
  mergeScheduleSource,
  alertConfigHasOwnSchedule,
  saveAlertaSemRespostaConfig,
  listAlertaSemRespostaEventos,
  processCompanyAtendimentoSemResposta,
  runAtendimentoSemRespostaForAllCompanies,
  emitAlertaRealtime,
  clearEstado,
  clearReabertaFaltaInteracao,
  resetAlertaSemRespostaAoAssumirReaberta,
  buildAlertaSemRespostaResetPatch,
  normalizeBusinessSchedule,
  isBusinessTime,
  businessMinutesBetween,
  describeBusinessSchedule,
  getBusinessScheduleInfo,
  resolveAlertaSemRespostaCycleAnchor,
  resolveGestorWhatsappDestination,
  sendGestorWhatsapp,
  formatTempoSemResposta,
  buildGestorWhatsappText,
}
