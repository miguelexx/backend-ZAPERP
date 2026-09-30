'use strict'

/**
 * Testes do endpoint GET /crm/instancia-status (crmInstanciaController):
 *   - auth por x-zaperp-secret (comparação segura) → 401 sem/segredo errado
 *   - 200 { conectado, numero, nome } para empresa com WhatsApp conectado
 *   - 200 { conectado:false, numero:null } para empresa sem instância whapi
 *   - erro/timeout da Whapi → 200 conectado:false (nunca 500)
 *   - o token da Whapi nunca aparece na resposta
 */

const mockGetConnectionStatus = jest.fn()
const mockGetUserProfile = jest.fn()

jest.mock('../services/providers', () => ({
  getProvider: () => ({
    getConnectionStatus: (...a) => mockGetConnectionStatus(...a),
    getUserProfile: (...a) => mockGetUserProfile(...a),
  }),
}))

const { instanciaStatus } = require('../controllers/crmInstanciaController')

const OLD_ENV = process.env

function mockRes() {
  const res = { statusCode: 200, body: null }
  res.status = jest.fn((c) => {
    res.statusCode = c
    return res
  })
  res.json = jest.fn((b) => {
    res.body = b
    return res
  })
  return res
}

function req(query, secret = 'segredo-teste') {
  return { headers: secret == null ? {} : { 'x-zaperp-secret': secret }, query }
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env = { ...OLD_ENV, ZAP_SSO_SECRET: 'segredo-teste' }
  mockGetConnectionStatus.mockResolvedValue({ ok: true, connected: true, status: 'AUTH', phone: '5534999911246' })
  mockGetUserProfile.mockResolvedValue({ ok: true, profile: { name: 'WM Sistemas' } })
})

afterAll(() => {
  process.env = OLD_ENV
})

describe('autenticação', () => {
  test('sem ZAP_SSO_SECRET no ambiente → 503', async () => {
    delete process.env.ZAP_SSO_SECRET
    const res = mockRes()
    await instanciaStatus(req({ companyId: '1' }), res)
    expect(res.statusCode).toBe(503)
  })

  test('sem header de segredo → 401', async () => {
    const res = mockRes()
    await instanciaStatus(req({ companyId: '1' }, null), res)
    expect(res.statusCode).toBe(401)
    expect(mockGetConnectionStatus).not.toHaveBeenCalled()
  })

  test('segredo errado → 401', async () => {
    const res = mockRes()
    await instanciaStatus(req({ companyId: '1' }, 'errado'), res)
    expect(res.statusCode).toBe(401)
  })
})

describe('validação', () => {
  test('companyId ausente/ inválido → 400', async () => {
    const res = mockRes()
    await instanciaStatus(req({}), res)
    expect(res.statusCode).toBe(400)
  })
})

describe('empresa conectada', () => {
  test('200 { conectado:true, numero (só dígitos), nome }', async () => {
    const res = mockRes()
    await instanciaStatus(req({ companyId: '7' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, conectado: true, numero: '5534999911246', nome: 'WM Sistemas' })
    expect(mockGetConnectionStatus).toHaveBeenCalledWith(expect.objectContaining({ companyId: 7 }))
  })

  test('number com formatação vira só dígitos', async () => {
    mockGetConnectionStatus.mockResolvedValue({ ok: true, connected: true, status: 'AUTH', phone: '55 (34) 99991-1246' })
    const res = mockRes()
    await instanciaStatus(req({ companyId: '7' }), res)
    expect(res.body.numero).toBe('5534999911246')
  })

  test('conectado mas sem perfil → nome null, não quebra', async () => {
    mockGetUserProfile.mockResolvedValue({ ok: false, error: 'x' })
    const res = mockRes()
    await instanciaStatus(req({ companyId: '7' }), res)
    expect(res.body).toEqual({ ok: true, conectado: true, numero: '5534999911246', nome: null })
  })
})

describe('empresa sem instância / não conectada', () => {
  test('sem instância whapi (not_configured) → 200 conectado:false, numero:null', async () => {
    mockGetConnectionStatus.mockResolvedValue({ ok: false, connected: false, status: 'not_configured' })
    const res = mockRes()
    await instanciaStatus(req({ companyId: '9' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, conectado: false, numero: null, nome: null })
    // não busca perfil quando não está conectado
    expect(mockGetUserProfile).not.toHaveBeenCalled()
  })

  test('canal desconectado (status LAUNCH) → conectado:false', async () => {
    mockGetConnectionStatus.mockResolvedValue({ ok: true, connected: false, status: 'LAUNCH', phone: null })
    const res = mockRes()
    await instanciaStatus(req({ companyId: '9' }), res)
    expect(res.body).toMatchObject({ ok: true, conectado: false, numero: null })
  })
})

describe('resiliência (Whapi fora/erro) → nunca 500', () => {
  test('getConnectionStatus lança → 200 conectado:false', async () => {
    mockGetConnectionStatus.mockRejectedValue(new Error('ECONNRESET'))
    const res = mockRes()
    await instanciaStatus(req({ companyId: '7' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, conectado: false, numero: null, nome: null })
  })

  test('resposta não vaza o token da Whapi', async () => {
    mockGetConnectionStatus.mockResolvedValue({
      ok: true,
      connected: true,
      status: 'AUTH',
      phone: '5534999911246',
      raw: { token: 'SEGREDO-WHAPI' },
    })
    const res = mockRes()
    await instanciaStatus(req({ companyId: '7' }), res)
    expect(JSON.stringify(res.body)).not.toMatch(/SEGREDO-WHAPI/)
    expect(res.body).not.toHaveProperty('raw')
  })
})
