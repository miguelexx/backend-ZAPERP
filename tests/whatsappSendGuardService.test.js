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

  describe('espacamento por instancia (numero) e nao por empresa', () => {
    function envioAutomacao(guard, { companyId, whatsappInstanceId }) {
      return guard.beforeWhatsAppSend({
        companyId,
        whatsappInstanceId,
        endpoint: '/messages/chat',
        body: { to: '+5534999999999', body: 'Ola' },
        meta: { origin: 'regra_automatica', type: 'text' },
      })
    }

    test('a instancia resolvida chega ao contexto da guarda', async () => {
      const guard = require('../services/whatsappSendGuardService')
      const result = await guard.beforeWhatsAppSend({
        companyId: 10,
        whatsappInstanceId: 7,
        endpoint: '/messages/chat',
        body: { to: '+5534999999999', body: 'Ola' },
        meta: { origin: 'atendimento_humano', type: 'text' },
      })

      expect(result.ctx.whatsapp_instance_id).toBe(7)
    })

    test('instancias diferentes da mesma empresa nao se atrasam entre si', async () => {
      process.env.WHATSAPP_SEND_GUARD_MODE = 'soft'
      process.env.WHATSAPP_SEND_GUARD_AUTOMATION_INTERVAL_MS = '1500'
      const guard = require('../services/whatsappSendGuardService')

      const primeiro = await envioAutomacao(guard, { companyId: 10, whatsappInstanceId: 1 })
      const outroNumero = await envioAutomacao(guard, { companyId: 10, whatsappInstanceId: 2 })

      expect(primeiro.delayMs).toBe(0)
      expect(outroNumero.delayMs).toBe(0)
    })

    test('rajada no mesmo numero continua espacada', async () => {
      process.env.WHATSAPP_SEND_GUARD_MODE = 'soft'
      process.env.WHATSAPP_SEND_GUARD_AUTOMATION_INTERVAL_MS = '1500'
      const guard = require('../services/whatsappSendGuardService')

      const primeiro = await envioAutomacao(guard, { companyId: 10, whatsappInstanceId: 1 })
      const segundo = await envioAutomacao(guard, { companyId: 10, whatsappInstanceId: 1 })

      expect(primeiro.delayMs).toBe(0)
      expect(segundo.delayMs).toBeGreaterThan(0)
    })

    test('envio humano segue sem atraso por padrao mesmo em rajada', async () => {
      process.env.WHATSAPP_SEND_GUARD_MODE = 'soft'
      const guard = require('../services/whatsappSendGuardService')

      const envios = []
      for (let i = 0; i < 5; i++) {
        envios.push(
          await guard.beforeWhatsAppSend({
            companyId: 10,
            whatsappInstanceId: 1,
            endpoint: '/messages/chat',
            body: { to: '+5534999999999', body: `Msg ${i}` },
            meta: { origin: 'atendimento_humano', type: 'text' },
          })
        )
      }

      expect(envios.every((e) => e.delayMs === 0)).toBe(true)
    })

    test('chave separa instancia, empresa e tipo de origem', () => {
      const { _test } = require('../services/whatsappSendGuardService')

      expect(_test.pacingKey({ company_id: 10, whatsapp_instance_id: 1 }, 'human')).toBe('inst:1:human')
      expect(_test.pacingKey({ company_id: 10, whatsapp_instance_id: 1 }, 'automation')).toBe('inst:1:automation')
      // Sem instancia resolvida mantem o comportamento anterior, por empresa.
      expect(_test.pacingKey({ company_id: 10, whatsapp_instance_id: null }, 'human')).toBe('company:10:human')
      expect(_test.pacingKey({ company_id: 10 }, 'human')).toBe('company:10:human')
    })
  })
})
