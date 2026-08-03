describe('jobsController.checkCronSecret', () => {
  const ORIGINAL_ENV = process.env

  function createRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }
  }

  afterEach(() => {
    process.env = ORIGINAL_ENV
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('bloqueia endpoint manual sem CRON_SECRET configurado', () => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: '' }
    const { checkCronSecret } = require('../controllers/jobsController')
    const res = createRes()
    const next = jest.fn()

    checkCronSecret({ headers: {} }, res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejeita X-Cron-Secret incorreto', () => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: 'secret-a' }
    const { checkCronSecret } = require('../controllers/jobsController')
    const res = createRes()
    const next = jest.fn()

    checkCronSecret({ headers: { 'x-cron-secret': 'secret-b' } }, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('aceita X-Cron-Secret correto', () => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: 'secret-a' }
    const { checkCronSecret } = require('../controllers/jobsController')
    const res = createRes()
    const next = jest.fn()

    checkCronSecret({ headers: { 'x-cron-secret': 'secret-a' } }, res, next)

    expect(res.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })
})

describe('jobsController.isChatbotOutboundMessage', () => {
  const { isChatbotOutboundMessage } = require('../controllers/jobsController')

  test('nao confunde mensagem do atendente com mensagem do bot', () => {
    expect(isChatbotOutboundMessage({
      direcao: 'out',
      origem: 'painel',
      autor_usuario_id: 55,
      texto: 'Posso ajudar em algo mais?',
      status: 'sent',
    }, {})).toBe(false)
  })

  test('aceita automacao entregue e rejeita automacao com falha', () => {
    const bot = {
      direcao: 'out',
      origem: 'automacao',
      autor_usuario_id: null,
      texto: 'Menu personalizado',
      status: 'sent',
      provider_request: { options: { sendOrigin: 'chatbot_triage' } },
    }
    expect(isChatbotOutboundMessage(bot, {})).toBe(true)
    expect(isChatbotOutboundMessage({ ...bot, status: 'erro', status_mensagem: 'failed' }, {})).toBe(false)
    expect(isChatbotOutboundMessage({
      ...bot,
      provider_request: { options: { sendOrigin: 'regra_automatica' } },
    }, {})).toBe(false)
  })
})
