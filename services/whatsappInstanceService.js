/**
 * Camada Fase 1 para instancias WhatsApp/UltraMsg por empresa.
 * Mantem compatibilidade com empresa_zapi como legado/default.
 */

const supabase = require('../config/supabase')

const DEFAULT_PROVIDER = 'ultramsg'

const PUBLIC_SELECT = [
  'id',
  'company_id',
  'provider',
  'nome',
  'descricao',
  'instance_id',
  'telefone_conectado',
  'display_phone',
  'ativo',
  'is_default',
  'status',
  'status_at',
  'ultimo_qr_em',
  'ultimo_sync_em',
  'ultimo_webhook_em',
  'ultimo_erro',
  'metadata',
  'legacy_empresa_zapi_id',
  'criado_em',
  'atualizado_em',
].join(', ')

const PRIVATE_SELECT = `${PUBLIC_SELECT}, instance_token, client_token`

function normalizeProvider(provider) {
  const p = String(provider || DEFAULT_PROVIDER).trim().toLowerCase()
  return p || DEFAULT_PROVIDER
}

function normalizeCompanyId(companyId) {
  const n = Number(companyId)
  return Number.isFinite(n) && n > 0 ? n : null
}

function normalizeInstanceLookupValues(instanceId) {
  const id = instanceId == null ? '' : String(instanceId).trim()
  if (!id) return []
  const values = [id]
  if (/^\d+$/.test(id)) values.push(`instance${id}`)
  if (id.toLowerCase().startsWith('instance') && id.length > 8) {
    const numeric = id.replace(/\D/g, '')
    if (numeric) values.push(numeric)
  }
  return Array.from(new Set(values))
}

function normalizeProviderInstanceId(instanceId) {
  const id = instanceId == null ? '' : String(instanceId).trim()
  if (!id) return ''
  return id.toLowerCase().startsWith('instance') ? id.slice(8).toLowerCase() : id.toLowerCase()
}

function isMissingTableError(error) {
  if (!error) return false
  const msg = String(error.message || error.details || error.hint || '').toLowerCase()
  return error.code === '42P01' || error.code === 'PGRST205' || msg.includes('whatsapp_instances')
}

function sanitizeWhatsappInstance(instance) {
  if (!instance || typeof instance !== 'object') return null
  const {
    instance_token: _instanceToken,
    client_token: _clientToken,
    token: _token,
    ...safe
  } = instance
  return safe
}

function buildLegacyInstance(row, opts = {}) {
  if (!row) return null
  const includeCredentials = opts.includeCredentials === true
  const base = {
    id: null,
    company_id: Number(row.company_id),
    provider: DEFAULT_PROVIDER,
    nome: 'WhatsApp principal',
    descricao: null,
    instance_id: row.instance_id,
    telefone_conectado: null,
    display_phone: null,
    ativo: row.ativo !== false,
    is_default: true,
    status: 'unknown',
    status_at: null,
    ultimo_qr_em: null,
    ultimo_sync_em: null,
    ultimo_webhook_em: null,
    ultimo_erro: null,
    metadata: {},
    legacy_empresa_zapi_id: row.id ?? null,
    criado_em: row.criado_em ?? null,
    atualizado_em: row.atualizado_em ?? null,
    source: 'empresa_zapi',
    legacy: true,
  }
  if (includeCredentials) {
    base.instance_token = row.instance_token
    base.client_token = row.client_token
  }
  return base
}

function toEmpresaWhatsappConfig(instance) {
  if (!instance) return null
  return {
    instance_id: instance.instance_id,
    instance_token: instance.instance_token,
    client_token: instance.client_token || '',
    ativo: instance.ativo !== false,
    whatsapp_instance_id: instance.id ?? null,
    provider: instance.provider || DEFAULT_PROVIDER,
    is_default: instance.is_default === true,
    nome: instance.nome || null,
    source: instance.source || 'whatsapp_instances',
  }
}

function responseInstance(instance, opts = {}) {
  return opts.includeCredentials === true ? instance : sanitizeWhatsappInstance(instance)
}

function duplicateProviderInstanceResult(provider, instanceId, rows, source) {
  const companyIds = Array.from(new Set((rows || []).map((r) => r.company_id).filter((v) => v != null)))
  console.error('[WHATSAPP-INSTANCES] Duplicidade ativa de provider/instance_id bloqueada:', {
    source,
    provider,
    instance_id: String(instanceId || '').slice(0, 64),
    company_ids: companyIds,
  })
  return {
    instance: null,
    error: `Duplicidade ativa de instancia WhatsApp detectada para provider=${provider} instance_id=${instanceId}. Corrija o cadastro antes de processar webhooks ou envios.`,
    code: 'DUPLICATE_PROVIDER_INSTANCE',
    duplicates: companyIds,
  }
}

