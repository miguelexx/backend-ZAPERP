/**
 * Sincronização de grupos do WhatsApp via UltraMsg.
 * Endpoint: POST /api/integrations/whatsapp/groups/sync
 *
 * Fluxo:
 * 1) GET /groups - lista grupos da instância
 * 2) Para cada grupo: busca metadados (nome, foto)
 * 3) Cria/atualiza registro na tabela `conversas` (tipo: 'grupo')
 *
 * Resposta: { ok, totalFetched, inserted, updated, skipped, errors[] }
 */

const supabase = require('../config/supabase')
const { getProvider } = require('./providers')
const { getEmpresaWhatsappConfig } = require('./whatsappConfigService')
const { findOrCreateConversation, getOrCreateCliente } = require('../helpers/conversationSync')
const { normalizePhoneBR } = require('../helpers/phoneHelper')

// Constantes de configuração
const GROUP_ID_PREFIX = '120'
const MIN_GROUP_ID_LENGTH = 15
const GROUP_SUFFIX = '@g.us'
const ERROR_MESSAGE_MAX_LENGTH = 80

/**
 * Extrai campos de um grupo retornado pela UltraMsg.
 * Formato esperado: { id: "120363027...@g.us", name: "Nome do Grupo", ... }
 */
function extractGroupFields(raw) {
  if (!raw || typeof raw !== 'object') return null
  
  const groupId = String(raw.id || raw.jid || raw.chatId || '').trim()
  if (!groupId || !groupId.endsWith(GROUP_SUFFIX)) return null
  
  // Remove @g.us e valida formato de grupo (120...)
  const digits = groupId.replace(GROUP_SUFFIX, '').replace(/\D/g, '')
  if (!digits.startsWith(GROUP_ID_PREFIX) || digits.length < MIN_GROUP_ID_LENGTH) return null
  
  const nome = String(raw.name || raw.subject || raw.title || '').trim() || null
  const foto = raw.picture || raw.image || raw.photo || null
  const fotoUrl = foto && typeof foto === 'string' && foto.trim().startsWith('http') ? foto.trim() : null
  
  return {
    groupId: groupId,
    telefone: digits, // Apenas os dígitos (sem @g.us) para armazenar no banco
    nome: nome,
    foto: fotoUrl
  }
}

/**
 * Busca metadados de um grupo (nome e foto) via API UltraMsg.
 * Usa GET /groups/group?groupId= para obter o nome do grupo.
 */
async function getGroupMetadata(groupId, company_id) {
  const provider = getProvider()
  if (!provider) return { nome: null, foto: null }
  
  try {
    let nome = null
    let foto = null

    if (provider.getGroup) {
      try {
        const groupData = await provider.getGroup(groupId, { companyId: company_id })
        if (groupData && typeof groupData === 'object') {
          nome = String(groupData.name || groupData.subject || groupData.title || '').trim() || null
          const pic = groupData.picture || groupData.image || groupData.photo
          foto = pic && typeof pic === 'string' && pic.trim().startsWith('http') ? pic.trim() : null
        }
      } catch (e) {
        console.warn(`[GROUPS-SYNC] Erro ao buscar grupo ${groupId}:`, e?.message)
      }
    }

    if (!foto && provider.getProfilePicture) {
      try {
        foto = await provider.getProfilePicture(groupId, { companyId: company_id })
        if (!foto || !foto.startsWith('http')) foto = null
      } catch (e) {
        console.warn(`[GROUPS-SYNC] Erro ao buscar foto do grupo ${groupId}:`, e?.message)
      }
    }
    
    return { nome, foto }
  } catch (e) {
    console.warn(`[GROUPS-SYNC] Erro ao buscar metadados do grupo ${groupId}:`, e?.message)
    return { nome: null, foto: null }
  }
}

/**
 * Sincroniza grupos via API UltraMsg GET /groups.
 */
