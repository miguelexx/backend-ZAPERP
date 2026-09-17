/**
 * Catálogo WhatsApp Business (Whapi) — leitura da vitrine da empresa (produtos + coleções).
 * GET /business/products                       → lista os produtos do catálogo
 * GET /business/products/{ProductID}           → um produto
 * GET /business/collections                    → lista as coleções (categorias)
 * GET /business/collections/{CollectionID}     → uma coleção (com até 10 produtos)
 * GET /business/collections/{CollectionID}/products → produtos de uma coleção
 * GET /business/contacts/{ChatID}/products      → catálogo/produtos de um contato qualquer
 *
 * Só leitura: não dispara WhatsApp (skipSendGuard). Contrato confirmado via OpenAPI Whapi
 * + MCP (2026-09-17). Catálogo é recurso exclusivo de conta WhatsApp Business — 500 opaco em
 * conta comum é traduzido para 422 acionável (mesmo padrão de business.js). Ver doc 25.
 * UltraMSG não tem catálogo (não implementa).
 */

const { get, post, patch, del } = require('./http')
const { resolveConfig } = require('./config')
const { getConnectionStatus } = require('./instanceAdmin')
const { toWhapiChatId } = require('./phones')

const MAX_COUNT = 500
const DEFAULT_COUNT = 100

function cfgMissing() {
  return { ok: false, error: 'Instância Whapi não configurada' }
}

function apiError(status, data, text) {
  const providerError = data?.error
  const message = providerError?.message
    || (typeof providerError === 'string' ? providerError : null)
    || (typeof data?.message === 'string' ? data.message : null)
    || (typeof text === 'string' && text.trim() ? text.trim() : null)
    || `HTTP ${status}`
  return {
    ok: false,
    httpStatus: Number(status) || null,
    providerCode: providerError?.code ?? data?.code ?? null,
    providerDetails: providerError?.details ?? data?.details ?? null,
    error: String(message),
  }
}

function isOpaqueInternalError(result) {
  return Number(result?.httpStatus) >= 500 && /^internal error$/i.test(String(result?.error || '').trim())
}

/**
 * A Whapi responde 500 "Internal Error" para recursos Business (inclui catálogo) quando o canal
 * está autenticado com uma conta WhatsApp comum. /health informa isso em user.is_business.
 * Traduz para 422 acionável (mesmo código que o frontend já trata em business.js).
 */
async function diagnoseCatalogFailure(result, opts) {
  if (!isOpaqueInternalError(result)) return result
  try {
    const health = await getConnectionStatus({ ...opts, wakeup: false })
    if (health?.connected && health?.isBusiness === false) {
      return {
        ...result,
        httpStatus: 422,
        code: 'WHAPI_BUSINESS_ACCOUNT_REQUIRED',
        error: 'Este canal está conectado a uma conta WhatsApp comum. Use uma conta WhatsApp Business com catálogo para acessar os produtos.',
      }
    }
  } catch {}
  return {
    ...result,
    code: result.code || 'WHAPI_INTERNAL_ERROR',
    error: 'A Whapi retornou um erro interno ao acessar o catálogo. Tente novamente; se persistir, verifique o canal no painel da Whapi.',
  }
}

/** Normaliza um produto para um formato estável (espelha o cartão de produto do WhatsApp). */
function normalizeProduct(p) {
  if (!p || typeof p !== 'object') return null
  const images = Array.isArray(p.images)
    ? p.images.map((img) => (typeof img === 'string' ? img : (img?.link || img?.url || img?.id || null))).filter(Boolean)
    : []
  const price = Number(p.price)
  const salePrice = Number(p.sale_price)
  return {
    id: p.id != null ? String(p.id) : null,
    name: p.name != null ? String(p.name) : '',
    description: p.description != null ? String(p.description) : '',
    price: Number.isFinite(price) ? price : null,
    sale_price: Number.isFinite(salePrice) ? salePrice : undefined,
    currency: p.currency != null ? String(p.currency) : null,
    availability: p.availability != null ? String(p.availability) : null,
    images,
    image: images[0] || null,
    product_retailer_id: p.product_retailer_id != null ? String(p.product_retailer_id) : null,
    url: p.url != null ? String(p.url) : null,
    is_hidden: typeof p.is_hidden === 'boolean' ? p.is_hidden : undefined,
    review: p.review ?? undefined,
  }
}

