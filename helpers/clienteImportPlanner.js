/**
 * Planejador de importação de clientes por planilha (.xlsx).
 *
 * Módulo PURO (sem I/O, sem Supabase): recebe as linhas já extraídas da planilha
 * e produz um "plano" de importação com dedup por telefone normalizado, detecção
 * de conflitos (mesmo telefone com nomes diferentes) e lista de linhas ignoradas.
 *
 * Reutiliza a normalização oficial de telefone do ZapERP (phoneHelper) para que os
 * números fiquem exatamente no mesmo padrão usado em todo o sistema.
 *
 * Colunas reconhecidas:
 *  - Nome / Nome completo / Nome do(a) Aluno(a) → nome do cliente
 *  - Telefone / Celular / WhatsApp / Fone / Celular do(a) Responsável Pedagógico
 *  - Tags / Tag / Série (Ano)
 */

const { normalizePhoneBR, phoneKeyBR } = require('./phoneHelper')

/** Máximo de linhas de dados aceitas por importação (proteção contra arquivo gigante). */
const MAX_DATA_ROWS = 20000

function normalizeHeader(value) {
  const s = cellToString(value)
  if (!s) return ''
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Converte um valor de célula (exceljs / SheetJS) em string simples.
 * Não usar para telefone — use cellToPhoneString (evita notação científica).
 */
function cellToString(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    if (Number.isInteger(value)) return String(value)
    const rounded = Math.round(value)
    if (Math.abs(value - rounded) < 1e-6) return String(rounded)
    return String(value).trim()
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return value.richText.map((r) => (r && r.text) || '').join('').trim()
    }
    if (typeof value.text === 'string') return value.text.trim()
    if (value.result != null) return cellToString(value.result)
    if (value.v != null) return cellToString(value.v)
    if (typeof value.w === 'string' && value.w.trim()) return value.w.trim()
    if (typeof value.toString === 'function') {
      const s = value.toString()
      if (s && s !== '[object Object]') return s.trim()
    }
    return ''
  }
  return String(value).trim()
}

/**
 * Expande notação científica em dígitos, sem Number() (evita perda de precisão).
 * Ex.: "5.534999514579E+12" → "5534999514579"
 */
function expandScientificDigits(raw) {
  const s = String(raw || '').trim().replace(',', '.')
  const m = /^([+-])?(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s)
  if (!m) return null
  const sign = m[1] === '-' ? '-' : ''
  const intPart = m[2]
  const fracPart = m[3] || ''
  const exp = Number.parseInt(m[4], 10)
  if (!Number.isFinite(exp)) return null
  const digits = intPart + fracPart
  const fracLen = fracPart.length
  const shift = exp - fracLen
  let out
  if (shift >= 0) {
    out = digits + '0'.repeat(shift)
  } else {
    const split = digits.length + shift
    if (split <= 0) return null
    out = digits.slice(0, split)
  }
  out = out.replace(/^0+/, '') || '0'
  return sign === '-' ? null : out
}

/**
 * Telefone como texto estável. Nunca converte a string de dígitos com Number().
 */
function cellToPhoneString(value) {
  if (value == null || value === '') return ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.round(value)
    if (Math.abs(value - rounded) < 1e-4) return String(rounded)
    const sci = expandScientificDigits(String(value))
    if (sci) return sci
    return String(value)
  }
  if (typeof value === 'object') {
    if (typeof value.v === 'number') return cellToPhoneString(value.v)
    if (value.result != null) return cellToPhoneString(value.result)
    if (typeof value.w === 'string' && /e[+-]?\d+/i.test(value.w)) {
      const sci = expandScientificDigits(value.w)
      if (sci) return sci
    }
    if (typeof value.text === 'string') return cellToPhoneString(value.text)
    return cellToPhoneString(cellToString(value))
  }
  const s = String(value).trim()
  if (!s) return ''
  if (/e[+-]?\d+/i.test(s)) {
    const sci = expandScientificDigits(s)
    if (sci) return sci
  }
  return s
}

