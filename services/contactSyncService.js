/**
 * Sincronização segura e retomável de contatos da agenda (GET /contacts / UltraMsg).
 * - Isolamento por company_id (via empresa_zapi no provider).
 * - Lock sync_locks + checkpoint checkpoints_sync (tipo contact_sync).
 * - Deduplicação por empresa: wa_id normalizado e/ou telefone BR normalizado.
 * - Não remove clientes; upsert conservador (sem sobrescrever com null/vazio).
 */

const supabase = require('../config/supabase')
const { getProvider } = require('./providers')
const { getEmpresaWhatsappConfig } = require('./whatsappConfigService')
const { getOrCreateCliente } = require('../helpers/conversationSync')
const { normalizePhoneBR, possiblePhonesBR, phoneKeyBR } = require('../helpers/phoneHelper')
const { isBadName, chooseBestName } = require('../helpers/contactEnrichment')
const { getConfig, isProcessamentoPausado } = require('./configOperacionalService')
const { registrarEvento, TIPOS } = require('./operationalAuditService')

const LOCK_TIPO = 'contact_sync'
const CHECKPOINT_TIPO = 'contact_sync'
const NOME_FONTE = 'syncUltramsg'

const PAGE_SIZE_DEFAULT = 1000
const MIN_PHONE_DIGITS = 10
const BR_COUNTRY_CODE = '55'
const MIN_BR_PHONE_LENGTH = 12
const MAX_BR_PHONE_LENGTH = 13
const ERROR_MESSAGE_MAX_LENGTH = 80
const MAX_PAGES_DEFAULT = parseInt(process.env.SYNC_MAX_PAGES_PER_RUN, 10) || 20

/**
 * Gera formas de wa_id / JID possíveis para busca (sem expor lógica global).
 */
function waIdSearchVariants(phoneNorm, rawJid) {
  const set = new Set()
  if (rawJid && String(rawJid).trim()) {
    const t = String(rawJid).trim()
    set.add(t)
    set.add(t.toLowerCase())
  }
  if (phoneNorm && phoneNorm.length >= 12) {
    set.add(`${phoneNorm}@c.us`)
    set.add(`${phoneNorm}@s.whatsapp.net`)
  }
  return [...set].filter(Boolean)
}

/**
 * Valor canônico preferido para persistir em clientes.wa_id (individual BR).
 */
function canonicalWaId(phoneNorm, rawJid) {
  if (rawJid && String(rawJid).includes('@g.us')) return null
  if (phoneNorm && phoneNorm.startsWith('55') && (phoneNorm.length === 12 || phoneNorm.length === 13)) {
    if (rawJid && String(rawJid).toLowerCase().includes('whatsapp')) {
      return `${phoneNorm}@s.whatsapp.net`
    }
    return `${phoneNorm}@c.us`
  }
  if (rawJid && String(rawJid).trim() && /^\d{10,}@/.test(String(rawJid).trim())) {
    return String(rawJid).trim()
  }
  return null
}

/**
 * Extrai e valida contato do payload do provider (regras alinhadas ao sync legado: agenda = name preenchido).
 */
function parseAgendaContact(raw) {
  if (!raw || typeof raw !== 'object') return null

  const name = String(raw.name ?? '').trim()
  if (!name) return null

  const phoneRaw = raw.phone ?? raw.wa_id ?? raw.id ?? ''
  const phoneStr = String(phoneRaw || '').trim()
  if (phoneStr.endsWith('@g.us') || phoneStr.includes('-group')) return null

  const digits = phoneStr.replace(/\D/g, '')
  if (!digits || digits.length < MIN_PHONE_DIGITS) return null

  const norm = normalizePhoneBR(digits)
  if (!norm || !norm.startsWith(BR_COUNTRY_CODE) || (norm.length !== MIN_BR_PHONE_LENGTH && norm.length !== MAX_BR_PHONE_LENGTH)) {
    return null
  }

  const nome =
    name || String(raw.short ?? raw.notify ?? raw.vname ?? '').trim() || null
  const foto = raw.imgUrl ?? raw.photo ?? raw.profilePicture ?? null
  const fotoUrl = foto && typeof foto === 'string' && foto.trim().startsWith('http') ? foto.trim() : null
  const waId = canonicalWaId(norm, phoneStr)

  return { phone: norm, nome: nome || null, foto: fotoUrl || null, rawJid: phoneStr, waId }
}

