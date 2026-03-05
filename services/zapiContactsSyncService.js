/**
 * Sincronização de contatos do celular via Z-API.
 * Endpoint: POST /api/integrations/zapi/contacts/sync
 *
 * Fluxo:
 * 1) Tenta GET /contacts (API oficial Z-API) — mode: "contacts_api"
 * 2) Se falhar ou retornar vazio: fallback via conversas existentes — mode: "fallback"
 *
 * Resposta: { ok, mode, totalFetched, inserted, updated, skipped, errors[] }
 */

const supabase = require('../config/supabase')
const zapiProvider = require('./providers/zapi')
const { getEmpresaZapiConfig } = require('./zapiIntegrationService')
const { getOrCreateCliente } = require('../helpers/conversationSync')
const { syncContactFromZapi } = require('./zapiSyncContact')
const { normalizePhoneBR, possiblePhonesBR } = require('../helpers/phoneHelper')

const PAGE_SIZE = 100

/**
 * Extrai phone e nome de um objeto contato retornado pela Z-API.
 * Campos: phone, name, short, vname, notify, imgUrl (quando disponível)
 */
function extractContactFields(raw) {
  if (!raw || typeof raw !== 'object') return null
  const phoneRaw = raw.phone ?? raw.wa_id ?? raw.id ?? ''
  const phone = String(phoneRaw || '').trim().replace(/\D/g, '')
  if (!phone || phone.length < 10) return null

  const norm = normalizePhoneBR(phone) || (phone.startsWith('55') ? phone : `55${phone}`)
  const nome =
    String(raw.notify ?? raw.name ?? raw.short ?? raw.vname ?? '').trim() ||
    null

  const foto = raw.imgUrl ?? raw.photo ?? raw.profilePicture ?? null
  const fotoUrl = foto && typeof foto === 'string' ? foto.trim() : (foto?.url ? String(foto.url).trim() : null)

  return { phone: norm, nome: nome || null, foto: fotoUrl || null }
}

/**
 * Sync via API oficial GET /contacts (Z-API).
 * @param {number} company_id
 * @returns {Promise<{ mode: string, totalFetched: number, inserted: number, updated: number, skipped: number, errors: string[] }>}
 */
async function syncViaContactsApi(company_id) {
  if (!zapiProvider.getContacts) {
    return { mode: 'contacts_api', totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: ['Z-API getContacts não disponível'] }
  }

  const stats = { totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [] }
  const opts = { companyId: company_id }

  let page = 1
  let hasMore = true
  const seen = new Set()

  while (hasMore) {
    const contacts = await zapiProvider.getContacts(page, PAGE_SIZE, opts)
    if (!Array.isArray(contacts) || contacts.length === 0) {
      hasMore = false
      break
    }

    stats.totalFetched += contacts.length
    for (const c of contacts) {
      const fields = extractContactFields(c)
      if (!fields || !fields.phone) {
        stats.skipped++
        continue
      }

      const key = fields.phone
      if (seen.has(key)) {
        stats.skipped++
        continue
      }
      seen.add(key)

      try {
        const variants = possiblePhonesBR(fields.phone).length > 0 ? possiblePhonesBR(fields.phone) : [fields.phone]
        const { data: existente } = await supabase
          .from('clientes')
          .select('id')
          .eq('company_id', company_id)
          .in('telefone', variants)
          .limit(1)
          .maybeSingle()

        const clienteFields = {}
        if (fields.nome) clienteFields.nome = fields.nome
        if (fields.foto) clienteFields.foto_perfil = fields.foto
        clienteFields.nomeSource = 'syncZapi'

        const result = await getOrCreateCliente(supabase, company_id, fields.phone, clienteFields)
        if (result.cliente_id) {
          if (existente?.id) stats.updated++
          else stats.inserted++
        } else {
          stats.skipped++
        }
      } catch (e) {
        stats.errors.push(`${fields.phone}: ${String(e?.message || e).slice(0, 80)}`)
      }
    }

    if (contacts.length < PAGE_SIZE) hasMore = false
    else page++
  }

  return { mode: 'contacts_api', ...stats }
}

/**
 * Fallback: enriquece clientes a partir de conversas existentes.
 * Busca conversas abertas com telefone individual e chama syncContactFromZapi.
 */
async function syncViaFallback(company_id) {
  const stats = { totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [] }

  const { data: conversas } = await supabase
    .from('conversas')
    .select('id, telefone, cliente_id, nome_contato_cache')
    .eq('company_id', company_id)
    .neq('status_atendimento', 'fechada')
    .not('telefone', 'like', '%@g.us')
    .not('telefone', 'like', 'lid:%')
    .limit(200)

  if (!Array.isArray(conversas) || conversas.length === 0) {
    return { mode: 'fallback', ...stats }
  }

  stats.totalFetched = conversas.length

  for (const conv of conversas) {
    const phone = conv.telefone
    if (!phone || phone.startsWith('lid:')) {
      stats.skipped++
      continue
    }

    try {
      const enriched = await syncContactFromZapi(phone, company_id)
      const nome = enriched?.nome ?? conv.nome_contato_cache ?? null
      const foto = enriched?.foto_perfil ?? null

      const clienteFields = {}
      if (nome) clienteFields.nome = nome
      if (foto) clienteFields.foto_perfil = foto
      clienteFields.nomeSource = 'syncZapi'

      const variants = possiblePhonesBR(phone).length > 0 ? possiblePhonesBR(phone) : [phone]
      const { data: prev } = await supabase
        .from('clientes')
        .select('id')
        .eq('company_id', company_id)
        .in('telefone', variants)
        .limit(1)
        .maybeSingle()

      const result = await getOrCreateCliente(supabase, company_id, phone, clienteFields)
      if (result.cliente_id) {
        if (prev?.id) stats.updated++
        else stats.inserted++
      } else {
        stats.skipped++
      }
    } catch (e) {
      stats.errors.push(`${String(phone).slice(-8)}: ${String(e?.message || e).slice(0, 80)}`)
    }
  }

  return { mode: 'fallback', ...stats }
}

/**
 * Executa sync de contatos para a empresa.
 * @param {number} company_id - req.user.company_id
 * @returns {Promise<{ ok: boolean, mode: string, totalFetched: number, inserted: number, updated: number, skipped: number, errors: string[] }>}
 */
async function syncContacts(company_id) {
  if (!company_id) {
    return { ok: false, mode: 'none', totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: ['company_id ausente'] }
  }

  const { config, error } = await getEmpresaZapiConfig(company_id)
  if (error || !config) {
    return { ok: false, mode: 'none', totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: ['Empresa sem instância Z-API configurada'] }
  }

  let result = await syncViaContactsApi(company_id)

  if (result.mode === 'contacts_api' && result.totalFetched === 0 && result.errors.length === 0) {
    console.log('[ZAPI-SYNC] contacts_api vazio — usando fallback via conversas')
    result = await syncViaFallback(company_id)
  } else if (result.errors.some((e) => e.includes('falhou') || e.includes('não configurado'))) {
    console.log('[ZAPI-SYNC] contacts_api falhou — usando fallback')
    result = await syncViaFallback(company_id)
  }

  return {
    ok: true,
    mode: result.mode,
    totalFetched: result.totalFetched,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped,
    errors: result.errors
  }
}

module.exports = { syncContacts, syncViaContactsApi, syncViaFallback }
