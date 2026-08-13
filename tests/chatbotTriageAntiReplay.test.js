/**
 * Regressão: chatbot de triagem NÃO deve iniciar boas-vindas para inbound antigo
 * (reentrega/replay/re-sync). Bug: "bot mandava boas-vindas sem o cliente ter mandado mensagem".
 * Cobre a defesa de idade do inbound em chatbotTriageService (isInboundTooOldForWelcome).
 */

const ORIGINAL_ENV = process.env.CHATBOT_WELCOME_MAX_INBOUND_AGE_MINUTES

function loadFresh() {
  jest.resetModules()
  return require('../services/chatbotTriageService')
}

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.CHATBOT_WELCOME_MAX_INBOUND_AGE_MINUTES
  else process.env.CHATBOT_WELCOME_MAX_INBOUND_AGE_MINUTES = ORIGINAL_ENV
  jest.resetModules()
})

describe('isInboundTooOldForWelcome — anti-replay de boas-vindas', () => {
  test('inbound recente (agora) → NÃO suprime welcome', () => {
    delete process.env.CHATBOT_WELCOME_MAX_INBOUND_AGE_MINUTES // default 360 min
    const { isInboundTooOldForWelcome } = loadFresh()
    const now = Date.now()
    expect(isInboundTooOldForWelcome(new Date(now).toISOString(), now)).toBe(false)
  })

  test('inbound de 10 min atrás (dentro da janela padrão) → NÃO suprime', () => {
    delete process.env.CHATBOT_WELCOME_MAX_INBOUND_AGE_MINUTES
    const { isInboundTooOldForWelcome } = loadFresh()
    const now = Date.now()
    const dezMinAtras = new Date(now - 10 * 60 * 1000).toISOString()
    expect(isInboundTooOldForWelcome(dezMinAtras, now)).toBe(false)
  })

  test('inbound de 1 mês atrás (cenário do bug) → SUPRIME welcome', () => {
    delete process.env.CHATBOT_WELCOME_MAX_INBOUND_AGE_MINUTES
    const { isInboundTooOldForWelcome } = loadFresh()
    const now = Date.now()
    const umMesAtras = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
    expect(isInboundTooOldForWelcome(umMesAtras, now)).toBe(true)
  })

  test('timestamp ausente/inválido → NÃO suprime (fail-open, não bloqueia mensagem real)', () => {
    delete process.env.CHATBOT_WELCOME_MAX_INBOUND_AGE_MINUTES
    const { isInboundTooOldForWelcome } = loadFresh()
    expect(isInboundTooOldForWelcome(null)).toBe(false)
    expect(isInboundTooOldForWelcome('')).toBe(false)
    expect(isInboundTooOldForWelcome('não-é-data')).toBe(false)
  })

  test('guarda desativada (env <= 0) → nunca suprime, mesmo mensagem antiga', () => {
    process.env.CHATBOT_WELCOME_MAX_INBOUND_AGE_MINUTES = '0'
    const { isInboundTooOldForWelcome, getWelcomeMaxInboundAgeMs } = loadFresh()
    expect(getWelcomeMaxInboundAgeMs()).toBe(0)
    const now = Date.now()
    const umAnoAtras = new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString()
    expect(isInboundTooOldForWelcome(umAnoAtras, now)).toBe(false)
  })

  test('janela customizada (5 min): inbound de 6 min atrás → SUPRIME', () => {
    process.env.CHATBOT_WELCOME_MAX_INBOUND_AGE_MINUTES = '5'
    const { isInboundTooOldForWelcome } = loadFresh()
    const now = Date.now()
    const seisMinAtras = new Date(now - 6 * 60 * 1000).toISOString()
    expect(isInboundTooOldForWelcome(seisMinAtras, now)).toBe(true)
  })
})