const COLUMN_ALIASES = {
  nome: [
    'nome',
    'nome completo',
    'nome do a aluno a',
    'nome do aluno a',
    'nome do a aluno',
    'nome do aluno',
    'nome da aluna',
    'nome do a aluno a nome completo',
    'aluno',
    'aluno a',
    'nome completo do aluno',
    'nome do estudante',
  ],
  telefone: [
    'telefone',
    'celular',
    'whatsapp',
    'fone',
    'tel',
    'telefone whatsapp',
    'celular whatsapp',
    'celular do a responsavel pedagogico',
    'celular do responsavel pedagogico',
    'celular da responsavel pedagogico',
    'telefone do a responsavel pedagogico',
    'telefone do responsavel pedagogico',
    'whatsapp do responsavel pedagogico',
    'celular responsavel pedagogico',
    'celular do a responsavel',
  ],
  serie: [
    'tag',
    'tags',
    'serie',
    'serie ano',
    'ano serie',
    'serie ano turma',
    'serie do aluno',
  ],
}

function headerBloqueadoParaCampo(field, h) {
  if (!h) return true
  if (field === 'nome') {
    if (/(telefone|celular|whatsapp|fone|tag|serie|email)/.test(h)) return true
    if (/(mae|pai|responsavel|tutor)/.test(h) && !/(aluno|estudante)/.test(h)) return true
  }
  if (field === 'telefone') {
    if (/(email|serie|tag)/.test(h) && !/(telefone|celular|whatsapp|fone|tel)/.test(h)) return true
    if (/^nome/.test(h) && !/(telefone|celular|whatsapp|fone)/.test(h)) return true
  }
  if (field === 'serie') {
    if (/(telefone|celular|whatsapp|fone|email)/.test(h)) return true
    if (/^nome/.test(h) && !/(serie|tag)/.test(h)) return true
  }
  return false
}

function scoreHeader(field, h) {
  if (!h || headerBloqueadoParaCampo(field, h)) return 0
  const aliases = COLUMN_ALIASES[field] || []
  if (aliases.includes(h)) return 100
  let best = 0
  for (const alias of aliases) {
    if (alias.length >= 8 && h.startsWith(`${alias} `)) best = Math.max(best, 80)
    if (alias.length >= 16 && h.includes(alias)) best = Math.max(best, 60)
  }
  return best
}

/**
 * Detecta índices de nome, telefone e série.
 * Casamento por alias exato primeiro; parcial só com frases longas.
 * Coluna ambígua (dois campos com o mesmo score) é ignorada.
 */
function detectColumns(headerRow) {
  const headers = (Array.isArray(headerRow) ? headerRow : []).map((h) => cellToString(h))
  const normalized = headers.map((h) => normalizeHeader(h))
  const byField = { nome: [], telefone: [], serie: [] }

  for (let i = 0; i < normalized.length; i++) {
    const h = normalized[i]
    if (!h) continue
    const hits = []
    for (const field of ['nome', 'telefone', 'serie']) {
      const score = scoreHeader(field, h)
      if (score > 0) hits.push({ field, score })
    }
    if (!hits.length) continue
    hits.sort((a, b) => b.score - a.score)
    if (hits.length > 1 && hits[0].score === hits[1].score) continue
    byField[hits[0].field].push({ idx: i, score: hits[0].score })
  }

  const pick = (field) => {
    const list = byField[field].slice().sort((a, b) => b.score - a.score || a.idx - b.idx)
    if (!list.length) return null
    if (list.length > 1 && list[0].score === list[1].score) return null
    return list[0].idx
  }

  return {
    nome: pick('nome'),
    telefone: pick('telefone'),
    serie: pick('serie'),
    headers,
  }
}

function valueAt(row, index) {
  if (index == null || index < 0) return ''
  if (!Array.isArray(row)) return ''
  return cellToString(row[index])
}

