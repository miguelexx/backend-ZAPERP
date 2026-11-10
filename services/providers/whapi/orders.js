/**
 * Pedidos (carrinho) do WhatsApp Business (Whapi) — leitura dos ITENS de um pedido recebido.
 *   GET /business/orders/{OrderID}?order_token={token}
 *     → { items: [ { product_retailer_id, name, image, quantity, price, currency } ] }
 *
 * O webhook de pedido (type 'order') só traz o agregado (order_id, token, item_count, total_price,
 * currency, preview) — os NOMES/PREÇOS/IMAGENS dos itens só vêm por este método (contrato Whapi,
 * confirmado 2026-11-10). `order_token` é base64 e vai na query; o token do canal vai no Bearer.
 * Leitura pura — não dispara nada no WhatsApp. UltraMSG não tem catálogo/pedido (não implementa).
 */

const { get } = require('./http')
const { resolveConfig } = require('./config')

/** Normaliza um item do pedido para formato estável (espelha o cartão de produto). */
function normalizeOrderItem(it) {
  if (!it || typeof it !== 'object') return null
  const price = Number(it.price)
  const quantity = Number(it.quantity)
  const retailerId = it.product_retailer_id != null ? String(it.product_retailer_id)
    : (it.id != null ? String(it.id) : null)
  return {
    product_retailer_id: retailerId,
    name: it.name != null ? String(it.name) : '',
    image: (typeof it.image === 'string' && it.image.trim()) ? it.image.trim() : null,
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    price: Number.isFinite(price) ? price : null,
    currency: it.currency != null ? String(it.currency) : null,
  }
}

/**
 * Itens de um pedido. GET /business/orders/{OrderID}?order_token=… → { ok, items }.
 * `opts`: { orderToken, companyId, whatsappInstanceId }. Falha devolve { ok:false, items:[] }
 * (o chamador cai no resumo + preview — nunca derruba o inbound).
 */
async function getOrder(orderId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada', items: [] }
  const id = String(orderId ?? '').trim()
  if (!id) return { ok: false, error: 'OrderID é obrigatório.', items: [] }
  const orderToken = String(opts.orderToken ?? opts.order_token ?? '').trim()
  try {
    const { ok, status, data, text } = await get({
      token: cfg.token,
      endpoint: `/business/orders/${encodeURIComponent(id)}`,
      extraParams: orderToken ? { order_token: orderToken } : {},
    })
    if (!ok || data?.error) {
      const msg = data?.error?.message
        || (typeof data?.message === 'string' ? data.message : null)
        || (typeof text === 'string' && text.trim() ? text.trim() : null)
        || `HTTP ${status}`
      return { ok: false, httpStatus: Number(status) || null, error: String(msg), items: [] }
    }
    const raw = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : [])
    return { ok: true, items: raw.map(normalizeOrderItem).filter(Boolean), httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao ler itens do pedido (Whapi): ${e?.message || e}`, items: [] }
  }
}

module.exports = { getOrder, normalizeOrderItem }
