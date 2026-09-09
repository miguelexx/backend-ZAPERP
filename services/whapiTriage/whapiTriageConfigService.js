/**
 * Triagem Interativa Whapi — leitura/escrita de configuração (tabelas whapi_triage_config
 * + whapi_triage_options). Módulo ADITIVO: não toca ia_config / chatbot_triage.
 *
 * Resiliente à ausência das tabelas: se a migration ainda não foi aplicada, tudo se comporta
 * como "desligado" (config null / lista vazia) — nunca lança. Ver doc 25 + doc 26.
 *
 * company_id SEMPRE do chamador (req.user) — nunca do payload. SERVICE_ROLE bypassa RLS,
 * então TODA query filtra company_id explicitamente.
 */

const supabase = require('../../config/supabase')

const MODES = new Set(['poll', 'list', 'button'])

const DEFAULT_CONFIG = {
  enabled: false,
  mode: 'poll',
  body_text: 'Para facilitar seu atendimento, selecione o setor desejado.',
  button_label: 'Selecionar setor',
  header_text: null,
  footer_text: null,
  confirm_message: null,
  fallback_to_text: true,
  options: [],
}

// Cache curto por instância (dados raramente mudam).
const _cache = new Map()
const _CACHE_TTL_MS = 5 * 60 * 1000

function cacheKey(company_id, whatsapp_instance_id) {
  return `${Number(company_id)}:${Number(whatsapp_instance_id)}`
}

function invalidateCache(company_id, whatsapp_instance_id) {
  if (whatsapp_instance_id != null) {
    _cache.delete(cacheKey(company_id, whatsapp_instance_id))
    return
  }
  // Sem instância → limpa toda a empresa.
  const prefix = `${Number(company_id)}:`
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key)
  }
}

