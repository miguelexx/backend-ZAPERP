/**
 * Configuração WhatsApp (UltraMSG).
 * Credenciais por empresa: tabela `empresa_zapi` (nome histórico da migração; armazena instance_id/instance_token UltraMSG).
 * Fallback ENV: ULTRAMSG_INSTANCE_ID, ULTRAMSG_TOKEN.
 * @see ../docs/_OFICIAL/ADR-LEGACY-NAMING.md
 */

const supabase = require('../config/supabase')

const TIMEOUT_MS = 10_000

// Cache em memória para credenciais WhatsApp (dados raramente mudam)
const _empresaConfigCache = new Map()
const _EMPRESA_CONFIG_CACHE_TTL = 5 * 60 * 1000 // 5 minutos

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

  const { data, error } = await supabase
    .from('empresa_zapi')
    .select('instance_id, instance_token, client_token, ativo')
    .eq('company_id', company_id)
    .eq('ativo', true)
    .maybeSingle()

  if (error) {
    console.error('[WHATSAPP-CONFIG] Erro ao buscar empresa_zapi:', error.message)
    return { error: 'Erro ao buscar configuração WhatsApp da empresa' }
  }
  if (data) {
    const result = { config: data }
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

  /**
   * Escolhe uma empresa quando há várias linhas ativas com o mesmo instance_id.
   * Antes: order('company_id').limit(1) → sempre o menor company_id (ex.: 2 "roubava" a 6).
   * Agora: quem atualizou a config por último em empresa_zapi (atualizado_em) — alinha com a instância real no painel.
   */
  async function firstCompanyByQuery(qb) {
    const { data: rows, error } = await qb
      .order('atualizado_em', { ascending: false, nullsFirst: false })
      .order('company_id', { ascending: false })
      .limit(2)
    if (error) {
      console.error('[WHATSAPP-CONFIG] Erro ao buscar company_id por instance_id:', error.message)
      return null
    }
    if (rows && rows.length > 1) {
      const ids = rows.map((r) => r.company_id).filter((x) => x != null)
      console.warn('[WHATSAPP-CONFIG] instance_id duplicado em empresa_zapi (ativo):', {
        instanceId: id.slice(0, 48),
        company_ids: ids,
        usando_company_id: ids[0],
        hint: 'Desative (ativo=false) linhas antigas ou instâncias erradas até ficar uma só por instance_id.',
      })
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
}
