const {
  isAbsenceFinalizationEmergencyDisabled,
  getAbsenceConfig,
  outboundQualificaParaAguardandoCliente,
  buildWaitingForClientAfterOutboundPatch,
  hasAbsenceDeadlineElapsed,
} = require('../services/absenceFinalizationService')
const { validateChatbotConfig } = require('../services/chatbotTriageService')

describe('absenceFinalizationService - configuracao por empresa', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  it('ativa pela configuracao do admin sem depender de flag global ou allowlist por ENV', () => {
    delete process.env.ABSENCE_FINALIZATION_GLOBAL_ENABLED
    process.env.ABSENCE_FINALIZATION_ALLOWED_COMPANY_IDS = ''

    const cfg = getAbsenceConfig({
      finalizar_por_ausencia_ativo: true,
      finalizar_por_ausencia_prazo: 3,
      finalizar_por_ausencia_unidade: 'horas_corridas',
      finalizar_por_ausencia_mensagem: 'Encerrando por ausencia.',
    })

    expect(cfg.ativo).toBe(true)
    expect(cfg.prazo).toBe(3)
    expect(cfg.unidade).toBe('horas_corridas')
    expect(cfg.enviarMensagem).toBe(true)
    expect(cfg.mensagem).toBe('Encerrando por ausencia.')
  })

  it('permanece desligada quando o admin desativa a empresa, mesmo com ENV legado ligado', () => {
    process.env.ABSENCE_FINALIZATION_GLOBAL_ENABLED = 'true'
    process.env.ABSENCE_FINALIZATION_ALLOWED_COMPANY_IDS = '1,2,3'

    const cfg = getAbsenceConfig({
      finalizar_por_ausencia_ativo: false,
      finalizar_por_ausencia_prazo: 24,
    })

    expect(cfg.ativo).toBe(false)
  })

  it('mantem defaults seguros para prazo e reabertura, permitindo mensagem vazia', () => {
    const cfg = getAbsenceConfig({
      finalizar_por_ausencia_ativo: true,
      finalizar_por_ausencia_prazo: 0,
      finalizar_por_ausencia_mensagem: '',
    })

    expect(cfg.ativo).toBe(true)
    expect(cfg.prazo).toBe(24)
    expect(cfg.mensagem).toBe('')
    expect(cfg.enviarMensagem).toBe(false)
    expect(cfg.reabrirAutomaticamente).toBe(true)
    expect(cfg.reabrirSemChatbot).toBe(true)
  })

  it('respeita a opcao explicita de encerrar apenas no sistema sem apagar a mensagem salva', () => {
    const cfg = getAbsenceConfig({
      finalizar_por_ausencia_ativo: true,
      finalizar_por_ausencia_enviar_mensagem: false,
      finalizar_por_ausencia_mensagem: 'Texto mantido para uso futuro.',
    })

    expect(cfg.enviarMensagem).toBe(false)
    expect(cfg.mensagem).toBe('Texto mantido para uso futuro.')
  })

  it('valida e persiste a nova opcao mantendo compatibilidade com configuracoes antigas', () => {
    const explicit = validateChatbotConfig({
      enabled: false,
      finalizar_por_ausencia_enviar_mensagem: false,
      finalizar_por_ausencia_mensagem: 'Mensagem salva.',
    })
    const legacy = validateChatbotConfig({
      enabled: false,
      finalizar_por_ausencia_mensagem: 'Mensagem antiga.',
    })

    expect(explicit.finalizar_por_ausencia_enviar_mensagem).toBe(false)
    expect(explicit.finalizar_por_ausencia_mensagem).toBe('Mensagem salva.')
    expect(legacy.finalizar_por_ausencia_enviar_mensagem).toBe(true)
  })

  it('interpreta kill switch emergencial sem alterar a regra principal da tela', () => {
    process.env.ABSENCE_FINALIZATION_EMERGENCY_DISABLED = 'true'

    const cfg = getAbsenceConfig({
      finalizar_por_ausencia_ativo: true,
    })

    expect(cfg.ativo).toBe(true)
    expect(isAbsenceFinalizationEmergencyDisabled()).toBe(true)
  })

  it('permite midia enviada por atendente sem legenda marcar aguardando cliente', () => {
    expect(
      outboundQualificaParaAguardandoCliente('', 77, {}, {}, { permitirConteudoSemTexto: true })
    ).toBe(true)
    expect(outboundQualificaParaAguardandoCliente('', 77, {}, {})).toBe(false)
  })

  it('monta patch para foto enviada pelo atendente em conversa ainda aberta', () => {
    const ts = '2026-07-06T20:30:00.000Z'
    const patch = buildWaitingForClientAfterOutboundPatch(
      { status_atendimento: 'aberta', atendente_id: null },
      77,
      ts
    )

    expect(patch).toMatchObject({
      status_atendimento: 'em_atendimento',
      atendente_id: 77,
      atendente_atribuido_em: ts,
      aguardando_cliente_desde: ts,
      finalizacao_motivo: null,
      finalizada_automaticamente: false,
      finalizada_automaticamente_em: null,
    })
  })

  it('preserva atendente existente ao marcar aguardando cliente', () => {
    const ts = '2026-07-06T20:31:00.000Z'
    const patch = buildWaitingForClientAfterOutboundPatch(
      { status_atendimento: 'em_atendimento', atendente_id: 45 },
      77,
      ts
    )

    expect(patch).toMatchObject({
      aguardando_cliente_desde: ts,
      finalizacao_motivo: null,
    })
    expect(patch).not.toHaveProperty('status_atendimento')
    expect(patch).not.toHaveProperty('atendente_id')
  })

  it('nao reabre conversa fechada para aguardando cliente', () => {
    expect(
      buildWaitingForClientAfterOutboundPatch(
        { status_atendimento: 'fechada', atendente_id: 77 },
        77,
        '2026-07-06T20:32:00.000Z'
      )
    ).toBeNull()
  })

  it('horas uteis pausam durante noite e fim de semana', () => {
    const cfg = getAbsenceConfig({
      finalizar_por_ausencia_prazo: 2,
      finalizar_por_ausencia_unidade: 'horas_uteis',
      timezone: 'America/Sao_Paulo',
      horarioInicio: '09:00',
      horarioFim: '18:00',
      diasSemanaDesativados: [0, 6],
    })
    const sexta17h = '2026-08-07T20:00:00.000Z'

    expect(hasAbsenceDeadlineElapsed(sexta17h, cfg, '2026-08-10T12:59:00.000Z')).toBe(false)
    expect(hasAbsenceDeadlineElapsed(sexta17h, cfg, '2026-08-10T13:00:00.000Z')).toBe(true)
  })

  it('horas corridas continuam contando durante o fim de semana', () => {
    const cfg = getAbsenceConfig({
      finalizar_por_ausencia_prazo: 2,
      finalizar_por_ausencia_unidade: 'horas_corridas',
    })
    expect(hasAbsenceDeadlineElapsed('2026-08-07T20:00:00.000Z', cfg, '2026-08-07T22:00:00.000Z')).toBe(true)
  })
})
