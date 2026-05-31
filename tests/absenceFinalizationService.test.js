const {
  ABSENCE_FALLBACK_MESSAGE,
  isAbsenceFinalizationEmergencyDisabled,
  getAbsenceConfig,
} = require('../services/absenceFinalizationService')

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

  it('mantem defaults seguros para prazo, mensagem e reabertura', () => {
    const cfg = getAbsenceConfig({
      finalizar_por_ausencia_ativo: true,
      finalizar_por_ausencia_prazo: 0,
      finalizar_por_ausencia_mensagem: '',
    })

    expect(cfg.ativo).toBe(true)
    expect(cfg.prazo).toBe(24)
    expect(cfg.mensagem).toBe(ABSENCE_FALLBACK_MESSAGE)
    expect(cfg.reabrirAutomaticamente).toBe(true)
    expect(cfg.reabrirSemChatbot).toBe(true)
  })

  it('interpreta kill switch emergencial sem alterar a regra principal da tela', () => {
    process.env.ABSENCE_FINALIZATION_EMERGENCY_DISABLED = 'true'

    const cfg = getAbsenceConfig({
      finalizar_por_ausencia_ativo: true,
    })

    expect(cfg.ativo).toBe(true)
    expect(isAbsenceFinalizationEmergencyDisabled()).toBe(true)
  })
})
