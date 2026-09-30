'use strict'

/**
 * Testes do endpoint GET /crm/contatos (crmContatosController):
 *   - auth por x-zaperp-secret (comparação segura) → 401 sem/segredo errado
 *   - 400 companyId inválido
 *   - busca por nome/telefone (aplica .or); sem busca → mais recentes (sem .or)
 *   - resposta { contatos: [{ nome, telefone(só dígitos) }] }, telefone formatado vira dígitos
 *   - LID / telefone curto são ignorados
 *   - erro no banco → 200 { contatos: [] }
 */

const mockResult = { data: [], error: null }
const mockQuery = {
  select: jest.fn(() => mockQuery),
  eq: jest.fn(() => mockQuery),
  order: jest.fn(() => mockQuery),
  limit: jest.fn(() => mockQuery),
  or: jest.fn(() => mockQuery),
  then: (resolve) => resolve({ data: mockResult.data, error: mockResult.error }),
}
jest.mock('../config/supabase', () => ({ from: jest.fn(() => mockQuery) }))

const { listarContatos } = require('../controllers/crmContatosController')

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
  mockResult.data = []
  mockResult.error = null
})

afterAll(() => {
  process.env = OLD_ENV
})

describe('autenticação', () => {
  test('sem ZAP_SSO_SECRET no ambiente → 503', async () => {
    delete process.env.ZAP_SSO_SECRET
    const res = mockRes()
    await listarContatos(req({ companyId: '1' }), res)
    expect(res.statusCode).toBe(503)
  })

  test('sem header de segredo → 401', async () => {
    const res = mockRes()
    await listarContatos(req({ companyId: '1' }, null), res)
    expect(res.statusCode).toBe(401)
  })

  test('segredo errado → 401', async () => {
    const res = mockRes()
    await listarContatos(req({ companyId: '1' }, 'errado'), res)
    expect(res.statusCode).toBe(401)
  })
})

describe('validação', () => {
  test('companyId inválido → 400', async () => {
    const res = mockRes()
    await listarContatos(req({ busca: 'mig' }), res)
    expect(res.statusCode).toBe(400)
  })
})

describe('busca', () => {
  test('busca "mig" → aplica .or e retorna contatos com telefone (só dígitos)', async () => {
    mockResult.data = [
      { nome: 'Miguel', pushname: null, telefone: '5534999911246' },
      { nome: 'Miguela', pushname: 'Mig', telefone: '+55 (34) 98888-7777' },
    ]
    const res = mockRes()
    await listarContatos(req({ companyId: '7', busca: 'mig' }), res)
    expect(res.statusCode).toBe(200)
    expect(mockQuery.or).toHaveBeenCalledTimes(1)
    expect(res.body).toEqual({
      contatos: [
        { nome: 'Miguel', telefone: '5534999911246' },
        { nome: 'Miguela', telefone: '5534988887777' },
      ],
    })
  })

  test('escopo por empresa e limite aplicados', async () => {
    const res = mockRes()
    await listarContatos(req({ companyId: '7', busca: 'x' }), res)
    expect(mockQuery.eq).toHaveBeenCalledWith('company_id', 7)
    expect(mockQuery.limit).toHaveBeenCalledWith(20)
    expect(mockQuery.order).toHaveBeenCalledWith('id', { ascending: false })
  })

  test('sem busca → mais recentes, SEM .or', async () => {
    mockResult.data = [{ nome: 'Recente', telefone: '5511999998888' }]
    const res = mockRes()
    await listarContatos(req({ companyId: '7' }), res)
    expect(mockQuery.or).not.toHaveBeenCalled()
    expect(res.body.contatos).toEqual([{ nome: 'Recente', telefone: '5511999998888' }])
  })

  test('nome ausente → cai no pushname; senão no telefone', async () => {
    mockResult.data = [
      { nome: '', pushname: 'ApelidoZap', telefone: '5511977776666' },
      { nome: null, pushname: null, telefone: '5511955554444' },
    ]
    const res = mockRes()
    await listarContatos(req({ companyId: '1', busca: 'a' }), res)
    expect(res.body.contatos).toEqual([
      { nome: 'ApelidoZap', telefone: '5511977776666' },
      { nome: '5511955554444', telefone: '5511955554444' },
    ])
  })

  test('LID e telefone curto são ignorados', async () => {
    mockResult.data = [
      { nome: 'Válido', telefone: '5511988887777' },
      { nome: 'LID', telefone: 'lid:1234567890' },
      { nome: 'Curto', telefone: '123' },
      { nome: 'Vazio', telefone: '' },
    ]
    const res = mockRes()
    await listarContatos(req({ companyId: '1', busca: 'x' }), res)
    expect(res.body.contatos).toEqual([{ nome: 'Válido', telefone: '5511988887777' }])
  })
})

describe('resiliência', () => {
  test('erro no banco → 200 { contatos: [] }', async () => {
    mockResult.error = { message: 'db down' }
    const res = mockRes()
    await listarContatos(req({ companyId: '1', busca: 'x' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ contatos: [] })
  })
})