async function findActiveProviderInstanceRows(provider, instanceId, opts = {}) {
  const p = normalizeProvider(provider)
  const values = normalizeInstanceLookupValues(instanceId)
  if (!values.length) return { rows: [], error: null }
  const table = opts.table || 'whatsapp_instances'
  const select = table === 'empresa_zapi'
    ? 'id, company_id, instance_id, instance_token, client_token, ativo, criado_em, atualizado_em'
    : (opts.includeCredentials === true ? PRIVATE_SELECT : PUBLIC_SELECT)

  let query = supabase
    .from(table)
    .select(select)
    .eq('ativo', true)
    .in('instance_id', values)

  if (table === 'whatsapp_instances') query = query.eq('provider', p)

  const { data, error } = await query.order('company_id', { ascending: true }).limit(20)
  if (error) return { rows: [], error }

  const normalizedTarget = normalizeProviderInstanceId(instanceId)
  const unique = new Map()
  for (const row of data || []) {
    if (normalizeProviderInstanceId(row.instance_id) !== normalizedTarget) continue
    const key = row.id != null ? `id:${row.id}` : `${row.company_id}:${row.instance_id}`
    unique.set(key, row)
  }
  return { rows: Array.from(unique.values()), error: null }
}

async function getLegacyEmpresaZapiDefault(companyId, opts = {}) {
  const cid = normalizeCompanyId(companyId)
  if (!cid) return { instance: null, error: 'company_id invalido' }

  const { data, error } = await supabase
    .from('empresa_zapi')
    .select('id, company_id, instance_id, instance_token, client_token, ativo, criado_em, atualizado_em')
    .eq('company_id', cid)
    .eq('ativo', true)
    .maybeSingle()

  if (error) return { instance: null, error: 'Erro ao buscar empresa_zapi' }
  return { instance: buildLegacyInstance(data, opts), error: null }
}

async function getDefaultWhatsappInstance(companyId, opts = {}) {
  const cid = normalizeCompanyId(companyId)
  if (!cid) return { instance: null, error: 'company_id invalido' }
  const provider = normalizeProvider(opts.provider)
  const select = opts.includeCredentials === true ? PRIVATE_SELECT : PUBLIC_SELECT

  const defaultQuery = await supabase
    .from('whatsapp_instances')
    .select(select)
    .eq('company_id', cid)
    .eq('provider', provider)
    .eq('ativo', true)
    .eq('is_default', true)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (defaultQuery.error && !isMissingTableError(defaultQuery.error)) {
    return { instance: null, error: 'Erro ao buscar instancia WhatsApp default' }
  }
  if (defaultQuery.data) {
    return { instance: responseInstance(defaultQuery.data, opts), error: null }
  }

  if (!defaultQuery.error) {
    const firstActive = await supabase
      .from('whatsapp_instances')
      .select(select)
      .eq('company_id', cid)
      .eq('provider', provider)
      .eq('ativo', true)
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (firstActive.error && !isMissingTableError(firstActive.error)) {
      return { instance: null, error: 'Erro ao buscar instancia WhatsApp ativa' }
    }
    if (firstActive.data) {
      return { instance: responseInstance(firstActive.data, opts), error: null }
    }
  }

  return getLegacyEmpresaZapiDefault(cid, opts)
}

async function getWhatsappInstanceById(companyId, whatsappInstanceId, opts = {}) {
  const cid = normalizeCompanyId(companyId)
  const id = Number(whatsappInstanceId)
  if (!cid) return { instance: null, error: 'company_id invalido' }
  if (!Number.isFinite(id) || id <= 0) return { instance: null, error: 'whatsapp_instance_id invalido' }
  const select = opts.includeCredentials === true ? PRIVATE_SELECT : PUBLIC_SELECT

  let query = supabase
    .from('whatsapp_instances')
    .select(select)
    .eq('id', id)
    .eq('company_id', cid)

  if (opts.requireActive !== false) query = query.eq('ativo', true)

  const { data, error } = await query.maybeSingle()
  if (error) {
    if (isMissingTableError(error)) return { instance: null, error: 'Instancia WhatsApp nao encontrada' }
    return { instance: null, error: 'Erro ao buscar instancia WhatsApp' }
  }
  if (!data) return { instance: null, error: 'Instancia WhatsApp nao encontrada' }
  return { instance: responseInstance(data, opts), error: null }
}

