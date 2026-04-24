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
const { phoneKeyBR } = require('../helpers/phoneHelper')
const { processContactsPage, parseAgendaContact } = require('./contactSyncService')

// Chunks alinhados ao max da API (~1000); paginação correta via hasMore (ver ultramsg getContacts)
const PAGE_SIZE = 1000
/** Evita laço infinito se a API ignorar offset e repetir a mesma página. */
const MAX_SYNC_PAGES = 200
const ERROR_MESSAGE_MAX_LENGTH = 80

/**
 * Alias para parseAgendaContact (uma única regra de normalização para sync manual e progressivo).
 */
function extractContactFields(raw) {
  return parseAgendaContact(raw)
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
    if (page > MAX_SYNC_PAGES) {
      stats.errors.push(
        `Limite de ${MAX_SYNC_PAGES} páginas de agenda atingido (proteção). Sincronização progressiva pode continuar o restante.`
      )
      break
    }

    const res = await provider.getContacts(page, PAGE_SIZE, opts)
    const contacts = res?.data != null ? res.data : (Array.isArray(res) ? res : [])
    const pageHasMore = res?.hasMore === true
    if (!Array.isArray(contacts) || contacts.length === 0) {
      if (!pageHasMore) hasMore = false
      else {
        page++
        continue
      }
      break
    }

    stats.totalFetched += contacts.length
    let novosNestaPagina = 0
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
      novosNestaPagina++

      try {
        const clienteFields = {}
        if (fields.nome) clienteFields.nome = fields.nome
        if (fields.waId) clienteFields.wa_id = fields.waId
        // Foto da resposta da API (campo imgUrl/photo), se existir — sem chamada individual extra
        // Fotos individuais são atualizadas pelo botão "Sincronizar fotos de perfil"
        if (fields.foto) clienteFields.foto_perfil = fields.foto
        clienteFields.nomeSource = 'syncUltramsg'

        const result = await getOrCreateCliente(supabase, company_id, fields.phone, clienteFields)
        if (result.cliente_id) {
          if (result.created === true) stats.inserted++
          else if (result.changed === true) stats.updated++
          else stats.skipped++
        } else {
          stats.skipped++
        }
      } catch (e) {
        const errorMessage = String(e?.message || e).slice(0, ERROR_MESSAGE_MAX_LENGTH)
        stats.errors.push(`${fields.phone}: ${errorMessage}`)
      }
    }

    // Se a API não avança o offset, a 2.ª+ página repete 100% dos contactos; sem isto o while nunca acaba.
    if (page > 1 && novosNestaPagina === 0) {
      console.warn(
        '[SYNC-CONTATOS] Página da agenda repetida (possivelmente offset não suportado). Encerrando loop.'
      )
      hasMore = false
      break
    }

    if (!pageHasMore) hasMore = false
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

  console.log(`[ULTRAMSG-SYNC] empresa=${company_id} instance=${config.instance_id} — iniciando busca de contatos (UltraMSG)...`)
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
 * Usado pela rota e testes; delega a contactSyncService (dedupe, wa_id, logs).
 * @param {number} company_id
 * @param {object} opts - { page, pageSize }
 * @returns {Promise<{ processados: number, inserted: number, updated: number, skipped: number, conflicted?: number, errors: string[], hasMore: boolean }>}
 */
async function syncContactsBatch(company_id, opts = {}) {
  const page = Math.max(1, opts.page || 1)
  const pageSize = Math.min(1000, Math.max(10, opts.pageSize || 50))
  return processContactsPage(company_id, { page, pageSize })
}

module.exports = {
  syncContacts,
  syncViaContactsApi,
  syncViaFallback,
  syncContactsBatch,
  syncMissingConversationContacts
}
