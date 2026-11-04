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

  test('type "order" vira resumo de texto (agregado) — nunca vazio', () => {
    const m = normalize({
      id: 'wamid.order1',
      from_me: false,
      type: 'order',
      chat_id: '5534988887777@s.whatsapp.net',
      from_name: 'Cliente',
      timestamp: 1700000000,
      order: { order_id: '964278151888836', item_count: 3, currency: 'BRL', total_price: 359, status: 'new' },
    })
    expect(m.type).toBe('chat') // sem cartão por item (a API Whapi não envia os itens)
    expect(m.productRef).toBeUndefined()
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
