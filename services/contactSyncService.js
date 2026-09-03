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
const { normalizePhoneBR, possiblePhonesBR, possiblePhonesForWhatsappIdentity, phoneKeyBR } = require('../helpers/phoneHelper')
const { isBadName, chooseBestName } = require('../helpers/contactEnrichment')
const { clienteTemNomeProtegido } = require('../helpers/clienteNomeProtecao')
const { marcarSchemaNomeProtecaoIndisponivel } = require('../helpers/clienteNomeColunas')
const { getConfig, isProcessamentoPausado } = require('./configOperacionalService')
const { registrarEvento, TIPOS } = require('./operationalAuditService')
const { agendaContactFields } = require('../helpers/agendaContact')

const LOCK_TIPO = 'contact_sync'
const CHECKPOINT_TIPO = 'contact_sync'
const NOME_FONTE = 'syncUltramsg'

const PAGE_SIZE_DEFAULT = 1000
const MIN_PHONE_DIGITS = 10
const BR_COUNTRY_CODE = '55'
const MIN_BR_PHONE_LENGTH = 12
const MAX_BR_PHONE_LENGTH = 13
const MIN_INTL_PHONE_LENGTH = 10
const MAX_INTL_PHONE_LENGTH = 15
const ERROR_MESSAGE_MAX_LENGTH = 80
const MAX_PAGES_DEFAULT = parseInt(process.env.SYNC_MAX_PAGES_PER_RUN, 10) || 20
// Teto de contatos importados por sincronização (nome + foto). Padrão 2500; override via env ou opts.
const MAX_CONTATOS_DEFAULT = Math.max(1, parseInt(process.env.SYNC_MAX_CONTATOS, 10) || 2500)

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
  return /^\d{10,15}$/.test(phoneNorm || '') ? `${phoneNorm}@c.us` : null
}

/**
 * Extrai e valida contato do payload do provider (regras alinhadas ao sync legado: agenda = name preenchido).
 */
function parseAgendaContact(raw) {
  raw = agendaContactFields(raw)
  if (!raw) return null

  const name = String(raw.name ?? '').trim()
  if (!name) return null

  const phoneRaw = raw.phone ?? raw.wa_id ?? raw.id ?? ''
  const phoneStr = String(phoneRaw || '').trim()
  if (phoneStr.endsWith('@g.us') || phoneStr.includes('-group')) return null

  const digits = phoneStr.replace(/\D/g, '')
  if (!digits || digits.length < MIN_PHONE_DIGITS) return null

  const explicitIntl = phoneStr.startsWith('+') || phoneStr.includes('@')
  const normBR = explicitIntl && !digits.startsWith('55') ? '' : normalizePhoneBR(digits)
  let phoneNorm = normBR
  let isBR = true
  if (!phoneNorm) {
    // Fallback internacional: permite contatos válidos fora do padrão BR.
    if (digits.length < MIN_INTL_PHONE_LENGTH || digits.length > MAX_INTL_PHONE_LENGTH) return null
    phoneNorm = digits
    isBR = false
  } else if (!phoneNorm.startsWith(BR_COUNTRY_CODE) || (phoneNorm.length !== MIN_BR_PHONE_LENGTH && phoneNorm.length !== MAX_BR_PHONE_LENGTH)) {
    // Normalizou mas não caiu em BR canônico: ainda aceita como internacional válido.
    if (digits.length < MIN_INTL_PHONE_LENGTH || digits.length > MAX_INTL_PHONE_LENGTH) return null
    phoneNorm = digits
    isBR = false
  }

  const nome =
    name || String(raw.short ?? raw.notify ?? raw.vname ?? '').trim() || null
  const foto = raw.imgUrl ?? raw.photo ?? raw.profilePicture ?? null
  const fotoUrl = foto && typeof foto === 'string' && foto.trim().startsWith('http') ? foto.trim() : null
  const waId = canonicalWaId(phoneNorm, phoneStr)

  return { phone: phoneNorm, nome: nome || null, foto: fotoUrl || null, rawJid: phoneStr, waId, isBR }
}

/**
 * Busca candidatos no mesmo company_id (telefone e/ou wa_id).
 * @returns {Promise<{ rows: object[], hadConflict: boolean }>}
 */