async function getWhatsappInstanceByProviderInstanceId(provider, instanceId, opts = {}) {
  const p = normalizeProvider(provider)
  const values = normalizeInstanceLookupValues(instanceId)
  if (!values.length) return { instance: null, error: 'instance_id invalido' }

  const activeRows = await findActiveProviderInstanceRows(p, instanceId, opts)
  if (activeRows.error && !isMissingTableError(activeRows.error)) {
    return { instance: null, error: 'Erro ao buscar instancia por provider instance_id' }
  }
  if (activeRows.rows.length > 1) {
    return duplicateProviderInstanceResult(p, instanceId, activeRows.rows, 'whatsapp_instances')
  }
  if (activeRows.rows.length === 1) {
    return { instance: responseInstance(activeRows.rows[0], opts), error: null }
  }

  if (opts.allowLegacyFallback === false) {
    return { instance: null, error: 'Instancia WhatsApp nao encontrada' }
  }

  const legacyRows = await findActiveProviderInstanceRows(p, instanceId, { ...opts, table: 'empresa_zapi' })
  if (legacyRows.error) return { instance: null, error: 'Erro ao buscar empresa_zapi por instance_id' }
  if (legacyRows.rows.length > 1) {
    return duplicateProviderInstanceResult(p, instanceId, legacyRows.rows, 'empresa_zapi')
  }
  if (legacyRows.rows.length === 1) {
    return { instance: buildLegacyInstance(legacyRows.rows[0], opts), error: null }
  }

  return { instance: null, error: 'Instancia WhatsApp nao encontrada' }
}

async function listWhatsappInstances(companyId) {
  const cid = normalizeCompanyId(companyId)
  if (!cid) return { instances: [], error: 'company_id invalido' }

  const { data, error } = await supabase
    .from('whatsapp_instances')
    .select(PUBLIC_SELECT)
    .eq('company_id', cid)
    .order('is_default', { ascending: false })
    .order('id', { ascending: true })

  if (error) {
    if (!isMissingTableError(error)) return { instances: [], error: 'Erro ao listar instancias WhatsApp' }
    const legacy = await getLegacyEmpresaZapiDefault(cid)
    return { instances: legacy.instance ? [legacy.instance] : [], error: null }
  }

  if (Array.isArray(data) && data.length) return { instances: data.map(sanitizeWhatsappInstance), error: null }

  const legacy = await getLegacyEmpresaZapiDefault(cid)
  return { instances: legacy.instance ? [legacy.instance] : [], error: null }
}

async function hasActiveDefault(companyId) {
  const { instance } = await getDefaultWhatsappInstance(companyId)
  return !!instance && instance.source !== 'empresa_zapi'
}

async function setDefaultWhatsappInstance(companyId, whatsappInstanceId) {
  const cid = normalizeCompanyId(companyId)
  const id = Number(whatsappInstanceId)
  if (!cid) return { instance: null, error: 'company_id invalido' }
  if (!Number.isFinite(id) || id <= 0) return { instance: null, error: 'whatsapp_instance_id invalido' }

  const existing = await getWhatsappInstanceById(cid, id, { requireActive: true })
  if (existing.error || !existing.instance) return { instance: null, error: existing.error || 'Instancia WhatsApp nao encontrada' }

  const { data, error } = await supabase.rpc('set_default_whatsapp_instance', {
    p_company_id: cid,
    p_whatsapp_instance_id: id,
  })

  const row = Array.isArray(data) ? data[0] : data
  if (error || !row) return { instance: null, error: error?.message || 'Erro ao definir instancia default' }
  return { instance: sanitizeWhatsappInstance(row), error: null }
}

