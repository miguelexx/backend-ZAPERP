/**
 * Configuração WhatsApp (UltraMSG).
 * Credenciais por empresa: tabela `empresa_zapi` (nome histórico da migração; armazena instance_id/instance_token UltraMSG).
 * Fallback ENV: ULTRAMSG_INSTANCE_ID, ULTRAMSG_TOKEN.
 * @see ../docs/reference/ADR-LEGACY-NAMING.md
 */

const supabase = require('../config/supabase')
const {
  getDefaultWhatsappInstance,
  getWhatsappInstanceByProviderInstanceId,
  toEmpresaWhatsappConfig,
} = require('./whatsappInstanceService')

const TIMEOUT_MS = 10_000

/**
 * Quando existem várias linhas ativas com o mesmo instance_id em empresa_zapi:
 * - legacy (default): menor company_id — comportamento original do projeto (não muda fluxo em produção).
 * - recent: última linha alterada (atualizado_em) — só com WEBHOOK_INSTANCE_DUPLICATE_STRATEGY=recent (opt-in).
 */
function instanceDuplicateStrategy() {
  const s = String(process.env.WEBHOOK_INSTANCE_DUPLICATE_STRATEGY || '')
    .trim()
    .toLowerCase()
  if (s === 'recent' || s === 'prefer_recent' || s === 'atualizado_em') return 'recent'
  return 'legacy'
}

// Cache em memória para credenciais WhatsApp (dados raramente mudam)
const _empresaConfigCache = new Map()
const _EMPRESA_CONFIG_CACHE_TTL = 5 * 60 * 1000 // 5 minutos

/** Limpa cache após alterar `empresa_zapi` (SQL/script) ou quando a API UltraMSG rejeita o token. */
function invalidateEmpresaWhatsappConfigCache(companyId) {
  if (companyId != null && companyId !== '' && Number.isFinite(Number(companyId))) {
    _empresaConfigCache.delete(Number(companyId))
    return
  }
  _empresaConfigCache.clear()
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal })
    return res
  } finally {
    clearTimeout(to)
  }
}

async function getEmpresaWhatsappConfig(company_id) {
  if (!company_id) return { error: 'Empresa sem instância configurada' }

  const cacheKey = Number(company_id)
  const cached = _empresaConfigCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < _EMPRESA_CONFIG_CACHE_TTL) {
    return cached.result
  }

  const { instance, error } = await getDefaultWhatsappInstance(company_id, { includeCredentials: true })
  if (error && !/nao encontrada|sem inst/i.test(String(error))) {
    console.error('[WHATSAPP-CONFIG] Erro ao buscar whatsapp_instances:', error)
  }
  if (instance) {
    const result = { config: toEmpresaWhatsappConfig(instance) }
    _empresaConfigCache.set(cacheKey, { ts: Date.now(), result })
    return result
  }
  // Produção: dados APENAS do banco — não usar fallback ENV (multi-tenant vendendo para clientes).
  if (process.env.NODE_ENV === 'production') {
    return { error: 'Empresa sem instância configurada em empresa_zapi. Cadastre credenciais UltraMsg no painel.' }
  }
  const fallbackId = process.env.ULTRAMSG_INSTANCE_ID || ''
  const fallbackToken = process.env.ULTRAMSG_TOKEN || ''
  if (fallbackId && fallbackToken) {
    return { config: { instance_id: fallbackId, instance_token: fallbackToken, client_token: '', ativo: true } }
  }
  return { error: 'Empresa sem instância configurada' }
}

async function getCompanyIdByInstanceId(instanceId) {
  const id = instanceId == null ? '' : String(instanceId).trim()
  if (!id) return null

  const resolved = await getWhatsappInstanceByProviderInstanceId('ultramsg', id)
  if (resolved.instance?.company_id != null) {
    return Number(resolved.instance.company_id)
  }
  if (resolved.code === 'DUPLICATE_PROVIDER_INSTANCE') {
    console.error('[WHATSAPP-CONFIG] Resolucao de webhook bloqueada por instance_id duplicado:', {
      instanceId: id.slice(0, 48),
      error: resolved.error,
    })
    return null
  }

  /**
   * Com várias linhas ativas para o mesmo instance_id, a escolha depende de WEBHOOK_INSTANCE_DUPLICATE_STRATEGY
   * (default legacy = igual ao histórico do projeto). Ver instanceDuplicateStrategy().
   */
  async function firstCompanyByQuery(qb) {
    const strategy = instanceDuplicateStrategy()
    let ordered = qb
    if (strategy === 'recent') {
      ordered = ordered
        .order('atualizado_em', { ascending: false, nullsFirst: false })
        .order('company_id', { ascending: false })
    } else {
      ordered = ordered.order('company_id', { ascending: true })
    }
    const { data: rows, error } = await ordered.limit(2)
    if (error) {
      console.error('[WHATSAPP-CONFIG] Erro ao buscar company_id por instance_id:', error.message)
      return null
    }
    if (rows && rows.length > 1) {
      const ids = rows.map((r) => r.company_id).filter((x) => x != null)
      console.warn('[WHATSAPP-CONFIG] instance_id duplicado em empresa_zapi (ativo):', {
        instanceId: id.slice(0, 48),
        company_ids: ids,
        strategy,
        usando_company_id: rows[0]?.company_id,
        hint:
          'Corrija dados: deixe uma única linha ativa por instance_id. Opcional: WEBHOOK_INSTANCE_DUPLICATE_STRATEGY=recent usa atualizado_em (opt-in).',
      })
      return null
    }
    const cid = rows?.[0]?.company_id
    return cid != null ? Number(cid) : null
  }

  let cid = await firstCompanyByQuery(
    supabase.from('empresa_zapi').select('company_id, atualizado_em').eq('instance_id', id).eq('ativo', true)
  )
  if (cid != null) return cid

  cid = await firstCompanyByQuery(
    supabase.from('empresa_zapi').select('company_id, atualizado_em').eq('ativo', true).ilike('instance_id', id)
  )
  if (cid != null) return cid

  // UltraMsg webhook envia instanceId numérico (ex: "51534"); banco pode ter "instance51534"
  if (/^\d+$/.test(id)) {
    const altId = `instance${id}`
    cid = await firstCompanyByQuery(
      supabase.from('empresa_zapi').select('company_id, atualizado_em').eq('instance_id', altId).eq('ativo', true)
    )
    if (cid != null) return cid
  } else if (id.toLowerCase().startsWith('instance') && id.length > 8) {
    const numericPart = id.replace(/\D/g, '')
    if (numericPart) {
      cid = await firstCompanyByQuery(
        supabase.from('empresa_zapi').select('company_id, atualizado_em').eq('instance_id', numericPart).eq('ativo', true)
      )
      if (cid != null) return cid
    }
  }
  return null
}

module.exports = {
  getEmpresaWhatsappConfig,
  getCompanyIdByInstanceId,
  fetchWithTimeout,
  invalidateEmpresaWhatsappConfigCache,
}
