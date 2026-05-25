const { sanitizePayload } = require('../services/webhookLogService')

describe('webhookLogService.sanitizePayload', () => {
  it('mascara credenciais em campos aninhados e payload JSON em string', () => {
    const sanitized = sanitizePayload({
      token: 'webhook-secret',
      data: {
        instanceToken: 'instance-secret',
        client_token: 'client-secret',
        body: '{"token":"nested-secret","message":"ok"}',
      },
    })

    expect(sanitized.token).toBe('***')
    expect(sanitized.data.instanceToken).toBe('***')
    expect(sanitized.data.client_token).toBe('***')
    expect(sanitized.data.body).toEqual({ token: '***', message: 'ok' })
  })

  it('trunca payload grande depois de sanitizar segredos', () => {
    const sanitized = sanitizePayload({
      payload: `"token":"secret-in-preview" ${'x'.repeat(51000)}`,
    })

    expect(sanitized._truncated).toBe(true)
    expect(sanitized._preview).not.toContain('secret-in-preview')
    expect(sanitized._preview).toContain('***')
  })
})
