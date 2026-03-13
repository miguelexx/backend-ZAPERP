/**
 * Enriquecimento de conversas com nome e foto de perfil via UltraMsg.
 * Usado quando listarConversas retorna conversas sem nome_contato_cache/foto_perfil_contato_cache.
 *
 * Regras:
 * - Só enriquece contatos individuais (não grupos)
 * - Usa syncUltraMsgContact (cache 5 min)
 * - Heurística: nunca sobrescrever nome/foto melhor por pior
 * - Limita concorrência e quantidade para performance
 */

const supabase = require('../config/supabase')
const { syncUltraMsgContact } = require('../services/ultramsgSyncContact')
const { chooseBestName, isBadName } = require('./contactEnrichment')
const { isGroupConversation } = require('../helpers/conversaHelper')
const { phoneKeyBR } = require('../helpers/phoneHelper')

function isValidPhotoUrl(url) {
  return url && typeof url === 'string' && url.trim().startsWith('http')
}

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
      const data = await syncUltraMsgContact(conv.telefone, company_id, { skipPersistence: true })
      if (!data) return null
      const nome = data.nome || null
      const foto = data.foto_perfil && isValidPhotoUrl(data.foto_perfil) ? data.foto_perfil : null
      return { conv, nome, foto }
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
        const { conv, nome, foto } = p.value
        if (nome || foto) results.set(conv.id, { id: conv.id, nome, foto })
      }
    }
  }

  if (results.size === 0) return conversas

  const updates = []
  if (opts.skipPersistence !== true) {
    for (const [id, data] of results) {
      const { data: convRow } = await supabase
        .from('conversas')
        .select('nome_contato_cache, foto_perfil_contato_cache')
        .eq('id', Number(id))
        .eq('company_id', company_id)
        .maybeSingle()

      const nomeAtual = convRow?.nome_contato_cache ? String(convRow.nome_contato_cache).trim() : null
      const fotoAtual = convRow?.foto_perfil_contato_cache ? String(convRow.foto_perfil_contato_cache).trim() : null

      const fields = {}
      if (data.nome && !isBadName(data.nome)) {
        const { name: bestNome, decision } = chooseBestName(nomeAtual, data.nome, 'syncUltramsg', { fromMe: false, company_id })
        if (bestNome && decision === 'updated') fields.nome_contato_cache = bestNome
      }
      if (data.foto && isValidPhotoUrl(data.foto) && !fotoAtual) fields.foto_perfil_contato_cache = data.foto.trim()

      if (Object.keys(fields).length > 0) {
        await supabase.from('conversas').update(fields).eq('id', Number(id)).eq('company_id', company_id)
        updates.push({ id: Number(id), nome: fields.nome_contato_cache || data.nome, foto: fields.foto_perfil_contato_cache || data.foto })
      } else {
        updates.push({ id: Number(id), nome: data.nome, foto: data.foto })
      }
    }
  } else {
    for (const [id, data] of results) {
      updates.push({ id: Number(id), nome: data.nome, foto: data.foto })
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
