const { collectAllowedSocketOrigins } = require('../helpers/socketCorsOrigins')

describe('collectAllowedSocketOrigins', () => {
  test('em produção rejeita http e extras ZAPERP_CORS_EXTRA_ORIGINS', () => {
    const origins = collectAllowedSocketOrigins(
      {
        CORS_ORIGINS: 'https://zaperp.wmsistemas.inf.br,http://evil.local',
        ZAPERP_CORS_EXTRA_ORIGINS: 'http://localhost:5173',
        APP_URL: 'https://api.zaperp.wmsistemas.inf.br',
      },
      true
    )

    expect(origins).toContain('https://zaperp.wmsistemas.inf.br')
    expect(origins).toContain('https://api.zaperp.wmsistemas.inf.br')
    expect(origins).not.toContain('http://evil.local')
    expect(origins).not.toContain('http://localhost:5173')
  })

  test('fora de produção aceita localhost e extras', () => {
    const origins = collectAllowedSocketOrigins(
      {
        CORS_ORIGINS: 'https://zaperp.wmsistemas.inf.br',
        ZAPERP_CORS_EXTRA_ORIGINS: 'http://localhost:5173',
        APP_URL: 'http://localhost:3000',
      },
      false
    )

    expect(origins).toContain('http://localhost:5173')
    expect(origins).toContain('http://localhost:3000')
  })
})
