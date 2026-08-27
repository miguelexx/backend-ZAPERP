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
 */

const ExcelJS = require('exceljs')
const supabase = require('../config/supabase')
const {
  detectColumns,
  planImport,
  cellToString,
  MAX_DATA_ROWS,
} = require('../helpers/clienteImportPlanner')
const { executarImportacao } = require('../services/clienteImportService')

const PREVIEW_SAMPLE_SIZE = 50

/**
 * Lê o arquivo enviado (buffer) e devolve { headers, dataRows } da primeira planilha.
 * @param {Buffer} buffer
 * @returns {Promise<{ headers: string[], dataRows: Array<Array<string>> }>}
 */
async function lerPlanilha(buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const ws = wb.worksheets[0]
  if (!ws) {
    const err = new Error('A planilha está vazia ou não pôde ser lida.')
    err.status = 400
    err.code = 'PLANILHA_VAZIA'
    throw err
  }

  // exceljs: row.values é 1-indexed (posição 0 vazia). Convertemos para 0-indexed.
  const toArray = (row) => {
    const values = Array.isArray(row?.values) ? row.values : []
    const out = []
    for (let c = 1; c < values.length; c++) out.push(cellToString(values[c]))
    return out
  }

  const headerRow = ws.getRow(1)
  const headers = toArray(headerRow)

  const dataRows = []
  const lastRow = ws.actualRowCount || ws.rowCount || 0
  for (let r = 2; r <= lastRow; r++) {
    const row = ws.getRow(r)
    if (!row || !row.hasValues) continue
    dataRows.push(toArray(row))
    if (dataRows.length > MAX_DATA_ROWS) {
      const err = new Error(
        `A planilha excede o limite de ${MAX_DATA_ROWS.toLocaleString('pt-BR')} linhas. Divida o arquivo e importe em partes.`
      )
      err.status = 400
      err.code = 'PLANILHA_MUITO_GRANDE'
      throw err
    }
  }

  return { headers, dataRows }
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
    const { headers, dataRows } = await lerPlanilha(req.file.buffer)
    const mapping = resolverMapeamento(headers, parseBodyMapping(req))

    const faltando = []
    if (mapping.nome == null) faltando.push('Nome do(a) Aluno(a)')
    if (mapping.telefone == null) faltando.push('Celular do(a) Responsável Pedagógico')
    // série é opcional (sem ela, importa sem tag) — não bloqueia

    const plano = planImport(dataRows, mapping)

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

    const { headers, dataRows } = await lerPlanilha(req.file.buffer)
    const mapping = resolverMapeamento(headers, parseBodyMapping(req))

    if (mapping.nome == null || mapping.telefone == null) {
      return res.status(400).json({
        erro: 'Não foi possível identificar as colunas de nome e/ou telefone. Ajuste o mapeamento e tente novamente.',
        codigo: 'MAPEAMENTO_INCOMPLETO',
      })
    }

    const plano = planImport(dataRows, mapping)
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