/** true quando a tabela ainda não existe (migration não aplicada) — trata como recurso desligado. */
function isMissingTableError(error) {
  if (!error) return false
  if (error.code === '42P01') return true
  const msg = String(error.message || '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('schema cache') || msg.includes('could not find the table')
}

function toNumberOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

function normalizeMode(v) {
  const m = String(v || '').trim().toLowerCase()
  return MODES.has(m) ? m : 'poll'
}

function sanitizeText(v, max = 4096) {
  const s = v == null ? '' : String(v).trim()
  if (!s) return null
  return s.slice(0, max)
}

/** Normaliza uma linha de opção do banco para o formato usado pelo renderer/resolver. */
function normalizeOptionRow(row) {
  return {
    id: String(row.id),
    label: String(row.label || '').trim() || 'Setor',
    departamento_id: toNumberOrNull(row.departamento_id),
    tag_id: toNumberOrNull(row.tag_id),
    ordem: Number.isFinite(Number(row.ordem)) ? Number(row.ordem) : 0,
    active: row.active !== false,
  }
}

/** Normaliza config + opções para consumo interno. */
function buildConfig(row, optionRows) {
  const options = (optionRows || [])
    .map(normalizeOptionRow)
    .sort((a, b) => a.ordem - b.ordem)
  return {
    id: row.id,
    company_id: Number(row.company_id),
    whatsapp_instance_id: Number(row.whatsapp_instance_id),
    enabled: row.enabled === true,
    mode: normalizeMode(row.mode),
    body_text: sanitizeText(row.body_text) || DEFAULT_CONFIG.body_text,
    button_label: sanitizeText(row.button_label) || DEFAULT_CONFIG.button_label,
    header_text: sanitizeText(row.header_text),
    footer_text: sanitizeText(row.footer_text),
    confirm_message: sanitizeText(row.confirm_message),
    fallback_to_text: row.fallback_to_text !== false,
    options,
  }
}

/**
 * Config bruta (para a UI de gestão) de uma instância — cria defaults em memória se não existir.
 * NÃO cacheia (a UI edita e precisa do estado fresco). Retorna { config, exists }.
 */
async function getWhapiTriageConfigRaw(company_id, whatsapp_instance_id) {
  const cid = Number(company_id)
  const iid = Number(whatsapp_instance_id)
  if (!cid || !iid) return { config: { ...DEFAULT_CONFIG }, exists: false }

  try {
    const { data: cfg, error } = await supabase
      .from('whapi_triage_config')
      .select('*')
      .eq('company_id', cid)
      .eq('whatsapp_instance_id', iid)
      .maybeSingle()

    if (error) {
      if (isMissingTableError(error)) return { config: { ...DEFAULT_CONFIG }, exists: false, migrationPending: true }
      throw new Error(error.message)
    }
    if (!cfg) return { config: { ...DEFAULT_CONFIG }, exists: false }

    const { data: opts, error: optErr } = await supabase
      .from('whapi_triage_options')
      .select('*')
      .eq('company_id', cid)
      .eq('config_id', cfg.id)
      .order('ordem', { ascending: true })

    if (optErr && !isMissingTableError(optErr)) throw new Error(optErr.message)
    return { config: buildConfig(cfg, opts || []), exists: true }
  } catch (e) {
    if (isMissingTableError(e)) return { config: { ...DEFAULT_CONFIG }, exists: false, migrationPending: true }
    throw e
  }
}

/**
 * Config VALIDADA e pronta para o motor de triagem (Seam A/B). Cacheada.
 * Retorna null quando: recurso desligado, sem opções válidas, tabela ausente ou erro.
 * Usada no pipeline de inbound — NUNCA lança (best-effort; falha = recurso off).
 */
async function getActiveWhapiTriageConfig(company_id, whatsapp_instance_id) {
  const cid = Number(company_id)
  const iid = Number(whatsapp_instance_id)
  if (!cid || !iid) return null

  const key = cacheKey(cid, iid)
  const cached = _cache.get(key)
  if (cached && Date.now() - cached.ts < _CACHE_TTL_MS) return cached.config

  let resolved = null
  try {
    const { config, exists } = await getWhapiTriageConfigRaw(cid, iid)
    if (exists && config.enabled) {
      const activeOptions = (config.options || []).filter(
        (o) => o.active !== false && o.departamento_id != null
      )
      resolved = activeOptions.length ? { ...config, options: activeOptions } : null
    }
  } catch (e) {
    console.warn('[whapiTriage] getActiveWhapiTriageConfig:', e?.message || e)
    resolved = null
  }

  _cache.set(key, { ts: Date.now(), config: resolved })
  return resolved
}

/**
 * Upsert da config + substituição autoritativa das opções (a planilha da UI manda).
 * Preserva o id UUID de opções existentes casadas por id (mantém o vínculo estável);
 * cria novas para as sem id. company_id sempre do chamador.
 */
async function saveWhapiTriageConfig(company_id, whatsapp_instance_id, payload = {}) {
  const cid = Number(company_id)
  const iid = Number(whatsapp_instance_id)
  if (!cid || !iid) return { ok: false, error: 'company_id/whatsapp_instance_id inválidos' }

  const configFields = {
    company_id: cid,
    whatsapp_instance_id: iid,
    enabled: payload.enabled === true,
    mode: normalizeMode(payload.mode),
    body_text: sanitizeText(payload.body_text) || DEFAULT_CONFIG.body_text,
    button_label: sanitizeText(payload.button_label) || DEFAULT_CONFIG.button_label,
    header_text: sanitizeText(payload.header_text),
    footer_text: sanitizeText(payload.footer_text),
    confirm_message: sanitizeText(payload.confirm_message),
    fallback_to_text: payload.fallback_to_text !== false,
  }

  // 1) upsert do cabeçalho (unique company_id + whatsapp_instance_id)
  const { data: cfgRow, error: cfgErr } = await supabase
    .from('whapi_triage_config')
    .upsert(configFields, { onConflict: 'company_id,whatsapp_instance_id' })
    .select('*')
    .single()
  if (cfgErr) {
    if (isMissingTableError(cfgErr)) {
      return { ok: false, error: 'Tabelas da Triagem Interativa Whapi não existem ainda (migration pendente).', migrationPending: true }
    }
    return { ok: false, error: cfgErr.message }
  }

  // 2) opções — substituição autoritativa mantendo ids estáveis existentes
  const incoming = Array.isArray(payload.options) ? payload.options : []
  const rows = incoming
    .map((o, idx) => ({
      raw: o,
      row: {
        config_id: cfgRow.id,
        company_id: cid,
        label: sanitizeText(o.label, 256) || 'Setor',
        departamento_id: toNumberOrNull(o.departamento_id),
        tag_id: toNumberOrNull(o.tag_id),
        ordem: Number.isFinite(Number(o.ordem)) ? Number(o.ordem) : idx,
        active: o.active !== false,
      },
    }))

  // ids que devem permanecer (UUID válido enviado pela UI)
  const keepIds = rows
    .map((r) => (typeof r.raw?.id === 'string' && /^[0-9a-fA-F-]{36}$/.test(r.raw.id) ? r.raw.id : null))
    .filter(Boolean)

  // apaga as opções que saíram
  {
    let delQuery = supabase
      .from('whapi_triage_options')
      .delete()
      .eq('company_id', cid)
      .eq('config_id', cfgRow.id)
    if (keepIds.length) delQuery = delQuery.not('id', 'in', `(${keepIds.map((id) => `"${id}"`).join(',')})`)
    const { error: delErr } = await delQuery
    if (delErr && !isMissingTableError(delErr)) return { ok: false, error: delErr.message }
  }

  // upsert das mantidas + insert das novas
  for (const { raw, row } of rows) {
    const hasId = typeof raw?.id === 'string' && /^[0-9a-fA-F-]{36}$/.test(raw.id)
    if (hasId) {
      const { error } = await supabase
        .from('whapi_triage_options')
        .update(row)
        .eq('company_id', cid)
        .eq('config_id', cfgRow.id)
        .eq('id', raw.id)
      if (error && !isMissingTableError(error)) return { ok: false, error: error.message }
    } else {
      const { error } = await supabase.from('whapi_triage_options').insert(row)
      if (error && !isMissingTableError(error)) return { ok: false, error: error.message }
    }
  }

  invalidateCache(cid, iid)
  const fresh = await getWhapiTriageConfigRaw(cid, iid)
  return { ok: true, config: fresh.config }
}

module.exports = {
  DEFAULT_CONFIG,
  getWhapiTriageConfigRaw,
  getActiveWhapiTriageConfig,
  saveWhapiTriageConfig,
  invalidateCache,
  isMissingTableError,
  _internal: { normalizeMode, normalizeOptionRow, buildConfig },
}
