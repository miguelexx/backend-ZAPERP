/**
 * Enriquecimento da CITAÇÃO (mensagem citada / reply_meta) na hora de montar o detalhe da conversa.
 *
 * Problema que resolve: quando a mensagem chega pelo webhook (UltraMSG/Whapi) o `reply_meta.snippet`
 * é resolvido best-effort a partir do payload. Se a mensagem citada ainda não estava no banco naquele
 * instante (corrida com o ACK/reconciliação, ou id de citação que só casa depois) o snippet cai no
 * placeholder genérico "Mensagem" e fica gravado assim para sempre — foi o que apareceu no print
 * (bloco "Nome / Mensagem" acima da bolha).
 *
 * No READ-TIME a mensagem citada quase sempre já está no banco (é uma mensagem anterior da MESMA
 * conversa). Aqui resolvemos o trecho real: primeiro entre as mensagens já carregadas na página
 * (custo zero) e, para o resto, uma única consulta `.in()` na conversa. Conserta retroativamente as
 * citações já gravadas como "Mensagem" e cobre os dois providers, sem depender do formato do payload.
 *
 * É aditivo e conservador: só toca `reply_meta` cujo `snippet` esteja vazio ou seja exatamente o
 * placeholder "Mensagem", e nunca sobrescreve citações especiais (enquete/pix/produto/catálogo/triagem).
 */

const supabaseDefault = require('../../../config/supabase')
const { applyWhatsappInstanceFilterOrLegacy } = require('../../../controllers/webhookInbound/whatsappIdLookup')

// Chaves que indicam um reply_meta "especial" (não é uma citação de texto do usuário).
const SPECIAL_REPLY_META_KEYS = ['poll', 'pix', 'product', 'catalog', 'whapi_triage']

// Evita usar nome de arquivo cru (ex.: "IMG-123.jpg") como preview de mídia.
function looksLikeBareFilename(value) {
  const t = String(value || '').trim()
  if (!t || /\s/.test(t)) return false
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif|mp4|mov|webm|ogg|opus|mp3|m4a|aac|wav|pdf|docx?|xlsx?|pptx?|txt|zip|rar)$/i.test(t)
}

function clip(text) {
  const t = String(text || '')
  return t.length > 180 ? `${t.slice(0, 180)}…` : t
}

/** true se este reply_meta é uma citação comum cujo snippet precisa ser resolvido. */
function replyMetaNeedsSnippet(rm) {
  if (!rm || typeof rm !== 'object') return false
  if (rm.replyToId == null || String(rm.replyToId).trim() === '') return false
  if (SPECIAL_REPLY_META_KEYS.some((k) => rm[k])) return false
  const sn = String(rm.snippet || '').trim().toLowerCase()
  return sn === '' || sn === 'mensagem'
}

/** Trecho de preview a partir da linha da mensagem citada (texto real ou rótulo por tipo de mídia). */
function snippetFromQuotedRow(row) {
  if (!row || typeof row !== 'object') return null
  const tipo = String(row.tipo || '').toLowerCase()
  const texto = String(row.texto || '').trim()
  const hasRealText = texto && !looksLikeBareFilename(texto)

  if (tipo === 'audio' || tipo === 'voice' || tipo === 'ptt') return '(áudio)'
  if (tipo === 'imagem') return hasRealText ? clip(texto) : 'Foto'
  if (tipo === 'video') return hasRealText ? clip(texto) : '(vídeo)'
  if (tipo === 'sticker') return 'Figurinha'
  if (tipo === 'arquivo' || tipo === 'document') {
    const nome = String(row.nome_arquivo || '').trim()
    if (nome) return clip(nome)
    return hasRealText ? clip(texto) : '(arquivo)'
  }
  if (tipo === 'location') return hasRealText ? clip(texto) : '(localização)'
  if (hasRealText) return clip(texto)
  // Texto vazio e sem tipo útil → não temos como melhorar; mantém o que já existe.
  return null
}

/** Nome de quem enviou a mensagem citada. */
function nameFromQuotedRow(row) {
  if (!row) return null
  if (row.direcao === 'out') return 'Você'
  const rn = String(row.remetente_nome || '').trim()
  return rn || null
}

/**
 * Enriquece `mensagens` resolvendo o snippet/nome real das citações genéricas ("Mensagem"/vazias).
 * Best-effort: nunca lança e devolve o array (novo, se houve mudança).
 */
async function enrichReplyMetaSnippets(
  supabaseClient,
  { company_id, conversa_id, whatsapp_instance_id = null } = {},
  mensagens
) {
  if (!Array.isArray(mensagens) || mensagens.length === 0) return mensagens
  const targets = mensagens.filter((m) => replyMetaNeedsSnippet(m?.reply_meta))
  if (targets.length === 0) return mensagens

  const supabase = supabaseClient || supabaseDefault

  // Índice das mensagens já carregadas por whatsapp_id (resolução de custo zero).
  const byWaId = new Map()
  for (const m of mensagens) {
    const wa = m?.whatsapp_id != null ? String(m.whatsapp_id).trim() : ''
    if (wa && !byWaId.has(wa)) byWaId.set(wa, m)
  }

  // IDs citados que não estão na página → resolver com 1 consulta.
  const wantedIds = new Set()
  for (const m of targets) {
    const rid = String(m.reply_meta.replyToId).trim()
    if (rid && !byWaId.has(rid)) wantedIds.add(rid)
  }

  const dbByWaId = new Map()
  if (wantedIds.size > 0 && company_id && conversa_id) {
    try {
      let q = supabase
        .from('mensagens')
        .select('whatsapp_id, texto, tipo, direcao, remetente_nome, nome_arquivo')
        .eq('company_id', company_id)
        .eq('conversa_id', conversa_id)
      q = applyWhatsappInstanceFilterOrLegacy(q, whatsapp_instance_id)
      // Cap defensivo: evita URL gigante no PostgREST (ver 414 do disparo); citações por página são poucas.
      const { data } = await q.in('whatsapp_id', Array.from(wantedIds).slice(0, 200))
      for (const row of data || []) {
        const wa = row?.whatsapp_id != null ? String(row.whatsapp_id).trim() : ''
        if (wa && !dbByWaId.has(wa)) dbByWaId.set(wa, row)
      }
    } catch (_) {
      // best-effort: segue sem a resolução via banco
    }
  }

  const resolveRow = (rid) => byWaId.get(rid) || dbByWaId.get(rid) || null

  let changed = false
  const out = mensagens.map((m) => {
    if (!replyMetaNeedsSnippet(m?.reply_meta)) return m
    const rid = String(m.reply_meta.replyToId).trim()
    const row = resolveRow(rid)
    if (!row) return m
    const snippet = snippetFromQuotedRow(row)
    if (!snippet) return m

    const nextMeta = { ...m.reply_meta, snippet }
    // "Contato"/"Mensagem"/vazio são placeholders genéricos (o front troca "Contato" por peerName):
    // sobrescrever com o nome real é uma melhora — sobretudo "Você" quando a citada é nossa.
    const curName = String(m.reply_meta.name || '').trim().toLowerCase()
    if (!curName || curName === 'mensagem' || curName === 'contato') {
      const nome = nameFromQuotedRow(row)
      if (nome) nextMeta.name = nome
    }
    changed = true
    return { ...m, reply_meta: nextMeta }
  })

  return changed ? out : mensagens
}

module.exports = {
  enrichReplyMetaSnippets,
  replyMetaNeedsSnippet,
  snippetFromQuotedRow,
  nameFromQuotedRow,
}
