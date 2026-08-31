/**
 * Alertas de atendimento sem resposta — fachada estável.
 * Implementação: services/atendimentoSemResposta/
 *
 * Config: ia_config.config.alerta_sem_resposta
 * Eventos: alerta_atendimento_sem_resposta_eventos
 * Estado/idempotência: alerta_atendimento_sem_resposta_estado
 */

module.exports = require('./atendimentoSemResposta')
