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
const { resolveCompanyWhatsappProvider } = require('./chat/identity/conversationAddressService')
const { getEmpresaWhatsappConfig } = require('./whatsappConfigService')
const { findOrCreateConversation, getOrCreateCliente } = require('../helpers/conversationSync')
const { normalizePhoneBR } = require('../helpers/phoneHelper')

// Constantes de configuração
const GROUP_ID_PREFIX = '120'
const MIN_GROUP_ID_LENGTH = 15
const GROUP_SUFFIX = '@g.us'
const ERROR_MESSAGE_MAX_LENGTH = 80
/**
 * Grupo de ID LEGADO: `<telefone do criador>-<timestamp da criação>` (grupos criados antes de
 * 2021 — ex. `553484079741-1553807524@g.us`). O filtro `120…` abaixo os descartava em silêncio:
 * no canal da empresa 1 isso deixava "WM Sistemas de Gestão" (397 participantes) fora do
 * sistema. Mesmo padrão que `getCanonicalPhone` reconhece em helpers/conversationSync.js.
 */
const LEGACY_GROUP_ID_RE = /^\d{5,15}-\d{10,15}$/

/**
 * Extrai campos de um grupo retornado pelo provedor (UltraMsg ou Whapi).
 * Formato esperado: { id: "120363027...@g.us" | "5534…-15538…@g.us", name: "Nome do Grupo", ... }
 *
 * `telefone` sai no MESMO formato que `findOrCreateConversation` grava (o id sem `@g.us`,
 * hífen preservado nos legados) — gravar os dígitos colados criaria uma segunda linha para
 * o grupo que o webhook já conhece.
 */
function extractGroupFields(raw) {
  if (!raw || typeof raw !== 'object') return null

  const groupId = String(raw.id || raw.jid || raw.chatId || '').trim()
  if (!groupId || !groupId.endsWith(GROUP_SUFFIX)) return null

  const semSufixo = groupId.slice(0, -GROUP_SUFFIX.length).trim()
  if (!semSufixo) return null

  const digits = semSufixo.replace(/\D/g, '')
  const idModerno = digits.startsWith(GROUP_ID_PREFIX) && digits.length >= MIN_GROUP_ID_LENGTH
  const idLegado = LEGACY_GROUP_ID_RE.test(semSufixo)
  if (!idModerno && !idLegado) return null

  const nome = String(raw.name || raw.subject || raw.title || '').trim() || null
  const foto = raw.picture || raw.image || raw.photo || null
  const fotoUrl = foto && typeof foto === 'string' && foto.trim().startsWith('http') ? foto.trim() : null

  return {
    groupId: groupId,
    telefone: semSufixo, // sem @g.us, como a conversa é gravada
    nome: nome,
    foto: fotoUrl
  }
}

/**
 * Números (instâncias WhatsApp ATIVAS) que o sync precisa varrer.
 *
 * `syncGroups`/`syncFromChats` só recebem `company_id` e os providers, sem
 * `whatsappInstanceId`, resolvem a instância **default** (`resolveConfig` →
 * `getDefaultWhatsappInstance`). Numa empresa com mais de um número, os grupos dos outros
 * números nunca eram importados — só apareciam se chegasse mensagem ao vivo.
 *
 * @returns {Promise<Array<{whatsappInstanceId: number|null, provider: string|null, isDefault: boolean}>>}
 */
async function listSyncTargets(company_id) {
  try {
    const { listWhatsappInstances } = require('./whatsappInstanceService')
    const { instances } = await listWhatsappInstances(company_id)
    const ativas = (Array.isArray(instances) ? instances : [])
      .filter((i) => i && i.ativo !== false && Number(i.id) > 0)
      .map((i) => ({
        whatsappInstanceId: Number(i.id),
        provider: String(i.provider || '').trim().toLowerCase() || null,
        isDefault: i.is_default === true,
      }))
    if (ativas.length > 0) return ativas
  } catch (e) {
    console.warn('[GROUPS-SYNC] não foi possível listar instâncias:', e?.message || e)
  }

  // Sem tabela de instâncias / só legado empresa_zapi: comportamento antigo (instância default).
  const provider = await resolveCompanyWhatsappProvider(company_id)
  return [{ whatsappInstanceId: null, provider, isDefault: true }]
}

