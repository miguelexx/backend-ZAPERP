'use strict'

const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_SECRET = 'test-jwt-secret-for-zaperp'

// Dados retornados pelo supabase por chamada de .from(tabela) — controlados por teste.
let mockConversaRow = null
let mockClienteRow = null

jest.mock('../config/supabase', () => ({
  from: jest.fn((table) => {
    const result =
      table === 'conversas'
        ? { data: mockConversaRow, error: null }
        : { data: mockClienteRow, error: null }
    return {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue(result),
    }
  }),
}))

const mockRegistrarMovimentacao = jest.fn()
let mockCrmEnabled = true
jest.mock('../services/crmSyncService', () => ({
  isEnabled: () => mockCrmEnabled,
  isCrmError: (v) => v != null && typeof v === 'object' && v._crmError === true,
  registrarMovimentacao: (...a) => mockRegistrarMovimentacao(...a),
}))

function buildApp() {
  const app = express()
  app.use(express.json())
  const auth = require('../middleware/auth')
  const crmLead = require('../controllers/crmLeadController')
  const router = express.Router()
  router.post('/movimentacao/from-conversa/:conversaId', auth, crmLead.registrarMovimentacaoDaConversa)
  app.use('/api/crm', router)
  return app
}

function token(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '5m' })
}

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET
})

beforeEach(() => {
  mockConversaRow = null
  mockClienteRow = null
  mockCrmEnabled = true
  mockRegistrarMovimentacao
    .mockReset()
    .mockResolvedValue({ ok: true, oportunidade: { id: 'op1', titulo: 'José Silva' }, etapa: null, movimentacao: { id: 'm1', criadoEm: '2026-11-03T12:00:00Z' } })
})

describe('POST /api/crm/movimentacao/from-conversa/:conversaId', () => {
  const app = buildApp()
  const authToken = token({ id: 7, company_id: 1, email: 'ana@empresa.com' })

  it('401 sem Authorization', async () => {
    const res = await request(app).post('/api/crm/movimentacao/from-conversa/10').send({ texto: 'oi' })
    expect(res.status).toBe(401)
  })

  it('400 quando texto está vazio', async () => {
    const res = await request(app)
      .post('/api/crm/movimentacao/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ texto: '   ' })
    expect(res.status).toBe(400)
    expect(mockRegistrarMovimentacao).not.toHaveBeenCalled()
  })

  it('403 quando o CRM está desativado', async () => {
    mockCrmEnabled = false
    const res = await request(app)
      .post('/api/crm/movimentacao/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ texto: 'água de banho do banheiro 2 ok' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CRM_DISABLED')
  })

  it('404 quando a conversa não existe (na empresa)', async () => {
    mockConversaRow = null
    const res = await request(app)
      .post('/api/crm/movimentacao/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ texto: 'oi' })
    expect(res.status).toBe(404)
  })

  it('400 para conversa de grupo', async () => {
    mockConversaRow = { id: 10, tipo: 'grupo', telefone: '123@g.us', cliente_id: null }
    const res = await request(app)
      .post('/api/crm/movimentacao/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ texto: 'oi' })
    expect(res.status).toBe(400)
    expect(mockRegistrarMovimentacao).not.toHaveBeenCalled()
  })

  it('200 repassa texto + ids externos do ZapERP (leadId=conversaId, contatoId, telefone, usuarioId do JWT)', async () => {
    mockConversaRow = { id: 10, tipo: 'individual', telefone: '5511999', cliente_id: 55, nome_contato_cache: 'Zé' }
    mockClienteRow = { id: 55, telefone: '5511999' }
    const res = await request(app)
      .post('/api/crm/movimentacao/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ texto: 'água de banho do banheiro 2 ok' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.oportunidade).toEqual({ id: 'op1', titulo: 'José Silva' })
    expect(mockRegistrarMovimentacao).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 1,
        usuarioId: '7',
        texto: 'água de banho do banheiro 2 ok',
        leadId: 10,
        contatoId: 55,
        telefone: '5511999',
      })
    )
  })

  it('company_id vem do token, nunca do body', async () => {
    mockConversaRow = { id: 10, tipo: 'individual', telefone: '5511999', cliente_id: null }
    await request(app)
      .post('/api/crm/movimentacao/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ texto: 'oi', companyId: 999 })
    expect(mockRegistrarMovimentacao).toHaveBeenCalledWith(expect.objectContaining({ companyId: 1 }))
  })

  it('422 + message real quando o cliente não está em etapa nenhuma (CRM 409)', async () => {
    mockConversaRow = { id: 10, tipo: 'individual', telefone: '5511999', cliente_id: null }
    mockRegistrarMovimentacao.mockResolvedValue({
      _crmError: true,
      status: 409,
      detail: '{"message":"Este cliente não está em nenhuma etapa do funil. Use \'Enviar ao CRM\' primeiro."}',
      message: "Este cliente não está em nenhuma etapa do funil. Use 'Enviar ao CRM' primeiro.",
    })
    const res = await request(app)
      .post('/api/crm/movimentacao/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ texto: 'oi' })
    expect(res.status).toBe(422)
    expect(res.body.message).toMatch(/nenhuma etapa do funil/)
    expect(res.body.crm_status).toBe(409)
    expect(mockRegistrarMovimentacao).toHaveBeenCalledTimes(1) // sem retry (append-only)
  })

  it('502 quando o CRM não responde (registrarMovimentacao retorna null)', async () => {
    mockConversaRow = { id: 10, tipo: 'individual', telefone: '5511999', cliente_id: null }
    mockRegistrarMovimentacao.mockResolvedValue(null)
    const res = await request(app)
      .post('/api/crm/movimentacao/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ texto: 'oi' })
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('CRM_UNREACHABLE')
  })

  it('502 quando o CRM retorna 5xx — sem retry (movimentação é append-only)', async () => {
    mockConversaRow = { id: 10, tipo: 'individual', telefone: '5511999', cliente_id: null }
    mockRegistrarMovimentacao.mockResolvedValue({ _crmError: true, status: 500, detail: 'Internal Server Error' })
    const res = await request(app)
      .post('/api/crm/movimentacao/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ texto: 'oi' })
    expect(res.status).toBe(502)
    expect(mockRegistrarMovimentacao).toHaveBeenCalledTimes(1)
  })
})
