/**
 * Sincronização de contatos do celular via UltraMsg.
 * Endpoint: POST /api/integrations/whatsapp/contacts/sync
 *
 * Fluxo:
 * 1) Tenta GET /contacts (quando disponível) — mode: "contacts_api"
 * 2) Fallback via conversas existentes — mode: "fallback"
 *
 * Resposta: { ok, mode, totalFetched, inserted, updated, skipped, errors[] }
 */

const supabase = require('../config/supabase')
const { getProvider } = require('./providers')
const { getEmpresaWhatsappConfig } = require('./whatsappConfigService')
const { getOrCreateCliente } = require('../helpers/conversationSync')
const { syncUltraMsgContact } = require('./ultramsgSyncContact')
const { normalizePhoneBR, possiblePhonesBR, phoneKeyBR } = require('../helpers/phoneHelper')
const ultramsgIntegrationService = require('./ultramsgIntegrationService')

// Constantes de configuração
const PAGE_SIZE = 100
const MIN_PHONE_DIGITS = 10
const BR_COUNTRY_CODE = '55'
const MIN_BR_PHONE_LENGTH = 12
const MAX_BR_PHONE_LENGTH = 13
const ERROR_MESSAGE_MAX_LENGTH = 80

/**
 * Extrai phone e nome de um objeto contato retornado pelo provider.
 * Campos: phone, name, short, vname, notify, imgUrl (quando disponível)
 *
 * Regras de filtragem (evita contatos falsos/inventados):
 * 1) Exige campo `name` não-vazio: contatos sem nome não estão salvos na agenda —
 *    são apenas JIDs que apareceram em conversas, grupos ou spam.
 * 2) Ignora grupos (@g.us) e IDs não-numéricos.
 * 3) Exige número BR válido após normalização (12 ou 13 dígitos, começa com 55).
 *    NÃO faz prepend '55' em números inválidos — evita inventar números.
 */
function extractContactFields(raw) {
  if (!raw || typeof raw !== 'object') return null

  // Regra 1: exige name (contato salvo na agenda do celular)
  const name = String(raw.name ?? '').trim()
  if (!name) return null

  const phoneRaw = raw.phone ?? raw.wa_id ?? raw.id ?? ''
  const phoneStr = String(phoneRaw || '').trim()

  // Regra 2: ignora grupos e IDs não numéricos
  if (phoneStr.endsWith('@g.us') || phoneStr.includes('-group')) return null

  const digits = phoneStr.replace(/\D/g, '')
  if (!digits || digits.length < MIN_PHONE_DIGITS) return null

  // Regra 3: normaliza para BR válido sem inventar prefixo
  const norm = normalizePhoneBR(digits)
  if (!norm || !norm.startsWith(BR_COUNTRY_CODE) || (norm.length !== MIN_BR_PHONE_LENGTH && norm.length !== MAX_BR_PHONE_LENGTH)) return null

  // Nome: prioriza name (salvo no celular) > short > notify > vname
  const nome = name || String(raw.short ?? raw.notify ?? raw.vname ?? '').trim() || null

  const foto = raw.imgUrl ?? raw.photo ?? raw.profilePicture ?? null
  const fotoUrl = foto && typeof foto === 'string' && foto.trim().startsWith('http') ? foto.trim() : null

  return { phone: norm, nome: nome || null, foto: fotoUrl || null }
}

/**
 * Sync via API oficial GET /contacts.
 * A API UltraMsg retorna APENAS contatos da agenda do celular conectado via QR.
 * Regra: exige campo `name` — contatos sem nome são JIDs de conversas/grupos, não da agenda.
 * @param {number} company_id
 * @returns {Promise<{ mode: string, totalFetched: number, inserted: number, updated: number, skipped: number, errors: string[] }>}
 */
