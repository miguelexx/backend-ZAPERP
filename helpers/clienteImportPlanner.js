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
 * Colunas usadas (modelo da secretaria):
 *  - "Nome do(a) Aluno(a)"                 → nome do cliente
 *  - "Celular do(a) Responsável Pedagógico"→ telefone/WhatsApp
 *  - "Série (Ano)"                         → tag (série)
 * Todas as demais colunas são ignoradas.
 */

const { normalizePhoneBR, phoneKeyBR } = require('./phoneHelper')

/** Máximo de linhas de dados aceitas por importação (proteção contra arquivo gigante). */
const MAX_DATA_ROWS = 20000

/**
 * Normaliza um cabeçalho para casamento tolerante:
 * minúsculas, sem acentos, sem pontuação, espaços colapsados.
 * @param {*} value
 * @returns {string}
 */
function normalizeHeader(value) {
  const s = cellToString(value)
  if (!s) return ''
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos (marcas diacríticas combinantes)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ') // pontuação/símbolos → espaço
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Converte um valor de célula (exceljs pode devolver objeto: richText, hyperlink,
 * fórmula, data) em string simples.
 * @param {*} value
 * @returns {string}
 */
function cellToString(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value).trim()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    // exceljs: rich text
    if (Array.isArray(value.richText)) {
      return value.richText.map((r) => (r && r.text) || '').join('').trim()
    }
    // exceljs: hyperlink → { text, hyperlink }
    if (typeof value.text === 'string') return value.text.trim()
    // exceljs: fórmula → { formula, result }
    if (value.result != null) return cellToString(value.result)
    if (typeof value.toString === 'function') {
      const s = value.toString()
      if (s && s !== '[object Object]') return s.trim()
    }
    return ''
  }
  return String(value).trim()
}

/**
 * Aliases de cabeçalho por campo (já normalizados por normalizeHeader).
 * Cobrem variações comuns/erros de digitação do modelo.
 */
const COLUMN_ALIASES = {
  nome: [
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
    'serie ano',
    'serie',
    'ano serie',
    'serie ano turma',
    'ano',
    'serie do aluno',
  ],
}

/**
 * Detecta os índices das colunas de nome, telefone e série a partir dos cabeçalhos.
 * Faz casamento exato por alias e, se falhar, casamento parcial (contains).
 *
 * @param {Array<*>} headerRow - células da primeira linha (0-indexed)
 * @returns {{ nome: number|null, telefone: number|null, serie: number|null, headers: string[] }}
 */
function detectColumns(headerRow) {
  const headers = (Array.isArray(headerRow) ? headerRow : []).map((h) => cellToString(h))
  const normalized = headers.map((h) => normalizeHeader(h))

  const result = { nome: null, telefone: null, serie: null, headers }

  for (const field of ['nome', 'telefone', 'serie']) {
    const aliases = COLUMN_ALIASES[field]
    // 1) casamento exato
    let idx = normalized.findIndex((h) => h && aliases.includes(h))
    // 2) casamento parcial (cabeçalho contém um alias, ou alias contém o cabeçalho)
    if (idx === -1) {
      idx = normalized.findIndex(
        (h) => h && aliases.some((a) => h === a || h.includes(a) || a.includes(h))
      )
    }
    result[field] = idx === -1 ? null : idx
  }

  return result
}

/**
 * Extrai o valor textual de uma célula por índice de coluna (0-indexed).
 * @param {Array<*>} row
 * @param {number|null} index
 * @returns {string}
 */
function valueAt(row, index) {
  if (index == null || index < 0) return ''
  if (!Array.isArray(row)) return ''
  return cellToString(row[index])
}

/**
 * Colapsa espaços e apara um texto simples (nome/série).
 * @param {string} s
 * @returns {string}
 */
function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

/**
 * Monta o plano de importação a partir das linhas de dados.
 *
 * Regras:
 *  - Ignora linha sem nome ou sem telefone válido (BR).
 *  - Deduplica por telefone normalizado (phoneKeyBR) DENTRO do arquivo:
 *      → um único cliente por telefone; agrega todas as séries (tags) do mesmo número.
 *  - Conflito: mesmo telefone com nomes de aluno diferentes (ex.: irmãos com o mesmo
 *    responsável). Não sobrescreve nada — apenas sinaliza para conferência.
 *
 * @param {Array<Array<*>>} dataRows - linhas de dados (sem o cabeçalho), 0-indexed por coluna
 * @param {{ nome:number|null, telefone:number|null, serie:number|null }} mapping
 * @returns {{
 *   entries: Array<{ telefone:string, telefoneNormalizado:string, phoneKey:string, nome:string, tags:string[], nomesConflitantes:string[], linhas:number[] }>,
 *   ignored: Array<{ linha:number, nome:string, telefone:string, serie:string, motivo:string }>,
 *   conflicts: Array<{ telefone:string, nome:string, nomesConflitantes:string[], tags:string[], linhas:number[] }>,
 *   stats: { totalLinhas:number, validas:number, ignoradas:number, telefonesUnicos:number, conflitos:number }
 * }}
 */
function planImport(dataRows, mapping) {
  const rows = Array.isArray(dataRows) ? dataRows : []
  const map = mapping || {}

  const ignored = []
  // Mapa por chave de telefone → agregação do contato
  const byKey = new Map()

  let ordinal = 0 // preserva ordem de primeira aparição
  rows.forEach((row, i) => {
    const linha = i + 2 // +1 pelo header, +1 porque humanos contam a partir de 1
    const nome = cleanText(valueAt(row, map.nome))
    const telefoneRaw = cleanText(valueAt(row, map.telefone))
    const serie = cleanText(valueAt(row, map.serie))

    // Linha totalmente vazia nas 3 colunas → ignora em silêncio (não conta como erro relevante)
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
      }
      byKey.set(key, entry)
    }

    entry.linhas.push(linha)

    // Nome: mantém o primeiro; registra divergências para conferência (sem sobrescrever)
    if (nome && !nomesIguais(nome, entry.nome) && !entry.nomesConflitantes.some((n) => nomesIguais(n, nome))) {
      entry.nomesConflitantes.push(nome)
    }

    // Série → tag (agrega distintas, case-insensitive)
    if (serie && !entry.tags.some((t) => t.toLowerCase() === serie.toLowerCase())) {
      entry.tags.push(serie)
    }
  })

  const entries = Array.from(byKey.values()).sort((a, b) => a._ordinal - b._ordinal)
  entries.forEach((e) => delete e._ordinal)

  const conflicts = entries
    .filter((e) => e.nomesConflitantes.length > 0)
    .map((e) => ({
      telefone: e.telefoneNormalizado,
      nome: e.nome,
      nomesConflitantes: [e.nome, ...e.nomesConflitantes],
      tags: e.tags.slice(),
      linhas: e.linhas.slice(),
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
    },
  }
}

/** Compara nomes ignorando caixa e espaços redundantes. */
function nomesIguais(a, b) {
  return cleanText(a).toLowerCase() === cleanText(b).toLowerCase()
}

module.exports = {
  MAX_DATA_ROWS,
  normalizeHeader,
  cellToString,
  detectColumns,
  planImport,
  COLUMN_ALIASES,
}
