/**
 * Testes — parser de status UltraMSG (payload aninhado vs string).
 */

const {
  extractUltramsgStatusString,
  interpretUltramsgInstanceStatus,
} = require('../helpers/ultramsgStatusHelper')

describe('ultramsgStatusHelper', () => {
  it('interpreta string simples authenticated', () => {
    const r = interpretUltramsgInstanceStatus({ status: 'authenticated' })
    expect(r.connected).toBe(true)
    expect(r.conclusive).toBe(true)
    expect(r.status).toBe('authenticated')
  })

  it('interpreta objeto aninhado accountStatus (bug histórico [object Object])', () => {
    const payload = {
      status: {
        accountStatus: {
          status: 'authenticated',
          substatus: 'connected',
        },
      },
    }
    // String(payload.status) === '[object Object]' → parser antigo falhava
    expect(String(payload.status).toLowerCase()).toContain('object')

    const r = interpretUltramsgInstanceStatus(payload)
    expect(r.connected).toBe(true)
    expect(r.conclusive).toBe(true)
    expect(r.status).toBe('authenticated')
  })

  it('interpreta accountStatus string no topo', () => {
    const r = interpretUltramsgInstanceStatus({ accountStatus: 'standby' })
    expect(r.connected).toBe(true)
    expect(r.status).toBe('standby')
  })

  it('disconnected conclusivo', () => {
    const r = interpretUltramsgInstanceStatus({ status: 'disconnected' })
    expect(r.connected).toBe(false)
    expect(r.conclusive).toBe(true)
  })

  it('payload vazio é inconclusivo (não forçar offline)', () => {
    const r = interpretUltramsgInstanceStatus({})
    expect(r.connected).toBe(false)
    expect(r.conclusive).toBe(false)
    expect(r.status).toBe('unknown')
  })

  it('extractUltramsgStatusString acha authenticated em JSON profundo', () => {
    expect(extractUltramsgStatusString({ foo: { bar: 'authenticated' } })).toBe('authenticated')
  })
})
