/**
 * Enriquecimento de conversas com nome e foto de perfil via UltraMsg.
 * Usado quando listarConversas retorna conversas sem nome_contato_cache/foto_perfil_contato_cache.
 *
 * Regras:
 * - Só enriquece contatos individuais (não grupos)
 * - Não chama /contacts/image para grupos
 * - Usa syncContactFromUltramsg (já tem cache 5 min)
 * - Limita concorrência e quantidade para performance
 * - Persiste no banco para próxima listagem
 */

const supabase = require('../config/supabase')
const { syncContactFromUltramsg } = require('../services/ultramsgSyncContact')
const { isGroupConversation } = require('../helpers/conversaHelper')
const { phoneKeyBR } = require('../helpers/phoneHelper')

const MAX_ENRICH_PER_REQUEST = 15
const CONCURRENCY = 5

function isLid(phone) {
  return phone && String(phone).trim().toLowerCase().startsWith('lid:')
}

function needsEnrichment(conv) {
  if (!conv || isGroupConversation(conv)) return false
  if (conv.id == null || conv.sem_conversa) return false
  if (isLid(conv.telefone)) return false
  const tel = String(conv.telefone || '').trim()
  if (!tel || tel.length < 10) return false
  const hasName = conv.contato_nome && String(conv.contato_nome).trim() && !/^\d+$/.test(String(conv.contato_nome).replace(/\D/g, ''))
  const hasPhoto = conv.foto_perfil && String(conv.foto_perfil).trim().startsWith('http')
  return !hasName || !hasPhoto
}

/**
 * Enriquece conversas que estão sem nome ou foto.
 * @param {object[]} conversas - Lista já formatada (contato_nome, foto_perfil, id, telefone, is_group)
 * @param {number} company_id
 * @param {object} opts - { maxEnrich, skipPersistence }
 * @returns {Promise<object[]>} conversas com dados enriquecidos
 */
async function enrichConversationsWithContactData(conversas, company_id, opts = {}) {
  if (!conversas || !Array.isArray(conversas) || !company_id) return conversas

  const toEnrich = conversas.filter(needsEnrichment).slice(0, opts.maxEnrich ?? MAX_ENRICH_PER_REQUEST)
  if (toEnrich.length === 0) return conversas

  const results = new Map()
  const byPhone = new Map()
  for (const c of toEnrich) {
    const key = phoneKeyBR(c.telefone) || String(c.telefone).trim()
    if (!byPhone.has(key)) byPhone.set(key, c)
  }
  const unique = Array.from(byPhone.values())

  async function processOne(conv) {
    try {
      const enriched = await syncContactFromUltramsg(conv.telefone, company_id)
      if (!enriched) return null
      return { conv, enriched }
    } catch {
      return null
    }
  }

  const chunks = []
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    chunks.push(unique.slice(i, i + CONCURRENCY))
  }

  for (const chunk of chunks) {
    const settled = await Promise.allSettled(chunk.map(processOne))
    for (const p of settled) {
      if (p.status === 'fulfilled' && p.value) {
        const { conv, enriched } = p.value
        const key = conv.id
        results.set(key, {
          id: conv.id,
          telefone: conv.telefone,
          nome: enriched.nome || enriched.pushname || null,
          foto: enriched.foto_perfil || null
        })
      }
    }
  }

  if (results.size === 0) return conversas

  const updates = []
  for (const [id, data] of results) {
    if (data.nome || data.foto) {
      updates.push({ id: Number(id), nome: data.nome, foto: data.foto })
    }
  }

  if (updates.length > 0 && opts.skipPersistence !== true) {
    for (const u of updates) {
      const fields = {}
      if (u.nome) fields.nome_contato_cache = u.nome
      if (u.foto) fields.foto_perfil_contato_cache = u.foto
      if (Object.keys(fields).length > 0) {
        await supabase.from('conversas').update(fields).eq('id', u.id).eq('company_id', company_id)
      }
    }
  }

  const enrichedMap = new Map(updates.map((u) => [u.id, { nome: u.nome, foto: u.foto }]))

  return conversas.map((c) => {
    const e = enrichedMap.get(Number(c.id))
    if (!e) return c
    const next = { ...c }
    if (e.nome && (!c.contato_nome || !String(c.contato_nome).trim())) next.contato_nome = e.nome
    if (e.foto && (!c.foto_perfil || !String(c.foto_perfil).trim().startsWith('http'))) next.foto_perfil = e.foto
    return next
  })
}

module.exports = { enrichConversationsWithContactData, needsEnrichment }
