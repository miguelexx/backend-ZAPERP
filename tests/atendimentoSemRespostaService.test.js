const {
  normalizeAlertaSemResposta,
  validateAlertaSemResposta,
  DEFAULT_ALERTA_SEM_RESPOSTA,
} = require('../services/atendimentoSemRespostaService')

describe('atendimentoSemRespostaService', () => {
  it('normaliza defaults', () => {
    const cfg = normalizeAlertaSemResposta({})
    expect(cfg.alerta_sem_resposta_ativo).toBe(false)
    expect(cfg.tempo_primeiro_alerta_minutos).toBe(2)
    expect(cfg.tempo_alerta_critico_minutos).toBe(10)
    expect(cfg.tempo_notificar_gestor_minutos).toBe(15)
    expect(cfg.notificar_interno).toBe(true)
  })

  it('valida ordem dos tempos', () => {
    const err = validateAlertaSemResposta({
      ...DEFAULT_ALERTA_SEM_RESPOSTA,
      tempo_primeiro_alerta_minutos: 10,
      tempo_alerta_critico_minutos: 5,
    })
    expect(err).toMatch(/crítico/i)
  })

  it('exige canal de notificação', () => {
    const err = validateAlertaSemResposta({
      ...DEFAULT_ALERTA_SEM_RESPOSTA,
      notificar_interno: false,
      notificar_por_whatsapp: false,
    })
    expect(err).toMatch(/canal/i)
  })
})
