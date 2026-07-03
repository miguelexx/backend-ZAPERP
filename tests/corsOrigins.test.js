const {
  collectAllowedOrigins,
  isOriginAllowed,
} = require('../config/corsOrigins')

describe('corsOrigins', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('permite frontend publico do ZapERP por padrao', () => {
    expect(isOriginAllowed('https://zaperp.wmsistemas.inf.br')).toBe(true)
  })

  test('permite subdominios wmsistemas por padrao para HTTP e Socket.IO', () => {
    expect(isOriginAllowed('https://zaperpapi.wmsistemas.inf.br')).toBe(true)
    expect(isOriginAllowed('https://cliente-demo.wmsistemas.inf.br')).toBe(true)
  })

  test('mantem origens fora do dominio bloqueadas', () => {
    expect(isOriginAllowed('https://example.com')).toBe(false)
  })

  test('inclui APP_URL e CORS_ORIGINS na lista explicita', () => {
    process.env.APP_URL = 'https://api.minhaempresa.test'
    process.env.CORS_ORIGINS = 'https://app.minhaempresa.test'

    expect(collectAllowedOrigins()).toEqual(
      expect.arrayContaining([
        'https://api.minhaempresa.test',
        'https://app.minhaempresa.test',
      ])
    )
    expect(isOriginAllowed('https://app.minhaempresa.test')).toBe(true)
  })
})
