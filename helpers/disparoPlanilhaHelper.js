/**
 * Parser de planilhas para o módulo Disparo de Mensagens.
 * Suporta .xlsx, .xls (ExcelJS) e .csv (parser nativo).
 * Não executa fórmulas: usa apenas valores resultantes das células.
 */

const ExcelJS = require('exceljs')
const { validarTelefoneDisparo } = require('./disparoPhoneHelper')

/** Máximo de linhas aceitas por importação */
const MAX_ROWS_DISPARO = 50000

/** Limite de amostra retornada no preview */
const PREVIEW_SAMPLE = 100

// ─── Auto-detecção de colunas ─────────────────────────────────────────────────

const NOME_ALIASES = [
  'nome', 'name', 'cliente', 'clientes', 'responsavel', 'responsável',
  'contato', 'contatos', 'aluno', 'aluna', 'destinatario', 'destinatário',
]
const FONE_ALIASES = [
  'telefone', 'celular', 'whatsapp', 'fone', 'phone', 'tel',
  'numero', 'número', 'cell', 'mobile', 'celular whatsapp',
]

function normalizeHeader(h) {
  return String(h ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function detectMappingAuto(headers) {
  const normalized = headers.map(normalizeHeader)
  const findFirst = (aliases) => {
    // 1) exact match
    for (const alias of aliases) {
      const idx = normalized.findIndex(h => h === alias)
      if (idx >= 0) return idx
    }
    // 2) starts-with or contains
    for (const alias of aliases) {
      const idx = normalized.findIndex(h => h && (h.startsWith(alias) || h.includes(alias)))
      if (idx >= 0) return idx
    }
    return null
  }
  return {
    nome: findFirst(NOME_ALIASES),
    telefone: findFirst(FONE_ALIASES),
  }
}

// ─── Conversão de célula ExcelJS → string ────────────────────────────────────

function cellToStr(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v).trim()
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(r => r?.text ?? '').join('').trim()
    if (typeof v.text === 'string') return v.text.trim()
    // fórmula: usa resultado, nunca a fórmula em si
    if (v.result != null) return cellToStr(v.result)
    return ''
  }
  return String(v).trim()
}

// ─── Parser CSV ───────────────────────────────────────────────────────────────

function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = text.split('\n')
  const rows = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    rows.push(parseCsvLine(trimmed))
  }
  return rows
}

function parseCsvLine(line) {
  const result = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuotes = !inQuotes
    } else if ((ch === ',' || ch === ';' || ch === '\t') && !inQuotes) {
      result.push(cur.trim()); cur = ''
    } else {
      cur += ch
    }
  }
  result.push(cur.trim())
  return result
}

// ─── Parser XLSX / XLS ────────────────────────────────────────────────────────

async function parseXlsxBuffer(buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const sheets = wb.worksheets.map(ws => ({
    id: ws.id,
    name: ws.name,
    rowCount: (ws.actualRowCount || ws.rowCount || 0) - 1, // -1 pelo header
  }))
  return { workbook: wb, sheets }
}

