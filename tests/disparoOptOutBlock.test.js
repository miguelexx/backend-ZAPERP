/**
 * Block no opt-out do disparo: opt-in por env (default OFF), dry-run seguro, provider-aware.
 * UltraMSG (sem blockContact) → no-op. Só Whapi bloqueia. Ver doc 25.
 */

describe('disparoOptOutService.bloquearContatoNoWhatsapp', () => {
  let prevEnv
  beforeEach(() => {
    jest.resetModules()
    prevEnv = process.env.WHAPI_OPTOUT_BLOCK_ENABLED
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.WHAPI_OPTOUT_BLOCK_ENABLED
    else process.env.WHAPI_OPTOUT_BLOCK_ENABLED = prevEnv
    jest.resetModules()
  })

  function load({ canSendLive = true, provider = 'whapi', blockImpl } = {}) {
    const blockContact = jest.fn(blockImpl || (async () => ({ ok: true })))
    const providerObj = provider === 'whapi'
      ? { blockContact }
      : {} // ultramsg: sem blockContact
    jest.doMock('../services/providers', () => ({
      getProvider: jest.fn(() => providerObj),
    }))
    jest.doMock('../services/chat/identity/conversationAddressService', () => ({
      resolveConversationProvider: jest.fn(async () => provider),
    }))
    jest.doMock('../helpers/disparoWorkerConfig', () => ({
      getDisparoFlags: jest.fn(() => ({ canSendLive })),
    }))
    const svc = require('../services/disparoOptOutService')
    return { svc, blockContact }
  }

  const ARGS = { companyId: 1, telefone: '5534988887777', instanciaId: 10 }

  test('desabilitado por padrão → não bloqueia', async () => {
    delete process.env.WHAPI_OPTOUT_BLOCK_ENABLED
    const { svc, blockContact } = load({})
    const r = await svc.bloquearContatoNoWhatsapp(ARGS)
    expect(r).toEqual({ attempted: false, reason: 'disabled' })
    expect(blockContact).not.toHaveBeenCalled()
  })

  test('habilitado + dry-run → não bloqueia (seguro)', async () => {
    process.env.WHAPI_OPTOUT_BLOCK_ENABLED = 'true'
    const { svc, blockContact } = load({ canSendLive: false })
    const r = await svc.bloquearContatoNoWhatsapp(ARGS)
    expect(r).toEqual({ attempted: false, reason: 'dry_run' })
    expect(blockContact).not.toHaveBeenCalled()
  })

  test('habilitado + live + whapi → bloqueia', async () => {
    process.env.WHAPI_OPTOUT_BLOCK_ENABLED = 'true'
    const { svc, blockContact } = load({ canSendLive: true, provider: 'whapi' })
    const r = await svc.bloquearContatoNoWhatsapp(ARGS)
    expect(r).toEqual({ attempted: true, ok: true })
    expect(blockContact).toHaveBeenCalledWith('5534988887777', { companyId: 1, whatsappInstanceId: 10 })
  })

  test('habilitado + live + ultramsg (sem blockContact) → no-op', async () => {
    process.env.WHAPI_OPTOUT_BLOCK_ENABLED = 'true'
    const { svc } = load({ canSendLive: true, provider: 'ultramsg' })
    const r = await svc.bloquearContatoNoWhatsapp(ARGS)
    expect(r).toEqual({ attempted: false, reason: 'unsupported_provider' })
  })

  test('erro no block não vaza (retorna ok:false)', async () => {
    process.env.WHAPI_OPTOUT_BLOCK_ENABLED = 'true'
    const { svc } = load({ canSendLive: true, provider: 'whapi', blockImpl: async () => { throw new Error('boom') } })
    const r = await svc.bloquearContatoNoWhatsapp(ARGS)
    expect(r.attempted).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('boom')
  })
})
