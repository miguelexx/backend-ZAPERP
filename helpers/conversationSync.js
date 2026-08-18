/**
 * Sincronização de conversa/cliente por telefone canônico.
 * Garante um único contato e uma única conversa aberta por número (evita duplicata 55... vs 11...).
 */

const supabase = require('../config/supabase')
const { normalizePhoneBR, possiblePhonesBR, phoneKeyBR } = require('./phoneHelper')
const { chooseBestName, isBadName } = require('./contactEnrichment')

/**
 * Retorna telefone canônico para armazenamento (sempre o mesmo formato por número).
 *
 * REGRA: para contato individual, **só aceita telefone BR válido** (normalizePhoneBR).
 * Não converte LID/IDs internos em “telefone”. Isso garante que o campo `telefone`
 * da conversa/cliente nunca seja um número inexistente como o da sua imagem.
 *
 * @param {string} phone
 * @returns {string}
 */
function getCanonicalPhone(phone) {
  if (!phone) return ''
  const s = String(phone).trim()

  // Chave sintética LID: mensagens enviadas pelo celular (espelhamento) podem vir só com phone @lid.
  // Aceitar "lid:XXXX" para encontrar/criar a mesma conversa e exibir no front.
  if (s.startsWith('lid:') && s.length > 4) return s

  // Grupos: preservar JID completo (120...@g.us ou Group-Owner@g.us)
  if (s.endsWith('@g.us')) return s
  if (/^\d{5,15}-\d{10,15}$/.test(s)) return `${s}@g.us` // UltraMsg formato Group-Owner sem sufixo

  // JID individual @s.whatsapp.net → extrair apenas os dígitos do telefone
  let phoneStr = s
  if (s.includes('@s.whatsapp.net')) {
    phoneStr = s.replace('@s.whatsapp.net', '')
  }

  // IDs internos (@lid, @broadcast, etc.) — não converter para telefone; o controller já usa chave "lid:xxx"
  if (/@(lid|broadcast)$/i.test(s)) return ''
  // (removido warn: LID é tratado em resolveConversationKeyFromZapi como lid:xxx)

  // Só aceitamos telefone BR válido
  const norm = normalizePhoneBR(phoneStr)
  if (norm) return norm

  // Qualquer coisa que não normalize para BR é considerada inválida
  console.warn('[getCanonicalPhone] Telefone inválido para BR, descartado:', phoneStr)
  return ''
}

function getCanonicalPhoneAnyIntl(phone) {
  if (!phone) return ''
  const s = String(phone).trim()
  if (!s) return ''
  const digits = s.replace(/\D/g, '')
  if (digits.length >= 10 && digits.length <= 15) return digits
  return ''
}

/**
 * Mescla conversas duplicadas para uma única (canonical), movendo todas as dependências.
 * @param {object} supabaseClient
 * @param {number} company_id
 * @param {number} canonicalId   - ID da conversa que fica
 * @param {number[]} dupIds      - IDs das conversas a eliminar
 */
/**
 * Avisa clientes em tempo real que IDs antigos foram unificados no canônico.
 * Frontend usa `merged_into` para redirecionar a conversa aberta (evita 404).
 */
function emitConversasMerged(io, company_id, canonicalId, mergedFromIds = []) {
  if (!io || !company_id || !canonicalId) return
  const room = `empresa_${Number(company_id)}`
  const canonicalNumber = Number(canonicalId)
  const fromIds = [...new Set(
    (Array.isArray(mergedFromIds) ? mergedFromIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0 && id !== canonicalNumber)
  )]
  for (const dupId of fromIds) {
    const payload = {
      id: dupId,
      conversa_id: dupId,
      removida: true,
      merged_into: canonicalNumber,
      company_id: Number(company_id),
      motivo: 'merge_duplicata',
    }
    try {
      io.to(room).emit('conversa_apagada', payload)
      io.to(room).emit('atualizar_conversa', payload)
    } catch (e) {
      console.warn('[conversationSync] emit merge dup:', e?.message || e)
    }
  }
  try {
    io.to(room).emit('conversa_atualizada', { id: canonicalNumber, company_id: Number(company_id) })
    io.to(room).emit('atualizar_conversa', { id: canonicalNumber, company_id: Number(company_id) })
  } catch (e) {
    console.warn('[conversationSync] emit merge canonico:', e?.message || e)
  }
}

/**
 * @returns {Promise<{ ok: boolean, canonicalId?: number, mergedFrom: number[] }>}
 */
async function mergeConversasIntoCanonico(supabaseClient, company_id, canonicalId, dupIds, opts = {}) {
  const empty = { ok: false, mergedFrom: [] }
  if (!dupIds || dupIds.length === 0) return empty
  try {
    const canonicalNumber = Number(canonicalId)
    const requestedDupIds = [...new Set(
      dupIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id !== canonicalNumber)
    )]

    if (!company_id || !Number.isFinite(canonicalNumber) || requestedDupIds.length === 0) return empty

    const { data: scopedConversations, error: scopedError } = await supabaseClient
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .in('id', [canonicalNumber, ...requestedDupIds])

    if (scopedError) throw scopedError

    const scopedIds = new Set((scopedConversations || []).map((row) => Number(row.id)))
    if (!scopedIds.has(canonicalNumber)) {
      console.warn('[conversationSync] merge bloqueado: conversa canonica fora da empresa', { company_id, canonicalId })
      return empty
    }

    const safeDupIds = requestedDupIds.filter((id) => scopedIds.has(id))
    if (safeDupIds.length === 0) return empty

    await supabaseClient.from('mensagens').update({ conversa_id: canonicalNumber }).in('conversa_id', safeDupIds).eq('company_id', company_id)
    await supabaseClient.from('conversa_tags').update({ conversa_id: canonicalNumber }).in('conversa_id', safeDupIds).eq('company_id', company_id)
    await supabaseClient.from('atendimentos').update({ conversa_id: canonicalNumber }).in('conversa_id', safeDupIds).eq('company_id', company_id)
    await supabaseClient.from('historico_atendimentos').update({ conversa_id: canonicalNumber }).in('conversa_id', safeDupIds)
    await supabaseClient.from('conversa_unreads').update({ conversa_id: canonicalNumber }).in('conversa_id', safeDupIds).eq('company_id', company_id)
    const del = await supabaseClient.from('conversas').delete().in('id', safeDupIds).eq('company_id', company_id)
    if (del.error) {
      await supabaseClient.from('conversas')
        .update({ status_atendimento: 'fechada', lida: true })
        .in('id', safeDupIds)
        .eq('company_id', company_id)
    }
    console.log(`[conversationSync] 🧹 ${safeDupIds.length} duplicata(s) mesclada(s) → conv ${canonicalNumber}`)
    emitConversasMerged(opts.io, company_id, canonicalNumber, safeDupIds)
    return { ok: true, canonicalId: canonicalNumber, mergedFrom: safeDupIds }
  } catch (e) {
    console.warn('[conversationSync] ⚠️ falha ao mesclar duplicatas:', e?.message || e)
    return empty
  }
}

