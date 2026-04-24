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
async function mergeConversasIntoCanonico(supabaseClient, company_id, canonicalId, dupIds) {
  if (!dupIds || dupIds.length === 0) return
  try {
    await supabaseClient.from('mensagens').update({ conversa_id: canonicalId }).in('conversa_id', dupIds).eq('company_id', company_id)
    await supabaseClient.from('conversa_tags').update({ conversa_id: canonicalId }).in('conversa_id', dupIds).eq('company_id', company_id)
    await supabaseClient.from('atendimentos').update({ conversa_id: canonicalId }).in('conversa_id', dupIds).eq('company_id', company_id)
    await supabaseClient.from('historico_atendimentos').update({ conversa_id: canonicalId }).in('conversa_id', dupIds)
    await supabaseClient.from('conversa_unreads').update({ conversa_id: canonicalId }).in('conversa_id', dupIds).eq('company_id', company_id)
    const del = await supabaseClient.from('conversas').delete().in('id', dupIds).eq('company_id', company_id)
    if (del.error) {
      await supabaseClient.from('conversas')
        .update({ status_atendimento: 'fechada', lida: true })
        .in('id', dupIds)
        .eq('company_id', company_id)
    }
    console.log(`[conversationSync] 🧹 ${dupIds.length} duplicata(s) mesclada(s) → conv ${canonicalId}`)
  } catch (e) {
    console.warn('[conversationSync] ⚠️ falha ao mesclar duplicatas:', e?.message || e)
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

  const { data: convByLid } = await supabaseClient
    .from('conversas')
    .select('id, telefone, nome_contato_cache, foto_perfil_contato_cache')
    .eq('company_id', company_id)
    .eq('chat_lid', lidPart)
    .maybeSingle()

  const { data: convByPhoneRows } = await supabaseClient
    .from('conversas')
    .select('id, telefone, nome_contato_cache, foto_perfil_contato_cache')
    .eq('company_id', company_id)
    .in('telefone', variants)
    .neq('status_atendimento', 'fechada')
    .order('ultima_atividade', { ascending: false })
    .limit(1)

  const convByPhone = Array.isArray(convByPhoneRows) && convByPhoneRows[0] ? convByPhoneRows[0] : null

  if (!convByLid || !convByPhone || convByLid.id === convByPhone.id) {
    return { merged: false }
  }

  try {
    await mergeConversasIntoCanonico(supabaseClient, company_id, convByPhone.id, [convByLid.id])
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
      const payload = { id: convByPhone.id, telefone: canonical, ...cacheUpdates }
      io.to(`empresa_${company_id}`).emit('conversa_atualizada', payload)
      io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: convByPhone.id })
    }

    console.log('[conversationSync] 🔗 LID→PHONE:', { lidPart, canonical: canonical.slice(-8), conversa_id: convByPhone.id })
    return { merged: true, conversa_id: convByPhone.id }
  } catch (e) {
    console.warn('[conversationSync] ⚠️ mergeConversationLidToPhone:', e?.message || e)
    return { merged: false }
  }
}