function extractSheetRows(workbook, sheetId) {
  const ws = sheetId != null
    ? workbook.worksheets.find(s => s.id === sheetId) ?? workbook.worksheets[0]
    : workbook.worksheets[0]
  if (!ws) throw Object.assign(new Error('Aba não encontrada.'), { status: 400, code: 'ABA_NAO_ENCONTRADA' })

  const toArr = (row) => {
    const vals = Array.isArray(row?.values) ? row.values : []
    const out = []
    for (let c = 1; c < vals.length; c++) out.push(cellToStr(vals[c]))
    return out
  }

  const headers = toArr(ws.getRow(1))
  const dataRows = []
  const last = ws.actualRowCount || ws.rowCount || 0
  for (let r = 2; r <= last; r++) {
    const row = ws.getRow(r)
    if (!row?.hasValues) continue
    dataRows.push(toArr(row))
    if (dataRows.length >= MAX_ROWS_DISPARO) break
  }
  return { headers, dataRows }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Faz o parse inicial do arquivo e retorna estrutura para preview.
 * @param {Buffer} buffer
 * @param {string} extension - 'xlsx', 'xls' ou 'csv'
 * @param {number|null} sheetId - ID da aba (para xlsx/xls; null = primeira)
 */
async function parseArquivo(buffer, extension, sheetId = null) {
  const ext = String(extension ?? '').toLowerCase().replace(/^\./, '')

  if (ext === 'csv') {
    const rows = parseCsvBuffer(buffer)
    if (rows.length === 0) throw Object.assign(new Error('Arquivo CSV vazio.'), { status: 400, code: 'ARQUIVO_VAZIO' })
    const headers = rows[0]
    const dataRows = rows.slice(1).filter(r => r.some(c => c !== '')).slice(0, MAX_ROWS_DISPARO)
    return {
      sheets: [{ id: 1, name: 'Planilha', rowCount: dataRows.length }],
      sheetIdAtual: 1,
      headers,
      dataRows,
      _workbook: null,
    }
  }

  if (ext === 'xlsx' || ext === 'xls') {
    const { workbook, sheets } = await parseXlsxBuffer(buffer)
    if (!sheets.length) throw Object.assign(new Error('Planilha sem abas.'), { status: 400, code: 'ARQUIVO_VAZIO' })
    const targetId = sheetId ?? sheets[0].id
    const { headers, dataRows } = extractSheetRows(workbook, targetId)
    return {
      sheets,
      sheetIdAtual: targetId,
      headers,
      dataRows,
      _workbook: workbook,
    }
  }

  throw Object.assign(
    new Error(`Formato '${ext}' não suportado. Use .xlsx, .xls ou .csv.`),
    { status: 400, code: 'FORMATO_INVALIDO' },
  )
}

/**
 * Monta a chave canônica de variável a partir do nome da coluna.
 * Ex: "Vencimento (dd/mm)" → "vencimento_dd_mm"
 */
function toVariavelKey(colNome) {
  return String(colNome ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Processa as linhas com o mapeamento e retorna plano de importação.
 * @param {string[]} headers
 * @param {Array<string[]>} dataRows
 * @param {{ nome: number|null, telefone: number|null }} mapping
 * @param {Set<string>} telefonesJaNaCampanha - telefones normalizados já cadastrados
 */
function planejarImportacao(headers, dataRows, mapping, telefonesJaNaCampanha = new Set()) {
  if (mapping.nome == null) throw Object.assign(new Error('Coluna de nome não mapeada.'), { status: 400 })
  if (mapping.telefone == null) throw Object.assign(new Error('Coluna de telefone não mapeada.'), { status: 400 })

  const mapNome = mapping.nome
  const mapFone = mapping.telefone

  // Colunas extras: todas que não são nome nem telefone e têm cabeçalho
  const colunasExtras = headers
    .map((h, idx) => ({ idx, nome: h, chave: toVariavelKey(h) }))
    .filter(c => c.idx !== mapNome && c.idx !== mapFone && c.chave)

  const valid = []
  const invalid = []
  const telefonesVistos = new Set() // dedup dentro da planilha

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const linha = i + 2 // +1 header, +1 base-1
    const nome = String(row[mapNome] ?? '').trim()
    const foneRaw = String(row[mapFone] ?? '').trim()

    // Linha completamente vazia (nome e fone): pula silenciosamente
    if (!nome && !foneRaw) continue

    if (!nome) {
      invalid.push({ linha, nome: '', telefone: foneRaw, motivo: 'Nome ausente' })
      continue
    }

    const { original, normalizado, valido, motivo } = validarTelefoneDisparo(foneRaw)
    if (!valido) {
      invalid.push({ linha, nome, telefone: original, motivo })
      continue
    }

    if (telefonesVistos.has(normalizado)) {
      invalid.push({ linha, nome, telefone: original, motivo: 'Número duplicado na planilha' })
      continue
    }
    telefonesVistos.add(normalizado)

    if (telefonesJaNaCampanha.has(normalizado)) {
      invalid.push({ linha, nome, telefone: original, motivo: 'Número já incluído na campanha' })
      continue
    }

    const variaveis = {}
    for (const col of colunasExtras) {
      const val = String(row[col.idx] ?? '').trim()
      if (val) variaveis[col.chave] = val
    }

    valid.push({
      linha,
      nome,
      telefone_original: original,
      telefone_normalizado: normalizado,
      variaveis: Object.keys(variaveis).length > 0 ? variaveis : null,
    })
  }

  return {
    valid,
    invalid,
    colunasExtras,
    stats: {
      totalLinhas: dataRows.length,
      validas: valid.length,
      invalidas: invalid.length,
    },
  }
}

module.exports = {
  parseArquivo,
  planejarImportacao,
  detectMappingAuto,
  cellToStr,
  normalizeHeader,
  toVariavelKey,
  MAX_ROWS_DISPARO,
  PREVIEW_SAMPLE,
}
