/**
 * Parser de planilhas para o módulo Disparo de Mensagens.
 * Suporte: .xlsx, .xls (SheetJS — leitura real de BIFF8) e .csv.
 * Validação de conteúdo pelos magic bytes — não confia apenas na extensão.
 * Não executa fórmulas: usa apenas os valores resultantes das células.
 */

const XLSX = require('xlsx')
const { validarTelefoneDisparo } = require('./disparoPhoneHelper')

/** Máximo de linhas aceitas por importação */
const MAX_ROWS_DISPARO = 50000

/** Limite de amostra retornada no preview */
const PREVIEW_SAMPLE = 100

// ─── Detecção de conteúdo real (magic bytes) ─────────────────────────────────

/**
 * Identifica o formato real do arquivo pelos magic bytes, sem depender da extensão.
 * @param {Buffer} buffer
 * @returns {'xlsx'|'xls'|'csv'|'unknown'}
 */
function detectarFormatoReal(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return 'unknown'
  // XLSX / ZIP: 50 4B 03 04
  if (buffer[0] === 0x50 && buffer[1] === 0x4B) return 'xlsx'
  // XLS / OLE2 Compound Document: D0 CF 11 E0
  if (buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0) return 'xls'
  // CSV / texto: verifica se começa com bytes imprimíveis ou BOM UTF-8
  const sample = buffer.slice(0, 512)
  // BOM UTF-8
  if (sample[0] === 0xEF && sample[1] === 0xBB && sample[2] === 0xBF) return 'csv'
  // Texto simples ASCII
  if (sample.every(b => (b >= 0x09 && b <= 0x0D) || (b >= 0x20 && b <= 0x7E) || b >= 0x80)) return 'csv'
  return 'unknown'
}

// ─── Auto-detecção de colunas ─────────────────────────────────────────────────

const NOME_ALIASES = [
  'nome', 'name', 'cliente', 'clientes', 'responsavel', 'responsável',
  'contato', 'contatos', 'aluno', 'aluna', 'destinatario', 'destinatário',
]
const FONE_ALIASES = [
  'telefone', 'celular', 'whatsapp', 'fone', 'phone', 'tel',
  'numero', 'número', 'cell', 'mobile',
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
    for (const alias of aliases) {
      const idx = normalized.findIndex(h => h === alias)
      if (idx >= 0) return idx
    }
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

// ─── Leitura via SheetJS ──────────────────────────────────────────────────────

/**
 * Converte um valor de célula SheetJS em string limpa.
 * Nunca executa fórmulas — usa apenas o valor resultante (v).
 */
function cellToStr(cell) {
  if (cell == null) return ''
  // SheetJS: { v: value, t: type, f?: formula, r?: rich, w?: formatted }
  if (typeof cell === 'object' && 'v' in cell) {
    const v = cell.v
    if (v == null) return ''
    if (typeof v === 'number') return String(v)
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (v instanceof Date) return v.toISOString()
    return String(v).trim()
  }
  if (typeof cell === 'string') return cell.trim()
  if (typeof cell === 'number') return String(cell)
  if (typeof cell === 'boolean') return cell ? 'true' : 'false'
  return String(cell).trim()
}

/**
 * Lê o workbook com SheetJS e retorna a lista de abas + função de extração de rows.
 * @param {Buffer} buffer
 * @param {'xlsx'|'xls'|'csv'} format
 */
function lerWorkbook(buffer, format) {
  let wb
  try {
    wb = XLSX.read(buffer, {
      type: 'buffer',
      // Não executa fórmulas; lê apenas valores
      cellFormula: false,
      cellHTML: false,
      cellText: false,
      raw: false,       // usa conversão de tipo nativa
    })
  } catch (err) {
    const msg = format === 'xls'
      ? 'Não foi possível ler o arquivo .xls. Certifique-se de que é uma planilha Excel 97-2003 válida.'
      : `Não foi possível ler o arquivo .${format}.`
    throw Object.assign(new Error(msg), { status: 400, code: 'ARQUIVO_INVALIDO' })
  }

  const sheets = wb.SheetNames.map((name, idx) => {
    const ws = wb.Sheets[name]
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1')
    const rowCount = Math.max(0, range.e.r) // rows de dados (excluindo header)
    return { id: idx, name, rowCount }
  })

  return { wb, sheets }
}

/**
 * Extrai headers e dataRows de uma aba do workbook.
 */
function extractRows(wb, sheetIdx) {
  const sheetName = wb.SheetNames[sheetIdx ?? 0]
  if (!sheetName) throw Object.assign(new Error('Aba não encontrada.'), { status: 400, code: 'ABA_NAO_ENCONTRADA' })
  const ws = wb.Sheets[sheetName]

  // sheet_to_json com header:1 retorna Array<Array> onde [0] = headers, [1..] = dados
  const raw = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: '',
    blankrows: false,
  })

  if (!raw.length) return { headers: [], dataRows: [] }

  const headers = (raw[0] || []).map(v => String(v ?? '').trim())
  const dataRows = raw.slice(1)
    .filter(row => Array.isArray(row) && row.some(c => c !== '' && c != null))
    .slice(0, MAX_ROWS_DISPARO)

  return { headers, dataRows }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Faz o parse inicial do arquivo e retorna estrutura para preview.
 * Valida o conteúdo real pelos magic bytes.
 * @param {Buffer} buffer
 * @param {string} extension - 'xlsx', 'xls' ou 'csv'
 * @param {number|null} sheetIdx - índice da aba (0-based; null = primeira)
 */