/**
 * Mescla conversa LID na conversa PHONE quando ambas existem para o mesmo contato.
 * Chamar em TODOS os callbacks que possam trazer chatLid + canonicalPhone (ReceivedCallback,
 * DeliveryCallback, MessageStatusCallback).
 *
 * @param {object} supabaseClient
 * @param {number} company_id
 * @param {string} chatLid - Parte antes de @lid (ex: "24601656598766")
 * @param {string} canonicalPhone - Telefone canônico do contato (número real)
 * @param {object} [opts]
 * @param {object} [opts.io] - Socket.io para emitir conversa_atualizada/atualizar_conversa
 * @param {number|string|null} [opts.whatsapp_instance_id] - Instancia WhatsApp do webhook atual
 * @param {string} [opts.nomeCache] - Nome para atualizar cache na conversa PHONE
 * @param {string} [opts.fotoCache] - Foto para atualizar cache na conversa PHONE
 * @returns {Promise<{merged: boolean, conversa_id?: number}>}
 */
async function mergeConversationLidToPhone(supabaseClient, company_id, chatLid, canonicalPhone, opts = {}) {
  if (!chatLid || !canonicalPhone || !company_id) return { merged: false }

  const lidPart = String(chatLid).replace(/@lid$/i, '').trim()
  if (!lidPart) return { merged: false }

  const canonical = getCanonicalPhone(canonicalPhone)
  if (!canonical || canonical.startsWith('lid:')) return { merged: false }

  const variants = possiblePhonesBR(canonical).length > 0 ? possiblePhonesBR(canonical) : [canonical]
  const whatsappInstanceId = opts.whatsapp_instance_id ?? opts.whatsappInstanceId ?? null
  const applyInstanceScope = (query) => {
    const id = Number(whatsappInstanceId)
    if (Number.isFinite(id) && id > 0) return query.eq('whatsapp_instance_id', id)
    return query.is('whatsapp_instance_id', null)
  }

  let convByLidQuery = supabaseClient
    .from('conversas')
    .select('id, telefone, nome_contato_cache, foto_perfil_contato_cache, whatsapp_instance_id')
    .eq('company_id', company_id)
    .eq('chat_lid', lidPart)
  convByLidQuery = applyInstanceScope(convByLidQuery)
  const { data: convByLid } = await convByLidQuery.maybeSingle()

  let convByPhoneQuery = supabaseClient
    .from('conversas')
    .select('id, telefone, nome_contato_cache, foto_perfil_contato_cache, whatsapp_instance_id')
    .eq('company_id', company_id)
    .in('telefone', variants)
    .neq('status_atendimento', 'fechada')
    .order('ultima_atividade', { ascending: false })
    .limit(1)
  convByPhoneQuery = applyInstanceScope(convByPhoneQuery)
  const { data: convByPhoneRows } = await convByPhoneQuery

  const convByPhone = Array.isArray(convByPhoneRows) && convByPhoneRows[0] ? convByPhoneRows[0] : null

  if (!convByLid || !convByPhone || convByLid.id === convByPhone.id) {
    return { merged: false }
  }

  try {
    const mergeResult = await mergeConversasIntoCanonico(
      supabaseClient,
      company_id,
      convByPhone.id,
      [convByLid.id],
      { io: opts.io }
    )
    await supabaseClient.from('conversas').update({ chat_lid: lidPart }).eq('id', convByPhone.id).eq('company_id', company_id)

    const cacheUpdates = {}
    if (opts.nomeCache && String(opts.nomeCache).trim()) {
      const { name: bestNome } = chooseBestName(
        convByPhone.nome_contato_cache,
        String(opts.nomeCache).trim(),
        opts.nomeSource || 'chatName',
        { fromMe: opts.fromMe, company_id, telefoneTail: canonical.slice(-6) }
      )
      if (bestNome && bestNome !== (convByPhone.nome_contato_cache || '')) cacheUpdates.nome_contato_cache = bestNome
    }
    if (opts.fotoCache && String(opts.fotoCache).trim()) cacheUpdates.foto_perfil_contato_cache = String(opts.fotoCache).trim()
    if (Object.keys(cacheUpdates).length > 0) {
      await supabaseClient.from('conversas').update(cacheUpdates).eq('id', convByPhone.id).eq('company_id', company_id)
    }

    const io = opts.io
    if (io) {
      // Cache/telefone do canônico (redirect dos IDs antigos já foi emitido no merge).
      const payload = { id: convByPhone.id, telefone: canonical, company_id, ...cacheUpdates }
      io.to(`empresa_${company_id}`).emit('conversa_atualizada', payload)
    }

    console.log('[conversationSync] 🔗 LID→PHONE:', {
      lidPart,
      canonical: canonical.slice(-8),
      conversa_id: convByPhone.id,
      mergedFrom: mergeResult?.mergedFrom || [],
    })
    return {
      merged: true,
      conversa_id: convByPhone.id,
      merged_from: mergeResult?.mergedFrom || [convByLid.id],
    }
  } catch (e) {
    console.warn('[conversationSync] ⚠️ mergeConversationLidToPhone:', e?.message || e)
    return { merged: false }
  }
}