/**
 * Busca candidatos no mesmo company_id (telefone e/ou wa_id).
 * @returns {Promise<{ rows: object[], hadConflict: boolean }>}
 */
async function findClienteCandidates(companyId, phoneNorm, rawJid) {
  const company_id = Number(companyId)
  const phones = possiblePhonesBR(phoneNorm)
  const waList = waIdSearchVariants(phoneNorm, rawJid)

  const byId = new Map()
  if (waList.length) {
    const { data: a } = await supabase
      .from('clientes')
      .select('id, nome, telefone, wa_id, pushname, foto_perfil, email, empresa, company_id')
      .eq('company_id', company_id)
      .in('wa_id', waList)
    for (const r of a || []) byId.set(r.id, r)
  }
  if (phones.length) {
    const { data: b } = await supabase
      .from('clientes')
      .select('id, nome, telefone, wa_id, pushname, foto_perfil, email, empresa, company_id')
      .eq('company_id', company_id)
      .in('telefone', phones)
    for (const r of b || []) byId.set(r.id, r)
  }

  const rows = [...byId.values()].sort((x, y) => x.id - y.id)
  return { rows, hadConflict: rows.length > 1 }
}

/**
 * Foto: só preenche se ainda vazio ou inútil.
 */
function shouldApplyFoto(existente, novoUrl) {
  const cur = existente?.foto_perfil
  if (!novoUrl || typeof novoUrl !== 'string' || !novoUrl.startsWith('http')) return false
  if (!cur || cur === 'null' || !String(cur).trim()) return true
  return false
}

/**
 * Sincroniza um contato da agenda: insert ou update conservador.
 */
async function syncOneAgendaContact(companyId, parsed) {
  const { rows, hadConflict } = await findClienteCandidates(companyId, parsed.phone, parsed.rawJid)

  if (hadConflict) {
    const ids = rows.map((r) => r.id).join(',')
    const tail = String(parsed.phone).slice(-6)
    console.warn(
      `[CONTACT-SYNC] conflito candidatos company_id=${companyId} tail=${tail} ids=[${ids}] — atualizando menor id, revisar duplicata`
    )
  }

  const fieldsBase = { nomeSource: NOME_FONTE }
  if (parsed.nome) fieldsBase.nome = parsed.nome
  if (parsed.foto) fieldsBase.foto_perfil = parsed.foto
  if (parsed.waId) fieldsBase.wa_id = parsed.waId

  if (rows.length > 1) {
    const existente = rows[0]
    const updates = {}
    const telefoneTail = String(parsed.phone).replace(/\D/g, '').slice(-6) || null
    if (fieldsBase.nome && String(fieldsBase.nome).trim()) {
      const { name: bestNome, decision } = chooseBestName(
        existente.nome,
        String(fieldsBase.nome).trim(),
        NOME_FONTE,
        { fromMe: false, company_id: companyId, telefoneTail }
      )
      if (bestNome && decision === 'updated' && !isBadName(bestNome)) updates.nome = bestNome
    }
    if (shouldApplyFoto(existente, fieldsBase.foto_perfil)) {
      updates.foto_perfil = String(fieldsBase.foto_perfil).trim()
    }
    if (fieldsBase.wa_id && (!existente.wa_id || !String(existente.wa_id).trim())) {
      updates.wa_id = String(fieldsBase.wa_id).trim()
    }
    if (Object.keys(updates).length > 0) {
      const { error } = await supabase
        .from('clientes')
        .update(updates)
        .eq('id', existente.id)
        .eq('company_id', Number(companyId))
      if (error) console.warn('[CONTACT-SYNC] update cliente (conflito):', error.message || error)
    }
    const changed = Object.keys(updates).length > 0
    return {
      inserted: 0,
      updated: changed ? 1 : 0,
      skipped: changed ? 0 : 1,
      conflict: true
    }
  }

  const variants = possiblePhonesBR(parsed.phone).length > 0 ? possiblePhonesBR(parsed.phone) : [parsed.phone]
  const { data: exAntes } = await supabase
    .from('clientes')
    .select('id')
    .eq('company_id', Number(companyId))
    .in('telefone', variants)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()
  const existia = rows.length === 1 || !!exAntes?.id

  const r = await getOrCreateCliente(supabase, companyId, parsed.phone, fieldsBase)
  if (r.cliente_id) {
    if (existia) {
      return { inserted: 0, updated: 1, skipped: 0, conflict: false }
    }
    return { inserted: 1, updated: 0, skipped: 0, conflict: false }
  }
  return { inserted: 0, updated: 0, skipped: 1, conflict: false }
}

