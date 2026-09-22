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

  // ----------------------- Escrita (gestão do catálogo) -----------------------

  test('createCatalogProduct POST /business/products valida obrigatórios', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { product: rawProduct }) })
    const whapi = require('../services/providers/whapi')
    // falta imagem
    const bad = await whapi.createCatalogProduct({ name: 'X', description: 'Y', currency: 'BRL', price: 10 }, OPTS)
    expect(bad.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
    const r = await whapi.createCatalogProduct(
      { name: 'Camiseta', description: 'Algodão', currency: 'brl', price: 49.9, images: ['https://cdn/x.jpg'], availability: 'in stock' },
      OPTS,
    )
    expect(r.ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/business/products')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toMatchObject({ name: 'Camiseta', currency: 'BRL', price: 49.9, images: ['https://cdn/x.jpg'] })
  })

  test('updateCatalogProduct PATCH exige array de imagens completo', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { success: true }) })
    const whapi = require('../services/providers/whapi')
    const missing = await whapi.updateCatalogProduct('prod_1', { price: 20 }, OPTS)
    expect(missing.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
    const r = await whapi.updateCatalogProduct('prod_1', { price: 20, images: ['https://cdn/x.jpg'] }, OPTS)
    expect(r.ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/business/products/prod_1')
    expect(opts.method).toBe('PATCH')
  })

  test('deleteCatalogProduct DELETE /business/products/{id}', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { success: true }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.deleteCatalogProduct('prod_1', OPTS)
    expect(r.ok).toBe(true)
    expect(fetchWithRetry.mock.calls[0][1].method).toBe('DELETE')
    expect(fetchWithRetry.mock.calls[0][0]).toBe('https://gate.whapi.test/business/products/prod_1')
  })

  test('createCatalogCollection POST /business/collections { name, products }', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { collection: { id: 'c1', name: 'Verão', products: [] } }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.createCatalogCollection({ name: 'Verão', products: ['prod_1'] }, OPTS)
    expect(r.ok).toBe(true)
    expect(JSON.parse(fetchWithRetry.mock.calls[0][1].body)).toEqual({ name: 'Verão', products: ['prod_1'] })
  })

  test('editCatalogCollection PATCH add/remove products', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { success: true }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.editCatalogCollection('c1', { add_products: ['p2'], remove_products: ['p3'] }, OPTS)
    expect(r.ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/business/collections/c1')
    expect(opts.method).toBe('PATCH')
    expect(JSON.parse(opts.body)).toEqual({ add_products: ['p2'], remove_products: ['p3'] })
  })

  test('deleteCatalogCollection DELETE /business/collections/{id}', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() }, fetchImpl: jsonRes(200, { success: true }) })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.deleteCatalogCollection('c1', OPTS)
    expect(r.ok).toBe(true)
    expect(fetchWithRetry.mock.calls[0][1].method).toBe('DELETE')
  })
})

describe('Whapi catálogo — envio', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    jest.resetModules()
  })

  function mockDeps({ instancesById = {}, fetchImpl = null } = {}) {
    const fetchWithRetry = jest.fn(fetchImpl || (async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ sent: true, message: { id: 'wamid.PROD' } }),
    })))
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn((type, to, opts, extra) => ({ type, to, opts, extra })),
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

  test('sendProduct POST /business/products/{ProductID} { to } (product_id vai na URL)', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendProduct('5534988887777', { productId: 'prod_1' }, OPTS)
    expect(r.ok).toBe(true)
    expect(r.messageId).toBe('wamid.PROD')
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/business/products/prod_1')
    const sent = JSON.parse(opts.body)
    expect(sent).toMatchObject({ to: '5534988887777' })
    expect(sent.product_id).toBeUndefined()
  })

  test('sendProduct inclui catalog_id no corpo quando informado', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendProduct('5534988887777', { productId: 'prod_1', catalogId: 'cat_9' }, OPTS)
    expect(r.ok).toBe(true)
    const [, opts] = fetchWithRetry.mock.calls[0]
    expect(JSON.parse(opts.body)).toMatchObject({ to: '5534988887777', catalog_id: 'cat_9' })
  })

  test('sendProduct rejeita sem productId sem chamar API', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendProduct('5534988887777', {}, OPTS)
    expect(r.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  test('sendCatalog POST /business/catalogs/{ContactID} { to, title } (contact_id vai na URL)', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendCatalog('5534988887777', { contactId: '5534999990000', title: 'Nossa loja' }, OPTS)
    expect(r.ok).toBe(true)
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/business/catalogs/5534999990000')
    const sent = JSON.parse(opts.body)
    expect(sent).toMatchObject({ to: '5534988887777', title: 'Nossa loja' })
    expect(sent.contact_id).toBeUndefined()
  })
})
