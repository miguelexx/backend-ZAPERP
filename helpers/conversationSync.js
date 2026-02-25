/**
 * Sincronização de conversa/cliente por telefone canônico.
 * Garante um único contato e uma única conversa aberta por número (evita duplicata 55... vs 11...).
 */

const supabase = require('../config/supabase')
const { normalizePhoneBR, possiblePhonesBR, phoneKeyBR } = require('./phoneHelper')

/**
 * Retorna telefone canônico para armazenamento (sempre o mesmo formato por número).
 * Mantém compatibilidade com números já existentes, mas tenta extrair o telefone real
 * de JIDs (@s.whatsapp.net) e de identificadores especiais como @lid.
 *
 * ATENÇÃO: A deduplicação forte (12/13 dígitos BR) é feita por `normalizePhoneBR` /
 * `possiblePhonesBR`. Aqui o objetivo principal é **nunca perder mensagem**: se não
 * conseguir normalizar, ainda assim devolve os dígitos disponíveis.
 *
 * @param {string} phone
 * @returns {string}
 */
function getCanonicalPhone(phone) {
  if (!phone) return ''
  const s = String(phone).trim()

  // Grupos: preservar JID completo
  if (s.endsWith('@g.us')) return s

  // JID individual @s.whatsapp.net → extrair apenas os dígitos do telefone
  let phoneStr = s
  if (s.includes('@s.whatsapp.net')) {
    phoneStr = s.replace('@s.whatsapp.net', '')
  }

  // Identificadores especiais (@lid, @broadcast, etc.): extrair só dígitos
  if (/@(lid|broadcast)$/i.test(s)) {
    phoneStr = s.replace(/@[^@]+$/, '')
  }

  // 1) Tentar normalização BR (caso de uso principal)
  const norm = normalizePhoneBR(phoneStr)
  if (norm) return norm

  // 2) Fallback defensivo: usar apenas dígitos disponíveis.
  //    Isso garante que nenhuma mensagem seja perdida, mesmo que o provider
  //    envie identificadores não-BR. A deduplicação por número BR continua
  //    sendo feita por `possiblePhonesBR`/`phoneKeyBR`.
  const digits = phoneStr.replace(/\D/g, '')
  if (!digits) return ''

  // Loga quando parecer algo fora do padrão BR (ex.: 14+ dígitos).
  if (digits.length > 13 || !digits.startsWith('55')) {
    console.warn('[getCanonicalPhone] Telefone não-BR ou fora do padrão, usando dígitos brutos:', digits)
  }

  return digits
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
    await supabaseClient.from('mensagens').update({ conversa_id: canonicalId }).in('conversa_id', dupIds)
    await supabaseClient.from('conversa_tags').update({ conversa_id: canonicalId }).in('conversa_id', dupIds)
    await supabaseClient.from('atendimentos').update({ conversa_id: canonicalId }).in('conversa_id', dupIds)
    await supabaseClient.from('historico_atendimentos').update({ conversa_id: canonicalId }).in('conversa_id', dupIds)
    await supabaseClient.from('conversa_unreads').update({ conversa_id: canonicalId }).in('conversa_id', dupIds)
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
  logPrefix = '',
}) {
  if (!phone) {
    console.warn(`[findOrCreateConversation] ${logPrefix} phone vazio/nulo`)
    return null
  }

  // 1) Normalização: SEMPRE usar telefone canônico
  const canonical = getCanonicalPhone(phone)
  if (!canonical) {
    console.warn(`[findOrCreateConversation] ${logPrefix} não foi possível normalizar o phone: "${phone}"`)
    return null
  }

  // 2) Variantes para busca (cobre 12 vs 13 dígitos, com/sem 9)
  const variants = isGroup ? [canonical] : (possiblePhonesBR(canonical).length > 0 ? possiblePhonesBR(canonical) : [canonical])

  console.log(`[findOrCreateConversation] ${logPrefix} canonical="${canonical}" variants=[${variants.join(',')}] isGroup=${isGroup}`)

  // 3) Buscar conversa(s) abertas por qualquer variante do telefone
  const { data: found, error: errFind } = await supabaseClient
    .from('conversas')
    .select('id, departamento_id, telefone, cliente_id')
    .eq('company_id', company_id)
    .neq('status_atendimento', 'fechada')
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
    if (!isGroup && conv.telefone !== canonical) {
      try {
        await supabaseClient.from('conversas')
          .update({ telefone: canonical })
          .eq('id', conv.id)
          .eq('company_id', company_id)
      } catch (_) { /* não crítico */ }
    }

    return { conversa: conv, created: false }
  }

  // 6) Não encontrou — criar com telefone CANÔNICO
  const insertData = {
    telefone: canonical,
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
      // Race condition resolvida: busca novamente
      const { data: raceFound } = await supabaseClient
        .from('conversas')
        .select('id, departamento_id, telefone, cliente_id')
        .eq('company_id', company_id)
        .neq('status_atendimento', 'fechada')
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

module.exports = {
  getCanonicalPhone,
  findOrCreateConversation,
  mergeConversasIntoCanonico,
  deduplicateConversationsByContact,
  sortConversationsByRecent,
}