/** URL de foto de perfil utilizável (não sobrescrever se já houver uma). */
function hasValidFotoPerfil(url) {
  const s = url != null ? String(url).trim() : ''
  if (!s || s.toLowerCase() === 'null') return false
  return /^https?:\/\//i.test(s)
}

/**
 * Sticky por padrão (evita foto de match errado).
 * Com refresh=true (sync UltraMSG do mesmo contato), permite trocar se a URL nova for diferente.
 */
function shouldUpdateFotoPerfil(existenteUrl, novoUrl, { refresh = false } = {}) {
  if (!hasValidFotoPerfil(novoUrl)) return false
  if (!hasValidFotoPerfil(existenteUrl)) return true
  if (!refresh) return false
  return String(novoUrl).trim() !== String(existenteUrl).trim()
}

/**
 * Aplica campos no cliente existente (sem anular com vazio) e retorna o id.
 * foto_perfil: sticky — só preenche se ainda vazia/inválida; refresh explícito atualiza URL.
 */
async function mergeAndReturnCliente(supabaseClient, company_id, existente, phone, fields) {
  const updates = {}
  const telefoneTail = String(phone).replace(/\D/g, '').slice(-6) || null
  if (fields.nome != null && String(fields.nome).trim()) {
    const { name: bestNome } = chooseBestName(
      existente.nome,
      String(fields.nome).trim(),
      fields.nomeSource || 'unknown',
      { fromMe: fields.fromMe, company_id, telefoneTail }
    )
    if (bestNome && bestNome !== (existente.nome || '')) updates.nome = bestNome
  }
  if (!updates.nome && (!existente.nome || !String(existente.nome).trim())) {
    const numericDisplay = String(phone).replace(/\D/g, '')
    if (numericDisplay) updates.nome = numericDisplay
  }
  if (fields.pushname !== undefined && fields.pushname != null && String(fields.pushname).trim()) {
    updates.pushname = String(fields.pushname).trim()
  }
  // Sticky padrão; sync UltraMSG do mesmo contato pode passar foto_perfil_refresh.
  if (
    shouldUpdateFotoPerfil(existente.foto_perfil, fields.foto_perfil, {
      refresh: fields.foto_perfil_refresh === true,
    })
  ) {
    updates.foto_perfil = String(fields.foto_perfil).trim()
  }
  if (fields.wa_id != null && String(fields.wa_id).trim() && (!existente.wa_id || !String(existente.wa_id).trim())) {
    updates.wa_id = String(fields.wa_id).trim()
  }
  if (fields.email !== undefined && fields.email != null && String(fields.email).trim()) {
    if (!existente.email || !String(existente.email).trim()) updates.email = String(fields.email).trim()
  }
  if (fields.empresa !== undefined && fields.empresa != null && String(fields.empresa).trim()) {
    if (!existente.empresa || !String(existente.empresa).trim()) updates.empresa = String(fields.empresa).trim()
  }
  if (Object.keys(updates).length > 0) {
    await supabaseClient.from('clientes').update(updates).eq('id', existente.id).eq('company_id', company_id)
  }
  return { cliente_id: existente.id, created: false, changed: Object.keys(updates).length > 0 }
}

const CLIENTE_SELECT_COLS =
  'id, nome, pushname, foto_perfil, company_id, telefone, wa_id, email, empresa'

function digitsOnlyPhone(v) {
  return String(v || '').replace(/\D/g, '')
}

/**
 * Compara números BR mesmo com/sem 55, com/sem 9º dígito.
 * Apenas igualdade exata ou phoneKeyBR (remove o 9º dígito de forma canônica).
 * NÃO usa últimos 8 nem últimos 10 do E.164 — colidem entre DDDs (ex.: 11 vs 21 → foto errada).
 */
function phonesMatchDigitally(a, b) {
  const da = digitsOnlyPhone(a)
  const db = digitsOnlyPhone(b)
  if (!da || !db) return false
  if (da === db) return true
  const ka = phoneKeyBR(da)
  const kb = phoneKeyBR(db)
  if (ka && kb && ka === kb) return true
  return false
}

