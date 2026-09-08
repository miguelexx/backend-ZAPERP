/**
 * Perfil WhatsApp Business (Whapi) — cartão da empresa (endereço, descrição, e-mail, sites, horário).
 * GET  /business  → lê o perfil
 * POST /business  → edita (campos omitidos ficam inalterados)
 *
 * Só leitura/edição de perfil: não dispara WhatsApp (skipSendGuard). Contrato confirmado via
 * OpenAPI Whapi + MCP (2026-09-08). UltraMSG não tem business profile (não implementa). Ver doc 25 §32.
 */

const { get, post } = require('./http')
const { resolveConfig } = require('./config')

const EDIT_FIELDS = new Set(['address', 'description', 'email', 'websites', 'hours'])
const MAX = { address: 256, description: 256, email: 128 }

function cfgMissing() {
  return { ok: false, error: 'Instância Whapi não configurada' }
}

function apiError(status, data) {
  return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
}

/** Lê o perfil Business. GET /business → { ok, profile }. */
async function getBusinessProfile(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  try {
    const { ok, status, data } = await get({ token: cfg.token, endpoint: '/business' })
    if (!ok || data?.error) return apiError(status, data)
    return { ok: true, profile: data || {}, httpStatus: status }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao ler perfil Business (Whapi): ${e?.message || e}` }
  }
}

/**
 * Edita o perfil Business. POST /business.
 * `fields`: { address?, description?, email?, websites?: string[], hours?: { timeZone, config } }.
 * Só envia chaves conhecidas presentes; valida limites de tamanho e até 2 websites.
 */
async function editBusinessProfile(fields = {}, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return cfgMissing()
  if (!fields || typeof fields !== 'object') return { ok: false, error: 'Payload de perfil inválido' }

  const body = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!EDIT_FIELDS.has(key) || value === undefined) continue
    if (typeof value === 'string' && MAX[key] && value.length > MAX[key]) {
      return { ok: false, error: `${key} excede ${MAX[key]} caracteres.` }
    }
    if (key === 'websites') {
      if (!Array.isArray(value)) return { ok: false, error: 'websites deve ser um array.' }
      if (value.length > 2) return { ok: false, error: 'no máximo 2 websites.' }
      if (value.some((u) => String(u).length > 256)) return { ok: false, error: 'cada website tem no máximo 256 caracteres.' }
    }
    body[key] = value
  }
  if (!Object.keys(body).length) return { ok: false, error: 'Nenhum campo de perfil para atualizar.' }

  try {
    const { ok, status, data } = await post({
      token: cfg.token,
      endpoint: '/business',
      body,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error || data?.success === false) return apiError(status, data)
    return { ok: true, httpStatus: status, profile: data && typeof data === 'object' ? data : undefined }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao editar perfil Business (Whapi): ${e?.message || e}` }
  }
}

module.exports = {
  getBusinessProfile,
  editBusinessProfile,
}
