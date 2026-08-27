/**
 * Importação de clientes por planilha (.xlsx).
 *
 * Endpoints (ver routes/clienteRoutes.js):
 *  - POST /clientes/importar/preview  → analisa o arquivo e devolve a prévia (não grava nada)
 *  - POST /clientes/importar          → executa a importação (grava clientes + tags)
 *
 * Segurança:
 *  - Restrito a administradores (adminOnly na rota).
 *  - Isolamento por empresa: SEMPRE usa req.user.company_id; nunca aceita company_id do body.
 *  - Arquivo em memória (multer memoryStorage), com limite de tamanho e tipo .xlsx.
 *
 * Leitura: SheetJS (`xlsx`), o mesmo parser do Disparo. ExcelJS NÃO é usado para ler —
 * planilhas reais da secretaria (dimensão A1:XFD1048576, estilos, desenhos, várias abas)
 * fazem o ExcelJS alocar milhões de Row e derrubar o processo (HTTP 500 + conexões fechadas).
 */

const XLSX = require('xlsx')
const supabase = require('../config/supabase')
const {
  detectColumns,
  findHeaderRow,
  planImport,
  cellToString,
  MAX_DATA_ROWS,
  HEADER_SCAN_ROWS,
} = require('../helpers/clienteImportPlanner')
const { executarImportacao } = require('../services/clienteImportService')

const PREVIEW_SAMPLE_SIZE = 50

function httpError(message, status, code) {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

/**
 * Converte célula extraída pelo SheetJS em string estável (número inteiro sem notação científica).
 * @param {*} value
 * @returns {string}
 */
function sheetCellToString(value) {
  return cellToString(value)
}

/**
 * Corta o intervalo da aba para não materializar planilhas com dimensão “folha inteira”.
 * @param {object} ws
 */
function clampSheetRef(ws) {
  if (!ws) return
  const ref = ws['!ref']
  if (!ref) return
  let range
  try {
    range = XLSX.utils.decode_range(ref)
  } catch {
    return
  }
  const maxRow = MAX_DATA_ROWS + HEADER_SCAN_ROWS
  if (range.e.r > maxRow) {
    range.e.r = maxRow
    ws['!ref'] = XLSX.utils.encode_range(range)
  }
}

/**
 * Extrai linhas da aba como arrays de string (0-indexed).
 * @param {object} ws
 * @returns {string[][]}
 */
function rowsFromSheet(ws) {
  if (!ws) return []
  clampSheetRef(ws)
  const raw = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: '',
    blankrows: false,
    raw: true,
  })
  return (Array.isArray(raw) ? raw : []).map((row) => {
    const arr = Array.isArray(row) ? row : []
    return arr.map(sheetCellToString)
  })
}

/**
 * Escolhe a aba e a linha de cabeçalho com melhor detecção das 3 colunas do modelo.
 * @param {object} wb - workbook SheetJS
 * @returns {{ headers: string[], dataRows: string[][], headerRowNumber: number }}
 */
function escolherAbaECabecalho(wb) {
  const names = Array.isArray(wb?.SheetNames) ? wb.SheetNames : []
  let best = null

  for (const name of names) {
    const rows = rowsFromSheet(wb.Sheets?.[name])
    if (!rows.length) continue
    const found = findHeaderRow(rows)
    const headers = (rows[found.index] || []).map((h) => cellToString(h))
    const dataRows = rows.slice(found.index + 1)
    const candidate = {
      headers,
      dataRows,
      headerRowNumber: found.index + 1,
      score: found.score,
      dataCount: dataRows.length,
    }
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.dataCount > best.dataCount)
    ) {
      best = candidate
    }
  }

  return best
}

/**
 * Lê o arquivo enviado (buffer) e devolve { headers, dataRows, headerRowNumber } da aba útil.
 * @param {Buffer} buffer
 * @returns {{ headers: string[], dataRows: Array<Array<string>>, headerRowNumber: number }}
 */
function lerPlanilha(buffer) {
  const buf = Buffer.isBuffer(buffer)
    ? buffer
    : (buffer instanceof Uint8Array ? Buffer.from(buffer) : null)
  if (!buf || buf.length < 4) {
    throw httpError('Arquivo inválido.', 400, 'ARQUIVO_INVALIDO')
  }

  // Magic bytes: xlsx é ZIP (PK). .xls antigo (OLE2) e CSV precisam de mensagem clara, não 500.
  if (buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0) {
    throw httpError(
      'O arquivo é .xls (Excel 97-2003). Abra no Excel e salve como .xlsx.',
      400,
      'FORMATO_XLS'
    )
  }
  if (buf[0] !== 0x50 || buf[1] !== 0x4B) {
    throw httpError(
      'Não foi possível ler o arquivo. Envie uma planilha .xlsx válida (não protegida por senha).',
      400,
      'ARQUIVO_INVALIDO'
    )
  }

  let wb
  try {
    wb = XLSX.read(buf, {
      type: 'buffer',
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      cellDates: false,
      sheetRows: MAX_DATA_ROWS + HEADER_SCAN_ROWS + 1,
    })
  } catch {
    throw httpError(
      'Não foi possível ler a planilha. Verifique se o arquivo é um .xlsx válido (não protegido por senha).',
      400,
      'PLANILHA_ILEGIVEL'
    )
  }

  const escolhida = escolherAbaECabecalho(wb)
  if (!escolhida) {
    throw httpError('A planilha está vazia ou não pôde ser lida.', 400, 'PLANILHA_VAZIA')
  }

  if (escolhida.dataRows.length > MAX_DATA_ROWS) {
    throw httpError(
      `A planilha excede o limite de ${MAX_DATA_ROWS.toLocaleString('pt-BR')} linhas. Divida o arquivo e importe em partes.`,
      400,
      'PLANILHA_MUITO_GRANDE'
    )
  }

  return {
    headers: escolhida.headers,
    dataRows: escolhida.dataRows,
    headerRowNumber: escolhida.headerRowNumber,
  }
}