function phoneAt(row, index) {
  if (index == null || index < 0) return ''
  if (!Array.isArray(row)) return ''
  return cellToPhoneString(row[index])
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function nomesIguais(a, b) {
  return cleanText(a).toLowerCase() === cleanText(b).toLowerCase()
}

/**
 * @param {Array<Array<*>>} dataRows
 * @param {{ nome:number|null, telefone:number|null, serie:number|null }} mapping
 * @param {{ nomesPrincipais?: Record<string,string> }} [opts]
 */
function planImport(dataRows, mapping, opts = {}) {
  const rows = Array.isArray(dataRows) ? dataRows : []
  const map = mapping || {}
  const nomesPrincipais = opts.nomesPrincipais && typeof opts.nomesPrincipais === 'object'
    ? opts.nomesPrincipais
    : {}

  const ignored = []
  const byKey = new Map()

  let ordinal = 0
  rows.forEach((row, i) => {
    const linha = i + 2
    const nome = cleanText(valueAt(row, map.nome))
    const telefoneRaw = cleanText(phoneAt(row, map.telefone))
    const serie = cleanText(valueAt(row, map.serie))

    if (!nome && !telefoneRaw && !serie) {
      ignored.push({ linha, nome, telefone: telefoneRaw, serie, motivo: 'Linha vazia' })
      return
    }

    if (!nome) {
      ignored.push({ linha, nome, telefone: telefoneRaw, serie, motivo: 'Sem nome' })
      return
    }

    const telefoneNormalizado = normalizePhoneBR(telefoneRaw)
    if (!telefoneNormalizado) {
      ignored.push({
        linha,
        nome,
        telefone: telefoneRaw,
        serie,
        motivo: telefoneRaw ? 'Telefone inválido' : 'Sem telefone',
      })
      return
    }

    const key = phoneKeyBR(telefoneNormalizado) || telefoneNormalizado

    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        _ordinal: ordinal++,
        telefone: telefoneNormalizado,
        telefoneNormalizado,
        phoneKey: key,
        nome,
        tags: [],
        nomesConflitantes: [],
        linhas: [],
        alunos: [],
      }
      byKey.set(key, entry)
    }

    entry.linhas.push(linha)
    entry.alunos.push({ nome, serie: serie || null, linha })

    if (nome && !nomesIguais(nome, entry.nome) && !entry.nomesConflitantes.some((n) => nomesIguais(n, nome))) {
      entry.nomesConflitantes.push(nome)
    }

    if (serie && !entry.tags.some((t) => t.toLowerCase() === serie.toLowerCase())) {
      entry.tags.push(serie)
    }
  })

  const entries = Array.from(byKey.values()).sort((a, b) => a._ordinal - b._ordinal)

  for (const entry of entries) {
    const escolhido = nomesPrincipais[entry.phoneKey] || nomesPrincipais[entry.telefoneNormalizado]
    if (escolhido && cleanText(escolhido)) {
      const todos = [entry.nome, ...entry.nomesConflitantes]
      const match = todos.find((n) => nomesIguais(n, escolhido))
      if (match) {
        entry.nomesConflitantes = todos.filter((n) => !nomesIguais(n, match))
        entry.nome = match
      }
    }
    delete entry._ordinal
  }

  const conflicts = entries
    .filter((e) => e.nomesConflitantes.length > 0 || (e.alunos && e.alunos.length > 1 && e.nomesConflitantes.length > 0))
    .map((e) => ({
      telefone: e.telefoneNormalizado,
      phoneKey: e.phoneKey,
      nome: e.nome,
      nomesConflitantes: [e.nome, ...e.nomesConflitantes],
      tags: e.tags.slice(),
      linhas: e.linhas.slice(),
      alunos: (e.alunos || []).map((a) => ({ ...a })),
      quantidade: (e.alunos || []).length,
    }))

  return {
    entries,
    ignored,
    conflicts,
    stats: {
      totalLinhas: rows.length,
      validas: entries.reduce((acc, e) => acc + e.linhas.length, 0),
      ignoradas: ignored.length,
      telefonesUnicos: entries.length,
      conflitos: conflicts.length,
      telefonesCompartilhados: conflicts.length,
    },
  }
}

module.exports = {
  MAX_DATA_ROWS,
  normalizeHeader,
  cellToString,
  cellToPhoneString,
  expandScientificDigits,
  detectColumns,
  planImport,
  nomesIguais,
  cleanText,
  COLUMN_ALIASES,
}
