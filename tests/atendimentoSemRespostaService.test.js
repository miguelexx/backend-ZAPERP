const {
  normalizeAlertaSemResposta,
  validateAlertaSemResposta,
  DEFAULT_ALERTA_SEM_RESPOSTA,
  formatTempoSemResposta,
  buildGestorWhatsappText,
  normalizeBusinessSchedule,
  isBusinessTime,
  businessMinutesBetween,
  resolveAlertaSemRespostaCycleAnchor,
  buildAlertaSemRespostaResetPatch,
} = require('../services/atendimentoSemRespostaService')

describe('atendimentoSemRespostaService', () => {
  it('normaliza defaults', () => {
    const cfg = normalizeAlertaSemResposta({})
    expect(cfg.alerta_sem_resposta_ativo).toBe(false)
    expect(cfg.tempo_primeiro_alerta_minutos).toBe(2)
    expect(cfg.tempo_alerta_critico_minutos).toBe(10)
    expect(cfg.tempo_notificar_gestor_minutos).toBe(15)
    expect(cfg.notificar_interno).toBe(true)
    expect(cfg.horario_comercial_ativo).toBe(true)
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

  describe('contador por horario comercial', () => {
    const cfg = { ...DEFAULT_ALERTA_SEM_RESPOSTA, horario_comercial_ativo: true }
    const fullConfig = {
      chatbot_triage: {
        horarioInicio: '09:00',
        horarioFim: '18:00',
        timezone: 'America/Sao_Paulo',
        diasSemanaDesativados: [0, 6],
      },
    }

    it('conta minutos dentro do mesmo expediente', () => {
      const schedule = normalizeBusinessSchedule(cfg, fullConfig)
      const minutes = businessMinutesBetween(
        '2026-06-15T12:00:00.000Z',
        new Date('2026-06-15T12:10:00.000Z'),
        schedule
      )
      expect(minutes).toBe(10)
    })

    it('pausa no fechamento e continua no proximo expediente', () => {
      const schedule = normalizeBusinessSchedule(cfg, fullConfig)
      const minutes = businessMinutesBetween(
        '2026-06-15T20:55:00.000Z',
        new Date('2026-06-16T12:05:00.000Z'),
        schedule
      )
      expect(minutes).toBe(10)
    })

    it('mensagem fora do horario comeca a contar no proximo expediente', () => {
      const schedule = normalizeBusinessSchedule(cfg, fullConfig)
      const minutes = businessMinutesBetween(
        '2026-06-15T23:00:00.000Z',
        new Date('2026-06-16T12:05:00.000Z'),
        schedule
      )
      expect(minutes).toBe(5)
    })

    it('job fora do horario nao pode disparar acoes', () => {
      const schedule = normalizeBusinessSchedule(cfg, fullConfig)
      expect(isBusinessTime(new Date('2026-06-15T21:01:00.000Z'), schedule)).toBe(false)
    })

    it('respeita pausa/almoco via janelas multiplas', () => {
      const schedule = normalizeBusinessSchedule(cfg, {
        chatbot_triage: {
          timezone: 'America/Sao_Paulo',
          diasSemanaDesativados: [0, 6],
          horariosJanelas: [
            { inicio: '09:00', fim: '12:00' },
            { inicio: '13:00', fim: '18:00' },
          ],
        },
      })
      const minutes = businessMinutesBetween(
        '2026-06-15T14:50:00.000Z',
        new Date('2026-06-15T16:10:00.000Z'),
        schedule
      )
      expect(minutes).toBe(20)
    })

    it('empresas com horarios diferentes nao se misturam', () => {
      const companyA = normalizeBusinessSchedule(cfg, {
        chatbot_triage: { timezone: 'America/Sao_Paulo', horarioInicio: '09:00', horarioFim: '18:00', diasSemanaDesativados: [0, 6] },
      })
      const companyB = normalizeBusinessSchedule(cfg, {
        chatbot_triage: { timezone: 'America/Sao_Paulo', horarioInicio: '13:00', horarioFim: '17:00', diasSemanaDesativados: [0, 6] },
      })
      const start = '2026-06-15T12:00:00.000Z'
      const end = new Date('2026-06-15T13:00:00.000Z')
      expect(businessMinutesBetween(start, end, companyA)).toBe(60)
      expect(businessMinutesBetween(start, end, companyB)).toBe(0)
    })

    it('mantem comportamento atual quando horario comercial foi explicitamente desativado', () => {
      const schedule = normalizeBusinessSchedule({ ...cfg, horario_comercial_ativo: false }, fullConfig)
      expect(businessMinutesBetween('2026-06-15T20:55:00.000Z', new Date('2026-06-15T21:05:00.000Z'), schedule)).toBe(10)
    })
  })

  describe('reset de ciclo ao assumir conversa reaberta', () => {
    it('usa o momento da assuncao quando a conversa veio de reabertura automatica', () => {
      const anchor = resolveAlertaSemRespostaCycleAnchor({
        ultima: { criado_em: '2026-06-15T12:00:00.000Z', direcao: 'in' },
        estado: { ultimo_cliente_msg_em: '2026-06-15T13:00:00.000Z' },
        conv: { atendente_atribuido_em: '2026-06-15T13:00:00.000Z' },
      })
      expect(anchor).toBe('2026-06-15T13:00:00.000Z')
    })

    it('nao consome o prazo antigo logo apos assumir', () => {
      const schedule = normalizeBusinessSchedule({ ...DEFAULT_ALERTA_SEM_RESPOSTA, horario_comercial_ativo: false }, {})
      const anchor = resolveAlertaSemRespostaCycleAnchor({
        ultima: { criado_em: '2026-06-15T12:00:00.000Z', direcao: 'in' },
        estado: { ultimo_cliente_msg_em: '2026-06-15T13:00:00.000Z' },
        conv: { atendente_atribuido_em: '2026-06-15T13:00:00.000Z' },
      })
      expect(businessMinutesBetween(anchor, new Date('2026-06-15T13:01:00.000Z'), schedule)).toBe(1)
    })

    it('primeiro alerta so vence apos o prazo completo da assuncao', () => {
      const schedule = normalizeBusinessSchedule({ ...DEFAULT_ALERTA_SEM_RESPOSTA, horario_comercial_ativo: false }, {})
      const anchor = '2026-06-15T13:00:00.000Z'
      expect(businessMinutesBetween(anchor, new Date('2026-06-15T13:09:00.000Z'), schedule)).toBe(9)
      expect(businessMinutesBetween(anchor, new Date('2026-06-15T13:10:00.000Z'), schedule)).toBe(10)
    })

    it('nova mensagem do cliente apos assuncao inicia novo ciclo pela mensagem', () => {
      const anchor = resolveAlertaSemRespostaCycleAnchor({
        ultima: { criado_em: '2026-06-15T13:05:00.000Z', direcao: 'in' },
        estado: { ultimo_cliente_msg_em: '2026-06-15T13:00:00.000Z' },
        conv: { atendente_atribuido_em: '2026-06-15T13:00:00.000Z' },
      })
      expect(anchor).toBe('2026-06-15T13:05:00.000Z')
    })

    it('atendimento normal continua usando a ultima mensagem do cliente', () => {
      const anchor = resolveAlertaSemRespostaCycleAnchor({
        ultima: { criado_em: '2026-06-15T12:00:00.000Z', direcao: 'in' },
        estado: {},
        conv: { atendente_atribuido_em: '2026-06-15T11:00:00.000Z' },
      })
      expect(anchor).toBe('2026-06-15T12:00:00.000Z')
    })

    it('zera os campos do ciclo antigo sem apagar historico/eventos', () => {
      expect(buildAlertaSemRespostaResetPatch('2026-06-15T13:00:00.000Z')).toEqual({
        ultimo_cliente_msg_em: '2026-06-15T13:00:00.000Z',
        primeiro_alerta_em: null,
        alerta_critico_em: null,
        gestor_notificado_em: null,
        reaberta_em: null,
      })
    })

    it('assuncao fora do horario so comeca a contar no proximo expediente', () => {
      const schedule = normalizeBusinessSchedule(
        { ...DEFAULT_ALERTA_SEM_RESPOSTA, horario_comercial_ativo: true },
        {
          chatbot_triage: {
            horarioInicio: '09:00',
            horarioFim: '18:00',
            timezone: 'America/Sao_Paulo',
            diasSemanaDesativados: [0, 6],
          },
        }
      )
      const anchor = resolveAlertaSemRespostaCycleAnchor({
        ultima: { criado_em: '2026-06-15T20:55:00.000Z', direcao: 'in' },
        estado: { ultimo_cliente_msg_em: '2026-06-15T22:30:00.000Z' },
        conv: { atendente_atribuido_em: '2026-06-15T22:30:00.000Z' },
      })

      expect(anchor).toBe('2026-06-15T22:30:00.000Z')
      expect(isBusinessTime(new Date('2026-06-15T22:31:00.000Z'), schedule)).toBe(false)
      expect(businessMinutesBetween(anchor, new Date('2026-06-15T23:30:00.000Z'), schedule)).toBe(0)
      expect(businessMinutesBetween(anchor, new Date('2026-06-16T12:05:00.000Z'), schedule)).toBe(5)
    })

    it('nao dispara antes do prazo util e permite apos completar prazo util', () => {
      const schedule = normalizeBusinessSchedule(
        { ...DEFAULT_ALERTA_SEM_RESPOSTA, horario_comercial_ativo: true },
        {
          chatbot_triage: {
            horarioInicio: '09:00',
            horarioFim: '18:00',
            timezone: 'America/Sao_Paulo',
            diasSemanaDesativados: [0, 6],
          },
        }
      )
      const anchor = '2026-06-15T22:30:00.000Z'

      expect(businessMinutesBetween(anchor, new Date('2026-06-16T12:09:00.000Z'), schedule)).toBe(9)
      expect(businessMinutesBetween(anchor, new Date('2026-06-16T12:10:00.000Z'), schedule)).toBe(10)
    })

    it('nova mensagem apos assuncao fora do horario vira ancora e tambem respeita expediente', () => {
      const schedule = normalizeBusinessSchedule(
        { ...DEFAULT_ALERTA_SEM_RESPOSTA, horario_comercial_ativo: true },
        {
          chatbot_triage: {
            horarioInicio: '09:00',
            horarioFim: '18:00',
            timezone: 'America/Sao_Paulo',
            diasSemanaDesativados: [0, 6],
          },
        }
      )
      const anchor = resolveAlertaSemRespostaCycleAnchor({
        ultima: { criado_em: '2026-06-16T11:59:00.000Z', direcao: 'in' },
        estado: { ultimo_cliente_msg_em: '2026-06-15T22:30:00.000Z' },
        conv: { atendente_atribuido_em: '2026-06-15T22:30:00.000Z' },
      })

      expect(anchor).toBe('2026-06-16T11:59:00.000Z')
      expect(businessMinutesBetween(anchor, new Date('2026-06-16T12:05:00.000Z'), schedule)).toBe(5)
    })
  })
})
