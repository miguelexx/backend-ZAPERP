/**
 * Labels do WhatsApp Business (Whapi): list/create/rename/delete + associações a chat.
 * /labels, /labels/{id}, /labels/{id}/{chatId}. fetch mockado. Ver doc 25 §30.
 */

describe('Whapi labels', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    jest.resetModules()
  })

  function mockDeps({ instancesById = {}, fetchImpl } = {}) {
    const fetchWithRetry = jest.fn(fetchImpl)
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn(),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry, sleep: jest.fn(async () => {}), isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async (companyId, id) => ({
        instance: instancesById[`${companyId}:${id}`] || null,
        error: instancesById[`${companyId}:${id}`] ? null : 'not found',
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    return { fetchWithRetry }
  }
  const inst = () => ({ id: 10, company_id: 1, provider: 'whapi', instance_id: 'NEBULA-AER3B', instance_token: 'TESTTOKEN', ativo: true })
  const OPTS = { companyId: 1, whatsappInstanceId: 10 }
  const jsonRes = (status, obj) => async () => ({ ok: status < 400, status, text: async () => (obj == null ? '' : JSON.stringify(obj)) })

  test('getLabels chama GET /labels e normaliza { id, name, color, count }', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': inst() },
      fetchImpl: jsonRes(200, [{ id: 1, name: 'Cliente VIP', color: 'gold', count: 3 }]),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getLabels(OPTS)
    expect(r.ok).toBe(true)
    expect(r.labels).toEqual([{ id: '1', name: 'Cliente VIP', color: 'gold', count: 3 }])
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/labels')
  })

  test('createLabel POST /labels { id, name, color }; valida cor', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { success: true }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.createLabel({ name: 'Novo', color: 'gold' }, OPTS)
    expect(r.ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/labels')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ name: 'Novo', color: 'gold', id: '' })
  })

  test('createLabel rejeita cor inválida e nome vazio sem chamar API', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { success: true }) })
    const whapi = require('../services/providers/whapi')
    expect((await whapi.createLabel({ name: 'X', color: 'roxo-magico' }, OPTS)).ok).toBe(false)
    expect((await whapi.createLabel({ name: '', color: 'gold' }, OPTS)).ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('renameLabel PATCH /labels/{id} { name }', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { success: true }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.renameLabel('5', 'Renomeado', OPTS)
    expect(r.ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/labels/5')
    expect(opts.method).toBe('PATCH')
    expect(JSON.parse(opts.body)).toEqual({ name: 'Renomeado' })
  })

  test('deleteLabel DELETE /labels/{id}', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { success: true }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.deleteLabel('5', OPTS)
    expect(r.ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/labels/5')
    expect(opts.method).toBe('DELETE')
  })

  test('getLabelAssociations GET /labels/{id} → { chats, messages }', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': inst() },
      fetchImpl: jsonRes(200, { chats: [{ id: '5534@s.whatsapp.net' }], messages: [] }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getLabelAssociations('5', OPTS)
    expect(r.ok).toBe(true)
    expect(r.chats).toHaveLength(1)
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/labels/5')
  })

  test('addLabelAssociation POST /labels/{id}/{chatId} (telefone → ChatID)', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { success: true }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.addLabelAssociation('5', '5534988887777', OPTS)
    expect(r.ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/labels/5/5534988887777%40s.whatsapp.net')
    expect(opts.method).toBe('POST')
  })

  test('deleteLabelAssociation DELETE /labels/{id}/{chatId}', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { success: true }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.deleteLabelAssociation('5', '5534988887777', OPTS)
    expect(r.ok).toBe(true)
    expect(fetchWithRetry.mock.calls[0][1].method).toBe('DELETE')
  })

  test('instância inexistente → ok:false sem chamar API', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: {}, fetchImpl: jsonRes(200, []) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getLabels(OPTS)
    expect(r.ok).toBe(false)
    expect(r.labels).toEqual([])
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })
})
