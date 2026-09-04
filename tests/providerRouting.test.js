/**
 * Fase A — roteamento de provider. Default/no-arg → UltraMSG (invariante crítico).
 * Só provider='whapi' roteia o adapter Whapi. Ver docs/ai-handoff/25.
 */

describe('getProvider routing', () => {
  const { getProvider, ultramsg, whapi } = require('../services/providers')

  test('no-arg → ultramsg', () => {
    expect(getProvider()).toBe(ultramsg)
  })
  test('opts vazio → ultramsg', () => {
    expect(getProvider({})).toBe(ultramsg)
  })
  test("provider 'ultramsg' → ultramsg", () => {
    expect(getProvider({ provider: 'ultramsg' })).toBe(ultramsg)
  })
  test('provider desconhecido → ultramsg (fallback seguro)', () => {
    expect(getProvider({ provider: 'zap' })).toBe(ultramsg)
    expect(getProvider({ provider: '' })).toBe(ultramsg)
    expect(getProvider({ provider: null })).toBe(ultramsg)
  })
  test("provider 'whapi' → whapi", () => {
    expect(getProvider({ provider: 'whapi' })).toBe(whapi)
    expect(getProvider({ provider: 'WHAPI' })).toBe(whapi)
  })
  test('ultramsg e whapi são adapters distintos', () => {
    expect(whapi).not.toBe(ultramsg)
    expect(typeof whapi.sendText).toBe('function')
    expect(whapi.provider).toBe('whapi')
  })
})