/** Normaliza uma coleção (categoria) com seus produtos aninhados. */
function normalizeCollection(c) {
  if (!c || typeof c !== 'object') return null
  const products = Array.isArray(c.products) ? c.products.map(normalizeProduct).filter(Boolean) : []
  return {
    id: c.id != null ? String(c.id) : null,
    name: c.name != null ? String(c.name) : '',
    status: c.status != null ? String(c.status) : undefined,
    products,
    products_count: Number.isFinite(Number(c.products_count)) ? Number(c.products_count) : products.length,
  }
}

/** Clampa count/offset para os limites da API (count 1..500, offset ≥ 0). */
function pagingParams({ count, offset } = {}) {
  const params = {}
  const c = Number(count)
  if (Number.isFinite(c) && c > 0) params.count = Math.min(Math.trunc(c), MAX_COUNT)
  else params.count = DEFAULT_COUNT
  const o = Number(offset)
  if (Number.isFinite(o) && o > 0) params.offset = Math.trunc(o)
  return params
}

/** Extrai o rodapé de paginação padrão da Whapi ({ count, total, offset }). */
function pagingMeta(data) {
  return {
    count: Number.isFinite(Number(data?.count)) ? Number(data.count) : undefined,
    total: Number.isFinite(Number(data?.total)) ? Number(data.total) : undefined,
    offset: Number.isFinite(Number(data?.offset)) ? Number(data.offset) : undefined,
  }
}

/** Lista os produtos do catálogo. GET /business/products → { ok, products, ...paging }. */
async function getProducts(params = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ...cfgMissing(), products: [] }
  try {
    const { ok, status, data, text } = await get({
      token: cfg.token,
      endpoint: '/business/products',
      extraParams: pagingParams(params),
    })
    if (!ok || data?.error) return { ...(await diagnoseCatalogFailure(apiError(status, data, text), opts)), products: [] }
    const raw = Array.isArray(data?.products) ? data.products : (Array.isArray(data) ? data : [])
    return { ok: true, products: raw.map(normalizeProduct).filter(Boolean), ...pagingMeta(data), httpStatus: status }
  } catch (e) {
    return { ok: false, products: [], error: `Falha de conexão ao listar produtos (Whapi): ${e?.message || e}` }
  }
}

/** Um produto por ID. GET /business/products/{ProductID} → { ok, product }. */
async function getProduct(productId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const id = String(productId ?? '').trim()
  if (!id) return { ok: false, error: 'ProductID é obrigatório.' }
  try {
    const { ok, status, data, text } = await get({
      token: cfg.token,
      endpoint: `/business/products/${encodeURIComponent(id)}`,
    })
    if (!ok || data?.error) return diagnoseCatalogFailure(apiError(status, data, text), opts)
    return { ok: true, product: normalizeProduct(data?.product || data), httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao ler produto (Whapi): ${e?.message || e}` }
  }
}

/** Lista as coleções (categorias) do catálogo. GET /business/collections → { ok, collections, ...paging }. */
async function getCollections(params = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ...cfgMissing(), collections: [] }
  try {
    const { ok, status, data, text } = await get({
      token: cfg.token,
      endpoint: '/business/collections',
      extraParams: pagingParams(params),
    })
    if (!ok || data?.error) return { ...(await diagnoseCatalogFailure(apiError(status, data, text), opts)), collections: [] }
    const raw = Array.isArray(data?.collections) ? data.collections : (Array.isArray(data) ? data : [])
    return { ok: true, collections: raw.map(normalizeCollection).filter(Boolean), ...pagingMeta(data), httpStatus: status }
  } catch (e) {
    return { ok: false, collections: [], error: `Falha de conexão ao listar coleções (Whapi): ${e?.message || e}` }
  }
}

/** Uma coleção por ID (com produtos). GET /business/collections/{CollectionID} → { ok, collection }. */
async function getCollection(collectionId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const id = String(collectionId ?? '').trim()
  if (!id) return { ok: false, error: 'CollectionID é obrigatório.' }
  try {
    const { ok, status, data, text } = await get({
      token: cfg.token,
      endpoint: `/business/collections/${encodeURIComponent(id)}`,
    })
    if (!ok || data?.error) return diagnoseCatalogFailure(apiError(status, data, text), opts)
    return { ok: true, collection: normalizeCollection(data?.collection || data), httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao ler coleção (Whapi): ${e?.message || e}` }
  }
}

