'use strict'

const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_SECRET = 'test-jwt-secret-for-zaperp'

// Linhas devolvidas pelo supabase (conversa/cliente) para o teste de envio.
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

const mockListEtapas = jest.fn()
const mockSyncLead = jest.fn()
const mockSyncContato = jest.fn()
let mockCrmEnabled = true
jest.mock('../services/crmSyncService', () => ({
  isEnabled: () => mockCrmEnabled,
  isCrmError: (v) => v != null && typeof v === 'object' && v._crmError === true,
  listEtapas: (...a) => mockListEtapas(...a),
  syncLead: (...a) => mockSyncLead(...a),
  syncContato: (...a) => mockSyncContato(...a),
}))

function buildApp() {
  const app = express()
  app.use(express.json())
  const auth = require('../middleware/auth')
  const crmLead = require('../controllers/crmLeadController')
  const router = express.Router()
  router.get('/etapas', auth, crmLead.listarEtapasCrm)
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
  mockListEtapas.mockReset()
  mockSyncLead.mockReset().mockResolvedValue({ ok: true })
  mockSyncContato.mockReset().mockResolvedValue({ ok: true })
})

describe('GET /api/crm/etapas', () => {
  const app = buildApp()
  const authToken = token({ id: 7, company_id: 1, email: 'ana@empresa.com' })

  it('401 sem Authorization', async () => {
    const res = await request(app).get('/api/crm/etapas')
    expect(res.status).toBe(401)
  })

  it('403 quando o CRM está desativado', async () => {
    mockCrmEnabled = false
    const res = await request(app).get('/api/crm/etapas').set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('CRM_DISABLED')
  })

  it('normaliza e ordena as etapas no formato real do CRM ({ funil, etapas })', async () => {
    // Formato exato devolvido pelo CRM Avançado (zaperp-webhook.service.listarEtapas).
    mockListEtapas.mockResolvedValue({
      funil: { id: 'f1', nome: 'Comercial' },
      etapas: [
        { id: 'e3', nome: 'Perdido', ordem: 5, tipo: 'PERDA', cor: '#dc2626' },
        { id: 'e1', nome: 'Leads', ordem: 1, tipo: 'EM_ANDAMENTO', cor: '#2563eb' },
      ],
    })
    const res = await request(app).get('/api/crm/etapas').set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(200)
    expect(mockListEtapas).toHaveBeenCalledWith(1)
    expect(res.body.disponivel).toBe(true)
    expect(res.body.pipeline_nome).toBe('Comercial')
    expect(res.body.etapas.map((e) => e.nome)).toEqual(['Leads', 'Perdido'])
    expect(res.body.etapas[0]).toEqual(
      expect.objectContaining({ id: 'e1', nome: 'Leads', ordem: 1, tipo: 'EM_ANDAMENTO', cor: '#2563eb' })
    )
  })

  it('expõe funis[] (multi-funil) com etapas normalizadas e ordenadas por funil', async () => {
    mockListEtapas.mockResolvedValue({
      pipelineNome: 'ZapERP',
      funil: { id: 'f1', nome: 'ZapERP' },
      etapas: [{ id: 'e1', nome: 'Leads', ordem: 0, tipo: 'EM_ANDAMENTO', cor: '#2563eb' }],
      funis: [
        {
          id: 'f1',
          nome: 'ZapERP',
          padrao: true,
          etapas: [
            { id: 'e2', nome: 'Contato Realizado', ordem: 1, tipo: 'EM_ANDAMENTO', cor: '#7c3aed' },
            { id: 'e1', nome: 'Leads', ordem: 0, tipo: 'EM_ANDAMENTO', cor: '#2563eb' },
          ],
        },
        {
          id: 'f2',
          nome: 'WM Sistemas',
          padrao: false,
          etapas: [{ id: 'x1', nome: 'Prospecção', ordem: 0, tipo: 'EM_ANDAMENTO', cor: '#059669' }],
        },
      ],
    })
    const res = await request(app).get('/api/crm/etapas').set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(200)
    expect(res.body.funis).toHaveLength(2)
    expect(res.body.funis[0]).toEqual(
      expect.objectContaining({ id: 'f1', nome: 'ZapERP', padrao: true })
    )
    // Etapas do funil padrão ordenadas por `ordem`.
    expect(res.body.funis[0].etapas.map((e) => e.nome)).toEqual(['Leads', 'Contato Realizado'])
    expect(res.body.funis[1]).toEqual(expect.objectContaining({ id: 'f2', nome: 'WM Sistemas', padrao: false }))
    // `etapas` (legado) continua vindo — as do funil padrão/topo.
    expect(res.body.etapas.map((e) => e.nome)).toEqual(['Leads'])
    expect(res.body.pipeline_nome).toBe('ZapERP')
  })

  it('funis[] vem vazio quando o CRM só devolve o formato antigo (funil único)', async () => {
    mockListEtapas.mockResolvedValue({
      funil: { id: 'f1', nome: 'Comercial' },
      etapas: [{ id: 'e1', nome: 'Leads', ordem: 0 }],
    })
    const res = await request(app).get('/api/crm/etapas').set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(200)
    expect(res.body.funis).toEqual([])
    expect(res.body.etapas.map((e) => e.nome)).toEqual(['Leads'])
  })

  it('aceita array direto do CRM', async () => {
    mockListEtapas.mockResolvedValue([{ id: 9, name: 'Negociação' }])
    const res = await request(app).get('/api/crm/etapas').set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(200)
    expect(res.body.etapas).toHaveLength(1)
    expect(res.body.etapas[0].nome).toBe('Negociação')
  })

  it('200 com etapas vazias quando o CRM não expõe o endpoint (null)', async () => {
    mockListEtapas.mockResolvedValue(null)
    const res = await request(app).get('/api/crm/etapas').set('Authorization', `Bearer ${authToken}`)
    expect(res.status).toBe(200)
    expect(res.body.etapas).toEqual([])
    expect(res.body.disponivel).toBe(false)
  })
})