async function syncViaContactsApi(company_id) {
  const provider = getProvider()
  if (!provider?.getContacts) {
    return { mode: 'contacts_api', totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: ['getContacts não disponível'] }
  }

  const stats = { totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [] }
  const opts = { companyId: company_id }

  let page = 1
  let hasMore = true
  const seen = new Set()

  while (hasMore) {
    const contacts = await provider.getContacts(page, PAGE_SIZE, opts)
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

      // Usa phoneKeyBR como chave de dedup: normaliza 12↔13 dígitos para a mesma chave,
      // evitando que o mesmo contato físico seja processado duas vezes dentro do mesmo batch.
      const key = phoneKeyBR(fields.phone)
      if (seen.has(key)) {
        stats.skipped++
        continue
      }
      seen.add(key)

      try {
        const variants = possiblePhonesBR(fields.phone).length > 0 ? possiblePhonesBR(fields.phone) : [fields.phone]
        const { data: existente } = await supabase
          .from('clientes')
          .select('id, foto_perfil')
          .eq('company_id', company_id)
          .in('telefone', variants)
          .limit(1)
          .maybeSingle()

        const clienteFields = {}
        if (fields.nome) clienteFields.nome = fields.nome
        clienteFields.nomeSource = 'syncUltramsg'

        // Se não tem foto na resposta da API ou cliente existente não tem foto, busca ativamente
        let fotoUrl = fields.foto
        const needsFoto = !fotoUrl && (!existente?.foto_perfil || existente.foto_perfil === 'null' || existente.foto_perfil === '')
        
        if (needsFoto) {
          const provider = getProvider()
          if (provider?.getProfilePicture) {
            try {
              fotoUrl = await provider.getProfilePicture(fields.phone, { companyId: company_id })
              if (fotoUrl && typeof fotoUrl === 'string' && fotoUrl.startsWith('http')) {
                clienteFields.foto_perfil = fotoUrl
              }
            } catch (fotoErr) {
              // Falha na busca de foto não deve interromper o sync do contato
              console.warn(`[SYNC-CONTACTS] Erro ao buscar foto ${fields.phone.slice(-8)}:`, fotoErr?.message)
            }
          }
        } else if (fotoUrl) {
          clienteFields.foto_perfil = fotoUrl
        }

        const result = await getOrCreateCliente(supabase, company_id, fields.phone, clienteFields)
        if (result.cliente_id) {
          if (existente?.id) stats.updated++
          else stats.inserted++
        } else {
          stats.skipped++
        }
      } catch (e) {
        const errorMessage = String(e?.message || e).slice(0, ERROR_MESSAGE_MAX_LENGTH)
        stats.errors.push(`${fields.phone}: ${errorMessage}`)
      }
    }

    if (contacts.length < PAGE_SIZE) hasMore = false
    else page++
  }

  return { mode: 'contacts_api', ...stats }
}

/**
 * Fallback: enriquece clientes EXISTENTES a partir de conversas.
 * Apenas atualiza nome/foto de quem já tem registro em clientes — não cria novos.
 * Para criar contatos, use syncViaContactsApi (que filtra pela agenda do celular).
 */
