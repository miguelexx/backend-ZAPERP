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

const mockSyncLead = jest.fn()
const mockSyncContato = jest.fn()
let mockCrmEnabled = true
jest.mock('../services/crmSyncService', () => ({
  isEnabled: () => mockCrmEnabled,
  isCrmError: (v) => v != null && typeof v === 'object' && v._crmError === true,
  syncLead: (...a) => mockSyncLead(...a),
  syncContato: (...a) => mockSyncContato(...a),
}))

function buildApp() {
  const app = express()
  app.use(express.json())
  const auth = require('../middleware/auth')
  const crmLead = require('../controllers/crmLeadController')
  const router = express.Router()
  router.post('/leads/from-conversa/:conversaId', auth, crmLead.enviarLeadDaConversa)
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
  mockSyncLead.mockReset().mockResolvedValue({ ok: true })
  mockSyncContato.mockReset().mockResolvedValue({ ok: true })
})

describe('POST /api/crm/leads/from-conversa/:conversaId', () => {
  const app = buildApp()
  const authToken = token({ id: 7, company_id: 1, email: 'ana@empresa.com' })

  it('401 sem Authorization', async () => {
    const res = await request(app).post('/api/crm/leads/from-conversa/10')
    expect(res.status).toBe(401)
  })

  it('403 quando o CRM está desativado', async () => {
    mockCrmEnabled = false
    const res = await request(app)
      .post('/api/crm/leads/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CRM_DISABLED')
  })

  it('400 quando conversaId é inválido', async () => {
    const res = await request(app)
      .post('/api/crm/leads/from-conversa/abc')
      .set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(400)
  })

  it('404 quando a conversa não existe (na empresa)', async () => {
    mockConversaRow = null
    const res = await request(app)
      .post('/api/crm/leads/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(404)
  })

  it('400 para conversa de grupo', async () => {
    mockConversaRow = { id: 10, tipo: 'grupo', telefone: '123@g.us', cliente_id: null }
    const res = await request(app)
      .post('/api/crm/leads/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(400)
    expect(mockSyncLead).not.toHaveBeenCalled()
  })

  it('201 envia contato + lead puxando todos os dados do cliente', async () => {
    mockConversaRow = {
      id: 10,
      tipo: 'individual',
      telefone: '5511999',
      cliente_id: 55,
      nome_contato_cache: 'Zé',
    }
    mockClienteRow = {
      id: 55,
      nome: 'José Silva',
      telefone: '5511999',
      email: 'jose@x.com',
      empresa: 'ACME',
      observacoes: 'VIP',
    }
    const res = await request(app)
      .post('/api/crm/leads/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ observacoes: 'ligar amanhã' })

    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
    expect(mockSyncContato).toHaveBeenCalledWith(
      expect.objectContaining({
        empresaId: 1,
        contatoId: 55,
        nome: 'José Silva',
        email: 'jose@x.com',
        telefone: '5511999',
        empresaNome: 'ACME',
      })
    )
    expect(mockSyncLead).toHaveBeenCalledWith(
      expect.objectContaining({
        empresaId: 1,
        leadId: 10,
        nome: 'José Silva',
        telefone: '5511999',
        email: 'jose@x.com',
        origemNome: 'WhatsApp',
        responsavelEmail: 'ana@empresa.com',
        observacoes: 'ligar amanhã', // nota manual tem prioridade sobre observacoes do cliente
      })
    )
  })

  it('company_id vem do token, nunca do body', async () => {
    mockConversaRow = { id: 10, tipo: 'individual', telefone: '5511999', cliente_id: null }
    await request(app)
      .post('/api/crm/leads/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ company_id: 999 })
    expect(mockSyncLead).toHaveBeenCalledWith(expect.objectContaining({ empresaId: 1 }))
  })

  it('sem cliente vinculado ainda envia lead com o telefone da conversa', async () => {
    mockConversaRow = { id: 10, tipo: 'individual', telefone: '5511888', cliente_id: null }
    const res = await request(app)
      .post('/api/crm/leads/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(201)
    expect(mockSyncContato).not.toHaveBeenCalled()
    expect(mockSyncLead).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 10, telefone: '5511888', nome: '5511888' })
    )
  })

  it('502 quando o CRM não responde (syncLead retorna null)', async () => {
    mockConversaRow = { id: 10, tipo: 'individual', telefone: '5511999', cliente_id: null }
    mockSyncLead.mockResolvedValue(null)
    const res = await request(app)
      .post('/api/crm/leads/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(502)
  })

  it('502 quando o CRM retorna _crmError (com retry)', async () => {
    mockConversaRow = { id: 10, tipo: 'individual', telefone: '5511999', cliente_id: null }
    mockSyncLead.mockResolvedValue({ _crmError: true, status: 500, detail: 'Internal Server Error' })
    const res = await request(app)
      .post('/api/crm/leads/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(502)
    expect(mockSyncLead).toHaveBeenCalledTimes(2) // retry automático
  })
})