/** Opções de provider para um alvo do sync (sem instância = resolve a default, como antes). */
function providerOptsFor(company_id, target) {
  const opts = { companyId: company_id }
  if (target?.whatsappInstanceId) opts.whatsappInstanceId = target.whatsappInstanceId
  return opts
}

/**
 * A empresa tem instância utilizável? Guarda herdada do fluxo antigo: sem instância
 * configurada o sync devolve erro em vez de "0 grupos".
 */
async function empresaTemInstancia(company_id, target) {
  if (target?.whatsappInstanceId) return true
  if (target?.provider === 'whapi') return true
  const { config, error } = await getEmpresaWhatsappConfig(company_id)
  return !(error || !config)
}

/**
 * Busca metadados de um grupo (nome e foto) via API UltraMsg.
 * Usa GET /groups/group?groupId= para obter o nome do grupo.
 */
async function getGroupMetadata(groupId, company_id, target = null) {
  const instanceProvider = target?.provider || (await resolveCompanyWhatsappProvider(company_id))
  const provider = getProvider({ provider: instanceProvider })
  if (!provider) return { nome: null, foto: null }
  const opts = providerOptsFor(company_id, target)

  try {
    let nome = null
    let foto = null

    if (provider.getGroup) {
      try {
        const groupData = await provider.getGroup(groupId, opts)
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
        foto = await provider.getProfilePicture(groupId, opts)
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
 * Procura a conversa do grupo SEM filtrar por instância.
 *
 * Um grupo é um só por empresa, mesmo que dois números conectados participem dele: filtrar por
 * `whatsapp_instance_id` aqui criaria uma segunda linha para o mesmo grupo (o "histórico que
 * some" quando o escopo de instância não casa). As variantes cobrem o id com e sem `@g.us` e
 * a forma só-dígitos que o sync antigo gravava.
 */
async function buscarGrupoExistente(company_id, fields) {
  const semSufixo = fields.telefone
  const variantes = [
    ...new Set([semSufixo, `${semSufixo}${GROUP_SUFFIX}`, semSufixo.replace(/\D/g, '')].filter(Boolean)),
  ]
  const { data, error } = await supabase
    .from('conversas')
    .select('id, telefone, nome_grupo, foto_grupo, whatsapp_instance_id')
    .eq('company_id', company_id)
    .eq('tipo', 'grupo')
    .in('telefone', variantes)
    .order('id', { ascending: true })
    .limit(5)
  if (error) throw error
  return (Array.isArray(data) ? data : [])[0] || null
}

/**
 * Cria/atualiza a conversa de UM grupo trazido pelo provedor. Devolve 'inserted' | 'updated' |
 * 'skipped' para as estatísticas.
 */
async function persistirGrupo(company_id, target, fields) {
  const existente = await buscarGrupoExistente(company_id, fields)

  // Metadados (GET /groups/{id} + foto) custam 1–2 chamadas POR GRUPO. A listagem já traz o
  // nome, então só vamos buscar quando falta nome ou falta foto — num re-sync de empresa com
  // ~150 grupos isso é a diferença entre ~300 chamadas e nenhuma (a Whapi pausa o canal em 429).
  let nome = fields.nome
  let foto = fields.foto
  const faltaNome = !nome && !existente?.nome_grupo
  const faltaFoto = !foto && !existente?.foto_grupo
  if (faltaNome || faltaFoto) {
    const metadata = await getGroupMetadata(fields.groupId, company_id, target)
    nome = nome || metadata.nome
    foto = foto || metadata.foto
  }

  if (existente) {
    const updates = {}
    if (nome && nome !== existente.nome_grupo) updates.nome_grupo = nome
    if (foto && foto !== existente.foto_grupo) updates.foto_grupo = foto
    // Grupo importado antes de existir o escopo por número fica com instância nula e pode cair
    // fora dos filtros por número — carimba agora que sabemos de qual número ele veio.
    if (existente.whatsapp_instance_id == null && target?.whatsappInstanceId) {
      updates.whatsapp_instance_id = target.whatsappInstanceId
    }
    if (Object.keys(updates).length === 0) return 'skipped'

    const { error: updateError } = await supabase
      .from('conversas')
      .update(updates)
      .eq('id', existente.id)
      .eq('company_id', company_id)
    if (updateError) throw new Error(`erro ao atualizar - ${updateError.message}`)
    return 'updated'
  }

  // Criação pelo MESMO caminho do webhook: telefone canônico, escopo de instância e tratamento
  // de corrida (unique violation) num só lugar.
  const resultado = await findOrCreateConversation(supabase, {
    company_id,
    phone: fields.groupId,
    isGroup: true,
    nomeGrupo: nome,
    chatPhoto: foto,
    whatsapp_instance_id: target?.whatsappInstanceId || null,
    whatsapp_instance_is_default: target?.isDefault === true,
    logPrefix: '[GROUPS-SYNC]',
  })
  if (!resultado?.conversa?.id) throw new Error('não foi possível criar a conversa do grupo')
  return resultado.created ? 'inserted' : 'updated'
}

/**
 * Sincroniza os grupos de TODOS os números ativos da empresa (GET /groups de cada instância).
 */
async function syncGroups(company_id) {
  if (!company_id) {
    return { ok: false, totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: ['company_id ausente'] }
  }

  const stats = { totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [] }
  const targets = await listSyncTargets(company_id)
  let algumaListagemOk = false

  for (const target of targets) {
    const rotulo = target.whatsappInstanceId ? `inst ${target.whatsappInstanceId}` : 'instância default'

    if (!(await empresaTemInstancia(company_id, target))) {
      stats.errors.push(`${rotulo}: Empresa sem instância configurada`)
      continue
    }
    const provider = getProvider({ provider: target.provider })
    if (!provider?.getGroups) {
      stats.errors.push(`${rotulo}: getGroups não disponível`)
      continue
    }

    let groups
    try {
      groups = await provider.getGroups(providerOptsFor(company_id, target))
    } catch (e) {
      stats.errors.push(`${rotulo}: ${String(e?.message || e).slice(0, ERROR_MESSAGE_MAX_LENGTH)}`)
      continue
    }
    algumaListagemOk = true
    if (!Array.isArray(groups) || groups.length === 0) continue

    stats.totalFetched += groups.length
    console.log(`[GROUPS-SYNC] ${rotulo}: ${groups.length} grupos para sincronizar`)

    for (const g of groups) {
      const fields = extractGroupFields(g)
      if (!fields || !fields.telefone) {
        stats.skipped++
        if (g && (g.id || g.jid || g.chatId)) {
          console.warn(`[GROUPS-SYNC] ${rotulo}: id de grupo não reconhecido, pulado:`, String(g.id || g.jid || g.chatId))
        }
        continue
      }
      try {
        const desfecho = await persistirGrupo(company_id, target, fields)
        stats[desfecho] += 1
      } catch (e) {
        const errorMessage = String(e?.message || e).slice(0, ERROR_MESSAGE_MAX_LENGTH)
        stats.errors.push(`${fields.telefone}: ${errorMessage}`)
      }
    }
  }

  if (!algumaListagemOk) {
    return { ok: false, ...stats }
  }
  return { ok: true, ...stats }
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
      .select('id, telefone, tipo, nome_grupo, foto_grupo')
      .eq('id', conversaId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!conv || String(conv.tipo || '').toLowerCase() !== 'grupo') return
    const tf = String(conv.telefone || '').trim()
    if (!tf || !tf.includes('@g.us') && !(tf.startsWith('120') || tf.includes('-'))) return

    const groupId = tf.endsWith('@g.us') ? tf : `${tf}@g.us`
    const metadata = await getGroupMetadata(groupId, companyId)
    if (!metadata?.nome && !metadata?.foto) return

    const updates = {}
    const nomeAtual = (conv.nome_grupo || '').trim()
    const fotoAtual = (conv.foto_grupo || '').trim()
    if (metadata.nome && metadata.nome !== nomeAtual) {
      updates.nome_grupo = metadata.nome
    }
    if (metadata.foto && String(metadata.foto).trim().startsWith('http') && metadata.foto !== fotoAtual) {
      updates.foto_grupo = String(metadata.foto).trim()
    }

    if (Object.keys(updates).length > 0) {
      const { error } = await supabase
        .from('conversas')
        .update(updates)
        .eq('id', conversaId)
        .eq('company_id', companyId)
      if (!error && io) {
        const eventName = io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada'
        const { emitirEventoEmpresaConversa } = require('../controllers/chatController')
        const nomeEmit = updates.nome_grupo || nomeAtual || null
        emitirEventoEmpresaConversa(io, companyId, conversaId, eventName, {
          id: conversaId,
          ...(updates.nome_grupo
            ? {
                nome_grupo: updates.nome_grupo,
                contato_nome: updates.nome_grupo,
                cliente_nome: updates.nome_grupo,
              }
            : {}),
          ...(updates.foto_grupo ? { foto_grupo: updates.foto_grupo } : {}),
        })
        if (nomeEmit || updates.foto_grupo) {
          io.to(`empresa_${companyId}`).emit('contato_atualizado', {
            conversa_id: Number(conversaId),
            contato_nome: nomeEmit || null,
            nome_grupo: nomeEmit || null,
            foto_grupo: updates.foto_grupo || fotoAtual || null,
          })
        }
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

  const stats = { totalFetched: 0, inserted: 0, updated: 0, skipped: 0, errors: [] }
  const targets = await listSyncTargets(company_id)
  let algumaListagemOk = false

  for (const target of targets) {
    const rotulo = target.whatsappInstanceId ? `inst ${target.whatsappInstanceId}` : 'instância default'

    if (!(await empresaTemInstancia(company_id, target))) {
      stats.errors.push(`${rotulo}: Empresa sem instância configurada`)
      continue
    }
    const provider = getProvider({ provider: target.provider })
    if (!provider?.getChats) {
      algumaListagemOk = true // provider sem /chats não é falha: o sync de grupos já cobriu
      continue
    }

    let chats
    try {
      chats = await provider.getChats(providerOptsFor(company_id, target))
    } catch (e) {
      stats.errors.push(`${rotulo}: ${String(e?.message || e).slice(0, ERROR_MESSAGE_MAX_LENGTH)}`)
      continue
    }
    algumaListagemOk = true
    if (!Array.isArray(chats) || chats.length === 0) continue

    stats.totalFetched += chats.length
    console.log(`[CHATS-SYNC] ${rotulo}: ${chats.length} chats para sincronizar`)

    for (const chat of chats) {
      const chatId = String(chat.id || chat.jid || chat.chatId || '').trim()
      if (!chatId) {
        stats.skipped++
        continue
      }

      const isGroup = chatId.endsWith(GROUP_SUFFIX)
      const nome = String(chat.name || chat.subject || chat.title || '').trim() || null
      const foto = chat.picture || chat.image || chat.photo
      const fotoUrl = foto && typeof foto === 'string' && foto.trim().startsWith('http') ? foto.trim() : null

      try {
        if (isGroup) {
          // Mesma validação de id do /groups — inclui os grupos de id legado (`dono-criação`).
          const fields = extractGroupFields({ id: chatId, name: nome, picture: fotoUrl })
          if (!fields) {
            stats.skipped++
            continue
          }
          const desfecho = await persistirGrupo(company_id, target, fields)
          stats[desfecho] += 1
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
          // Conversa individual segue SEM carimbo de instância, como antes: carimbar aqui
          // criaria linha nova para um número que já tem conversa de instância nula
          // (o escopo por instância não casa) — e isso é fora do escopo do sync de grupos.
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
  }

  if (!algumaListagemOk) {
    return { ok: false, ...stats }
  }
  return { ok: true, ...stats }
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