function normalizeWhatsappInstanceId(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function isUniqueViolationError(error) {
  if (!error) return false
  const code = String(error.code || '')
  const msg = String(error.message || error.details || '').toLowerCase()
  return code === '23505' || msg.includes('unique') || msg.includes('duplicate key')
}

async function refetchConversationInInstanceScope(
  supabaseClient,
  company_id,
  variants,
  whatsappInstanceId,
  allowLegacyNullInstance,
  limit = 20
) {
  const found = await selectConversationsByPhoneVariants(
    supabaseClient,
    company_id,
    variants,
    whatsappInstanceId,
    allowLegacyNullInstance,
    limit
  )
  const scoped = pickConversationForWhatsappInstance(found, whatsappInstanceId, allowLegacyNullInstance)
  if (!Array.isArray(scoped) || scoped.length === 0) return null
  let conv = scoped[0]
  conv = await attachWhatsappInstanceToLegacyConversation(supabaseClient, company_id, conv, whatsappInstanceId)
  return conv
}

function pickConversationForWhatsappInstance(rows, whatsappInstanceId, allowNullInstance) {
  const list = Array.isArray(rows) ? rows : []
  if (!whatsappInstanceId) return list
  const exact = list.filter((row) => Number(row?.whatsapp_instance_id) === Number(whatsappInstanceId))
  if (exact.length > 0) return exact
  if (allowNullInstance === true) return list.filter((row) => row?.whatsapp_instance_id == null)
  return []
}

async function attachWhatsappInstanceToLegacyConversation(supabaseClient, company_id, conversa, whatsappInstanceId) {
  if (!conversa?.id || !whatsappInstanceId || conversa.whatsapp_instance_id != null) return conversa
  try {
    await supabaseClient
      .from('conversas')
      .update({ whatsapp_instance_id: whatsappInstanceId })
      .eq('id', conversa.id)
      .eq('company_id', company_id)
      .is('whatsapp_instance_id', null)
    return { ...conversa, whatsapp_instance_id: whatsappInstanceId }
  } catch (_) {
    return conversa
  }
}

/**
 * Busca cliente existente por variantes 12/13 dígitos e phoneKeyBR (55… vs 9º dígito).
 * Cobre telefone salvo sem DDI ou formato diferente do canônico do INSERT.
 */
const CONVERSA_INSTANCE_SELECT = 'id, departamento_id, telefone, cliente_id, whatsapp_instance_id'

async function queryScopedConversationRows(buildBaseQuery, whatsappInstanceId, allowLegacyNullInstance) {
  async function run(scope) {
    let query = buildBaseQuery()
    if (scope === 'exact') query = query.eq('whatsapp_instance_id', whatsappInstanceId)
    if (scope === 'legacy') query = query.is('whatsapp_instance_id', null)
    const { data, error } = await query
    if (error) throw error
    return Array.isArray(data) ? data : []
  }

  if (whatsappInstanceId) {
    const exactRows = await run('exact')
    if (exactRows.length > 0 || allowLegacyNullInstance !== true) return exactRows
    return run('legacy')
  }

  return run('all')
}

function selectConversationsByChatLid(supabaseClient, company_id, lidPart, whatsappInstanceId, allowLegacyNullInstance) {
  return queryScopedConversationRows(
    () => supabaseClient
      .from('conversas')
      .select(CONVERSA_INSTANCE_SELECT)
      .eq('company_id', company_id)
      .eq('chat_lid', lidPart)
      .order('ultima_atividade', { ascending: false })
      .limit(20),
    whatsappInstanceId,
    allowLegacyNullInstance
  )
}

function selectConversationsByPhoneVariants(supabaseClient, company_id, variants, whatsappInstanceId, allowLegacyNullInstance, limit = 50) {
  return queryScopedConversationRows(
    () => supabaseClient
      .from('conversas')
      .select(CONVERSA_INSTANCE_SELECT)
      .eq('company_id', company_id)
      .in('telefone', variants)
      .order('id', { ascending: false })
      .limit(limit),
    whatsappInstanceId,
    allowLegacyNullInstance
  )
}

async function findClienteRowForPhone(supabaseClient, company_id, phone, telefoneCanonico, searchPhones) {
  const phonesToSearch = Array.from(
    new Set([telefoneCanonico, ...(Array.isArray(searchPhones) ? searchPhones : []), ...possiblePhonesBR(phone), ...possiblePhonesBR(telefoneCanonico)].filter(Boolean))
  )

  if (phonesToSearch.length > 0) {
    const { data: exactRows, error: errExact } = await supabaseClient
      .from('clientes')
      .select(CLIENTE_SELECT_COLS)
      .eq('company_id', company_id)
      .in('telefone', phonesToSearch)
      .order('id', { ascending: true })
      .limit(5)
    if (!errExact) {
      const exact = Array.isArray(exactRows) && exactRows[0] ? exactRows[0] : null
      if (exact?.id) return exact
    }
  }

  const refPhone = telefoneCanonico || phone
  // Fallback LIKE: sufixos nacionais com DDD completo (10 = DDD+8, 11 = DDD+9+8).
  // Sem LIKE %últimos8%/%últimos10% do E.164 — colidem entre DDDs.
  const key = phoneKeyBR(refPhone)
  const likeSuffixes = []
  if (key && key.startsWith('55') && key.length === 12) {
    const national10 = key.slice(2)
    if (national10.length === 10) {
      likeSuffixes.push(national10)
      likeSuffixes.push(national10.slice(0, 2) + '9' + national10.slice(2))
    }
  }
  for (const suf of Array.from(new Set(likeSuffixes.filter(Boolean)))) {
    const { data: legacyRows } = await supabaseClient
      .from('clientes')
      .select(CLIENTE_SELECT_COLS)
      .eq('company_id', company_id)
      .like('telefone', `%${suf}`)
      .order('id', { ascending: true })
      .limit(20)
    if (Array.isArray(legacyRows)) {
      const legacy = legacyRows.find((row) => row?.id && phonesMatchDigitally(refPhone, row.telefone))
      if (legacy?.id) return legacy
    }
  }

  return null
}

/** Último recurso: conversa já vinculada a um cliente com o mesmo telefone. */
async function findClienteRowViaConversa(supabaseClient, company_id, phone, telefoneCanonico, searchPhones) {
  const variants = Array.from(
    new Set([telefoneCanonico, ...(Array.isArray(searchPhones) ? searchPhones : []), ...possiblePhonesBR(phone), ...possiblePhonesBR(telefoneCanonico)].filter(Boolean))
  )
  if (variants.length === 0) return null

  const { data: convRows } = await supabaseClient
    .from('conversas')
    .select('cliente_id, telefone')
    .eq('company_id', company_id)
    .in('telefone', variants)
    .not('cliente_id', 'is', null)
    .order('id', { ascending: false })
    .limit(8)

  const refPhone = telefoneCanonico || phone
  for (const conv of Array.isArray(convRows) ? convRows : []) {
    if (!conv?.cliente_id) continue
    if (conv.telefone && !phonesMatchDigitally(refPhone, conv.telefone)) continue
    const { data: cli } = await supabaseClient
      .from('clientes')
      .select(CLIENTE_SELECT_COLS)
      .eq('id', conv.cliente_id)
      .eq('company_id', company_id)
      .maybeSingle()
    if (cli?.id) return cli
  }
  return null
}

/**
 * getOrCreateCliente — SELECT-then-UPDATE/INSERT. Nunca insert puro.
 * Evita 23505 (duplicate key) em clientes_company_telefone_unique.
 * Cada empresa tem seus próprios clientes; nunca retorna cliente de outra company.
 *
 * @param {object} supabaseClient
 * @param {number} company_id
 * @param {string} phone - Telefone bruto do payload
 * @param {object} fields - { nome?, pushname?, foto_perfil?, wa_id?, email?, empresa? } (não sobrescrever com null)
 * @returns {Promise<{ cliente_id: number|null }>}
 */
async function getOrCreateCliente(supabaseClient, company_id, phone, fields = {}) {
  const waFromFields = fields.wa_id != null && String(fields.wa_id).trim() ? String(fields.wa_id).trim() : ''
  if (waFromFields) {
    const wVars = Array.from(
      new Set([waFromFields, waFromFields.toLowerCase()])
    ).filter(Boolean)
    const { data: waRows, error: errWa } = await supabaseClient
      .from('clientes')
      .select('id, nome, pushname, foto_perfil, company_id, telefone, wa_id, email, empresa')
      .eq('company_id', company_id)
      .in('wa_id', wVars)
      .order('id', { ascending: true })
      .limit(1)
    const byWa = Array.isArray(waRows) && waRows[0] ? waRows[0] : null
    if (errWa) {
      console.warn('[getOrCreateCliente] busca wa_id:', errWa?.message || errWa)
    } else if (byWa?.id) {
      return mergeAndReturnCliente(supabaseClient, company_id, byWa, phone, fields)
    }
  }

  let telefoneCanonico = getCanonicalPhone(phone)
  const allowNonBR = fields?.allowNonBR === true
  const strictAgendaImport = fields?.strictAgendaImport === true
  const phones = possiblePhonesBR(phone)
  let searchPhones = phones.length > 0 ? phones : (telefoneCanonico ? [telefoneCanonico] : [])
  if (strictAgendaImport) {
    searchPhones = telefoneCanonico ? [telefoneCanonico] : []
  }

  // Fallback: extrair dígitos (10 ou 11 = DDD+num BR) e tentar normalizar quando getCanonicalPhone falha
  if (searchPhones.length === 0 && phone) {
    const digits = String(phone).replace(/\D/g, '')
    if (digits.length >= 10 && digits.length <= 13 && !digits.startsWith('120')) {
      const with55 = digits.startsWith('55') ? digits : '55' + digits
      if (with55.startsWith('55') && (with55.length === 12 || with55.length === 13)) {
        searchPhones = [with55]
        if (with55.length === 12) searchPhones.push(with55.slice(0, 4) + '9' + with55.slice(4))
        else if (with55.length === 13 && with55[4] === '9') searchPhones.push(with55.slice(0, 4) + with55.slice(5))
        if (!telefoneCanonico) telefoneCanonico = with55
      }
    }
  }

  // Contatos internacionais (não BR): usa telefone em formato dígitos puro.
  if (allowNonBR && searchPhones.length === 0 && phone) {
    const anyIntl = getCanonicalPhoneAnyIntl(phone)
    if (anyIntl) {
      searchPhones = [anyIntl]
      if (!telefoneCanonico) telefoneCanonico = anyIntl
    }
  }

  // Garantir telefoneCanonico quando temos searchPhones mas getCanonicalPhone retornou vazio
  if (searchPhones.length > 0 && !telefoneCanonico) {
    telefoneCanonico = searchPhones[0]
  }

  if (searchPhones.length === 0) {
    return { cliente_id: null }
  }

  // 1) SELECT por variantes + phoneKeyBR (12/13 dígitos, com/sem DDI no banco)
  let existente = null
  try {
    existente = await findClienteRowForPhone(supabaseClient, company_id, phone, telefoneCanonico, searchPhones)
  } catch (e) {
    console.warn('[getOrCreateCliente] Erro ao buscar:', e?.message || e)
    return { cliente_id: null }
  }

  if (existente?.id) {
    return mergeAndReturnCliente(supabaseClient, company_id, existente, phone, fields)
  }

  // 3) Telefone válido para INSERT?
  const isTelefoneValido = telefoneCanonico &&
    !telefoneCanonico.startsWith('lid:') &&
    (
      (telefoneCanonico.startsWith('55') && (telefoneCanonico.length === 12 || telefoneCanonico.length === 13)) ||
      (allowNonBR && /^\d{10,15}$/.test(telefoneCanonico)) ||
      telefoneCanonico.endsWith('@g.us') ||
      (telefoneCanonico.startsWith('120') && telefoneCanonico.length >= 15)
    )

  if (!isTelefoneValido) {
    return { cliente_id: null }
  }

  // 4) INSERT — cada empresa tem seus próprios clientes (UNIQUE company_id + telefone).
  // Prioridade: name (salvo no celular) > pushname (perfil WhatsApp) > telefone
  const nomeRaw = (fields.nome && String(fields.nome).trim()) || (fields.pushname && String(fields.pushname).trim())
  const nome = (nomeRaw && !isBadName(nomeRaw)) ? nomeRaw : telefoneCanonico || null
  const pushname = (fields.pushname !== undefined && fields.pushname != null && String(fields.pushname).trim()) ? String(fields.pushname).trim() : null
  const insertData = {
    telefone: telefoneCanonico,
    nome,
    observacoes: null,
    company_id,
    ...(pushname ? { pushname } : {}),
    ...(fields.foto_perfil && hasValidFotoPerfil(fields.foto_perfil) ? { foto_perfil: String(fields.foto_perfil).trim() } : {}),
    ...(fields.wa_id && String(fields.wa_id).trim() ? { wa_id: String(fields.wa_id).trim() } : {}),
    ...(fields.email && String(fields.email).trim() ? { email: String(fields.email).trim() } : {}),
    ...(fields.empresa && String(fields.empresa).trim() ? { empresa: String(fields.empresa).trim() } : {})
  }
  const { data: upserted, error: errUpsert } = await supabaseClient
    .from('clientes')
    .upsert(insertData, { onConflict: 'company_id,telefone', ignoreDuplicates: true })
    .select('id')
    .maybeSingle()

  if (!errUpsert && upserted?.id) {
    return { cliente_id: upserted.id, created: true, changed: true }
  }

  let foundRow = await findClienteRowForPhone(supabaseClient, company_id, phone, telefoneCanonico, searchPhones)
  if (!foundRow?.id) {
    foundRow = await findClienteRowViaConversa(supabaseClient, company_id, phone, telefoneCanonico, searchPhones)
  }
  if (foundRow?.id) {
    return mergeAndReturnCliente(supabaseClient, company_id, foundRow, phone, fields)
  }

  // Verificação direta antes do INSERT para evitar 23505 por race condition.
  // O upsert com ignoreDuplicates:true pode ter silenciado um conflito sem retornar a linha;
  // buscamos pelo telefone exato antes de arriscar o INSERT.
  if (telefoneCanonico) {
    const { data: preInsertCheck } = await supabaseClient
      .from('clientes')
      .select(CLIENTE_SELECT_COLS)
      .eq('company_id', company_id)
      .eq('telefone', telefoneCanonico)
      .maybeSingle()
    if (preInsertCheck?.id) {
      return mergeAndReturnCliente(supabaseClient, company_id, preInsertCheck, phone, fields)
    }
  }

  const { data: novoCliente, error: errInsert } = await supabaseClient
    .from('clientes')
    .insert(insertData)
    .select('id')
    .single()

  if (!errInsert && novoCliente?.id) {
    return { cliente_id: novoCliente.id, created: true, changed: true }
  }

  const isDuplicate = String(errInsert?.code || '') === '23505' ||
    String(errUpsert?.code || '') === '23505' ||
    String(errInsert?.message || '').includes('unique') ||
    String(errInsert?.message || '').includes('duplicate')

  if (isDuplicate) {
    foundRow = await findClienteRowForPhone(supabaseClient, company_id, phone, telefoneCanonico, searchPhones)
    if (!foundRow?.id) {
      foundRow = await findClienteRowViaConversa(supabaseClient, company_id, phone, telefoneCanonico, searchPhones)
    }
    if (!foundRow?.id && telefoneCanonico) {
      const { data: directRow } = await supabaseClient
        .from('clientes')
        .select(CLIENTE_SELECT_COLS)
        .eq('company_id', company_id)
        .eq('telefone', telefoneCanonico)
        .maybeSingle()
      if (directRow?.id) foundRow = directRow
    }
    if (!foundRow?.id) {
      await new Promise((r) => setTimeout(r, 80))
      foundRow = await findClienteRowForPhone(supabaseClient, company_id, phone, telefoneCanonico, searchPhones)
    }
    if (!foundRow?.id) {
      foundRow = await findClienteRowViaConversa(supabaseClient, company_id, phone, telefoneCanonico, searchPhones)
    }
    if (foundRow?.id) {
      return mergeAndReturnCliente(supabaseClient, company_id, foundRow, phone, fields)
    }
  }

  const errFinal = errInsert || errUpsert
  console.warn('[getOrCreateCliente] Insert falhou, continuando sem cliente:', errFinal?.code || errFinal?.message || 'unknown', 'company_id:', company_id, 'telefone:', telefoneCanonico)
  return { cliente_id: null, created: false, changed: false }
}

/**
 * findOrCreateConversation — FUNÇÃO CENTRAL.
 *
 * Garante que exista UMA ÚNICA conversa aberta por telefone canônico.
 * Busca por todas as variantes do número (12/13 dígitos, com/sem 9).
 * Se encontrar mais de uma, mescla automaticamente.
 * Se não encontrar, cria com telefone canônico e trata race condition (23505).
 *
 * @param {object} supabaseClient  - Instância do supabase
 * @param {object} opts
 * @param {number} opts.company_id
 * @param {string} opts.phone          - Telefone bruto (será normalizado internamente)
 * @param {number|null} opts.cliente_id
 * @param {boolean} opts.isGroup
 * @param {string|null} opts.nomeGrupo
 * @param {string|null} opts.chatPhoto
 * @param {string} opts.logPrefix      - Prefixo para logs (ex: '[Z-API fromMe=true]')
 * @param {string} [opts.initial_status_atendimento] - ao criar conversa nova (ex.: mensagem_disparada). Default aberta.
 * @returns {Promise<{conversa: object, created: boolean}|null>}
 */
async function findOrCreateConversation(supabaseClient, {
  company_id,
  phone,
  cliente_id = null,
  isGroup = false,
  nomeGrupo = null,
  chatPhoto = null,
  chatLid = null,
  whatsapp_instance_id = null,
  whatsapp_instance_is_default = false,
  logPrefix = '',
  initial_status_atendimento = 'aberta',
  io = null,
  allowNonBR = false,
}) {
  const whatsappInstanceId = normalizeWhatsappInstanceId(whatsapp_instance_id)
  const allowLegacyNullInstance = !!(whatsappInstanceId && whatsapp_instance_is_default === true)

  if (!phone) {
    console.warn(`[findOrCreateConversation] ${logPrefix} phone vazio/nulo`)
    return null
  }

  // 0) LID-only: buscar por chat_lid antes de criar (evita duplicata quando conv com telefone real já existe)
  // Inclui conversas fechadas: quando cliente manda msg, reutilizamos e o webhook reabre automaticamente
  const isLidPhone = String(phone || '').startsWith('lid:')
  if (isLidPhone && chatLid) {
    const lidPart = String(chatLid).replace(/@lid$/i, '').trim()
    if (lidPart) {
      const rows = await selectConversationsByChatLid(
        supabaseClient,
        company_id,
        lidPart,
        whatsappInstanceId,
        allowLegacyNullInstance
      )
      const scopedRows = pickConversationForWhatsappInstance(rows, whatsappInstanceId, allowLegacyNullInstance)
      const convByLid = Array.isArray(scopedRows) && scopedRows[0] ? scopedRows[0] : null
      if (convByLid?.id) {
        console.log(`[findOrCreateConversation] ${logPrefix} ✅ encontrada por chat_lid (evita duplicata LID) conv=${convByLid.id}`)
        const convWithInstance = await attachWhatsappInstanceToLegacyConversation(supabaseClient, company_id, convByLid, whatsappInstanceId)
        return { conversa: convWithInstance, created: false }
      }
    }
  }

  // 1) Normalização: SEMPRE usar telefone canônico
  let canonical = getCanonicalPhone(phone)
  if (!canonical && allowNonBR) {
    canonical = getCanonicalPhoneAnyIntl(phone)
  }
  if (!canonical) {
    console.warn(`[findOrCreateConversation] ${logPrefix} não foi possível normalizar o phone: "${phone}"`)
    return null
  }

  // 2) Variantes para busca (grupos: dígitos e @g.us; individual: 12 vs 13 dígitos)
  let variants
  if (isGroup) {
    const digits = canonical.endsWith('@g.us') ? canonical.replace(/@g.us$/i, '') : canonical
    variants = [...new Set([digits, digits ? `${digits}@g.us` : ''].filter(Boolean))]
    // UltraMsg formato Group-Owner: incluir parte antes do hífen para achar conversas legadas (ex: 3618420)
    if (digits && digits.includes('-')) {
      const groupPart = digits.split('-')[0]
      if (groupPart) variants.push(groupPart, `${groupPart}@g.us`)
    }
  } else {
    variants = possiblePhonesBR(canonical).length > 0 ? possiblePhonesBR(canonical) : [canonical]
  }

  console.log(`[findOrCreateConversation] ${logPrefix} canonical="${canonical}" variants=[${variants.join(',')}] isGroup=${isGroup}`)

  // 3) Buscar conversa(s) por qualquer variante do telefone (inclui fechadas para reutilizar — webhook reabre quando cliente manda msg)
  let found
  let errFind
  try {
    found = await selectConversationsByPhoneVariants(
      supabaseClient,
      company_id,
      variants,
      whatsappInstanceId,
      allowLegacyNullInstance,
      50
    )
  } catch (err) {
    errFind = err
  }

  if (errFind) {
    console.error(`[findOrCreateConversation] ${logPrefix} erro ao buscar conversa:`, errFind.message)
    throw errFind
  }

  const foundScoped = pickConversationForWhatsappInstance(found, whatsappInstanceId, allowLegacyNullInstance)

  if (Array.isArray(foundScoped) && foundScoped.length > 0) {
    // 4) Mesclar duplicatas automaticamente se houver mais de uma
    if (foundScoped.length > 1 && !isGroup) {
      const exactRows = whatsappInstanceId
        ? foundScoped.filter((row) => Number(row?.whatsapp_instance_id) === Number(whatsappInstanceId))
        : foundScoped
      const rowsToMerge = exactRows.length > 0 ? exactRows : foundScoped
      const canonicalConv = rowsToMerge[0]
      const dupIds = rowsToMerge.slice(1).map(c => c.id).filter(Boolean)
      await mergeConversasIntoCanonico(supabaseClient, company_id, canonicalConv.id, dupIds, { io })
    }

    let conv = foundScoped[0]
    console.log(`[findOrCreateConversation] ${logPrefix} ✅ encontrada conv=${conv.id} phone_db="${conv.telefone}"`)

    // 5) Garantir telefone canônico na conversa encontrada (normalizar legado)
    const storedCanonical = conv.telefone
    const targetTelefone = canonical.endsWith('@g.us') ? canonical.replace(/@g.us$/i, '') : canonical
    const needsUpdate = !isGroup && storedCanonical !== canonical
    const needsGroupUpdate = isGroup && canonical.includes('-') && storedCanonical !== targetTelefone && !storedCanonical.includes('-')
    if (needsUpdate || needsGroupUpdate) {
      try {
        await supabaseClient.from('conversas')
          .update({ telefone: targetTelefone })
          .eq('id', conv.id)
          .eq('company_id', company_id)
      } catch (_) { /* não crítico */ }
    }

    conv = await attachWhatsappInstanceToLegacyConversation(supabaseClient, company_id, conv, whatsappInstanceId)
    return { conversa: conv, created: false }
  }

  // 6) Não encontrou — criar com telefone CANÔNICO (grupos: sempre dígitos para consistência)
  const telefoneToInsert = isGroup && canonical.endsWith('@g.us')
    ? canonical.replace(/@g.us$/i, '')
    : canonical
  const statusInicial =
    initial_status_atendimento != null && String(initial_status_atendimento).trim() !== ''
      ? String(initial_status_atendimento).trim()
      : 'aberta'
  const insertData = {
    telefone: telefoneToInsert,
    lida: false,
    status_atendimento: statusInicial,
    company_id,
    ultima_atividade: new Date().toISOString(),
  }
  if (whatsappInstanceId) insertData.whatsapp_instance_id = whatsappInstanceId

  if (isGroup) {
    insertData.tipo = 'grupo'
    insertData.nome_grupo = nomeGrupo || null
    insertData.cliente_id = null
    if (chatPhoto) insertData.foto_grupo = chatPhoto
  } else {
    insertData.cliente_id = cliente_id || null
  }

  const { data: created, error: errCreate } = await supabaseClient
    .from('conversas')
    .insert(insertData)
    .select(CONVERSA_INSTANCE_SELECT)
    .single()

  if (errCreate) {
    // 7) Race condition / violacao de unique — rebuscar no escopo correto da instancia
    const isUnique = isUniqueViolationError(errCreate)
    const isMissingCol = String(errCreate.message || '').includes('ultima_atividade') || String(errCreate.code || '') === 'PGRST204'
    const legacyAllowed = whatsappInstanceId ? allowLegacyNullInstance === true : true

    if (isMissingCol) {
      delete insertData.ultima_atividade
      const { data: retry, error: errRetry } = await supabaseClient
        .from('conversas').insert(insertData).select(CONVERSA_INSTANCE_SELECT).single()
      if (!errRetry) {
        console.log(`[findOrCreateConversation] ${logPrefix} 🆕 criada (sem ultima_atividade) conv=${retry.id}`)
        return { conversa: retry, created: true }
      }
      if (!isUniqueViolationError(errRetry)) throw errRetry
    }

    if (isUnique || isMissingCol) {
      const raceConv = await refetchConversationInInstanceScope(
        supabaseClient,
        company_id,
        variants,
        whatsappInstanceId,
        legacyAllowed,
        20
      )
      if (raceConv?.id) {
        console.log(`[findOrCreateConversation] ${logPrefix} ⚡ unique violation → conv=${raceConv.id} instance=${raceConv.whatsapp_instance_id ?? 'legacy'}`)
        return { conversa: raceConv, created: false }
      }
    }

    console.error(`[findOrCreateConversation] ${logPrefix} ❌ erro ao criar conversa:`, errCreate.code, errCreate.message)
    throw errCreate
  }

  console.log(`[findOrCreateConversation] ${logPrefix} 🆕 criada conv=${created.id} canonical="${canonical}"`)
  return { conversa: created, created: true }
}

/**
 * Deduplica lista de conversas: uma por contato (por phoneKeyBR).
 * Mantém a conversa com atividade mais recente.
 * @param {Array} conversas - Lista de conversas formatadas (com telefone, ultima_atividade, criado_em, is_group)
 * @returns {Array}
 */
function conversationDedupeKey(c) {
  if (!c || c.is_group) return `grupo:${c?.id ?? ''}`
  const instanceId = normalizeWhatsappInstanceId(c.whatsapp_instance_id)
  const instanceScope = instanceId ? `wi:${instanceId}` : 'wi:legacy'
  const phoneKey = (c.telefone && (phoneKeyBR(c.telefone) || String(c.telefone).replace(/\D/g, ''))) || ''
  const lid = String(c.chat_lid || c.chatLid || '').trim()
  const contactKey = phoneKey || (lid ? `lid:${lid}` : `id:${c.id}`)
  return `${instanceScope}:${contactKey}`
}

function deduplicateConversationsByContact(conversas) {
  if (!Array.isArray(conversas) || conversas.length === 0) return conversas
  const byKey = new Map()
  for (const c of conversas) {
    if (c.is_group) {
      byKey.set(`grupo:${c.id}`, c)
      continue
    }
    const key = conversationDedupeKey(c)
    if (!key) {
      byKey.set(`id:${c.id}`, c)
      continue
    }
    const existing = byKey.get(key)
    const cTime = new Date(c.ultima_atividade || c.criado_em || 0).getTime()
    const exTime = existing ? new Date(existing.ultima_atividade || existing.criado_em || 0).getTime() : 0
    if (!existing || cTime >= exTime) byKey.set(key, c)
  }
  return Array.from(byKey.values())
}

/**
 * Ordena conversas: mais recentes no topo (como WhatsApp).
 * @param {Array} conversas
 * @returns {Array}
 */
function sortConversationsByRecent(conversas) {
  if (!Array.isArray(conversas)) return conversas
  return [...conversas].sort((a, b) => {
    const pickTs = (c) => {
      const candidates = [
        c?.ultima_mensagem?.criado_em,
        c?.ultima_mensagem_preview?.criado_em,
        c?.ultima_atividade,
        c?.criado_em,
      ]
      let best = 0
      for (const raw of candidates) {
        const t = new Date(raw || 0).getTime()
        if (Number.isFinite(t) && t > best) best = t
      }
      return best
    }
    const ta = pickTs(a)
    const tb = pickTs(b)
    if (tb !== ta) return tb - ta
    return (Number(b.id) || 0) - (Number(a.id) || 0)
  })
}

/**
 * Fixadas primeiro (mais recente em fixada_em / atividade), depois o restante por ultima_atividade.
 * Campos opcionais: fixada (boolean), fixada_em (ISO string).
 */
function sortConversationsPinThenRecent(conversas) {
  if (!Array.isArray(conversas)) return conversas
  return [...conversas].sort((a, b) => {
    const ap = !!(a && a.fixada)
    const bp = !!(b && b.fixada)
    if (ap !== bp) return ap ? -1 : 1
    if (ap && bp) {
      const tfa = new Date(a.fixada_em || a.ultima_atividade || a.criado_em || 0).getTime()
      const tfb = new Date(b.fixada_em || b.ultima_atividade || b.criado_em || 0).getTime()
      if (tfb !== tfa) return tfb - tfa
    }
    const ta = new Date(a.ultima_atividade || a.criado_em || 0).getTime()
    const tb = new Date(b.ultima_atividade || b.criado_em || 0).getTime()
    if (tb !== ta) return tb - ta
    return (Number(b.id) || 0) - (Number(a.id) || 0)
  })
}

/**
 * Ordena resultados de BUSCA por relevância (estilo WhatsApp):
 *   1) fixadas primeiro;
 *   2) match em nome/telefone do contato (inclui clientes sem conversa) antes de
 *      match encontrado apenas no texto de mensagens;
 *   3) dentro de cada faixa, mais recentes no topo.
 *
 * `prioritySet` é um Set de IDs de conversa cujo match veio de nome/telefone.
 * Clientes sem conversa (sem_conversa=true) só aparecem em busca explícita e são
 * sempre match de nome/telefone — por isso entram na faixa prioritária.
 *
 * @param {Array} conversas
 * @param {Set<number>} prioritySet
 * @returns {Array}
 */
function sortConversationsBySearchRelevance(conversas, prioritySet) {
  if (!Array.isArray(conversas)) return conversas
  const priority = prioritySet instanceof Set ? prioritySet : new Set()
  const pickTs = (c) => {
    const candidates = [
      c?.ultima_mensagem?.criado_em,
      c?.ultima_mensagem_preview?.criado_em,
      c?.ultima_atividade,
      c?.criado_em,
    ]
    let best = 0
    for (const raw of candidates) {
      const t = new Date(raw || 0).getTime()
      if (Number.isFinite(t) && t > best) best = t
    }
    return best
  }
  const isPriority = (c) => {
    if (!c) return false
    if (c.sem_conversa === true) return true
    const id = Number(c.id)
    return Number.isFinite(id) && priority.has(id)
  }
  return [...conversas].sort((a, b) => {
    const ap = a?.fixada === true ? 1 : 0
    const bp = b?.fixada === true ? 1 : 0
    if (ap !== bp) return bp - ap
    const apr = isPriority(a) ? 1 : 0
    const bpr = isPriority(b) ? 1 : 0
    if (apr !== bpr) return bpr - apr
    // Dentro da faixa prioritária, contatos com conversa vêm antes dos "sem conversa".
    const asem = a?.sem_conversa === true ? 1 : 0
    const bsem = b?.sem_conversa === true ? 1 : 0
    if (asem !== bsem) return asem - bsem
    const ta = pickTs(a)
    const tb = pickTs(b)
    if (tb !== ta) return tb - ta
    return (Number(b.id) || 0) - (Number(a.id) || 0)
  })
}

module.exports = {
  getCanonicalPhone,
  getCanonicalPhoneAnyIntl,
  getOrCreateCliente,
  findOrCreateConversation,
  mergeConversasIntoCanonico,
  mergeConversationLidToPhone,
  emitConversasMerged,
  deduplicateConversationsByContact,
  sortConversationsByRecent,
  sortConversationsPinThenRecent,
  sortConversationsBySearchRelevance,
  phonesMatchDigitally,
  hasValidFotoPerfil,
  shouldUpdateFotoPerfil,
}