async function syncViaFallback(company_id) {
  const stats = { totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [] }

  // Busca conversas onde o cliente já existe mas está sem nome ou foto
  const { data: conversas } = await supabase
    .from('conversas')
    .select('id, telefone, cliente_id, nome_contato_cache, foto_perfil_contato_cache')
    .eq('company_id', company_id)
    .neq('status_atendimento', 'fechada')
    .not('telefone', 'like', '%@g.us')
    .not('telefone', 'like', 'lid:%')
    .not('cliente_id', 'is', null)
    .limit(200)

  if (!Array.isArray(conversas) || conversas.length === 0) {
    return { mode: 'fallback', ...stats }
  }

  // Filtra apenas as que realmente precisam de enriquecimento (sem nome ou sem foto)
  const precisamSync = conversas.filter((c) => {
    const semNome = !c.nome_contato_cache || !String(c.nome_contato_cache).trim()
    const semFoto = !c.foto_perfil_contato_cache || !String(c.foto_perfil_contato_cache).trim().startsWith('http')
    return semNome || semFoto
  })

  stats.totalFetched = precisamSync.length

  for (const conv of precisamSync) {
    const phone = conv.telefone
    if (!phone || phone.startsWith('lid:')) {
      stats.skipped++
      continue
    }

    try {
      const chatId = phone.includes('@c.us') ? phone : `${String(phone).replace(/\D/g, '')}@c.us`
      const result = await syncUltraMsgContact(chatId, company_id, { skipCache: true })
      if (result) {
        stats.updated++
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
 * Sincroniza em lote conversas individuais sem nome ou foto.
 * Usa syncUltraMsgContact por conversa com delay para evitar rate limit.
 *
 * @param {number} company_id
 * @param {object} opts - { batchSize, delayMs }
 * @returns {Promise<{ processadas: number, atualizadas: number, errors: string[] }>}
 */
async function syncMissingConversationContacts(company_id, opts = {}) {
  const batchSize = Math.min(50, Math.max(5, opts.batchSize ?? 20))
  const delayMs = Math.max(200, opts.delayMs ?? 500)

  const { config, error } = await getEmpresaWhatsappConfig(company_id)
  if (error || !config) {
    return { processadas: 0, atualizadas: 0, errors: ['Empresa sem instância configurada'] }
  }

  const { data: conversas } = await supabase
    .from('conversas')
    .select('id, telefone, nome_contato_cache, foto_perfil_contato_cache')
    .eq('company_id', company_id)
    .not('telefone', 'like', '%@g.us')
    .not('telefone', 'like', 'lid:%')
    .limit(batchSize * 2)

  const allRows = Array.isArray(conversas) ? conversas : []
  const needsSync = (c) => {
    const hasNome = c.nome_contato_cache && String(c.nome_contato_cache).trim().length > 0
    const hasFoto = c.foto_perfil_contato_cache && String(c.foto_perfil_contato_cache).trim().startsWith('http')
    return !hasNome || !hasFoto
  }
  const rows = allRows.filter(needsSync).slice(0, batchSize)

  if (rows.length === 0) {
    return { processadas: 0, atualizadas: 0, errors: [] }
  }

  const stats = { processadas: 0, atualizadas: 0, errors: [] }

  for (const conv of rows) {
    if (!conv.telefone || conv.telefone.length < 10) continue

    try {
      const chatId = conv.telefone.includes('@c.us') ? conv.telefone : `${String(conv.telefone).replace(/\D/g, '')}@c.us`
      const result = await syncUltraMsgContact(chatId, company_id, { skipCache: true })
      if (result) {
        stats.processadas++
        if (result.nome || result.foto_perfil) stats.atualizadas++
      }
    } catch (e) {
      stats.errors.push(`${String(conv.telefone).slice(-8)}: ${String(e?.message || e).slice(0, 80)}`)
    }

    await new Promise((r) => setTimeout(r, delayMs))
  }

  return stats
}

/**
 * Verifica se o WhatsApp está conectado (celular logado via QR).
 * O sync de contatos usa GET /contacts da API UltraMsg, que retorna
 * APENAS os contatos salvos na agenda do celular conectado.
 */
async function ensureConnected(company_id) {
  const status = await ultramsgIntegrationService.getStatus(company_id)
  if (status.error) return status.error
  if (!status.connected) {
    return 'Conecte o WhatsApp via QR code antes de sincronizar. Os contatos são puxados exclusivamente da agenda do celular logado.'
  }
  return null
}

/**
 * Executa sync de contatos para a empresa.
 * Garante que só puxa contatos da agenda do celular conectado via QR.
 * ISOLAMENTO: cada empresa tem seus próprios clientes (company_id); nunca mistura contatos entre empresas.
 * @param {number} company_id - req.user.company_id (obrigatório)
 * @returns {Promise<{ ok: boolean, mode: string, totalFetched: number, inserted: number, updated: number, skipped: number, errors: string[] }>}
 */
async function syncContacts(company_id) {
  if (!company_id) {
    return { ok: false, mode: 'none', totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: ['company_id ausente'] }
  }

  const { config, error } = await getEmpresaWhatsappConfig(company_id)
  if (error || !config) {
    console.warn(`[ULTRAMSG-SYNC] empresa=${company_id} sem instância: ${error || 'sem config'}`)
    return { ok: false, mode: 'none', totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: ['Empresa sem instância WhatsApp configurada. Conecte o WhatsApp em Integrações.'] }
  }

  console.log(`[ULTRAMSG-SYNC] empresa=${company_id} instance=${config.instance_id} — verificando conexão...`)
  const connError = await ensureConnected(company_id)
  if (connError) {
    console.warn(`[ULTRAMSG-SYNC] empresa=${company_id} não conectada: ${connError}`)
    return { ok: false, mode: 'none', totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [connError] }
  }

  console.log(`[ULTRAMSG-SYNC] empresa=${company_id} conectada — iniciando busca de contatos...`)
  let result = await syncViaContactsApi(company_id)

  if (result.mode === 'contacts_api' && result.totalFetched === 0 && result.errors.length === 0) {
    console.log('[ULTRAMSG-SYNC] contacts_api vazio — usando fallback via conversas')
    result = await syncViaFallback(company_id)
  } else if (result.errors.some((e) => e.includes('falhou') || e.includes('não configurado'))) {
    console.log('[ULTRAMSG-SYNC] contacts_api falhou — usando fallback')
    result = await syncViaFallback(company_id)
  }

  // Log do resultado da sincronização
  console.log(`[ULTRAMSG-SYNC] Concluído: ${result.mode}, fetched=${result.totalFetched}, inserted=${result.inserted}, updated=${result.updated}, skipped=${result.skipped}`)
  if (result.errors.length > 0) {
    console.warn('[ULTRAMSG-SYNC] Erros:', result.errors.slice(0, 3))
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

/**
 * Processa um único lote (página) de contatos.
 * Usado pela sincronização progressiva.
 * @param {number} company_id
 * @param {object} opts - { page, pageSize }
 * @returns {Promise<{ processados: number, inserted: number, updated: number, skipped: number, errors: string[], hasMore: boolean }>}
 */
async function syncContactsBatch(company_id, opts = {}) {
  const page = Math.max(1, opts.page || 1)
  const pageSize = Math.min(100, Math.max(10, opts.pageSize || 50))
  const provider = getProvider()

  if (!provider?.getContacts) {
    return { processados: 0, inserted: 0, updated: 0, skipped: 0, errors: ['getContacts não disponível'], hasMore: false }
  }

  const { config, error } = await getEmpresaWhatsappConfig(company_id)
  if (error || !config) {
    return { processados: 0, inserted: 0, updated: 0, skipped: 0, errors: ['Empresa sem instância configurada'], hasMore: false }
  }

  const connError = await ensureConnected(company_id)
  if (connError) {
    return { processados: 0, inserted: 0, updated: 0, skipped: 0, errors: [connError], hasMore: false }
  }

  const contacts = await provider.getContacts(page, pageSize, { companyId: company_id })
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return { processados: 0, inserted: 0, updated: 0, skipped: 0, errors: [], hasMore: false }
  }

  const stats = { processados: 0, inserted: 0, updated: 0, skipped: 0, errors: [] }
  const seen = new Set()

  for (const c of contacts) {
    const fields = extractContactFields(c)
    if (!fields || !fields.phone) {
      stats.skipped++
      continue
    }

    const key = phoneKeyBR(fields.phone)
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
      clienteFields.nomeSource = 'syncUltramsg'

      const result = await getOrCreateCliente(supabase, company_id, fields.phone, clienteFields)
      if (result.cliente_id) {
        if (existente?.id) stats.updated++
        else stats.inserted++
      } else {
        stats.skipped++
      }
      stats.processados++
    } catch (e) {
      stats.errors.push(`${fields.phone}: ${String(e?.message || e).slice(0, 80)}`)
    }
  }

  const hasMore = contacts.length >= pageSize
  return { ...stats, hasMore }
}

module.exports = {
  syncContacts,
  syncViaContactsApi,
  syncViaFallback,
  syncContactsBatch,
  syncMissingConversationContacts
}
