/**
 * Blacklist Whapi — bloquear/desbloquear contato no WhatsApp (opt-out com efeito real).
 * PUT    /blacklist/{ContactID}  → adiciona (bloqueia)
 * DELETE /blacklist/{ContactID}  → remove (desbloqueia)
 * GET    /blacklist              → lista
 *
 * ATENÇÃO de produto: bloquear impede TODA comunicação (não só marketing). O caller
 * decide QUANDO chamar (gate opt-in). Este módulo só executa a chamada. Ver doc 25.
 * Contrato confirmado via MCP (blacklistAdd/Remove: ContactIdOrLid; getBlackList).
 */

const { resolveConfig } = require('./config')
const { toWhapiContactId, isGroupJid } = require('./phones')
const { get, put, del } = require('./http')

/**
 * Bloqueia um contato (adiciona à blacklist). Retorna { ok, error? }.
 */
async function blockContact(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const contactId = toWhapiContactId(phone)
  if (!contactId || isGroupJid(contactId)) return { ok: false, error: 'Número inválido para bloqueio' }
  try {
    const { ok, status, data } = await put({
      token: cfg.token,
      endpoint: `/blacklist/${encodeURIComponent(contactId)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error) {
      return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao bloquear contato (Whapi): ${e?.message || e}` }
  }
}

/**
 * Desbloqueia um contato (remove da blacklist). Retorna { ok, error? }.
 */
async function unblockContact(phone, opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return { ok: false, error: 'Instância Whapi não configurada' }
  const contactId = toWhapiContactId(phone)
  if (!contactId || isGroupJid(contactId)) return { ok: false, error: 'Número inválido' }
  try {
    const { ok, status, data } = await del({
      token: cfg.token,
      endpoint: `/blacklist/${encodeURIComponent(contactId)}`,
      companyId: cfg.companyId,
      whatsappInstanceId: cfg.whatsappInstanceId,
      skipSendGuard: true,
    })
    if (!ok || data?.error) {
      return { ok: false, httpStatus: status, error: String(data?.error?.message || data?.error || `HTTP ${status}`) }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Falha de conexão ao desbloquear contato (Whapi): ${e?.message || e}` }
  }
}

/**
 * Lista a blacklist. GET /blacklist → array de contatos. Retorna array (vazio em erro).
 */
async function getBlacklist(opts = {}) {
  const cfg = await resolveConfig(opts)
  if (!cfg) return []
  try {
    const { ok, data } = await get({ token: cfg.token, endpoint: '/blacklist' })
    if (!ok || !data) return []
    if (Array.isArray(data)) return data
    if (Array.isArray(data.blacklist)) return data.blacklist
    if (Array.isArray(data.contacts)) return data.contacts
    return []
  } catch {
    return []
  }
}

module.exports = {
  blockContact,
  unblockContact,
  getBlacklist,
}
