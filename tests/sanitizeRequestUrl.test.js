const { sanitizeRequestUrl } = require('../helpers/sanitizeRequestUrl')
const requestLogger = require('../middleware/logger')
const { EventEmitter } = require('events')

describe('sanitizeRequestUrl', () => {
  test('preserva caminho e parâmetros operacionais', () => {
    expect(sanitizeRequestUrl('/media/proxy?url=https%3A%2F%2Fcdn.example%2Fa.jpg&company_id=7'))
      .toBe('/media/proxy?url=https%3A%2F%2Fcdn.example%2Fa.jpg&company_id=7')
  })

  test.each([
    'access_token',
    'token',
    'code',
    'api_key',
    'client_secret',
    'refresh_token',
    'webhook_token',
    'instance_token',
    'password',
    'authorization',
  ])('redige o parâmetro sensível %s', (key) => {
    const result = sanitizeRequestUrl(`/rota?ok=1&${key}=segredo&fim=2`)
    expect(result).toContain('ok=1')
    expect(result).toContain('fim=2')
    expect(result).not.toContain('segredo')
    expect(result).toContain(`${key}=%5BREDACTED%5D`)
  })

  test('redige todas as ocorrências e trata nomes sem diferenciar maiúsculas', () => {
    const result = sanitizeRequestUrl('/rota?TOKEN=primeiro&token=segundo')
    expect(result).not.toContain('primeiro')
    expect(result).not.toContain('segundo')
    expect(result.match(/%5BREDACTED%5D/g)).toHaveLength(2)
  })

  test('mantém URL sem query inalterada', () => {
    expect(sanitizeRequestUrl('/health')).toBe('/health')
  })

  test('o middleware nunca escreve o token no log de acesso', () => {
    const req = {
      requestId: 'req-1',
      method: 'GET',
      originalUrl: '/media/proxy?access_token=jwt-secreto&message_id=99',
      user: { id: 5 },
      ip: '127.0.0.1',
    }
    const res = new EventEmitter()
    res.statusCode = 200
    const next = jest.fn()
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})

    try {
      requestLogger(req, res, next)
      res.emit('finish')
      expect(next).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledTimes(1)
      const line = String(log.mock.calls[0][0])
      expect(line).not.toContain('jwt-secreto')
      expect(line).toContain('access_token=%5BREDACTED%5D')
      expect(line).toContain('message_id=99')
    } finally {
      log.mockRestore()
    }
  })
})
