/**
 * Labels do WhatsApp Business (Whapi) — casam com tags/kanban do CRM e refletem no celular.
 * GET    /labels                        → lista { id, name, color, count }
 * POST   /labels        { id, name, color }  → cria
 * PATCH  /labels/{LabelID} { name }     → renomeia
 * DELETE /labels/{LabelID}              → apaga
 * GET    /labels/{LabelID}              → chats/mensagens associados ao label
 * POST   /labels/{LabelID}/{ChatID}     → associa label a um chat
 * DELETE /labels/{LabelID}/{ChatID}     → remove associação
 *
 * Só leitura/gestão de labels: não dispara WhatsApp (skipSendGuard). Contrato confirmado via
 * OpenAPI Whapi + MCP (2026-09-08). Ver doc 25 §30. UltraMSG não tem labels (não implementa).
 */

const { get, post, patch, del } = require('./http')
const { resolveConfig } = require('./config')
const { toWhapiChatId } = require('./phones')

// 20 cores predefinidas do WhatsApp Business (OpenAPI Whapi). Fora dessa lista o WhatsApp recusa.
const LABEL_COLORS = new Set([
  'salmon', 'lightskyblue', 'gold', 'plum', 'silver', 'mediumturquoise', 'violet',
  'goldenrod', 'cornflowerblue', 'greenyellow', 'cyan', 'lightpink', 'mediumaquamarine',
  'orangered', 'deepskyblue', 'limegreen', 'darkorange', 'lightsteelblue', 'mediumpurple',
  'rebeccapurple',
])

const LABEL_ID_RE = /^\d{1,2}$/

function cfgMissing() {
  return { ok: false, error: 'Instância Whapi não configurada' }
}

function apiError(status, data) {
  return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
}

function normalizeLabel(l) {
  if (!l || typeof l !== 'object') return null
  return {
    id: l.id != null ? String(l.id) : null,
    name: l.name != null ? String(l.name) : '',
    color: l.color != null ? String(l.color) : null,
    count: Number.isFinite(Number(l.count)) ? Number(l.count) : undefined,
  }
}

/**
 * Lista os labels do WhatsApp Business. GET /labels → array. Retorna { ok, labels }.
 */
async function getLabels(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ...cfgMissing(), labels: [] }
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: '/labels' })
    if (!ok || data?.error) return { ...apiError(status, data), labels: [] }
    const raw = Array.isArray(data) ? data : (Array.isArray(data?.labels) ? data.labels : [])
    return { ok: true, labels: raw.map(normalizeLabel).filter(Boolean), httpStatus: status }
  } catch (e) {
    return { ok: false, labels: [], error: `Falha de conexão ao listar labels (Whapi): ${e?.message || e}` }
  }
}

/**
 * Cria um label. POST /labels { id, name, color }.
 * `id` (1-2 dígitos) é opcional — omitido, o WhatsApp atribui. `color` deve ser uma das 20 cores válidas.
 */
async function createLabel(payload = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const name = String(payload?.name ?? '').trim()
  if (!name) return { ok: false, error: 'name do label é obrigatório.' }
  const color = String(payload?.color ?? '').trim().toLowerCase()
  if (!color) return { ok: false, error: 'color do label é obrigatória.' }
  if (!LABEL_COLORS.has(color)) {
    return { ok: false, error: `color inválida. Use uma de: ${[...LABEL_COLORS].join(', ')}` }
  }
  const body = { name, color }
  if (payload?.id != null && String(payload.id).trim() !== '') {
    const id = String(payload.id).trim()
    if (!LABEL_ID_RE.test(id)) return { ok: false, error: 'id do label deve ter 1-2 dígitos.' }
    body.id = id
  } else {
    // O schema Whapi exige o campo id (aceita string vazia = auto-atribuição).
    body.id = ''
  }
  try {
    const { ok, status, data } = await post({
      token: cfg.token,
      endpoint: '/labels',
      body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error || data?.success === false) return apiError(status, data)
    return { ok: true, httpStatus: status, label: normalizeLabel(data?.label || data) || undefined }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao criar label (Whapi): ${e?.message || e}` }
  }
}

/**
 * Renomeia um label. PATCH /labels/{LabelID} { name }.
 */
async function renameLabel(labelId, name, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const id = String(labelId ?? '').trim()
  if (!id) return { ok: false, error: 'LabelID é obrigatório.' }
  const nome = String(name ?? '').trim()
  if (!nome) return { ok: false, error: 'name é obrigatório.' }
  try {
    const { ok, status, data } = await patch({
      token: cfg.token,
      endpoint: `/labels/${encodeURIComponent(id)}`,
      body: { name: nome },
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error || data?.success === false) return apiError(status, data)
    return { ok: true, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao renomear label (Whapi): ${e?.message || e}` }
  }
}