/** Produtos de uma coleção. GET /business/collections/{CollectionID}/products → { ok, products }. */
async function getCollectionProducts(collectionId, params = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ...cfgMissing(), products: [] }
  const id = String(collectionId ?? '').trim()
  if (!id) return { ok: false, error: 'CollectionID é obrigatório.', products: [] }
  const extraParams = {}
  const pc = Number(params?.products_count)
  if (Number.isFinite(pc) && pc > 0) extraParams.products_count = Math.min(Math.trunc(pc), MAX_COUNT)
  try {
    const { ok, status, data, text } = await get({
      token: cfg.token,
      endpoint: `/business/collections/${encodeURIComponent(id)}/products`,
      extraParams,
    })
    if (!ok || data?.error) return { ...(await diagnoseCatalogFailure(apiError(status, data, text), opts)), products: [] }
    const raw = Array.isArray(data?.products) ? data.products : (Array.isArray(data) ? data : [])
    return { ok: true, products: raw.map(normalizeProduct).filter(Boolean), ...pagingMeta(data), httpStatus: status }
  } catch (e) {
    return { ok: false, products: [], error: `Falha de conexão ao listar produtos da coleção (Whapi): ${e?.message || e}` }
  }
}

/**
 * Catálogo de um contato qualquer (mesmo fora da agenda). GET /business/contacts/{ChatID}/products.
 * `contact` aceita telefone (dígitos) ou chat id (…@s.whatsapp.net) — normalizado para ChatID.
 */
async function getContactProducts(contact, params = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ...cfgMissing(), products: [] }
  const chatId = toWhapiChatId(contact)
  if (!chatId) return { ok: false, error: 'Contato inválido para consultar catálogo.', products: [] }
  try {
    const { ok, status, data, text } = await get({
      token: cfg.token,
      endpoint: `/business/contacts/${encodeURIComponent(chatId)}/products`,
      extraParams: pagingParams(params),
    })
    if (!ok || data?.error) return { ...apiError(status, data, text), products: [] }
    const raw = Array.isArray(data?.products) ? data.products : (Array.isArray(data) ? data : [])
    return { ok: true, products: raw.map(normalizeProduct).filter(Boolean), ...pagingMeta(data), httpStatus: status }
  } catch (e) {
    return { ok: false, products: [], error: `Falha de conexão ao consultar catálogo do contato (Whapi): ${e?.message || e}` }
  }
}

// ------------------------------- Escrita (gestão do catálogo) -------------------------------

const AVAILABILITY = new Set(['in stock', 'out of stock'])

/** Monta o corpo de um produto validando os campos que o WhatsApp exige. */
function buildProductBody(payload = {}, { requireCore = true } = {}) {
  const body = {}
  const name = payload.name != null ? String(payload.name).trim() : undefined
  const description = payload.description != null ? String(payload.description).trim() : undefined
  const currency = payload.currency != null ? String(payload.currency).trim().toUpperCase() : undefined
  const price = payload.price != null && payload.price !== '' ? Number(payload.price) : undefined
  const images = Array.isArray(payload.images)
    ? payload.images.map((v) => String(v || '').trim()).filter(Boolean)
    : undefined

  if (name !== undefined) body.name = name
  if (description !== undefined) body.description = description
  if (currency !== undefined) body.currency = currency
  if (price !== undefined) {
    if (!Number.isFinite(price) || price < 0) return { error: 'price deve ser um número ≥ 0.' }
    body.price = price
  }
  if (images !== undefined) body.images = images
  if (payload.availability != null && payload.availability !== '') {
    const av = String(payload.availability).trim().toLowerCase()
    if (!AVAILABILITY.has(av)) return { error: "availability deve ser 'in stock' ou 'out of stock'." }
    body.availability = av
  }
  if (payload.product_retailer_id != null) body.product_retailer_id = String(payload.product_retailer_id).trim()
  if (payload.url != null) body.url = String(payload.url).trim()
  if (typeof payload.is_hidden === 'boolean') body.is_hidden = payload.is_hidden

  if (requireCore) {
    const missing = ['name', 'description', 'currency'].filter((k) => !body[k])
    if (missing.length) return { error: `Campos obrigatórios: ${missing.join(', ')}.` }
    if (body.price == null) return { error: 'price é obrigatório.' }
    if (!Array.isArray(body.images) || body.images.length < 1) return { error: 'Envie ao menos 1 imagem (URL).' }
  }
  return { body }
}