async function findClienteCandidates(companyId, phoneNorm, rawJid, opts = {}) {
  const company_id = Number(companyId)
  const strictAgendaImport = opts?.strictAgendaImport === true
  // Identidade WhatsApp (celular ±9º dígito) para achar o contato já salvo no outro
  // formato e ATUALIZAR em vez de duplicar. Fixo/internacional caem no telefone exato.
  const phones = strictAgendaImport
    ? (possiblePhonesForWhatsappIdentity(phoneNorm).length > 0
        ? possiblePhonesForWhatsappIdentity(phoneNorm)
        : [String(phoneNorm || '').trim()].filter(Boolean))
    : possiblePhonesBR(phoneNorm)
  const waList = waIdSearchVariants(phoneNorm, rawJid)

  const CONTACT_SELECT =
    'id, nome, telefone, wa_id, pushname, foto_perfil, email, empresa, company_id, nome_protegido, nome_origem'
  const CONTACT_SELECT_BASE =
    'id, nome, telefone, wa_id, pushname, foto_perfil, email, empresa, company_id'

  async function selectBy(col, values) {
    const first = await supabase
      .from('clientes')
      .select(CONTACT_SELECT)
      .eq('company_id', company_id)
      .in(col, values)
    if (first.error && marcarSchemaNomeProtecaoIndisponivel(first.error)) {
      return supabase
        .from('clientes')
        .select(CONTACT_SELECT_BASE)
        .eq('company_id', company_id)
        .in(col, values)
    }
    return first
  }

  const byId = new Map()
  if (waList.length) {
    const { data: a, error } = await selectBy('wa_id', waList)
    if (error) throw new Error('Falha ao consultar clientes no banco.')
    for (const r of a || []) byId.set(r.id, r)
  }
  if (phones.length) {
    const { data: b, error } = await selectBy('telefone', phones)
    if (error) throw new Error('Falha ao consultar clientes no banco.')
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
async function syncOneAgendaContact(companyId, parsed, opts = {}) {
  const { rows, hadConflict } = await findClienteCandidates(companyId, parsed.phone, parsed.rawJid, { strictAgendaImport: true })

  if (hadConflict) {
    const ids = rows.map((r) => r.id).join(',')
    const tail = String(parsed.phone).slice(-6)
    console.warn(
      `[CONTACT-SYNC] conflito candidatos company_id=${companyId} tail=${tail} ids=[${ids}] — atualizando menor id, revisar duplicata`
    )
  }

  const fieldsBase = { nomeSource: NOME_FONTE, allowNonBR: true, strictAgendaImport: true }
  let fotoIndisponivel = false
  if (opts.includePhotos && !parsed.foto) {
    parsed.foto = await maybeEnrichFoto(companyId, parsed.rawJid || parsed.phone, null)
    fotoIndisponivel = !parsed.foto
  }
  const fotoAtualizada = !!parsed.foto && rows[0]?.foto_perfil !== parsed.foto
  if (opts.includePhotos) fieldsBase.foto_perfil_refresh = true
  if (parsed.nome) fieldsBase.nome = parsed.nome
  if (parsed.foto) fieldsBase.foto_perfil = parsed.foto
  if (parsed.waId) fieldsBase.wa_id = parsed.waId

  if (rows.length > 1) {
    const existente = rows[0]
    const updates = {}
    const telefoneTail = String(parsed.phone).replace(/\D/g, '').slice(-6) || null
    if (fieldsBase.nome && String(fieldsBase.nome).trim() && !clienteTemNomeProtegido(existente)) {
      const { name: bestNome, decision } = chooseBestName(
        existente.nome,
        String(fieldsBase.nome).trim(),
        NOME_FONTE,
        { fromMe: false, company_id: companyId, telefoneTail }
      )
      if (bestNome && decision === 'updated' && !isBadName(bestNome)) updates.nome = bestNome
    }
    if (fieldsBase.foto_perfil && (opts.includePhotos || shouldApplyFoto(existente, fieldsBase.foto_perfil))) {
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
      if (error) throw new Error('Falha ao gravar contato no banco.')
    }
    const changed = Object.keys(updates).length > 0
    return {
      inserted: 0,
      updated: changed ? 1 : 0,
      skipped: changed ? 0 : 1,
      conflict: true, fotoAtualizada, fotoIndisponivel
    }
  }

  const r = await getOrCreateCliente(supabase, companyId, parsed.phone, fieldsBase)
  if (r.cliente_id) {
    if (r.created === true) {
      return { inserted: 1, updated: 0, skipped: 0, conflict: false, fotoAtualizada, fotoIndisponivel }
    }
    if (r.changed === true) {
      return { inserted: 0, updated: 1, skipped: 0, conflict: false, fotoAtualizada, fotoIndisponivel }
    }
    return { inserted: 0, updated: 0, skipped: 1, conflict: false, fotoAtualizada: false, fotoIndisponivel }
  }
  throw new Error('Não foi possível gravar o contato no banco.')
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
    if (dup) {
      const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString()
      const { data: removed, error: deleteError } = await supabase.from('sync_locks').delete()
        .eq('company_id', company_id).eq('tipo', LOCK_TIPO).lt('locked_at', staleBefore).select('id')
      if (deleteError || !removed?.length) return false
      const retry = await supabase.from('sync_locks').insert({ company_id, tipo: LOCK_TIPO, locked_by: 'contact_sync' })
      return !retry.error
    }
    throw new Error('Não foi possível obter o bloqueio de sincronização no banco.')
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
 * Importa a agenda completa e consulta as fotos disponíveis, respeitando o rate limit do provider.
 * Mantém lock com heartbeat; publica progresso a cada 10 contatos.
 * Repetições relêem a agenda e fazem upsert idempotente, sem offsets sobre uma lista mutável.
 */
async function runContactSyncFull(company_id, opts = {}) {
  const stats = { totalProcessados: 0, totalCriados: 0, totalAtualizados: 0,
    totalIgnorados: 0, totalInvalidos: 0, totalDuplicadosNoLote: 0, totalConflitados: 0,
    totalFotosAtualizadas: 0, totalFotosIndisponiveis: 0, totalErros: 0,
    totalAgendaRaw: 0, totalAgendaValidos: 0, totalVerificados: 0 }
  if (!company_id) return { ...stats, ok: false, error: 'company_id ausente' }
  let acquired = false
  let heartbeat
  const progress = async (fase, offset = 0) => {
    await updateCheckpoint(company_id, 1, { ...stats, fase, offset, job_id: opts.jobId || null })
    if (opts.onProgress) await opts.onProgress({ ...stats, fase })
  }
  try {
    acquired = await tryAcquireLock(company_id)
    if (!acquired) throw new Error('Sincronização já em andamento ou bloqueada. Aguarde a recuperação da fila.')
    heartbeat = setInterval(() => {
      Promise.resolve(supabase.from('sync_locks').update({ locked_at: new Date().toISOString() })
        .eq('company_id', company_id).eq('tipo', LOCK_TIPO)).catch(() => {})
    }, 30000)
    heartbeat.unref?.()
    const provider = getProvider()
    if (!provider?.getContacts) throw new Error('Consulta de contatos indisponível.')
    const { config: waCfg, error: cfgErr } = await getEmpresaWhatsappConfig(company_id)
    if (cfgErr || !waCfg) throw new Error('Empresa sem instância WhatsApp configurada.')
    // A agenda pode mudar de ordem entre execuções. Recomeçar é idempotente e evita pular contatos.
    await resetCheckpoint(company_id)
    await progress('buscando')
    const shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : null
    const cancelResult = () => ({
      ...stats,
      ok: true,
      cancelled: true,
      aviso: 'Importação interrompida pelo usuário. Os contatos já importados foram mantidos.',
    })
    const allContacts = []
    const fingerprints = new Set()
    const maxPages = Math.max(1, parseInt(process.env.SYNC_MAX_FETCH_PAGES, 10) || 50)
    for (let page = 1; ; page++) {
      if (shouldCancel && (await shouldCancel())) {
        await progress('cancelado', stats.totalVerificados)
        return cancelResult()
      }
      if (page > maxPages) throw new Error('A leitura da agenda ficou incompleta: limite de páginas atingido.')
      const response = await provider.getContacts(page, 10000, { companyId: company_id })
      if (response?.ok === false || response?.error) throw new Error('Falha ao consultar a agenda na UltraMSG.')
      const data = Array.isArray(response) ? response : response?.data
      if (!Array.isArray(data)) throw new Error('Resposta de contatos inválida.')
      const fingerprint = JSON.stringify(data)
      if (data.length && fingerprints.has(fingerprint)) throw new Error('A UltraMSG repetiu a página da agenda; sincronização incompleta.')
      fingerprints.add(fingerprint)
      stats.totalAgendaRaw += Number(response?.rawCount ?? data.length)
      for (const contact of data) allContacts.push(contact)
      if (!response?.hasMore) break
    }
    const maxContatos = Math.max(1, Number(opts.maxContatos) || MAX_CONTATOS_DEFAULT)
    const unique = new Map()
    let truncadoPorLimite = false
    for (const raw of allContacts) {
      const parsed = parseAgendaContact(raw)
      if (!parsed) { stats.totalInvalidos++; continue }
      // Identidade exata: não unir telefones diferentes apenas por remover o nono dígito.
      if (unique.has(parsed.phone)) { stats.totalDuplicadosNoLote++; continue }
      // Teto de 2500 contatos: para de acumular quando atinge o limite (o restante fica para a próxima sync).
      if (unique.size >= maxContatos) { truncadoPorLimite = true; break }
      unique.set(parsed.phone, parsed)
    }
    stats.totalAgendaValidos = unique.size
    stats.truncadoPorLimite = truncadoPorLimite
    stats.limiteContatos = maxContatos
    if (!unique.size) {
      throw new Error('A UltraMSG não disponibilizou contatos salvos com nome e telefone. Verifique a agenda e a conexão do celular e tente novamente.')
    }
    await progress('importando')
    let desdeUltimoCancelCheck = 0
    for (const parsed of unique.values()) {
      // Checa cancelamento a cada 10 contatos (evita 1 query por contato numa agenda grande)
      // e sempre no 1o item, para parar rapido logo apos o clique.
      if (shouldCancel && (desdeUltimoCancelCheck === 0 || desdeUltimoCancelCheck >= 10)) {
        desdeUltimoCancelCheck = 0
        if (await shouldCancel()) {
          await progress('cancelado', stats.totalVerificados)
          return cancelResult()
        }
      }
      desdeUltimoCancelCheck++
      if (opts.manual !== true && await isProcessamentoPausado(company_id)) {
        throw new Error('Sincronização interrompida: processamento pausado.')
      }
      try {
        const result = await syncOneAgendaContact(company_id, parsed, { includePhotos: opts.includePhotos !== false })
        stats.totalProcessados++
        stats.totalCriados += result.inserted || 0
        stats.totalAtualizados += result.updated || 0
        stats.totalIgnorados += result.skipped || 0
        stats.totalConflitados += result.conflict ? 1 : 0
        stats.totalFotosAtualizadas += result.fotoAtualizada ? 1 : 0
        stats.totalFotosIndisponiveis += result.fotoIndisponivel ? 1 : 0
      } catch {
        stats.totalErros++
      }
      stats.totalVerificados++
      if (stats.totalVerificados % 10 === 0 || stats.totalVerificados === unique.size) {
        await progress('importando', stats.totalVerificados)
      }
    }
    if (stats.totalErros) throw new Error(stats.totalErros + ' contato(s) não puderam ser gravados. Os demais foram preservados; a fila tentará novamente.')
    await progress('concluido', stats.totalVerificados)
    await registrarEvento(company_id, TIPOS.SYNC_FIM, 'Agenda sincronizada por solicitação manual', stats)
    const avisos = []
    if (truncadoPorLimite) {
      avisos.push(`Limite de ${maxContatos} contatos por sincronização atingido. Os ${maxContatos} primeiros foram importados com nome e foto; rode novamente para trazer o restante.`)
    }
    if (stats.totalFotosIndisponiveis) {
      avisos.push(`${stats.totalFotosIndisponiveis} contato(s) sem foto disponível na UltraMSG. Fotos existentes foram preservadas.`)
    }
    return { ...stats, ok: true, aviso: avisos.length ? avisos.join(' ') : null }
  } catch (e) {
    const error = e?.message || 'Falha ao sincronizar contatos.'
    await registrarEvento(company_id, TIPOS.FALHA, 'Sincronização da agenda falhou', { error })
    return { ...stats, ok: false, error }
  } finally {
    clearInterval(heartbeat)
    if (acquired) await releaseLock(company_id)
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