/**
 * Enriquece foto via API (opcional) — mesmo critério do serviço legado.
 */
async function maybeEnrichFoto(companyId, phoneNorm, existente) {
  let fotoUrl = null
  const needsFoto = !existente?.foto_perfil || existente.foto_perfil === 'null' || existente.foto_perfil === ''
  if (!needsFoto) return null
  const provider = getProvider()
  if (provider?.getProfilePicture) {
    try {
      fotoUrl = await provider.getProfilePicture(phoneNorm, { companyId })
      if (fotoUrl && typeof fotoUrl === 'string' && fotoUrl.startsWith('http')) return fotoUrl
    } catch (e) {
      console.warn(`[CONTACT-SYNC] getProfilePicture tail ${String(phoneNorm).slice(-6)}:`, e?.message || e)
    }
  }
  return null
}

/**
 * Uma página de contatos: fetch + aplica sync seguro.
 */
async function processContactsPage(companyId, opts = {}) {
  const page = Math.max(1, Number(opts.page) || 1)
  // Até 1000 por requisição (teto da API); alinhado ao getContacts/UltraMsg
  const pageSize = Math.min(1000, Math.max(10, Number(opts.pageSize) || PAGE_SIZE_DEFAULT))
  const provider = getProvider()

  if (!provider?.getContacts) {
    return {
      processados: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      conflicted: 0,
      errors: ['getContacts não disponível no provider'],
      hasMore: false,
      advanceCheckpoint: false
    }
  }

  const { config, error } = await getEmpresaWhatsappConfig(companyId)
  if (error || !config) {
    return {
      processados: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      conflicted: 0,
      errors: ['Empresa sem instância configurada em empresa_zapi'],
      hasMore: false,
      advanceCheckpoint: false
    }
  }

  const gcr = await provider.getContacts(page, pageSize, { companyId })
  const contacts = gcr?.data != null ? gcr.data : (Array.isArray(gcr) ? gcr : [])
  const apiHasMore = gcr?.hasMore === true
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return {
      processados: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      conflicted: 0,
      errors: [],
      hasMore: apiHasMore,
      advanceCheckpoint: true
    }
  }

  const stats = { processados: 0, inserted: 0, updated: 0, skipped: 0, conflicted: 0, errors: [] }
  const seen = new Set()

  for (const c of contacts) {
    const parsed = parseAgendaContact(c)
    if (!parsed || !parsed.phone) {
      stats.skipped++
      continue
    }
    const key = phoneKeyBR(parsed.phone)
    if (seen.has(key)) {
      stats.skipped++
      continue
    }
    seen.add(key)

    try {
      const r = await syncOneAgendaContact(companyId, parsed)
      stats.processados++
      stats.inserted += r.inserted ? 1 : 0
      stats.updated += r.updated ? 1 : 0
      if (r.skipped) stats.skipped += 1
      if (r.conflict) stats.conflicted += 1
    } catch (e) {
      const em = String(e?.message || e).slice(0, ERROR_MESSAGE_MAX_LENGTH)
      stats.errors.push(`${parsed.phone.slice(-8)}: ${em}`)
    }
  }

  const hasMore = apiHasMore
  return { ...stats, hasMore, advanceCheckpoint: true }
}

async function tryAcquireLock(company_id) {
  const { error } = await supabase.from('sync_locks').insert({
    company_id,
    tipo: LOCK_TIPO,
    locked_by: 'contact_sync'
  })
  if (error) {
    const dup = String(error.code || '') === '23505' || String(error.message || '').includes('duplicate')
    if (dup) return false
    console.warn('[CONTACT-SYNC] lock insert:', error.message || error)
    return false
  }
  return true
}

