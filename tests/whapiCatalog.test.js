/**
 * Catálogo WhatsApp Business (Whapi): produtos + coleções (só leitura).
 * /business/products, /business/products/{id}, /business/collections, /business/collections/{id}[/products],
 * /business/contacts/{chatId}/products. fetch mockado. Conta comum → 422 acionável. Ver doc 25.
 */

describe('Whapi catálogo', () => {
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

  const rawProduct = {
    id: 'prod_1',
    name: 'Camiseta',
    description: 'Algodão',
    price: 49.9,
    currency: 'BRL',
    availability: 'in stock',
    images: ['https://cdn/x.jpg', { link: 'https://cdn/y.jpg' }],
    product_retailer_id: 'SKU-1',
    url: 'https://loja/x',
    is_hidden: false,
  }

  test('getCatalogProducts GET /business/products, normaliza produto e imagens', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': inst() },
      fetchImpl: jsonRes(200, { products: [rawProduct], total: 1, count: 1, offset: 0 }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getCatalogProducts({ count: 50 }, OPTS)
    expect(r.ok).toBe(true)
    expect(r.total).toBe(1)
    expect(r.products).toHaveLength(1)
    expect(r.products[0]).toMatchObject({
      id: 'prod_1', name: 'Camiseta', price: 49.9, currency: 'BRL',
      availability: 'in stock', product_retailer_id: 'SKU-1',
      images: ['https://cdn/x.jpg', 'https://cdn/y.jpg'], image: 'https://cdn/x.jpg',
    })
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/business/products?count=50')
  })

  test('getCatalogProducts clampa count a 500 e usa default 100', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { products: [] }) })
    const whapi = require('../services/providers/whapi')
    await whapi.getCatalogProducts({ count: 9999 }, OPTS)
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/business/products?count=500')
    await whapi.getCatalogProducts({}, OPTS)
    expect(fetchWithRetry.mock.calls[1][0]).toBe('https://gate.whapi.test/business/products?count=100')
  })

  test('getCatalogProduct GET /business/products/{id}', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, rawProduct) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getCatalogProduct('prod_1', OPTS)
    expect(r.ok).toBe(true)
    expect(r.product.id).toBe('prod_1')
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/business/products/prod_1')
  })

  test('getCatalogCollections GET /business/collections normaliza coleção + produtos', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': inst() },
      fetchImpl: jsonRes(200, { collections: [{ id: 'col_1', name: 'Verão', products: [rawProduct], status: 'active' }], total: 1 }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getCatalogCollections({}, OPTS)
    expect(r.ok).toBe(true)
    expect(r.collections[0]).toMatchObject({ id: 'col_1', name: 'Verão', products_count: 1 })
    expect(r.collections[0].products[0].id).toBe('prod_1')
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/business/collections?count=100')
  })

  test('getCatalogCollectionProducts GET /business/collections/{id}/products', async () => {
    const { fetchWithRetry } = mockDeps({
      instancesById: { '1:10': inst() },
      fetchImpl: jsonRes(200, { products: [rawProduct] }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getCatalogCollectionProducts('col_1', { products_count: 10 }, OPTS)
    expect(r.ok).toBe(true)
    expect(r.products).toHaveLength(1)
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/business/collections/col_1/products?products_count=10')
  })

  test('getContactCatalogProducts normaliza telefone → ChatID', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { products: [rawProduct] }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getContactCatalogProducts('5534988887777', {}, OPTS)
    expect(r.ok).toBe(true)
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/business/contacts/5534988887777%40s.whatsapp.net/products?count=100')
  })

  test('conta comum: 500 Internal Error vira 422 WHAPI_BUSINESS_ACCOUNT_REQUIRED', async () => {
    let call = 0
    const fetchImpl = async (url) => {
      call += 1
      // 1ª chamada = /business/products (500). 2ª = /health (diagnóstico).
      if (String(url).includes('/health')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: { text: 'AUTH' }, user: { is_business: false } }) }
      }
      return { ok: false, status: 500, text: async () => JSON.stringify({ error: { message: 'Internal Error' } }) }
    }
    mockDeps({ instancesById: { '1:10': inst() }, fetchImpl })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getCatalogProducts({}, OPTS)
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(422)
    expect(r.code).toBe('WHAPI_BUSINESS_ACCOUNT_REQUIRED')
    expect(r.products).toEqual([])
    expect(call).toBeGreaterThanOrEqual(2)
  })

  test('instância inexistente → ok:false sem chamar API', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: {}, fetchImpl: jsonRes(200, { products: [] }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.getCatalogProducts({}, OPTS)
    expect(r.ok).toBe(false)
    expect(r.products).toEqual([])
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })
})