async function createWhatsappInstance(companyId, input = {}) {
  const cid = normalizeCompanyId(companyId)
  if (!cid) return { instance: null, error: 'company_id invalido' }

  const provider = normalizeProvider(input.provider)
  const nome = String(input.nome || input.name || 'WhatsApp').trim().slice(0, 120)
  const instanceId = String(input.instance_id || input.instanceId || '').trim()
  const instanceToken = String(input.instance_token || input.instanceToken || '').trim()
  const clientToken = input.client_token ?? input.clientToken ?? null
  const makeDefault = input.is_default === true || input.default === true

  if (!instanceId) return { instance: null, error: 'instance_id e obrigatorio' }
  if (!instanceToken) return { instance: null, error: 'instance_token e obrigatorio' }

  const active = input.ativo !== false
  if (active) {
    const duplicate = await findActiveProviderInstanceRows(provider, instanceId)
    if (duplicate.error && !isMissingTableError(duplicate.error)) {
      return { instance: null, error: 'Erro ao validar duplicidade da instancia WhatsApp' }
    }
    if (duplicate.rows.length > 0) {
      return duplicateProviderInstanceResult(provider, instanceId, duplicate.rows, 'whatsapp_instances')
    }
  }

  const hasDefault = await hasActiveDefault(cid)
  const shouldBeDefault = makeDefault || !hasDefault

  const { data, error } = await supabase
    .from('whatsapp_instances')
    .insert({
      company_id: cid,
      provider,
      nome: nome || 'WhatsApp',
      descricao: input.descricao ?? input.description ?? null,
      instance_id: instanceId,
      instance_token: instanceToken,
      client_token: clientToken ? String(clientToken).trim() : null,
      telefone_conectado: input.telefone_conectado ?? input.phone ?? null,
      display_phone: input.display_phone ?? input.displayPhone ?? null,
      ativo: active,
      is_default: false,
      status: input.status || 'unknown',
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    })
    .select(PUBLIC_SELECT)
    .maybeSingle()

  if (error || !data) return { instance: null, error: error?.message || 'Erro ao criar instancia WhatsApp' }
  if (shouldBeDefault && data.ativo !== false) {
    return setDefaultWhatsappInstance(cid, data.id)
  }
  return { instance: sanitizeWhatsappInstance(data), error: null }
}

async function updateWhatsappInstance(companyId, whatsappInstanceId, input = {}) {
  const cid = normalizeCompanyId(companyId)
  const id = Number(whatsappInstanceId)
  if (!cid) return { instance: null, error: 'company_id invalido' }
  if (!Number.isFinite(id) || id <= 0) return { instance: null, error: 'whatsapp_instance_id invalido' }

  const existing = await getWhatsappInstanceById(cid, id, { requireActive: false })
  if (existing.error || !existing.instance) return { instance: null, error: existing.error || 'Instancia WhatsApp nao encontrada' }

  const patch = {}
  if (input.nome != null || input.name != null) patch.nome = String(input.nome ?? input.name).trim().slice(0, 120)
  if (input.descricao !== undefined || input.description !== undefined) patch.descricao = input.descricao ?? input.description ?? null
  if (input.telefone_conectado !== undefined || input.phone !== undefined) patch.telefone_conectado = input.telefone_conectado ?? input.phone ?? null
  if (input.display_phone !== undefined || input.displayPhone !== undefined) patch.display_phone = input.display_phone ?? input.displayPhone ?? null
  if (input.status != null) patch.status = String(input.status).trim().slice(0, 40) || 'unknown'
  if (input.ativo !== undefined) {
    if (existing.instance.is_default && input.ativo === false) {
      return { instance: null, error: 'Defina outra instancia default antes de desativar a atual' }
    }
    patch.ativo = input.ativo === true
    if (patch.ativo === true) {
      const duplicate = await findActiveProviderInstanceRows(existing.instance.provider || DEFAULT_PROVIDER, existing.instance.instance_id)
      if (duplicate.error && !isMissingTableError(duplicate.error)) {
        return { instance: null, error: 'Erro ao validar duplicidade da instancia WhatsApp' }
      }
      const otherRows = duplicate.rows.filter((row) => Number(row.id) !== id)
      if (otherRows.length > 0) {
        return duplicateProviderInstanceResult(existing.instance.provider || DEFAULT_PROVIDER, existing.instance.instance_id, otherRows, 'whatsapp_instances')
      }
    }
  }

  if (!Object.keys(patch).length) return { instance: existing.instance, error: null }

  const { data, error } = await supabase
    .from('whatsapp_instances')
    .update(patch)
    .eq('company_id', cid)
    .eq('id', id)
    .select(PUBLIC_SELECT)
    .maybeSingle()

  if (error || !data) return { instance: null, error: error?.message || 'Erro ao atualizar instancia WhatsApp' }
  return { instance: sanitizeWhatsappInstance(data), error: null }
}

module.exports = {
  DEFAULT_PROVIDER,
  sanitizeWhatsappInstance,
  toEmpresaWhatsappConfig,
  getDefaultWhatsappInstance,
  getWhatsappInstanceById,
  getWhatsappInstanceByProviderInstanceId,
  listWhatsappInstances,
  createWhatsappInstance,
  updateWhatsappInstance,
  setDefaultWhatsappInstance,
}