async function syncGroups(company_id) {
  if (!company_id) {
    return { ok: false, totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: ['company_id ausente'] }
  }

  const { config, error } = await getEmpresaWhatsappConfig(company_id)
  if (error || !config) {
    return { ok: false, totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: ['Empresa sem instância configurada'] }
  }

  const provider = getProvider()
  if (!provider?.getGroups) {
    return { ok: false, totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: ['getGroups não disponível'] }
  }

  const stats = { totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [] }

  try {
    const groups = await provider.getGroups({ companyId: company_id })
    if (!Array.isArray(groups) || groups.length === 0) {
      return { ok: true, totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [] }
    }

    stats.totalFetched = groups.length
    console.log(`[GROUPS-SYNC] Encontrados ${groups.length} grupos para sincronizar`)

    for (const g of groups) {
      const fields = extractGroupFields(g)
      if (!fields || !fields.telefone) {
        stats.skipped++
        continue
      }

      try {
        // Verifica se o grupo já existe
        const { data: existente } = await supabase
          .from('conversas')
          .select('id, nome_grupo, foto_grupo')
          .eq('company_id', company_id)
          .eq('telefone', fields.telefone)
          .eq('tipo', 'grupo')
          .limit(1)
          .maybeSingle()

        // Busca metadados adicionais (principalmente foto)
        const metadata = await getGroupMetadata(fields.groupId, company_id)
        const nomeAtualizado = fields.nome || metadata.nome
        const fotoAtualizada = fields.foto || metadata.foto

        if (existente) {
          // Atualiza grupo existente apenas se houver novos dados
          const updates = {}
          if (nomeAtualizado && nomeAtualizado !== existente.nome_grupo) {
            updates.nome_grupo = nomeAtualizado
          }
          if (fotoAtualizada && fotoAtualizada !== existente.foto_grupo) {
            updates.foto_grupo = fotoAtualizada
          }

          if (Object.keys(updates).length > 0) {
            const { error: updateError } = await supabase
              .from('conversas')
              .update(updates)
              .eq('id', existente.id)
              .eq('company_id', company_id)

            if (updateError) {
              stats.errors.push(`${fields.telefone}: erro ao atualizar - ${updateError.message}`)
            } else {
              stats.updated++
            }
          } else {
            stats.skipped++
          }
        } else {
          // Cria novo grupo
          const novoGrupo = {
            company_id: company_id,
            telefone: fields.telefone,
            tipo: 'grupo',
            nome_grupo: nomeAtualizado,
            foto_grupo: fotoAtualizada,
            status_atendimento: 'aberta',
            criado_em: new Date().toISOString()
          }

          const { error: insertError } = await supabase
            .from('conversas')
            .insert(novoGrupo)

          if (insertError) {
            stats.errors.push(`${fields.telefone}: erro ao inserir - ${insertError.message}`)
          } else {
            stats.inserted++
          }
        }
      } catch (e) {
        const errorMessage = String(e?.message || e).slice(0, ERROR_MESSAGE_MAX_LENGTH)
        stats.errors.push(`${fields.telefone}: ${errorMessage}`)
      }
    }

    return { ok: true, ...stats }
  } catch (e) {
    return { ok: false, totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [String(e?.message || e)] }
  }
}

/** Debounce por conversa para evitar excesso de chamadas ao abrir grupo */
const _lastGroupSyncByConv = new Map()
const GROUP_SYNC_DEBOUNCE_MS = 60_000

/**
 * Sincroniza nome do grupo ao abrir a conversa (detalharChat).
 * Atualiza nome_grupo e emite conversa_atualizada se houver nome novo.
 */
async function syncConversationGroupOnJoin(supabase, conversaId, companyId, io, opts = {}) {
  if (!conversaId || !companyId || !io) return
  const key = `${companyId}:${conversaId}`
  if (opts.skipIfRecent && _lastGroupSyncByConv.get(key) && Date.now() - _lastGroupSyncByConv.get(key) < GROUP_SYNC_DEBOUNCE_MS) {
    return
  }

  try {
    const { data: conv } = await supabase
      .from('conversas')
      .select('id, telefone, tipo, nome_grupo')
      .eq('id', conversaId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!conv || String(conv.tipo || '').toLowerCase() !== 'grupo') return
    const tf = String(conv.telefone || '').trim()
    if (!tf || !tf.includes('@g.us') && !(tf.startsWith('120') || tf.includes('-'))) return

    const groupId = tf.endsWith('@g.us') ? tf : `${tf}@g.us`
    const metadata = await getGroupMetadata(groupId, companyId)
    if (!metadata?.nome) return

    const nomeAtual = (conv.nome_grupo || '').trim()
    if (metadata.nome !== nomeAtual) {
      const { error } = await supabase
        .from('conversas')
        .update({ nome_grupo: metadata.nome })
        .eq('id', conversaId)
        .eq('company_id', companyId)
      if (!error && io) {
        const eventName = io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada'
        io.to(`empresa_${companyId}`).to(`conversa_${conversaId}`).emit(eventName, {
          id: conversaId,
          nome_grupo: metadata.nome,
          contato_nome: metadata.nome,
          cliente_nome: metadata.nome
        })
      }
    }
    _lastGroupSyncByConv.set(key, Date.now())
  } catch (e) {
    console.warn('[syncConversationGroupOnJoin]', e?.message || e)
  }
}

