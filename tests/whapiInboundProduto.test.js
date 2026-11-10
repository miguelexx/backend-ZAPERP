/**
 * Recebimento de PRODUTO/PEDIDO do cliente via catálogo WhatsApp Business (Whapi).
 * Antes: type 'product'/'order' caía sem mapeamento → texto vazio → '(mídia)' (descartado) ou '(mensagem)'.
 * Agora: 'product' vira cartão (tipo=product + reply_meta.product, enriquecido no catálogo) e
 * 'order' vira um resumo legível. Ver docs/ai-handoff/25.
 */

describe('Whapi inbound — produto e pedido do catálogo', () => {
  const CTX = { channelId: 'NEBULA-AER3B', connectedPhone: '553433334444' }
  const CTX_SRC = { company_id: 7, whatsapp_instance_id: 42 }

  afterEach(() => jest.resetModules())

  function normalize(m) {
    const controller = require('../controllers/webhookWhapiController')
    return controller._test.normalizeWhapiMessageToInternal(m, CTX)
  }

  test('type "product" é reconhecido: internalType product + productRef + body provisório', () => {
    const m = normalize({
      id: 'wamid.prod1',
      from_me: false,
      type: 'product',
      chat_id: '5534988887777@s.whatsapp.net',
      from_name: 'Cliente',
      timestamp: 1700000000,
      product: { product_id: '7275856165856513', catalog_id: '919984351847@s.whatsapp.net' },
    })
    expect(m.type).toBe('product')
    expect(m.productRef).toEqual({ product_id: '7275856165856513', catalog_id: '919984351847@s.whatsapp.net' })
    // Sem enriquecimento ainda: nunca fica vazio (senão seria descartado como '(mídia)').
    expect(m.body).toBe('🛍️ Produto')
  })

  test('type "order" → internalType order + resumo no body (itens buscados no enrich)', () => {
    const m = normalize({
      id: 'wamid.order1',
      from_me: false,
      type: 'order',
      chat_id: '5534988887777@s.whatsapp.net',
      from_name: 'Cliente',
      timestamp: 1700000000,
      order: { order_id: '964278151888836', item_count: 3, currency: 'BRL', total_price: 359, status: 'new' },
    })
    expect(m.type).toBe('order') // cartão de pedido (OrderMessage); itens resolvidos em enrichNormalizedOrder
    expect(m.productRef).toBeUndefined()
    expect(m.orderRef).toMatchObject({ order_id: '964278151888836', item_count: 3, currency: 'BRL', total_price: 359 })
    expect(m.body).toContain('Pedido')
    expect(m.body).toContain('3 itens')
    expect(m.body).toMatch(/R\$\s?359/)
  })

  test('buildWhapiOrderSummary: singular/plural e sem total', () => {
    const controller = require('../controllers/webhookWhapiController')
    const { buildWhapiOrderSummary } = controller._test
    expect(buildWhapiOrderSummary({ item_count: 1, currency: 'BRL', total_price: 10 })).toContain('1 item')
    expect(buildWhapiOrderSummary({ item_count: 2 })).toContain('2 itens')
    expect(buildWhapiOrderSummary({})).toBe('🛒 Pedido recebido')
  })

  test('enrichNormalizedProduct: resolve nome/preço/imagem no catálogo e monta o body', async () => {
    const getProduct = jest.fn(async () => ({
      ok: true,
      product: { id: '7275856165856513', name: 'Cimento CP II 50kg', price: 32.9, currency: 'BRL', image: 'https://cdn/x.jpg', images: ['https://cdn/x.jpg'] },
    }))
    jest.doMock('../services/providers/whapi/catalog', () => ({ getProduct }))
    const controller = require('../controllers/webhookWhapiController')
    const normalized = controller._test.normalizeWhapiMessageToInternal({
      id: 'wamid.prod2', from_me: false, type: 'product', chat_id: '5534988887777@s.whatsapp.net',
      timestamp: 1700000000, product: { product_id: '7275856165856513', catalog_id: 'cat@s.whatsapp.net' },
    }, CTX)
    const out = await controller._test.enrichNormalizedProduct(normalized, CTX_SRC)
    expect(getProduct).toHaveBeenCalledWith('7275856165856513', { companyId: 7, whatsappInstanceId: 42 })
    expect(out.productMeta).toEqual({ id: '7275856165856513', catalog_id: 'cat@s.whatsapp.net', name: 'Cimento CP II 50kg', price: 32.9, currency: 'BRL', image: 'https://cdn/x.jpg' })
    expect(out.body).toContain('🛍️ Cimento CP II 50kg')
    expect(out.body).toMatch(/R\$\s?32,90/)
  })

  test('enrichNormalizedProduct: catálogo falha → cartão mínimo, sem derrubar o inbound', async () => {
    const getProduct = jest.fn(async () => { throw new Error('rede') })
    jest.doMock('../services/providers/whapi/catalog', () => ({ getProduct }))
    const controller = require('../controllers/webhookWhapiController')
    const normalized = controller._test.normalizeWhapiMessageToInternal({
      id: 'wamid.prod3', from_me: false, type: 'product', chat_id: '5534988887777@s.whatsapp.net',
      timestamp: 1700000000, product: { product_id: '999', catalog_id: 'cat@s.whatsapp.net' },
    }, CTX)
    const out = await controller._test.enrichNormalizedProduct(normalized, CTX_SRC)
    expect(out.productMeta).toEqual({ id: '999', catalog_id: 'cat@s.whatsapp.net', name: null, price: null, currency: null, image: null })
    expect(out.body).toBe('🛍️ Produto')
  })

  test('extractMessage repassa productMeta e mantém type product (não vira "(mídia)")', () => {
    const { extractMessage } = require('../controllers/webhookInbound/payload')
    const productMeta = { id: '7275856165856513', catalog_id: 'cat@s.whatsapp.net', name: 'Cimento CP II 50kg', price: 32.9, currency: 'BRL', image: 'https://cdn/x.jpg' }
    const extracted = extractMessage({
      type: 'ReceivedCallback', msgType: 'product',
      id: 'wamid.prod2', phone: '5534988887777',
      message: '🛍️ Cimento CP II 50kg\nR$ 32,90', text: { message: '🛍️ Cimento CP II 50kg\nR$ 32,90' },
      timestamp: 1700000000, productMeta,
    })
    expect(extracted.type).toBe('product')
    expect(extracted.productMeta).toEqual(productMeta)
    expect(extracted.texto).toContain('🛍️ Cimento')
    expect(extracted.texto).not.toBe('(mídia)')
  })

  test('applyInboundMediaFields: type product → tipo=product + reply_meta.product', () => {
    const { applyInboundMediaFields } = require('../controllers/webhookInbound/persistMensagem')
    const productMeta = { id: '1', catalog_id: 'c', name: 'X', price: 10, currency: 'BRL', image: 'https://i' }
    const insertMsg = { texto: '🛍️ X' }
    applyInboundMediaFields(insertMsg, { type: 'product', productMeta })
    expect(insertMsg.tipo).toBe('product')
    expect(insertMsg.reply_meta).toEqual({ product: productMeta })
  })
})

