/**
 * Testes do circuit breaker Z-API.
 */
const { isOpen, recordSuccess, recordFailure, execute } = require('../services/circuitBreakerZapi')

describe('circuitBreakerZapi', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it('isOpen retorna false inicialmente', () => {
    expect(isOpen(1)).toBe(false)
  })

  it('recordSuccess não abre circuito', () => {
    recordSuccess(1)
    expect(isOpen(1)).toBe(false)
  })

  it('execute retorna resultado quando fn resolve', async () => {
    const result = await execute(1, async () => ({ x: 42 }))
    expect(result.ok).toBe(true)
    expect(result.result).toEqual({ x: 42 })
  })

  it('execute retorna ok: false quando fn rejeita', async () => {
    const result = await execute(1, async () => {
      throw new Error('falha')
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('falha')
  })
})