async function releaseLock(company_id) {
  try {
    await supabase.from('sync_locks').delete().eq('company_id', company_id).eq('tipo', LOCK_TIPO)
  } catch (e) {
    console.warn('[CONTACT-SYNC] release lock:', e?.message || e)
  }
}

async function getCheckpoint(company_id) {
  const { data } = await supabase
    .from('checkpoints_sync')
    .select('ultimo_offset')
    .eq('company_id', company_id)
    .eq('tipo', CHECKPOINT_TIPO)
    .maybeSingle()
  const o = data?.ultimo_offset
  if (o == null || o === 0) return 1
  return Number(o) || 1
}

async function updateCheckpoint(company_id, nextPage, detalhes = {}) {
  await supabase.from('checkpoints_sync').upsert(
    {
      company_id,
      tipo: CHECKPOINT_TIPO,
      ultimo_offset: nextPage,
      detalhes_json: detalhes,
      atualizado_em: new Date().toISOString()
    },
    { onConflict: 'company_id,tipo' }
  )
}

async function resetCheckpoint(company_id) {
  await supabase.from('checkpoints_sync').delete().eq('company_id', company_id).eq('tipo', CHECKPOINT_TIPO)
}

/**
 * Um lote com lock. Checkpoint avança só após o lote processar (sem exceção).
 */
async function runContactSyncBatch(company_id, opts = {}) {
  if (!company_id) {
    return {
      ok: false,
      processados: 0,
      criados: 0,
      atualizados: 0,
      ignorados: 0,
      conflitados: 0,
      temMais: false,
      checkpoint: 1,
      locked: false,
      error: 'company_id ausente'
    }
  }

  const pausado = await isProcessamentoPausado(company_id)
  if (pausado) {
    return {
      ok: false,
      processados: 0,
      criados: 0,
      atualizados: 0,
      ignorados: 0,
      conflitados: 0,
      temMais: false,
      checkpoint: 1,
      locked: false,
      error: 'Processamento pausado'
    }
  }

  const config = await getConfig(company_id)
  const pageSize = Math.min(1000, Math.max(10, config.lote_max || 50))
  const maxPages = opts.maxPagesPerRun
  const acquired = await tryAcquireLock(company_id)
  if (!acquired) {
    return {
      ok: false,
      processados: 0,
      criados: 0,
      atualizados: 0,
      ignorados: 0,
      conflitados: 0,
      temMais: false,
      checkpoint: 1,
      locked: false,
      error: 'Sincronização de contatos já em andamento para esta empresa'
    }
  }

  let page = 1
  try {
    if (opts.reset) {
      await resetCheckpoint(company_id)
      page = 1
    } else {
      page = await getCheckpoint(company_id)
    }

    const batch = await processContactsPage(company_id, { page, pageSize })

    if (batch.advanceCheckpoint === false) {
      const msg = batch.errors?.[0] || 'Lote inválido (config ou provider)'
      await registrarEvento(company_id, TIPOS.FALHA, 'Contact sync: checkpoint NÃO avançado', { page, motivo: msg })
      return {
        ok: false,
        processados: batch.processados,
        criados: batch.inserted,
        atualizados: batch.updated,
        ignorados: batch.skipped,
        conflitados: batch.conflicted,
        temMais: false,
        checkpoint: page,
        locked: true,
        error: msg
      }
    }

    if (batch.errors?.length) {
      await registrarEvento(company_id, TIPOS.FALHA, `Contact sync lote página ${page} com erros`, {
        page,
        amostra: batch.errors.slice(0, 5)
      })
    }

    const nextPage = page + 1
    await updateCheckpoint(company_id, nextPage, {
      lastProcessados: batch.processados,
      lastInserted: batch.inserted,
      lastUpdated: batch.updated,
      lastSkipped: batch.skipped,
      lastConflicted: batch.conflicted
    })
    await registrarEvento(company_id, TIPOS.SYNC_LOTE, `Lote de contatos página ${page} processado`, {
      page,
      processados: batch.processados,
      inserted: batch.inserted,
      updated: batch.updated,
      conflicted: batch.conflicted
    })

    const underCap = maxPages == null || Number(page) < Number(maxPages)
    const temMais = !!batch.hasMore && underCap

    return {
      ok: true,
      processados: batch.processados,
      criados: batch.inserted,
      atualizados: batch.updated,
      ignorados: batch.skipped,
      conflitados: batch.conflicted,
      temMais,
      checkpoint: nextPage,
      locked: true
    }
  } catch (e) {
    const msg = e?.message || String(e)
    await registrarEvento(company_id, TIPOS.FALHA, 'Contact sync lote falhou', { error: msg.slice(0, 200) })
    return {
      ok: false,
      processados: 0,
      criados: 0,
      atualizados: 0,
      ignorados: 0,
      conflitados: 0,
      temMais: false,
      checkpoint: page != null ? page : 1,
      locked: true,
      error: msg
    }
  } finally {
    await releaseLock(company_id)
  }
}

