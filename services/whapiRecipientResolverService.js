'use strict'

/**
 * Resolve o destinatario canonico de uma mensagem Whapi.
 *
 * Ordem:
 * 1. grupos/LID seguem o normalizador do adapter;
 * 2. conversa com cliente e wa_id de 12 dígitos (JID real) usa esse destino;
 * 3. sem wa_id, ou wa_id de celular BR com 13 dígitos (agenda/9º), consulta
 *    POST /contacts (checkPhones), usa o wa_id da Whapi e persiste;
 * 4. qualquer falha de leitura/validacao cai no telefone original normalizado.
 *
 * Este servico e exclusivo da Whapi. UltraMSG permanece intocada.
 */

const supabase = require('../config/supabase')
const whapiContacts = require('./providers/whapi/contacts')
const { possiblePhonesForWhatsappIdentity } = require('../helpers/phoneHelper')
const { toWhapiRecipient, explicitPrivateJidDigits } = require('./providers/whapi/phones')

function normalizeCanonicalWaId(waId) {
  const raw = String(waId || '').trim()
  if (!raw) return ''
  const match = raw.match(/^(\d+)@(c\.us|s\.whatsapp\.net)$/i)
  if (match) return `${match[1]}@s.whatsapp.net`
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15 ? `${digits}@s.whatsapp.net` : ''
}

/** Agenda/CRM costuma gravar celular BR com 9º dígito; o JID real do WhatsApp pode ser o de 12. */
function isThirteenDigitBrMobileWaId(canonical) {
  const digits = String(canonical || '').replace(/\D/g, '')
  if (!digits.startsWith('55') || digits.length !== 13) return false
  return '6789'.includes(digits.charAt(4))
}

function storedPrivateDigits(phone) {
  const explicit = explicitPrivateJidDigits(phone)
  if (explicit) return explicit
  const digits = String(phone || '').replace(/@[^@]+$/, '').replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15 ? digits : ''
}

/** 12 e 13 dígitos do mesmo celular BR, sem reescrever o valor pelo preferredBrSendDigits. */
function listWhapiIdentityDigits(phone) {
  const stored = storedPrivateDigits(phone)
  if (!stored) return []
  const out = [stored]
  for (const variant of possiblePhonesForWhatsappIdentity(stored)) {
    const digits = storedPrivateDigits(variant) || String(variant || '').replace(/\D/g, '')
    if (digits) out.push(digits)
  }
  return [...new Set(out)]
}

function collectWhapiCheckCandidates({ phone, fallback, cliente, conversa } = {}) {
  const seeds = [
    storedPrivateDigits(conversa?.telefone),
    storedPrivateDigits(phone),
    storedPrivateDigits(cliente?.telefone),
    fallback,
  ].filter(Boolean)
  const expanded = []
  for (const seed of seeds) {
    for (const digits of listWhapiIdentityDigits(seed)) expanded.push(digits)
  }
  const unique = [...new Set([...seeds, ...expanded].filter(Boolean))]
  const twelve = unique.filter((d) => d.startsWith('55') && d.length === 12)
  const others = unique.filter((d) => !twelve.includes(d))
  return { seeds: [...new Set(seeds)], candidates: [...twelve, ...others] }
}

/** Se o checkPhones falhar, não inventar o 9º quando a conversa/cliente já tem a forma 12. */
function preferredUnresolvedFallback(seeds, fallback) {
  const twelveSeed = (seeds || []).find((d) => String(d).startsWith('55') && String(d).length === 12)
  if (twelveSeed) return twelveSeed
  return fallback
}

function checkPhonesDigits(value) {
  return String(value || '').replace(/@[^@]+$/, '').replace(/\D/g, '')
}

/** Prefere o primeiro candidato da nossa lista que a Whapi marcou como válido. */
function pickCanonicalFromCheckPhones(checked, candidates) {
  const list = Array.isArray(checked) ? checked : []
  const byInput = new Map()
  for (const item of list) {
    if (!item?.exists || !item?.waId) continue
    const inputDigits = checkPhonesDigits(item.input)
    if (inputDigits) byInput.set(inputDigits, item)
  }
  for (const cand of candidates) {
    const hit = byInput.get(checkPhonesDigits(cand))
    if (hit) return normalizeCanonicalWaId(hit.waId)
  }
  const any = list.find((item) => item?.exists && item?.waId)
  return normalizeCanonicalWaId(any?.waId)
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

async function persistCanonicalWaId(companyId, cliente, canonicalWaId, opts = {}) {
  const replaceExisting = opts.replaceExisting === true
  if (!cliente?.id || !canonicalWaId) return false
  const current = String(cliente.wa_id || '').trim()
  if (!replaceExisting && current) return false
  let query = supabase
    .from('clientes')
    .update({ wa_id: canonicalWaId, atualizado_em: new Date().toISOString() })
    .eq('company_id', Number(companyId))
    .eq('id', cliente.id)
  if (replaceExisting && current) {
    query = query.eq('wa_id', current)
  } else {
    query = cliente.wa_id == null ? query.is('wa_id', null) : query.eq('wa_id', '')
  }
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
  let lastSeeds = collectWhapiCheckCandidates({ phone, fallback }).seeds

  try {
    const context = conversaId != null ? await load(companyId, conversaId) : null
    const cliente = context?.cliente || (clienteId != null ? await loadClient(companyId, clienteId) : null)
    const existingCanonical = normalizeCanonicalWaId(cliente?.wa_id)
    const waIdLooksLikeAgendaMobile = isThirteenDigitBrMobileWaId(existingCanonical)
    if (existingCanonical && !waIdLooksLikeAgendaMobile) return toWhapiRecipient(existingCanonical)

    const { seeds, candidates } = collectWhapiCheckCandidates({
      phone,
      fallback,
      cliente,
      conversa: context?.conversa,
    })
    lastSeeds = seeds
    if (!candidates.length) return existingCanonical ? toWhapiRecipient(existingCanonical) : fallback

    const checked = await checkPhones(candidates, {
      companyId: Number(companyId),
      whatsappInstanceId: opts.whatsappInstanceId ?? opts.whatsapp_instance_id,
      forceCheck: true,
    })
    const canonical = pickCanonicalFromCheckPhones(checked, candidates)
    if (!canonical) {
      return existingCanonical
        ? toWhapiRecipient(existingCanonical)
        : preferredUnresolvedFallback(seeds, fallback)
    }

    if (cliente?.id) {
      if (waIdLooksLikeAgendaMobile) {
        await persist(companyId, cliente, canonical, { replaceExisting: true })
      } else {
        await persist(companyId, cliente, canonical)
      }
    }
    return toWhapiRecipient(canonical)
  } catch (e) {
    const safeFallback = preferredUnresolvedFallback(lastSeeds, fallback)
    console.warn('[WHAPI_DESTINO] Falha ao resolver wa_id canonico; usando destino conservador', {
      company_id: Number(companyId) || null,
      conversa_id: Number(conversaId) || null,
      cliente_id: Number(clienteId) || null,
      error: e?.message || String(e),
      destino: safeFallback,
    })
    return safeFallback
  }
}

module.exports = {
  resolveWhapiSendRecipient,
  normalizeCanonicalWaId,
  isThirteenDigitBrMobileWaId,
  listWhapiIdentityDigits,
  loadConversationContact,
  loadClientById,
  persistCanonicalWaId,
}
