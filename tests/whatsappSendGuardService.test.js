describe('whatsappSendGuardService', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...OLD_ENV }
    delete process.env.WHATSAPP_SEND_GUARD_MODE
    delete process.env.WHATSAPP_SEND_GUARD_AUTOMATION_INTERVAL_MS
  })

  afterAll(() => {
    process.env = OLD_ENV
  })

  test('usa modo monitor por padrao e nao aplica delay/bloqueio', async () => {
    const guard = require('../services/whatsappSendGuardService')
    const result = await guard.beforeWhatsAppSend({
      companyId: 1,
      endpoint: '/messages/chat',
      body: { to: '+5534999999999', body: 'Ola' },
      meta: { origin: 'chatbot_triage', type: 'text' },
    })

    expect(result.allow).toBe(true)
    expect(result.mode).toBe('monitor')
    expect(result.delayMs).toBe(0)
    expect(result.ctx.origem_tipo).toBe('automation')
    expect(result.ctx.risco).toBe('medium')
  })

  test('identifica atendimento humano como baixo risco', () => {
    const guard = require('../services/whatsappSendGuardService')

    expect(guard.inferOriginKind('atendimento_humano')).toBe('human')
    expect(guard.inferOriginKind('regra_automatica')).toBe('automation')
    expect(guard.inferOriginKind('campanha_promocional')).toBe('campaign')
  })

  test('modo off ignora endpoints de envio sem bloquear', async () => {
    process.env.WHATSAPP_SEND_GUARD_MODE = 'off'
    const guard = require('../services/whatsappSendGuardService')

    const result = await guard.beforeWhatsAppSend({
      companyId: 1,
      endpoint: '/messages/chat',
      body: { to: '+5534999999999', body: 'Ola' },
    })

    expect(result.allow).toBe(true)
    expect(result.mode).toBe('off')
    expect(result.delayMs).toBe(0)
  })
})