/**
 * Sincronização completa para jobs/worker.
 *
 * Estratégia gradual:
 *  1. Busca TODA a lista da API UltraMsg uma única vez (ela não pagina de verdade).
 *  2. Divide os contatos em lotes de CHUNK_SIZE e processa cada lote com uma pausa
 *     entre eles — evita sobrecarregar o banco e dá feedback progressivo via logs/eventos.
 *  3. O lock é mantido durante toda a sessão; o checkpoint registra qual lote foi
 *     concluído, permitindo retomada segura.
 */
async function runContactSyncFull(company_id, opts = {}) {
  if (!company_id) return { ok: false, error: 'company_id ausente', totalProcessados: 0, totalCriados: 0, totalAtualizados: 0 }

  const config = await getConfig(company_id)
  // Tamanho de cada lote de inserção no banco. Padrão 200; configurável via lote_max.
  const CHUNK_SIZE = Math.min(500, Math.max(50, config.lote_max || 200))
  // Pausa entre lotes em ms (padrão 2 s). Suficiente para não saturar o banco.
  const PAUSA_MS = Math.max(500, (config.intervalo_lotes_seg || 2) * 1000)

  await registrarEvento(company_id, TIPOS.SYNC_INICIO, 'Contact sync iniciada (gradual)', { chunkSize: CHUNK_SIZE })

  // Adquirir lock para toda a sessão.
  const acquired = await tryAcquireLock(company_id)
  if (!acquired) {
    return { ok: false, error: 'Sincronização já em andamento', totalProcessados: 0, totalCriados: 0, totalAtualizados: 0 }
  }

  try {
    // 1. Verificar provider e config da empresa.
    const provider = getProvider()
    if (!provider?.getContacts) {
      await registrarEvento(company_id, TIPOS.FALHA, 'provider.getContacts não disponível')
      return { ok: false, error: 'getContacts não disponível', totalProcessados: 0, totalCriados: 0, totalAtualizados: 0 }
    }

    const { config: waCfg, error: cfgErr } = await getEmpresaWhatsappConfig(company_id)
    if (cfgErr || !waCfg) {
      await registrarEvento(company_id, TIPOS.FALHA, 'Empresa sem instância configurada')
      return { ok: false, error: 'Empresa sem instância configurada', totalProcessados: 0, totalCriados: 0, totalAtualizados: 0 }
    }

    // 2. Buscar TODOS os contatos da API, percorrendo páginas até hasMore=false.
    //    UltraMsg tipicamente devolve tudo na página 1, mas o loop garante que
    //    nenhum contato seja perdido caso a API tenha limite interno e retorne hasMore.
    const MAX_FETCH_PAGES = 50  // teto de segurança (50 × 10000 = 500 000 contatos)
    let allContacts = []
    let fetchPage = 1
    let keepFetching = true

    while (keepFetching && fetchPage <= MAX_FETCH_PAGES) {
      const gcr = await provider.getContacts(fetchPage, 10000, { companyId: company_id })
      const pageData = Array.isArray(gcr?.data) ? gcr.data : []
      allContacts = allContacts.concat(pageData)

      console.log(`[CONTACT-SYNC] empresa=${company_id} fetch p${fetchPage}: ${pageData.length} contatos (hasMore=${gcr?.hasMore})`)

      if (!gcr?.hasMore || pageData.length === 0) {
        keepFetching = false
      } else {
        fetchPage++
      }
    }

    if (allContacts.length === 0) {
      await registrarEvento(company_id, TIPOS.SYNC_FIM, 'Nenhum contato retornado pela API')
      return { ok: true, totalProcessados: 0, totalCriados: 0, totalAtualizados: 0, paginas: 0 }
    }

    console.log(`[CONTACT-SYNC] empresa=${company_id} total da API: ${allContacts.length} contatos (${fetchPage} página(s))`)

    // 3. Checkpoint: suporte a retomada (offset dentro da lista).
    let startOffset = 0
    if (!opts.reset) {
      const savedPage = await getCheckpoint(company_id)
      // Checkpoint armazena índice de lote (base 1); offset = (lote - 1) * CHUNK_SIZE
      startOffset = Math.max(0, (Number(savedPage) - 1)) * CHUNK_SIZE
      if (startOffset >= allContacts.length) {
        // Checkpoint ultrapassou o total: reiniciar.
        startOffset = 0
      }
    } else {
      await resetCheckpoint(company_id)
    }

    const seen = new Set()
    let totalProcessados = 0
    let totalCriados = 0
    let totalAtualizados = 0
    let totalConflitados = 0
    let loteNum = Math.floor(startOffset / CHUNK_SIZE) + 1

    // 4. Processar em lotes com pausa entre eles.
    for (let offset = startOffset; offset < allContacts.length; offset += CHUNK_SIZE) {
      const pausado = await isProcessamentoPausado(company_id)
      if (pausado) {
        await registrarEvento(company_id, TIPOS.PAUSA, 'Contact sync pausada (processamento_pausado)')
        break
      }

      const chunk = allContacts.slice(offset, offset + CHUNK_SIZE)
      let lCriados = 0, lAtualizados = 0, lProcessados = 0, lConflitados = 0

      for (const c of chunk) {
        const parsed = parseAgendaContact(c)
        if (!parsed || !parsed.phone) continue
        const key = phoneKeyBR(parsed.phone)
        if (seen.has(key)) continue
        seen.add(key)

        try {
          const r = await syncOneAgendaContact(company_id, parsed)
          lProcessados++
          lCriados += r.inserted ? 1 : 0
          lAtualizados += r.updated ? 1 : 0
          if (r.conflict) lConflitados++
        } catch (e) {
          console.warn(`[CONTACT-SYNC] lote ${loteNum} contato erro:`, e?.message || e)
        }
      }

      totalProcessados += lProcessados
      totalCriados += lCriados
      totalAtualizados += lAtualizados
      totalConflitados += lConflitados

      // Salvar checkpoint após cada lote concluído.
      await updateCheckpoint(company_id, loteNum + 1, {
        loteNum, offset, totalContatos: allContacts.length,
        totalProcessados, totalCriados, totalAtualizados
      })
      await registrarEvento(company_id, TIPOS.SYNC_LOTE, `Lote ${loteNum} de contatos concluído`, {
        loteNum, offset, tamanho: chunk.length,
        criados: lCriados, atualizados: lAtualizados, processados: lProcessados,
        restantes: Math.max(0, allContacts.length - offset - CHUNK_SIZE)
      })

      loteNum++

      // Pausa entre lotes (exceto no último).
      if (offset + CHUNK_SIZE < allContacts.length) {
        await new Promise((r) => setTimeout(r, PAUSA_MS))
      }
    }

    await registrarEvento(company_id, TIPOS.SYNC_FIM, 'Contact sync gradual finalizada', {
      totalProcessados, totalCriados, totalAtualizados, totalConflitados, lotes: loteNum - 1
    })

    return { ok: true, totalProcessados, totalCriados, totalAtualizados, totalConflitados, paginas: loteNum - 1 }
  } catch (e) {
    const msg = e?.message || String(e)
    await registrarEvento(company_id, TIPOS.FALHA, 'Contact sync falhou', { error: msg.slice(0, 200) })
    return { ok: false, error: msg, totalProcessados: 0, totalCriados: 0, totalAtualizados: 0 }
  } finally {
    await releaseLock(company_id)
  }
}

module.exports = {
  LOCK_TIPO,
  CHECKPOINT_TIPO,
  parseAgendaContact,
  processContactsPage,
  tryAcquireLock,
  releaseLock,
  getCheckpoint,
  updateCheckpoint,
  resetCheckpoint,
  runContactSyncBatch,
  runContactSyncFull
}