/**
 * Pergunta do cliente SOBRE um produto do catálogo ("product_inquiry"): o CASO REAL de produção.
 * O cliente toca num produto e manda uma mensagem → chega como type:'text' com context.quoted_type
 * 'product' + quoted_content {catalog_id, product_id}. Antes a citação virava o rótulo solto
 * "Mensagem" (e o toque dava "não encontrada"). Agora a citação mostra o cartão do produto.
 * Shape confirmado no webhook_logs de produção (ids 2230886 "Samara", 2199003).
 */
describe('Whapi inbound — pergunta sobre produto (product_inquiry / citação)', () => {
  const CTX = { channelId: 'HULKBR-NZCYL', connectedPhone: '553498630553' }
  const CTX_SRC = { company_id: 7, whatsapp_instance_id: 42 }

  afterEach(() => jest.resetModules())

  // Mensagem real (Samara): texto citando o produto do catálogo.
  const inquiryMsg = (overrides = {}) => ({
    id: 'KqTSdhCL_D4Kvg-hdUEHgkAIPs',
    from: '556184262566',
    from_me: false,
    from_name: 'Samara',
    type: 'text',
    text: { body: 'Alugaria?' },
    chat_id: '556184262566@s.whatsapp.net',
    timestamp: 1793968998,
    context: {
      quoted_id: 'product_inquiry',
      quoted_type: 'product',
      quoted_author: '553498630553@s.whatsapp.net',
      quoted_content: { catalog_id: '553498630553@s.whatsapp.net', product_id: '27084234967920949' },
    },
    ...overrides,
  })

  function normalize(m) {
    const controller = require('../controllers/webhookWhapiController')
    return controller._test.normalizeWhapiMessageToInternal(m, CTX)
  }

  test('texto citando produto → quotedProductRef (NÃO productRef) e o texto do cliente é preservado', () => {
    const m = normalize(inquiryMsg())
    expect(m.type).toBe('chat')                 // segue sendo texto do cliente
    expect(m.body).toBe('Alugaria?')            // a pergunta não é descartada nem sobrescrita
    expect(m.productRef).toBeUndefined()        // não é um type:'product'
    expect(m.quotedProductRef).toEqual({ catalog_id: '553498630553@s.whatsapp.net', product_id: '27084234967920949' })
  })

  test('enrichQuotedProduct: resolve o produto citado no catálogo e preserva o texto da pergunta', async () => {
    const getProduct = jest.fn(async () => ({
      ok: true,
      product: { id: '27084234967920949', name: 'Apartamento Centro', price: 1200, currency: 'BRL', image: 'https://cdn/apt.jpg' },
    }))
    jest.doMock('../services/providers/whapi/catalog', () => ({ getProduct }))
    const controller = require('../controllers/webhookWhapiController')
    const normalized = controller._test.normalizeWhapiMessageToInternal(inquiryMsg(), CTX)
    const out = await controller._test.enrichQuotedProduct(normalized, CTX_SRC)
    expect(getProduct).toHaveBeenCalledWith('27084234967920949', { companyId: 7, whatsappInstanceId: 42 })
    expect(out.quotedProduct).toEqual({ id: '27084234967920949', catalog_id: '553498630553@s.whatsapp.net', name: 'Apartamento Centro', price: 1200, currency: 'BRL', image: 'https://cdn/apt.jpg' })
    expect(out.body).toBe('Alugaria?') // texto do cliente intacto
  })

  test('enrichQuotedProduct: pergunta SEM texto → corpo recebe o resumo do produto (não é descartada)', async () => {
    const getProduct = jest.fn(async () => ({
      ok: true, product: { id: '27084234967920949', name: 'Apartamento Centro', price: 1200, currency: 'BRL', image: 'https://cdn/apt.jpg' },
    }))
    jest.doMock('../services/providers/whapi/catalog', () => ({ getProduct }))
    const controller = require('../controllers/webhookWhapiController')
    const normalized = controller._test.normalizeWhapiMessageToInternal(inquiryMsg({ text: { body: '' } }), CTX)
    const out = await controller._test.enrichQuotedProduct(normalized, CTX_SRC)
    expect(out.body).toContain('🛍️ Apartamento Centro')
    expect(out.body).toMatch(/R\$\s?1\.200,00/)
  })

  test('enrichQuotedProduct: catálogo falha → cartão mínimo, pergunta preservada, sem derrubar o inbound', async () => {
    const getProduct = jest.fn(async () => { throw new Error('rede') })
    jest.doMock('../services/providers/whapi/catalog', () => ({ getProduct }))
    const controller = require('../controllers/webhookWhapiController')
    const normalized = controller._test.normalizeWhapiMessageToInternal(inquiryMsg(), CTX)
    const out = await controller._test.enrichQuotedProduct(normalized, CTX_SRC)
    expect(out.quotedProduct).toEqual({ id: '27084234967920949', catalog_id: '553498630553@s.whatsapp.net', name: null, price: null, currency: null, image: null })
    expect(out.body).toBe('Alugaria?')
  })

  test('buildWebhookReplyMeta: payload.quotedProduct → citação vira cartão (thumb+nome+preço), sem replyToId', async () => {
    const { buildWebhookReplyMeta } = require('../controllers/webhookInbound/replyMeta')
    const payload = {
      quotedProduct: { id: '27084234967920949', catalog_id: 'c', name: 'Apartamento Centro', price: 1200, currency: 'BRL', image: 'https://cdn/apt.jpg' },
    }
    // supabase nunca é tocado: o ramo de produto retorna antes de qualquer query.
    const supabaseStub = { from: () => { throw new Error('não deveria consultar o banco') } }
    const meta = await buildWebhookReplyMeta(supabaseStub, { payload, company_id: 7, conversa_id: 1, whatsapp_instance_id: 42 })
    expect(meta.name).toBe('🛍️ Apartamento Centro')
    expect(meta.snippet).toMatch(/R\$\s?1\.200,00/)
    expect(meta.thumb).toBe('https://cdn/apt.jpg')
    expect(meta.reply_kind).toBe('product')
    expect(meta.replyToId).toBeUndefined() // produto não é mensagem na thread → sem toque "não encontrada"
  })

  test('buildWebhookReplyMeta: sem quotedProduct segue o fluxo normal (não quebra o reply comum)', async () => {
    const { buildWebhookReplyMeta } = require('../controllers/webhookInbound/replyMeta')
    const meta = await buildWebhookReplyMeta(null, { payload: {}, company_id: 7, conversa_id: 1, whatsapp_instance_id: 42 })
    expect(meta).toBeNull() // sem citação nenhuma → null, como antes
  })
})