describe('POST /leads/from-conversa — etapa escolhida', () => {
  const app = buildApp()
  const authToken = token({ id: 7, company_id: 1, email: 'ana@empresa.com' })

  it('encaminha etapa_id e etapa_nome para o syncLead', async () => {
    mockConversaRow = { id: 10, tipo: 'individual', telefone: '5511999', cliente_id: null }
    const res = await request(app)
      .post('/api/crm/leads/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ etapa_id: 3, etapa_nome: 'Perdido' })
    expect(res.status).toBe(201)
    expect(mockSyncLead).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 10, etapaId: '3', etapaNome: 'Perdido' })
    )
  })

  it('encaminha funil_id/funil_nome escolhidos + acaoManual/usuarioId', async () => {
    mockConversaRow = { id: 10, tipo: 'individual', telefone: '5511999', cliente_id: null }
    const res = await request(app)
      .post('/api/crm/leads/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ funil_id: 'f2', funil_nome: 'WM Sistemas', etapa_id: 'x1', etapa_nome: 'Prospecção' })
    expect(res.status).toBe(201)
    expect(mockSyncLead).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: 10,
        funilId: 'f2',
        funilNome: 'WM Sistemas',
        etapaId: 'x1',
        etapaNome: 'Prospecção',
        acaoManual: true,
        usuarioId: '7',
      })
    )
  })

  it('sem etapa envia etapaId/etapaNome null (comportamento atual)', async () => {
    mockConversaRow = { id: 10, tipo: 'individual', telefone: '5511999', cliente_id: null }
    await request(app)
      .post('/api/crm/leads/from-conversa/10')
      .set('Authorization', `Bearer ${authToken}`)
      .send({})
    expect(mockSyncLead).toHaveBeenCalledWith(
      expect.objectContaining({ etapaId: null, etapaNome: null })
    )
  })
})
