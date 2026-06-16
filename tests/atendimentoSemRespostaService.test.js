const {
  normalizeAlertaSemResposta,
  validateAlertaSemResposta,
  DEFAULT_ALERTA_SEM_RESPOSTA,
  formatTempoSemResposta,
  buildGestorWhatsappText,
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
      notificar_por_email: false,
    })
    expect(err).toMatch(/canal/i)
  })

  it('preserva e aceita e-mail como canal configurado', () => {
    const cfg = normalizeAlertaSemResposta({
      notificar_por_email: true,
      notificar_interno: false,
      notificar_por_whatsapp: false,
    })
    expect(cfg.notificar_por_email).toBe(true)
    expect(validateAlertaSemResposta(cfg)).toBeNull()
  })

  it('formata tempo sem resposta', () => {
    expect(formatTempoSemResposta(15)).toBe('15min')
    expect(formatTempoSemResposta(135)).toBe('2h15min')
    expect(formatTempoSemResposta(1640)).toBe('1d 3h20min')
    expect(formatTempoSemResposta(120)).toBe('2h')
  })

  it('monta WhatsApp do gestor sem ID da conversa', () => {
    const text = buildGestorWhatsappText({
      clienteNome: 'Carlos Ferreira',
      atendenteNome: 'João',
      minutos: 15,
      cfg: { reabrir_conversa_automaticamente: true },
    })
    expect(text).toContain('🚨 ZapERP — Atendimento sem resposta')
    expect(text).toContain('Cliente: Carlos Ferreira')
    expect(text).toContain('Atendente: João')
    expect(text).toContain('Tempo sem resposta: 15min')
    expect(text).toContain('Status: conversa reaberta e liberada para novo atendimento.')
    expect(text).not.toMatch(/Conversa #/i)
  })

  it('permite tempos iguais', () => {
    const err = validateAlertaSemResposta({
      ...DEFAULT_ALERTA_SEM_RESPOSTA,
      tempo_primeiro_alerta_minutos: 10,
      tempo_alerta_critico_minutos: 10,
      tempo_notificar_gestor_minutos: 10,
    })
    expect(err).toBeNull()
  })

  it('rejeita minutos vazios, negativos ou invalidos', () => {
    expect(validateAlertaSemResposta({
      ...DEFAULT_ALERTA_SEM_RESPOSTA,
      tempo_primeiro_alerta_minutos: '',
    })).toMatch(/positivo/i)

    expect(validateAlertaSemResposta({
      ...DEFAULT_ALERTA_SEM_RESPOSTA,
      tempo_alerta_critico_minutos: -1,
    })).toMatch(/positivo/i)

    expect(validateAlertaSemResposta({
      ...DEFAULT_ALERTA_SEM_RESPOSTA,
      tempo_notificar_gestor_minutos: 'abc',
    })).toMatch(/positivo/i)
  })
})