/**
 * Pedido (carrinho) recebido do cliente pelo catálogo (Whapi type 'order'). O webhook traz só o
 * agregado + token; os ITENS vêm por GET /business/orders/{id}?order_token=…. Agora o pedido vira um
 * cartão (OrderMessage) com foto + nome + qtd + preço por item e o total. Shape confirmado 2026-11-10.
 */
describe('Whapi inbound — pedido (order) do catálogo', () => {
  const CTX = { channelId: 'HULKBR-NZCYL', connectedPhone: '553498630553' }
  const CTX_SRC = { company_id: 7, whatsapp_instance_id: 42 }

  afterEach(() => jest.resetModules())

  const orderMsg = (overrides = {}) => ({
    id: 'ORDER1', from: '556184262566', from_me: false, from_name: 'Daniele',
    type: 'order', chat_id: '556184262566@s.whatsapp.net', timestamp: 1700000000,
    order: {
      order_id: '964278151888836', seller: '553498630553', title: 'Daniele',
      token: 'AR4ToE6jF7HwiKY8cUChFb+h6Blgb0sbRMOY3vwRHhsaeg==',
      item_count: 1, currency: 'BRL', total_price: 1000, status: 'new',
      preview: 'data:image/jpeg;base64,/9j/XYZ',
    },
    ...overrides,
  })

  function normalize(m) {
    const controller = require('../controllers/webhookWhapiController')
    return controller._test.normalizeWhapiMessageToInternal(m, CTX)
  }

  test('type "order" → internalType order + orderRef (id, token, preview) + resumo no body', () => {
    const m = normalize(orderMsg())
    expect(m.type).toBe('order')
    expect(m.productRef).toBeUndefined()
    expect(m.orderRef).toMatchObject({
      order_id: '964278151888836',
      token: 'AR4ToE6jF7HwiKY8cUChFb+h6Blgb0sbRMOY3vwRHhsaeg==',
      item_count: 1, currency: 'BRL', total_price: 1000, preview: 'data:image/jpeg;base64,/9j/XYZ',
    })
    expect(m.body).toContain('Pedido recebido')
    expect(m.body).toMatch(/R\$\s?1\.000,00/)
  })

  test('enrichNormalizedOrder: busca itens e monta orderMeta com nomes no body', async () => {
    const getOrder = jest.fn(async () => ({
      ok: true,
      items: [
        { product_retailer_id: '27343291311970176', name: 'Apartamento Centro', image: 'https://cdn/apt.jpg', quantity: 1, price: 1000, currency: 'BRL' },
      ],
    }))
    jest.doMock('../services/providers/whapi/orders', () => ({ getOrder, normalizeOrderItem: (x) => x }))
    const controller = require('../controllers/webhookWhapiController')
    const normalized = controller._test.normalizeWhapiMessageToInternal(orderMsg(), CTX)
    const out = await controller._test.enrichNormalizedOrder(normalized, CTX_SRC)
    expect(getOrder).toHaveBeenCalledWith('964278151888836', expect.objectContaining({
      orderToken: 'AR4ToE6jF7HwiKY8cUChFb+h6Blgb0sbRMOY3vwRHhsaeg==', companyId: 7, whatsappInstanceId: 42,
    }))
    expect(out.orderMeta.items).toHaveLength(1)
    expect(out.orderMeta.items[0]).toMatchObject({ name: 'Apartamento Centro', image: 'https://cdn/apt.jpg', quantity: 1, price: 1000 })
    expect(out.orderMeta.preview).toBe('data:image/jpeg;base64,/9j/XYZ')
    expect(out.body).toContain('• Apartamento Centro')
  })

  test('enrichNormalizedOrder: busca falha → orderMeta sem itens mas com resumo+preview (não derruba)', async () => {
    const getOrder = jest.fn(async () => ({ ok: false, error: 'need order token', items: [] }))
    jest.doMock('../services/providers/whapi/orders', () => ({ getOrder, normalizeOrderItem: (x) => x }))
    const controller = require('../controllers/webhookWhapiController')
    const normalized = controller._test.normalizeWhapiMessageToInternal(orderMsg(), CTX)
    const out = await controller._test.enrichNormalizedOrder(normalized, CTX_SRC)
    expect(out.orderMeta.items).toEqual([])
    expect(out.orderMeta.item_count).toBe(1)
    expect(out.orderMeta.preview).toBe('data:image/jpeg;base64,/9j/XYZ')
    expect(out.body).toContain('Pedido recebido')
  })

  test('extractMessage repassa orderMeta e mantém type order (não vira "(mídia)")', () => {
    const { extractMessage } = require('../controllers/webhookInbound/payload')
    const orderMeta = { order_id: '1', item_count: 1, total_price: 1000, currency: 'BRL', title: 'Daniele', preview: 'data:image/jpeg;base64,X', items: [{ name: 'Apto', price: 1000, currency: 'BRL', quantity: 1, image: 'https://i' }] }
    const extracted = extractMessage({
      type: 'ReceivedCallback', msgType: 'order', id: 'ORDER1', phone: '556184262566',
      message: '🛒 Pedido recebido • 1 item • R$ 1.000,00', text: { message: '🛒 Pedido recebido • 1 item • R$ 1.000,00' },
      timestamp: 1700000000, orderMeta,
    })
    expect(extracted.type).toBe('order')
    expect(extracted.orderMeta).toEqual(orderMeta)
    expect(extracted.texto).toContain('Pedido recebido')
    expect(extracted.texto).not.toBe('(mídia)')
  })

  test('applyInboundMediaFields: type order → tipo=order + reply_meta.order', () => {
    const { applyInboundMediaFields } = require('../controllers/webhookInbound/persistMensagem')
    const orderMeta = { order_id: '1', item_count: 1, total_price: 1000, currency: 'BRL', preview: 'data:image/jpeg;base64,X', items: [{ name: 'Apto', price: 1000, quantity: 1, image: 'https://i' }] }
    const insertMsg = { texto: '🛒 Pedido recebido' }
    applyInboundMediaFields(insertMsg, { type: 'order', orderMeta })
    expect(insertMsg.tipo).toBe('order')
    expect(insertMsg.reply_meta).toEqual({ order: orderMeta })
  })

  test('orders.normalizeOrderItem: normaliza campos e defaults (quantity≥1, image só http/data)', () => {
    // requireActual: testes anteriores deste bloco dão doMock em orders (identidade) — aqui queremos o real.
    const { normalizeOrderItem } = jest.requireActual('../services/providers/whapi/orders')
    expect(normalizeOrderItem({ product_retailer_id: '9', name: 'X', image: 'https://i/x.jpg', quantity: 2, price: 50, currency: 'BRL' }))
      .toEqual({ product_retailer_id: '9', name: 'X', image: 'https://i/x.jpg', quantity: 2, price: 50, currency: 'BRL' })
    // sem quantity → 1; sem image → null
    expect(normalizeOrderItem({ name: 'Y' })).toMatchObject({ name: 'Y', quantity: 1, image: null, price: null })
  })
})