/** Cria um produto no catálogo. POST /business/products → { ok, product }. */
async function createProduct(payload = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const built = buildProductBody(payload, { requireCore: true })
  if (built.error) return { ok: false, error: built.error }
  try {
    const { ok, status, data, text } = await post({
      token: cfg.token,
      endpoint: '/business/products',
      body: built.body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error || data?.success === false) return diagnoseCatalogFailure(apiError(status, data, text), opts)
    return { ok: true, product: normalizeProduct(data?.product || data), httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao criar produto (Whapi): ${e?.message || e}` }
  }
}

/**
 * Atualiza um produto. PATCH /business/products/{ProductID}.
 * A Whapi exige o array `images` completo em toda atualização (substitui todas).
 */
async function updateProduct(productId, payload = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const id = String(productId ?? '').trim()
  if (!id) return { ok: false, error: 'ProductID é obrigatório.' }
  const built = buildProductBody(payload, { requireCore: false })
  if (built.error) return { ok: false, error: built.error }
  if (!Array.isArray(built.body.images) || built.body.images.length < 1) {
    return { ok: false, error: 'A Whapi exige o array completo de imagens na atualização (ao menos 1 URL).' }
  }
  try {
    const { ok, status, data, text } = await patch({
      token: cfg.token,
      endpoint: `/business/products/${encodeURIComponent(id)}`,
      body: built.body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error || data?.success === false) return diagnoseCatalogFailure(apiError(status, data, text), opts)
    return { ok: true, product: normalizeProduct(data?.product || data) || undefined, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao atualizar produto (Whapi): ${e?.message || e}` }
  }
}

/** Exclui um produto. DELETE /business/products/{ProductID}. */
async function deleteProduct(productId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const id = String(productId ?? '').trim()
  if (!id) return { ok: false, error: 'ProductID é obrigatório.' }
  try {
    const { ok, status, data, text } = await del({
      token: cfg.token,
      endpoint: `/business/products/${encodeURIComponent(id)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error || data?.success === false) return diagnoseCatalogFailure(apiError(status, data, text), opts)
    return { ok: true, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao excluir produto (Whapi): ${e?.message || e}` }
  }
}

/** Cria uma coleção. POST /business/collections { name, products: [ids] } → { ok, collection }. */
async function createCollection(payload = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const name = String(payload?.name ?? '').trim()
  if (!name) return { ok: false, error: 'name da coleção é obrigatório.' }
  const products = Array.isArray(payload?.products)
    ? payload.products.map((v) => String(v || '').trim()).filter(Boolean)
    : []
  try {
    const { ok, status, data, text } = await post({
      token: cfg.token,
      endpoint: '/business/collections',
      body: { name, products },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error || data?.success === false) return diagnoseCatalogFailure(apiError(status, data, text), opts)
    return { ok: true, collection: normalizeCollection(data?.collection || data) || undefined, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao criar coleção (Whapi): ${e?.message || e}` }
  }
}

/**
 * Edita uma coleção. PATCH /business/collections/{CollectionID}.
 * fields: { name?, add_products?: string[], remove_products?: string[] }.
 */
async function editCollection(collectionId, fields = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const id = String(collectionId ?? '').trim()
  if (!id) return { ok: false, error: 'CollectionID é obrigatório.' }
  const body = {}
  if (fields?.name != null && String(fields.name).trim()) body.name = String(fields.name).trim()
  const addP = Array.isArray(fields?.add_products) ? fields.add_products.map((v) => String(v || '').trim()).filter(Boolean) : []
  const remP = Array.isArray(fields?.remove_products) ? fields.remove_products.map((v) => String(v || '').trim()).filter(Boolean) : []
  if (addP.length) body.add_products = addP
  if (remP.length) body.remove_products = remP
  if (!Object.keys(body).length) return { ok: false, error: 'Nenhuma alteração informada (name, add_products ou remove_products).' }
  try {
    const { ok, status, data, text } = await patch({
      token: cfg.token,
      endpoint: `/business/collections/${encodeURIComponent(id)}`,
      body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error || data?.success === false) return diagnoseCatalogFailure(apiError(status, data, text), opts)
    return { ok: true, collection: normalizeCollection(data?.collection || data) || undefined, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao editar coleção (Whapi): ${e?.message || e}` }
  }
}

/** Exclui uma coleção. DELETE /business/collections/{CollectionID}. */
async function deleteCollection(collectionId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const id = String(collectionId ?? '').trim()
  if (!id) return { ok: false, error: 'CollectionID é obrigatório.' }
  try {
    const { ok, status, data, text } = await del({
      token: cfg.token,
      endpoint: `/business/collections/${encodeURIComponent(id)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error || data?.success === false) return diagnoseCatalogFailure(apiError(status, data, text), opts)
    return { ok: true, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao excluir coleção (Whapi): ${e?.message || e}` }
  }
}

module.exports = {
  getProducts,
  getProduct,
  getCollections,
  getCollection,
  getCollectionProducts,
  getContactProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  createCollection,
  editCollection,
  deleteCollection,
  // exportados para teste unitário
  normalizeProduct,
  normalizeCollection,
  buildProductBody,
}
