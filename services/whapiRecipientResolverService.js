'use strict'

/**
 * Resolve o destinatario canonico de uma mensagem Whapi.
 *
 * Ordem:
 * 1. grupos/LID seguem o normalizador do adapter;
 * 2. conversa com cliente e wa_id usa esse JID canonico;
 * 3. cliente sem wa_id consulta POST /contacts (checkPhones), usa o wa_id
 *    devolvido pela Whapi e o persiste sem sobrescrever valor concorrente;
 * 4. qualquer falha de leitura/validacao cai no telefone original normalizado.
 *
 * Este servico e exclusivo da Whapi. UltraMSG permanece intocada.
 */

const supabase = require('../config/supabase')
const whapiContacts = require('./providers/whapi/contacts')
const { toWhapiRecipient } = require('./providers/whapi/phones')

function normalizeCanonicalWaId(waId) {
  const raw = String(waId || '').trim()
  if (!raw) return ''
  const match = raw.match(/^(\d+)@(c\.us|s\.whatsapp\.net)$/i)
  if (match) return `${match[1]}@s.whatsapp.net`
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15 ? `${digits}@s.whatsapp.net` : ''
}

async function loadConversationContact(companyId, conversaId) {
  const cid = Number(companyId)
  const convId = Number(conversaId)
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(convId) || convId <= 0) return null

  const { data: conversa, error: convError } = await supabase
    .from('conversas')
    .select('id, cliente_id, telefone, tipo')
    .eq('company_id', cid)
    .eq('id', convId)
    .maybeSingle()
  if (convError || !conversa?.cliente_id) return { conversa, cliente: null }

  const { data: cliente, error: clienteError } = await supabase
    .from('clientes')
    .select('id, telefone, wa_id')
    .eq('company_id', cid)
    .eq('id', conversa.cliente_id)
    .maybeSingle()
  return { conversa, cliente: clienteError ? null : cliente }
}

async function loadClientById(companyId, clienteId) {
  const cid = Number(companyId)
  const clientId = Number(clienteId)
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(clientId) || clientId <= 0) return null
  const { data, error } = await supabase
    .from('clientes')
    .select('id, telefone, wa_id')
    .eq('company_id', cid)
    .eq('id', clientId)
    .maybeSingle()
  return error ? null : data
}

async function persistCanonicalWaId(companyId, cliente, canonicalWaId) {
  if (!cliente?.id || String(cliente.wa_id || '').trim() || !canonicalWaId) return false
  let query = supabase
    .from('clientes')
    .update({ wa_id: canonicalWaId, atualizado_em: new Date().toISOString() })
    .eq('company_id', Number(companyId))
    .eq('id', cliente.id)
  query = cliente.wa_id == null ? query.is('wa_id', null) : query.eq('wa_id', '')
  const { error } = await query
  if (error) {
    console.warn('[WHAPI_DESTINO] Nao foi possivel persistir wa_id canonico', {
      company_id: Number(companyId),
      cliente_id: cliente.id,
      error: error.message,
    })
    return false
  }
  return true
}

async function resolveWhapiSendRecipient(phone, opts = {}, deps = {}) {
  const fallback = toWhapiRecipient(phone)
  if (!fallback || fallback.includes('@g.us') || fallback.includes('@lid')) return fallback

  const companyId = opts.companyId ?? opts.company_id
  const conversaId = opts.conversaId ?? opts.conversa_id
  const clienteId = opts.clienteId ?? opts.cliente_id
  if (companyId == null || (conversaId == null && clienteId == null)) return fallback

  const load = deps.loadConversationContact || loadConversationContact
  const loadClient = deps.loadClientById || loadClientById
  const checkPhones = deps.checkPhones || whapiContacts.checkPhones
  const persist = deps.persistCanonicalWaId || persistCanonicalWaId

  try {
    const context = conversaId != null ? await load(companyId, conversaId) : null
    const cliente = context?.cliente || (clienteId != null ? await loadClient(companyId, clienteId) : null)
    const existingCanonical = normalizeCanonicalWaId(cliente?.wa_id)
    if (existingCanonical) return toWhapiRecipient(existingCanonical)

    if (!cliente?.id) return fallback
    const checked = await checkPhones([fallback], {
      companyId: Number(companyId),
      whatsappInstanceId: opts.whatsappInstanceId ?? opts.whatsapp_instance_id,
      forceCheck: true,
    })
    const valid = Array.isArray(checked) ? checked.find((item) => item?.exists && item?.waId) : null
    const canonical = normalizeCanonicalWaId(valid?.waId)
    if (!canonical) return fallback

    await persist(companyId, cliente, canonical)
    return toWhapiRecipient(canonical)
  } catch (e) {
    console.warn('[WHAPI_DESTINO] Falha ao resolver wa_id canonico; usando telefone da conversa', {
      company_id: Number(companyId) || null,
      conversa_id: Number(conversaId) || null,
      cliente_id: Number(clienteId) || null,
      error: e?.message || String(e),
    })
    return fallback
  }
}

module.exports = {
  resolveWhapiSendRecipient,
  normalizeCanonicalWaId,
  loadConversationContact,
  loadClientById,
  persistCanonicalWaId,
}