/**
 * Aplica campos no cliente existente (sem anular com vazio) e retorna o id.
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
  if (fields.foto_perfil) updates.foto_perfil = fields.foto_perfil
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

  // 1) SELECT por (company_id, telefone ou variantes)
  let q = supabaseClient
    .from('clientes')
    .select('id, nome, pushname, foto_perfil, company_id, telefone, wa_id, email, empresa')
  if (searchPhones.length > 0) q = q.in('telefone', searchPhones)
  else q = q.eq('telefone', phone)
  q = q.eq('company_id', company_id)
  const { data: rows1, error: err1 } = await q.order('id', { ascending: true }).limit(1)
  const existente = Array.isArray(rows1) && rows1[0] ? rows1[0] : null

  if (err1) {
    console.warn('[getOrCreateCliente] Erro ao buscar:', err1?.message || err1)
    return { cliente_id: null }
  }

  if (existente?.id) {
    return mergeAndReturnCliente(supabaseClient, company_id, existente, phone, fields)
  }

  // 2) Fallback legado: LIKE %digits10 (DDD+8) — somente para números BR.
  // Evita falso match em números internacionais que compartilham sufixo.
  const canonicalIsBR = !!(telefoneCanonico && String(telefoneCanonico).startsWith('55') && (String(telefoneCanonico).length === 12 || String(telefoneCanonico).length === 13))
  if (!strictAgendaImport && phone && canonicalIsBR) {
    try {
      const digits10 = String(phone).replace(/\D/g, '').slice(-10)
      if (digits10 && digits10.length === 10) {
        const { data: legacyRows } = await supabaseClient
          .from('clientes')
          .select('id, telefone, nome, pushname, foto_perfil, wa_id, email, empresa')
          .eq('company_id', company_id)
          .like('telefone', `%${digits10}`)
          .order('id', { ascending: true })
          .limit(1)
        const legacy = Array.isArray(legacyRows) && legacyRows[0] ? legacyRows[0] : null
        if (legacy?.id) {
          return mergeAndReturnCliente(supabaseClient, company_id, legacy, phone, fields)
        }
      }
    } catch (_) { /* fallback silencioso */ }
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
    ...(fields.foto_perfil ? { foto_perfil: fields.foto_perfil } : {}),
    ...(fields.wa_id && String(fields.wa_id).trim() ? { wa_id: String(fields.wa_id).trim() } : {}),
    ...(fields.email && String(fields.email).trim() ? { email: String(fields.email).trim() } : {}),
    ...(fields.empresa && String(fields.empresa).trim() ? { empresa: String(fields.empresa).trim() } : {})
  }
  const { data: novoCliente, error: errInsert } = await supabaseClient
    .from('clientes')
    .insert(insertData)
    .select('id')
    .single()

  if (!errInsert && novoCliente?.id) {
    return { cliente_id: novoCliente.id, created: true, changed: true }
  }

  // 5) 23505: race condition — buscar existente da MESMA company (unique é company_id + telefone)
  // Quando 23505, a linha (company_id, telefoneCanonico) JÁ EXISTE — garantir que a busca inclua esse valor
  const isDuplicate = String(errInsert?.code || '') === '23505' ||
    String(errInsert?.message || '').includes('unique') ||
    String(errInsert?.message || '').includes('duplicate')

  if (isDuplicate) {
    // Sempre incluir telefoneCanonico na busca (valor exato que causou o 23505)
    const phonesToSearch = Array.from(new Set([telefoneCanonico, ...searchPhones].filter(Boolean)))

    const tryFind = async (strategy = 'exact') => {
      let q = supabaseClient.from('clientes').select('id').eq('company_id', company_id)
      
      if (strategy === 'exact') {
        q = phonesToSearch.length > 0 ? q.in('telefone', phonesToSearch) : q.eq('telefone', telefoneCanonico)
      } else if (strategy === 'like' && telefoneCanonico) {
        const digits8 = String(telefoneCanonico).replace(/\D/g, '').slice(-8)
        if (digits8?.length === 8) {
          q = q.like('telefone', `%${digits8}`)
        } else {
          return null
        }
      }
      
      const { data, error } = await q.order('id', { ascending: true }).limit(1)
      if (error) return null
      return Array.isArray(data) && data[0] ? data[0] : null
    }

    // Tentativa 1: busca exata (inclui telefoneCanonico que causou 23505)
    let foundCo = await tryFind('exact')
    
    // Tentativa 2: busca DIRETA pelo valor exato do INSERT (100% garantido quando 23505)
    if (!foundCo?.id && telefoneCanonico) {
      const { data: directRow } = await supabaseClient
        .from('clientes')
        .select('id')
        .eq('company_id', company_id)
        .eq('telefone', telefoneCanonico)
        .limit(1)
        .maybeSingle()
      foundCo = directRow && directRow.id ? directRow : null
    }
    
    // Tentativa 3: aguardar (race condition) e retry
    if (!foundCo?.id) {
      await new Promise(r => setTimeout(r, 150))
      foundCo = await tryFind('exact')
    }
    
    // Tentativa 4: busca por LIKE (últimos 8 dígitos)
    if (!foundCo?.id) {
      foundCo = await tryFind('like')
    }
    
    // Tentativa 5: variações 12/13 dígitos
    if (!foundCo?.id && telefoneCanonico) {
      const allVariants = possiblePhonesBR(telefoneCanonico)
      if (allVariants.length >= 1) {
        const { data: variantRows } = await supabaseClient
          .from('clientes')
          .select('id')
          .eq('company_id', company_id)
          .in('telefone', allVariants)
          .order('id', { ascending: true })
          .limit(1)
        foundCo = Array.isArray(variantRows) && variantRows[0] ? variantRows[0] : null
      }
    }
    
    if (foundCo?.id) return { cliente_id: foundCo.id, created: false, changed: false }
  }

  console.warn('[getOrCreateCliente] Insert falhou, continuando sem cliente:', errInsert?.code || errInsert?.message || 'unknown', 'company_id:', company_id, 'telefone:', telefoneCanonico)
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
  logPrefix = '',
}) {
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
      const { data: rows } = await supabaseClient
        .from('conversas')
        .select('id, departamento_id, telefone, cliente_id')
        .eq('company_id', company_id)
        .eq('chat_lid', lidPart)
        .order('ultima_atividade', { ascending: false })
        .limit(1)
      const convByLid = Array.isArray(rows) && rows[0] ? rows[0] : null
      if (convByLid?.id) {
        console.log(`[findOrCreateConversation] ${logPrefix} ✅ encontrada por chat_lid (evita duplicata LID) conv=${convByLid.id}`)
        return { conversa: convByLid, created: false }
      }
    }
  }

  // 1) Normalização: SEMPRE usar telefone canônico
  const canonical = getCanonicalPhone(phone)
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
  const { data: found, error: errFind } = await supabaseClient
    .from('conversas')
    .select('id, departamento_id, telefone, cliente_id')
    .eq('company_id', company_id)
    .in('telefone', variants)
    .order('id', { ascending: false })
    .limit(10)

  if (errFind) {
    console.error(`[findOrCreateConversation] ${logPrefix} erro ao buscar conversa:`, errFind.message)
    throw errFind
  }

  if (Array.isArray(found) && found.length > 0) {
    // 4) Mesclar duplicatas automaticamente se houver mais de uma
    if (found.length > 1 && !isGroup) {
      const canonicalConv = found[0]
      const dupIds = found.slice(1).map(c => c.id).filter(Boolean)
      await mergeConversasIntoCanonico(supabaseClient, company_id, canonicalConv.id, dupIds)
    }

    const conv = found[0]
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

    return { conversa: conv, created: false }
  }

  // 6) Não encontrou — criar com telefone CANÔNICO (grupos: sempre dígitos para consistência)
  const telefoneToInsert = isGroup && canonical.endsWith('@g.us')
    ? canonical.replace(/@g.us$/i, '')
    : canonical
  const insertData = {
    telefone: telefoneToInsert,
    lida: false,
    status_atendimento: 'aberta',
    company_id,
    ultima_atividade: new Date().toISOString(),
  }

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
    .select('id, departamento_id')
    .single()

  if (errCreate) {
    // 7) Race condition: outra requisição criou antes de nós — rebuscar
    const isUnique = String(errCreate.code || '') === '23505' || String(errCreate.message || '').toLowerCase().includes('unique')
    const isMissingCol = String(errCreate.message || '').includes('ultima_atividade') || String(errCreate.code || '') === 'PGRST204'

    if (isMissingCol) {
      delete insertData.ultima_atividade
      const { data: retry, error: errRetry } = await supabaseClient
        .from('conversas').insert(insertData).select('id, departamento_id').single()
      if (!errRetry) {
        console.log(`[findOrCreateConversation] ${logPrefix} 🆕 criada (sem ultima_atividade) conv=${retry.id}`)
        return { conversa: retry, created: true }
      }
      if (String(errRetry.code || '') !== '23505') throw errRetry
    }

    if (isUnique || isMissingCol) {
      // Race condition resolvida: busca novamente (inclui fechadas)
      const { data: raceFound } = await supabaseClient
        .from('conversas')
        .select('id, departamento_id, telefone, cliente_id')
        .eq('company_id', company_id)
        .in('telefone', variants)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (raceFound) {
        console.log(`[findOrCreateConversation] ${logPrefix} ⚡ race condition → conv=${raceFound.id}`)
        return { conversa: raceFound, created: false }
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
function deduplicateConversationsByContact(conversas) {
  if (!Array.isArray(conversas) || conversas.length === 0) return conversas
  const byKey = new Map()
  for (const c of conversas) {
    if (c.is_group) {
      byKey.set(`grupo:${c.id}`, c)
      continue
    }
    const key = (c.telefone && (phoneKeyBR(c.telefone) || String(c.telefone).replace(/\D/g, ''))) || `id:${c.id}`
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
    const ta = new Date(a.ultima_atividade || a.criado_em || 0).getTime()
    const tb = new Date(b.ultima_atividade || b.criado_em || 0).getTime()
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

module.exports = {
  getCanonicalPhone,
  getOrCreateCliente,
  findOrCreateConversation,
  mergeConversasIntoCanonico,
  mergeConversationLidToPhone,
  deduplicateConversationsByContact,
  sortConversationsByRecent,
  sortConversationsPinThenRecent,
}
