'use strict'

const { STOPWORDS_EXTRAIR } = require('./lexicos')

/** Normaliza termo para busca (remove acentos, lowercase, trim). */
function normalizeSearchTerm(s) {
  if (!s || typeof s !== 'string') return ''
  return String(s)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

/** Remove caracteres que quebram padrões ILIKE no PostgREST e limita tamanho. */
function sanitizeIlikeTerm(s) {
  if (!s || typeof s !== 'string') return ''
  return String(s).trim().slice(0, 64).replace(/[%_\\,().:*]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Exclui conversas de grupo (tipo ou JID @g.us); mantém tipo NULL (legado). */
function filtrarConversasIndividuais(rows) {
  return (rows || []).filter((c) => {
    const t = String(c.tipo || '').toLowerCase()
    if (t === 'grupo' || t === 'group') return false
    if (String(c.telefone || '').includes('@g.us')) return false
    return true
  })
}

/** Expande termos com variantes sem acento + dedupe + limite para OR no PostgREST. */
function expandTermosForSearch(rawList, max = 22) {
  const out = []
  const seen = new Set()
  for (const raw of rawList || []) {
    const base = sanitizeIlikeTerm(String(raw))
    if (base.length < 2) continue
    const variants = [base, ...buildPortugueseSearchVariants(base)]
    const n = normalizeSearchTerm(base)
    if (n && n !== base) variants.push(n)
    for (const v of variants) {
      const k = normalizeSearchTerm(v)
      if (!seen.has(k) && v.length >= 2) {
        seen.add(k)
        out.push(v)
      }
      if (out.length >= max) return out
    }
  }
  return out
}

function buildPortugueseSearchVariants(term) {
  const base = String(term || '').trim()
  const n = normalizeSearchTerm(base)
  const variants = []
  const add = (v) => {
    const s = sanitizeIlikeTerm(v)
    if (s && s.length >= 2) variants.push(s)
  }
  if (base.toLowerCase().endsWith('ões') && base.length > 4) add(`${base.slice(0, -3)}ão`)
  if (base.toLowerCase().endsWith('ães') && base.length > 4) add(`${base.slice(0, -3)}ão`)
  if (n.endsWith('oes') && n.length > 4) add(`${n.slice(0, -3)}ao`)
  if (n.endsWith('aes') && n.length > 4) add(`${n.slice(0, -3)}ao`)
  if (n.endsWith('is') && n.length > 4) add(`${n.slice(0, -2)}il`)
  if (n.endsWith('s') && n.length > 4) add(n.slice(0, -1))
  if (!n.endsWith('s') && n.length >= 4) add(`${n}s`)
  return variants
}

/** Pós-filtro: remove matches fracos para termos muito curtos (ex.: "nf" só como palavra). */
function textoCasaTermoRobusto(texto, term) {
  if (!texto || !term) return false
  const t = normalizeSearchTerm(String(texto))
  const termNorm = normalizeSearchTerm(String(term).trim())
  if (termNorm.length < 2) return false
  const curtosPalavra = new Set(['nf', 'nfe', 'pix'])
  if (curtosPalavra.has(termNorm)) {
    const re = new RegExp(`(^|[^a-z0-9])${termNorm}([^a-z0-9]|$)`)
    return re.test(t)
  }
  if (termNorm.length <= 3) return t.includes(termNorm)
  return t.includes(termNorm)
}

function evidenciasPassamFiltroRobusto(evidencias, termosUsados) {
  const terms = (termosUsados || []).filter(Boolean)
  if (!terms.length) return evidencias || []
  return (evidencias || []).filter((ev) => {
    const tx = ev.texto_preview || ev.content_preview || ''
    return terms.some((term) => textoCasaTermoRobusto(tx, term))
  })
}

/** Extrai palavras-chave da pergunta quando o classificador não enviou termos (chat interno). */
function extrairTermosCandidatosDaPergunta(question) {
  if (!question || typeof question !== 'string') return []
  const n = normalizeSearchTerm(question).replace(/[^\p{L}\p{N}\s]/gu, ' ')
  const parts = n.split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS_EXTRAIR.has(w))
  return [...new Set(parts)].slice(0, 6)
}

function splitTermosLivres(raw) {
  const cleaned = String(raw || '')
    .replace(/["'“”‘’]/g, ' ')
    .replace(/\b(por exemplo|por favor|pfv|pfvr)\b/gi, ' ')
    .replace(/\b(hoje|ontem|nesta semana|esta semana|neste mes|este mes|ultimos?|ultimas?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return []
  const chunks = cleaned
    .split(/\s+(?:e|ou)\s+|[,;]+/i)
    .map((s) => s.trim())
    .filter(Boolean)
  return chunks
    .map((s) => s.replace(/^(de|do|da|dos|das|sobre|o|a|os|as|um|uma)\s+/i, '').trim())
    .filter((s) => s.length >= 2)
    .slice(0, 8)
}

function extrairTermosBuscaLivre(question) {
  const q = String(question || '').trim()
  if (!q) return []
  const patterns = [
    /\b(?:falando|falam|fala|falaram|menciona(?:m)?|cita(?:m|ram)?|citou|trata(?:m)?|coment(?:a|am|aram))\s+(?:de|do|da|dos|das|sobre)?\s*([^?!.;]{2,90})/i,
    /\b(?:conversas?|mensagens?|clientes?)\s+(?:sobre|com|de|do|da|dos|das)\s*([^?!.;]{2,90})/i,
    /\b(?:buscar|procure|procurar|localizar|ache|encontre|encontrar)\s+(?:conversas?|mensagens?)?\s*(?:sobre|com|de|do|da|dos|das)?\s*([^?!.;]{2,90})/i,
  ]
  for (const p of patterns) {
    const m = q.match(p)
    const terms = splitTermosLivres(m?.[1])
    if (terms.length) return terms
  }
  return extrairTermosCandidatosDaPergunta(question)
}

module.exports = {
  normalizeSearchTerm,
  sanitizeIlikeTerm,
  filtrarConversasIndividuais,
  expandTermosForSearch,
  buildPortugueseSearchVariants,
  textoCasaTermoRobusto,
  evidenciasPassamFiltroRobusto,
  extrairTermosCandidatosDaPergunta,
  splitTermosLivres,
  extrairTermosBuscaLivre,
}