/**
 * Resolve o mapeamento de colunas: usa o override do body (se enviado e válido) ou a
 * detecção automática pelos cabeçalhos.
 * @param {string[]} headers
 * @param {object} bodyMapping - { nome, telefone, serie } índices (0-indexed) opcionais
 * @returns {{ nome:number|null, telefone:number|null, serie:number|null, auto:object }}
 */
function resolverMapeamento(headers, bodyMapping) {
  const auto = detectColumns(headers)
  // Índice válido → número; null/vazio/ inválido → null ("não usar esta coluna")
  const parseIdx = (v) => {
    if (v == null || v === '') return null
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n >= headers.length) return null
    return n
  }
  const override = bodyMapping || {}
  const has = (k) => Object.prototype.hasOwnProperty.call(override, k)
  // Se o campo veio no override (mesmo que null), respeita a escolha do usuário.
  // Se não veio, usa a detecção automática pelos cabeçalhos.
  const resolve = (field) => (has(field) ? parseIdx(override[field]) : auto[field])

  return {
    nome: resolve('nome'),
    telefone: resolve('telefone'),
    serie: resolve('serie'),
    auto: { nome: auto.nome, telefone: auto.telefone, serie: auto.serie },
  }
}

/** Interpreta o mapeamento enviado no body (pode vir como JSON string no multipart). */
function parseBodyMapping(req) {
  const raw = req.body?.mapping ?? req.body?.mapeamento
  if (!raw) {
    // Também aceita campos soltos: mapping_nome, mapping_telefone, mapping_serie
    const solto = {
      nome: req.body?.mapping_nome,
      telefone: req.body?.mapping_telefone,
      serie: req.body?.mapping_serie,
    }
    if (solto.nome != null || solto.telefone != null || solto.serie != null) return solto
    return {}
  }
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function requireFile(req, res) {
  if (!req.file || !req.file.buffer || !req.file.size) {
    res.status(400).json({ erro: 'Envie um arquivo .xlsx no campo "arquivo".', codigo: 'ARQUIVO_OBRIGATORIO' })
    return false
  }
  return true
}

/**
 * POST /clientes/importar/preview
 * Analisa o arquivo e devolve a prévia SEM gravar nada.
 */
exports.previewImportacao = async (req, res) => {
  if (!requireFile(req, res)) return
  try {
    const { headers, dataRows, headerRowNumber } = lerPlanilha(req.file.buffer)
    const mapping = resolverMapeamento(headers, parseBodyMapping(req))

    const faltando = []
    if (mapping.nome == null) faltando.push('Nome do(a) Aluno(a)')
    if (mapping.telefone == null) faltando.push('Celular do(a) Responsável Pedagógico')
    // série é opcional (sem ela, importa sem tag) — não bloqueia

    const plano = planImport(dataRows, mapping, { headerRowNumber })

    return res.status(200).json({
      headers,
      mapping: { nome: mapping.nome, telefone: mapping.telefone, serie: mapping.serie },
      auto: mapping.auto,
      colunas_faltando: faltando,
      stats: plano.stats,
      // Amostra para a prévia (nome, telefone normalizado, tags)
      amostra: plano.entries.slice(0, PREVIEW_SAMPLE_SIZE).map((e) => ({
        nome: e.nome,
        telefone: e.telefoneNormalizado,
        tags: e.tags,
        conflito: e.nomesConflitantes.length > 0,
        nomes_conflitantes: e.nomesConflitantes,
      })),
      ignored: plano.ignored.slice(0, 500),
      conflicts: plano.conflicts.slice(0, 500),
    })
  } catch (err) {
    return responderErro(res, err, 'Erro ao analisar a planilha.')
  }
}

/**
 * POST /clientes/importar
 * Executa a importação: cria/reutiliza clientes e vincula as tags das séries.
 */
exports.confirmarImportacao = async (req, res) => {
  if (!requireFile(req, res)) return
  try {
    const companyId = Number(req.user?.company_id)
    if (!Number.isFinite(companyId) || companyId <= 0) {
      return res.status(401).json({ erro: 'Não autorizado' })
    }

    const { headers, dataRows, headerRowNumber } = lerPlanilha(req.file.buffer)
    const mapping = resolverMapeamento(headers, parseBodyMapping(req))

    if (mapping.nome == null || mapping.telefone == null) {
      return res.status(400).json({
        erro: 'Não foi possível identificar as colunas de nome e/ou telefone. Ajuste o mapeamento e tente novamente.',
        codigo: 'MAPEAMENTO_INCOMPLETO',
      })
    }

    const plano = planImport(dataRows, mapping, { headerRowNumber })
    if (plano.entries.length === 0) {
      return res.status(400).json({
        erro: 'Nenhuma linha válida para importar (todas sem nome ou telefone válido).',
        codigo: 'NENHUMA_LINHA_VALIDA',
        stats: plano.stats,
        ignored: plano.ignored.slice(0, 500),
      })
    }

    const resultado = await executarImportacao(supabase, companyId, plano)
    return res.status(200).json(resultado)
  } catch (err) {
    return responderErro(res, err, 'Erro ao importar clientes.')
  }
}

function responderErro(res, err, fallbackMsg) {
  const status = Number(err?.status) || 500
  if (status >= 500) console.error('[clienteImport]', err)
  return res.status(status).json({
    erro: status >= 500 ? fallbackMsg : (err?.message || fallbackMsg),
    ...(err?.code ? { codigo: err.code } : {}),
  })
}
