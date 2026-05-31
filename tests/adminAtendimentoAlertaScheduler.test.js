describe('adminAtendimentoAlertaScheduler', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    jest.useFakeTimers()
    process.env = { ...ORIGINAL_ENV }
  })

  afterEach(() => {
    jest.useRealTimers()
    process.env = ORIGINAL_ENV
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('nao usa ADMIN_ATENDIMENTO_ALERTA_SCHEDULER_ENABLED como bloqueio de liberacao', () => {
    process.env.ADMIN_ATENDIMENTO_ALERTA_SCHEDULER_ENABLED = '0'
    const runAdminAtendimentoAlertaForAllCompanies = jest.fn().mockResolvedValue({ ok: true, processadas: 0, enviadas: 0 })
    const setIntervalSpy = jest.spyOn(global, 'setInterval')

    jest.doMock('../services/adminAtendimentoAlertaService', () => ({
      runAdminAtendimentoAlertaForAllCompanies,
    }))

    const { startAdminAtendimentoAlertaScheduler } = require('../services/adminAtendimentoAlertaScheduler')
    startAdminAtendimentoAlertaScheduler()

    expect(setIntervalSpy).toHaveBeenCalled()
  })
})