/**
 * Apaga um label. DELETE /labels/{LabelID}.
 */
async function deleteLabel(labelId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const id = String(labelId ?? '').trim()
  if (!id) return { ok: false, error: 'LabelID é obrigatório.' }
  try {
    const { ok, status, data } = await del({
      token: cfg.token,
      endpoint: `/labels/${encodeURIComponent(id)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error || data?.success === false) return apiError(status, data)
    return { ok: true, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao apagar label (Whapi): ${e?.message || e}` }
  }
}

/**
 * Chats/mensagens associados a um label. GET /labels/{LabelID} → { chats, messages }.
 * Retorna { ok, chats, messages }.
 */
async function getLabelAssociations(labelId, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ...cfgMissing(), chats: [], messages: [] }
  const id = String(labelId ?? '').trim()
  if (!id) return { ok: false, error: 'LabelID é obrigatório.', chats: [], messages: [] }
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: `/labels/${encodeURIComponent(id)}` })
    if (!ok || data?.error) return { ...apiError(status, data), chats: [], messages: [] }
    return {
      ok: true,
      chats: Array.isArray(data?.chats) ? data.chats : [],
      messages: Array.isArray(data?.messages) ? data.messages : [],
      httpStatus: status,
    }
  } catch (e) {
    return { ok: false, chats: [], messages: [], error: `Falha de conexão ao ler associações do label (Whapi): ${e?.message || e}` }
  }
}

/**
 * Associa um label a um chat. POST /labels/{LabelID}/{ChatID}.
 * `chat` aceita telefone (dígitos) ou chat id (…@s.whatsapp.net / …@g.us) — normalizado para ChatID.
 */
async function addLabelAssociation(labelId, chat, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const id = String(labelId ?? '').trim()
  if (!id) return { ok: false, error: 'LabelID é obrigatório.' }
  const chatId = toWhapiChatId(chat)
  if (!chatId) return { ok: false, error: 'Chat inválido para associação de label.' }
  try {
    const { ok, status, data } = await post({
      token: cfg.token,
      endpoint: `/labels/${encodeURIComponent(id)}/${encodeURIComponent(chatId)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error || data?.success === false) return apiError(status, data)
    return { ok: true, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao associar label (Whapi): ${e?.message || e}` }
  }
}

/**
 * Remove a associação de um label com um chat. DELETE /labels/{LabelID}/{ChatID}.
 */
async function deleteLabelAssociation(labelId, chat, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  const id = String(labelId ?? '').trim()
  if (!id) return { ok: false, error: 'LabelID é obrigatório.' }
  const chatId = toWhapiChatId(chat)
  if (!chatId) return { ok: false, error: 'Chat inválido para remover associação de label.' }
  try {
    const { ok, status, data } = await del({
      token: cfg.token,
      endpoint: `/labels/${encodeURIComponent(id)}/${encodeURIComponent(chatId)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error || data?.success === false) return apiError(status, data)
    return { ok: true, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao remover associação de label (Whapi): ${e?.message || e}` }
  }
}

module.exports = {
  getLabels,
  createLabel,
  renameLabel,
  deleteLabel,
  getLabelAssociations,
  addLabelAssociation,
  deleteLabelAssociation,
  LABEL_COLORS,
}
