const {
  isOriginAllowed,
  getAllowedOrigins,
  applyCorsHeaders,
  HARDCODED_FRONTEND_ORIGINS,
} = require('../helpers/corsOrigins')

describe('corsOrigins', () => {
  test('allows production ZapERP frontend origins', () => {
    expect(isOriginAllowed('https://zaperp.wmsistemas.inf.br')).toBe(true)
    expect(isOriginAllowed('https://www.zaperp.wmsistemas.inf.br')).toBe(true)
    expect(HARDCODED_FRONTEND_ORIGINS).toContain('https://zaperp.wmsistemas.inf.br')
    expect(getAllowedOrigins()).toContain('https://zaperp.wmsistemas.inf.br')
  })

  test('allows wmsistemas subdomain pattern', () => {
    expect(isOriginAllowed('https://homolog.wmsistemas.inf.br')).toBe(true)
  })

  test('rejects unknown origin', () => {
    expect(isOriginAllowed('https://evil.example')).toBe(false)
  })

  test('allows missing origin (Postman / server-to-server)', () => {
    expect(isOriginAllowed(undefined)).toBe(true)
    expect(isOriginAllowed(null)).toBe(true)
  })

  test('applyCorsHeaders mirrors allowed origin and credentials', () => {
    const headers = {}
    const res = {
      headersSent: false,
      setHeader(k, v) { headers[k.toLowerCase()] = v },
      getHeader(k) { return headers[String(k).toLowerCase()] },
    }
    const ok = applyCorsHeaders(
      { get: () => 'https://zaperp.wmsistemas.inf.br', headers: { origin: 'https://zaperp.wmsistemas.inf.br' } },
      res
    )
    expect(ok).toBe(true)
    expect(headers['access-control-allow-origin']).toBe('https://zaperp.wmsistemas.inf.br')
    expect(headers['access-control-allow-credentials']).toBe('true')
  })

  test('applyCorsHeaders does not grant unknown origin', () => {
    const headers = {}
    const res = {
      headersSent: false,
      setHeader(k, v) { headers[k.toLowerCase()] = v },
      getHeader() { return undefined },
    }
    const ok = applyCorsHeaders(
      { get: () => 'https://evil.example', headers: { origin: 'https://evil.example' } },
      res
    )
    expect(ok).toBe(false)
    expect(headers['access-control-allow-origin']).toBeUndefined()
  })
})