async function parseArquivo(buffer, extension, sheetIdx = null) {
  const ext = String(extension ?? '').toLowerCase().replace(/^\./, '')
  const formatoReal = detectarFormatoReal(buffer)

  // Valida que o conteúdo bate com a extensão declarada
  if (ext === 'xlsx' && formatoReal === 'xls') {
    throw Object.assign(
      new Error('O arquivo enviado é .xls (Excel 97-2003), mas a extensão diz .xlsx. Renomeie ou salve como .xlsx.'),
      { status: 400, code: 'FORMATO_MISMATCH' },
    )
  }
  if (ext === 'xls' && formatoReal === 'xlsx') {
    throw Object.assign(
      new Error('O arquivo enviado é .xlsx, mas a extensão diz .xls. Renomeie ou salve como .xlsx.'),
      { status: 400, code: 'FORMATO_MISMATCH' },
    )
  }
  if ((ext === 'xlsx' || ext === 'xls') && formatoReal === 'csv') {
    throw Object.assign(
      new Error('O arquivo enviado parece ser texto/CSV, mas a extensão diz .' + ext + '. Use a extensão correta.'),
      { status: 400, code: 'ARQUIVO_INVALIDO' },
    )
  }
  if ((ext === 'xlsx' || ext === 'xls') && formatoReal === 'unknown') {
    throw Object.assign(
      new Error(`O conteúdo do arquivo não corresponde a uma planilha ${ext.toUpperCase()} válida.`),
      { status: 400, code: 'ARQUIVO_INVALIDO' },
    )
  }
  if (ext === 'csv' && (formatoReal === 'xlsx' || formatoReal === 'xls')) {
    throw Object.assign(
      new Error('O arquivo enviado é uma planilha binária, mas a extensão diz .csv. Salve como .csv ou use a extensão correta.'),
      { status: 400, code: 'FORMATO_MISMATCH' },
    )
  }

  if (!['xlsx', 'xls', 'csv'].includes(ext)) {
    throw Object.assign(
      new Error(`Formato '${ext}' não suportado. Use .xlsx, .xls ou .csv.`),
      { status: 400, code: 'FORMATO_INVALIDO' },
    )
  }

  // Para CSV, SheetJS lê diretamente do buffer
  const { wb, sheets } = lerWorkbook(buffer, ext)

  if (!sheets.length) {
    throw Object.assign(new Error('Arquivo sem dados ou vazio.'), { status: 400, code: 'ARQUIVO_VAZIO' })
  }

  const targetIdx = sheetIdx ?? 0
  const { headers, dataRows } = extractRows(wb, targetIdx)

  return {
    sheets,
    sheetIdxAtual: targetIdx,
    headers,
    dataRows,
  }
}

/**
 * Monta a chave canônica de variável a partir do nome da coluna.
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
 * @param {Array<any[]>} dataRows
 * @param {{ nome: number|null, telefone: number|null }} mapping
 * @param {Set<string>} telefonesJaNaCampanha
 */
function planejarImportacao(headers, dataRows, mapping, telefonesJaNaCampanha = new Set()) {
  if (mapping.nome == null) throw Object.assign(new Error('Coluna de nome não mapeada.'), { status: 400 })
  if (mapping.telefone == null) throw Object.assign(new Error('Coluna de telefone não mapeada.'), { status: 400 })

  const mapNome = mapping.nome
  const mapFone = mapping.telefone

  const colunasExtras = headers
    .map((h, idx) => ({ idx, nome: h, chave: toVariavelKey(h) }))
    .filter(c => c.idx !== mapNome && c.idx !== mapFone && c.chave)

  const valid = []
  const invalid = []
  const telefonesVistos = new Set()

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const linha = i + 2
    const nome = String(row[mapNome] ?? '').trim()
    const foneRaw = String(row[mapFone] ?? '').trim()

    if (!nome && !foneRaw) continue

    if (!nome) { invalid.push({ linha, nome: '', telefone: foneRaw, motivo: 'Nome ausente' }); continue }

    const { original, normalizado, valido, motivo } = validarTelefoneDisparo(foneRaw)
    if (!valido) { invalid.push({ linha, nome, telefone: original, motivo }); continue }

    if (telefonesVistos.has(normalizado)) {
      invalid.push({ linha, nome, telefone: original, motivo: 'Número duplicado na planilha' }); continue
    }
    telefonesVistos.add(normalizado)

    if (telefonesJaNaCampanha.has(normalizado)) {
      invalid.push({ linha, nome, telefone: original, motivo: 'Número já incluído na campanha' }); continue
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
  toVariavelKey,
  normalizeHeader,
  detectarFormatoReal,
  MAX_ROWS_DISPARO,
  PREVIEW_SAMPLE,
}
