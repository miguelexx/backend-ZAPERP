const express = require('express')
const request = require('supertest')

describe('contrato HTTP frontend → backend para Perfil Business e Labels Whapi', () => {
  let app
  let provider

  beforeEach(() => {
    jest.resetModules()
    provider = {
      getBusinessProfile: jest.fn(async () => ({ ok: true, profile: { address: 'Rua A' } })),
      editBusinessProfile: jest.fn(async () => ({ ok: true })),
      getLabels: jest.fn(async () => ({ ok: true, labels: [{ id: '1', name: 'VIP', color: 'gold' }] })),
      createLabel: jest.fn(async () => ({ ok: true, label: { id: '2', name: 'Novo', color: 'cyan' } })),
      renameLabel: jest.fn(async () => ({ ok: true })),
      deleteLabel: jest.fn(async () => ({ ok: true })),
      getLabelAssociations: jest.fn(async () => ({ ok: true, chats: [{ id: '5534999998888@s.whatsapp.net' }], messages: [] })),
      addLabelAssociation: jest.fn(async () => ({ ok: true })),
      deleteLabelAssociation: jest.fn(async () => ({ ok: true })),
    }

    jest.doMock('../middleware/auth', () => (req, _res, next) => {
      req.user = { id: 7, company_id: 12, perfil: 'admin' }
      next()
    })
    jest.doMock('../middleware/supervisorOrAdmin', () => (_req, _res, next) => next())
    jest.doMock('../middleware/adminOnly', () => (_req, _res, next) => next())
    jest.doMock('../middleware/rateLimit', () => ({
      apiLimiter: (_req, _res, next) => next(),
      destructiveLimiter: (_req, _res, next) => next(),
    }))
    jest.doMock('../services/providers', () => ({ getProvider: () => provider }))
    jest.doMock('../services/providers/whapi/partner', () => ({ isPartnerConfigured: () => false }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async (_companyId, id) => ({
        instance: { id: Number(id), provider: 'whapi', ativo: true },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))

    const whatsappRoutes = require('../routes/whatsappIntegrationRoutes')
    const labelsRoutes = require('../routes/labelsRoutes')
    app = express()
    app.use(express.json())
    app.use('/api/integrations/whatsapp', whatsappRoutes)
    app.use('/api/labels', labelsRoutes)
  })

  afterEach(() => jest.resetModules())

  test('Perfil Business usa GET/POST /api/integrations/whatsapp/instances/:id/business-profile', async () => {
    await request(app)
      .get('/api/integrations/whatsapp/instances/41/business-profile')
      .expect(200, { provider: 'whapi', profile: { address: 'Rua A' } })

    const payload = {
      address: 'Rua Nova',
      description: 'Descrição',
      email: 'contato@empresa.com',
      websites: ['https://empresa.com'],
      hours: { timeZone: 'America/Sao_Paulo', config: [] },
    }
    await request(app)
      .post('/api/integrations/whatsapp/instances/41/business-profile')
      .send(payload)
      .expect(200)

    expect(provider.getBusinessProfile).toHaveBeenCalledWith({ companyId: 12, whatsappInstanceId: 41 })
    expect(provider.editBusinessProfile).toHaveBeenCalledWith(payload, { companyId: 12, whatsappInstanceId: 41 })
  })

  test('Labels cobre lista, criação, rename, delete e associações sob /api/labels', async () => {
    await request(app).get('/api/labels?whatsapp_instance_id=41').expect(200)
    await request(app).post('/api/labels').send({ whatsapp_instance_id: 41, id: '', name: 'Novo', color: 'cyan' }).expect(201)
    await request(app).patch('/api/labels/2').send({ whatsapp_instance_id: 41, name: 'Renomeado' }).expect(200)
    await request(app).get('/api/labels/2/chats?whatsapp_instance_id=41').expect(200)
    await request(app).post('/api/labels/2/associacoes').send({ whatsapp_instance_id: 41, chat: '5534999998888' }).expect(200)
    await request(app).delete('/api/labels/2/associacoes').send({ whatsapp_instance_id: 41, chat: '5534999998888' }).expect(200)
    await request(app).delete('/api/labels/2?whatsapp_instance_id=41').expect(200)

    expect(provider.createLabel).toHaveBeenCalledWith(
      { id: '', name: 'Novo', color: 'cyan' },
      { companyId: 12, whatsappInstanceId: 41 },
    )
    expect(provider.renameLabel).toHaveBeenCalledWith('2', 'Renomeado', { companyId: 12, whatsappInstanceId: 41 })
    expect(provider.getLabelAssociations).toHaveBeenCalledWith('2', { companyId: 12, whatsappInstanceId: 41 })
    expect(provider.addLabelAssociation).toHaveBeenCalledWith('2', '5534999998888', { companyId: 12, whatsappInstanceId: 41 })
    expect(provider.deleteLabelAssociation).toHaveBeenCalledWith('2', '5534999998888', { companyId: 12, whatsappInstanceId: 41 })
    expect(provider.deleteLabel).toHaveBeenCalledWith('2', { companyId: 12, whatsappInstanceId: 41 })
  })

  test('erro Whapi 500 permanece 502; conta comum usa 422 com código acionável', async () => {
    provider.getBusinessProfile.mockResolvedValueOnce({
      ok: false,
      httpStatus: 500,
      error: 'Falha temporária da Whapi',
      code: 'WHAPI_INTERNAL_ERROR',
    })
    await request(app)
      .get('/api/integrations/whatsapp/instances/41/business-profile')
      .expect(502, { error: 'Falha temporária da Whapi', code: 'WHAPI_INTERNAL_ERROR', provider: 'whapi' })

    provider.getBusinessProfile.mockResolvedValueOnce({
      ok: false,
      httpStatus: 422,
      error: 'Conta WhatsApp Business necessária',
      code: 'WHAPI_BUSINESS_ACCOUNT_REQUIRED',
    })
    await request(app)
      .get('/api/integrations/whatsapp/instances/41/business-profile')
      .expect(422, { error: 'Conta WhatsApp Business necessária', code: 'WHAPI_BUSINESS_ACCOUNT_REQUIRED', provider: 'whapi' })
  })
})