/**
 * Sincroniza via GET /chats — lista completa de conversas (individuais + grupos).
 * Complementa /contacts e /groups: captura chats que possam não estar em nenhum dos dois.
 */
async function syncFromChats(company_id) {
  if (!company_id) {
    return { ok: false, totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: ['company_id ausente'] }
  }

  const { config, error } = await getEmpresaWhatsappConfig(company_id)
  if (error || !config) {
    return { ok: false, totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: ['Empresa sem instância configurada'] }
  }

  const provider = getProvider()
  if (!provider?.getChats) {
    return { ok: true, totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [] }
  }

  const stats = { totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [] }

  try {
    const chats = await provider.getChats({ companyId: company_id })
    if (!Array.isArray(chats) || chats.length === 0) {
      return { ok: true, ...stats }
    }

    stats.totalFetched = chats.length
    console.log(`[CHATS-SYNC] Encontrados ${chats.length} chats para sincronizar`)

    for (const chat of chats) {
      const chatId = String(chat.id || chat.jid || chat.chatId || '').trim()
      if (!chatId) {
        stats.skipped++
        continue
      }

      const isGroup = chatId.endsWith('@g.us')
      const nome = String(chat.name || chat.subject || chat.title || '').trim() || null
      const foto = chat.picture || chat.image || chat.photo
      const fotoUrl = foto && typeof foto === 'string' && foto.trim().startsWith('http') ? foto.trim() : null

      try {
        if (isGroup) {
          const digits = chatId.replace(/@g.us$/i, '').replace(/\D/g, '')
          if (!digits || digits.length < MIN_GROUP_ID_LENGTH) {
            stats.skipped++
            continue
          }
          const result = await findOrCreateConversation(supabase, {
            company_id,
            phone: chatId,
            isGroup: true,
            nomeGrupo: nome,
            chatPhoto: fotoUrl,
            logPrefix: '[CHATS-SYNC]'
          })
          if (result?.created) stats.inserted++
          else if (result) stats.updated++
          else stats.skipped++
        } else {
          const digits = chatId.replace(/@c.us$/i, '').replace(/\D/g, '')
          if (!digits || digits.length < 10) {
            stats.skipped++
            continue
          }
          const phoneNorm = normalizePhoneBR(digits)
          if (!phoneNorm || !phoneNorm.startsWith('55')) {
            stats.skipped++
            continue
          }
          const { cliente_id } = await getOrCreateCliente(supabase, company_id, phoneNorm, {
            nome: nome || digits,
            nomeSource: 'syncChats'
          })
          const result = await findOrCreateConversation(supabase, {
            company_id,
            phone: phoneNorm,
            cliente_id,
            isGroup: false,
            logPrefix: '[CHATS-SYNC]'
          })
          if (result?.created) stats.inserted++
          else if (result) stats.updated++
          else stats.skipped++
        }
      } catch (e) {
        const errMsg = String(e?.message || e).slice(0, ERROR_MESSAGE_MAX_LENGTH)
        stats.errors.push(`${chatId}: ${errMsg}`)
      }
    }

    return { ok: true, ...stats }
  } catch (e) {
    return { ok: false, totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [String(e?.message || e)] }
  }
}

/**
 * Sincronização completa: contatos + grupos + chats.
 * Garante que todos os contatos e grupos do celular apareçam no sistema.
 */
async function syncAll(company_id) {
  const { syncContacts } = require('./ultramsgContactsSyncService')
  const contactsResult = await syncContacts(company_id)
  const groupsResult = await syncGroups(company_id)
  const chatsResult = await syncFromChats(company_id)

  return {
    ok: contactsResult.ok && groupsResult.ok && chatsResult.ok,
    contacts: {
      ok: contactsResult.ok,
      mode: contactsResult.mode,
      totalFetched: contactsResult.totalFetched,
      inserted: contactsResult.inserted,
      updated: contactsResult.updated,
      skipped: contactsResult.skipped,
      errors: contactsResult.errors || []
    },
    groups: {
      ok: groupsResult.ok,
      totalFetched: groupsResult.totalFetched,
      inserted: groupsResult.inserted,
      updated: groupsResult.updated,
      skipped: groupsResult.skipped,
      errors: groupsResult.errors || []
    },
    chats: {
      ok: chatsResult.ok,
      totalFetched: chatsResult.totalFetched,
      inserted: chatsResult.inserted,
      updated: chatsResult.updated,
      skipped: chatsResult.skipped,
      errors: chatsResult.errors || []
    }
  }
}

module.exports = {
  syncGroups,
  syncFromChats,
  syncAll,
  extractGroupFields,
  getGroupMetadata,
  syncConversationGroupOnJoin
}