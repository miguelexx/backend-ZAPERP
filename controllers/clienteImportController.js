/**
 * Importação de clientes por planilha (.xlsx).
 *
 *  - POST /clientes/importar/preview  → analisa o arquivo e devolve a prévia (não grava nada)
 *  - POST /clientes/importar          → executa a importação (grava clientes + tags)
 *
 * company_id vem SEMPRE de req.user. Leitura via SheetJS (ExcelJS falha em alguns .xlsx reais).
 */

const XLSX = require('xlsx')
const supabase = require('../config/supabase')
const {
  detectColumns,
  planImport,
  cellToString,
  MAX_DATA_ROWS,
} = require('../helpers/clienteImportPlanner')
const {
  executarImportacao,
  enriquecerPlanoComExistentes,
} = require('../services/clienteImportService')
const { alunosParaVincular } = require('../helpers/clienteNomesVinculados')

const PREVIEW_SAMPLE_SIZE = 50
const importLocks = new Map()

function badRequest(message, code) {
  const err = new Error(message)
  err.status = 400
  err.code = code
  return err
}

function lerPlanilha(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw badRequest('Arquivo vazio ou corrompido. Envie um .xlsx válido.', 'ARQUIVO_CORROMPIDO')
  }
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B
  if (!isZip) {
    throw badRequest('Arquivo vazio ou corrompido. Envie um .xlsx válido.', 'ARQUIVO_CORROMPIDO')
  }

  let wb
  try {
    wb = XLSX.read(buffer, {
      type: 'buffer',
      cellFormula: false,
      cellHTML: false,
      raw: true,
    })
  } catch {
    throw badRequest('Arquivo vazio ou corrompido. Envie um .xlsx válido.', 'ARQUIVO_CORROMPIDO')
  }

  const sheetName = Array.isArray(wb.SheetNames) ? wb.SheetNames[0] : null
  if (!sheetName || !wb.Sheets?.[sheetName]) {
    throw badRequest('A planilha está vazia ou não pôde ser lida.', 'PLANILHA_VAZIA')
  }

  const ws = wb.Sheets[sheetName]
  const raw = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  })

  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest('A planilha está vazia ou não pôde ser lida.', 'PLANILHA_VAZIA')
  }

  const headerRow = Array.isArray(raw[0]) ? raw[0] : []
  const headers = headerRow.map((h) => cellToString(h))
  const dataRows = []

  for (let i = 1; i < raw.length; i++) {
    const row = Array.isArray(raw[i]) ? raw[i] : []
    if (dataRows.length >= MAX_DATA_ROWS) {
      throw badRequest(
        `A planilha excede o limite de ${MAX_DATA_ROWS.toLocaleString('pt-BR')} linhas. Divida o arquivo e importe em partes.`,
        'PLANILHA_MUITO_GRANDE'
      )
    }
    dataRows.push(row)
  }

  return { headers, dataRows }
}

function resolverMapeamento(headers, bodyMapping) {
  const auto = detectColumns(headers)
  const parseIdx = (v) => {
    if (v == null || v === '') return null
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n >= headers.length) return null
    return n
  }
  const override = bodyMapping || {}
  const has = (k) => Object.prototype.hasOwnProperty.call(override, k)
  const resolve = (field) => (has(field) ? parseIdx(override[field]) : auto[field])

  const serieOverride = has('serie')
    ? override.serie
    : (has('tag') ? override.tag : (has('tags') ? override.tags : undefined))

  return {
    nome: resolve('nome'),
    telefone: resolve('telefone'),
    serie: serieOverride !== undefined ? parseIdx(serieOverride) : auto.serie,
    auto: { nome: auto.nome, telefone: auto.telefone, serie: auto.serie },
  }
}

function parseJsonField(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function parseBodyMapping(req) {
  const raw = req.body?.mapping ?? req.body?.mapeamento
  if (!raw) {
    const solto = {
      nome: req.body?.mapping_nome,
      telefone: req.body?.mapping_telefone,
      serie: req.body?.mapping_serie ?? req.body?.mapping_tag,
    }
    if (solto.nome != null || solto.telefone != null || solto.serie != null) return solto
    return {}
  }
  return parseJsonField(raw)
}

function parseNomesPrincipais(req) {
  return parseJsonField(req.body?.nomes_principais ?? req.body?.nomesPrincipais)
}

function parseFlagTrue(v) {
  return v === true || v === 1 || String(v || '').toLowerCase() === 'true'
}

function parseVincularAlunos(req) {
  const raw = req.body?.vincular_alunos_mesmo_telefone
    ?? req.body?.vincularAlunosMesmoTelefone
    ?? req.body?.vincular_alunos
    ?? req.body?.vincularAlunos
  if (raw == null || raw === '') return false
  return parseFlagTrue(raw)
}

function serializarAlunosAVincular(entry) {
  return alunosParaVincular(entry?.alunos, entry?.nome)
}

function requireFile(req, res) {
  if (!req.file || !req.file.buffer || !req.file.size) {
    res.status(400).json({ erro: 'Envie um arquivo .xlsx no campo "arquivo".', codigo: 'ARQUIVO_OBRIGATORIO' })
    return false
  }
  return true
}

function serializarPlanoPreview(plano, mapping) {
  return {
    headers: mapping.headers,
    mapping: { nome: mapping.nome, telefone: mapping.telefone, serie: mapping.serie },
    auto: mapping.auto,
    colunas_faltando: mapping.faltando,
    stats: plano.stats,
    amostra: (plano.entries || []).slice(0, PREVIEW_SAMPLE_SIZE).map((e) => ({
      nome: e.nome,
      telefone: e.telefoneNormalizado,
      tags: e.tags,
      conflito: e.nomesConflitantes.length > 0,
      nomes_conflitantes: e.nomesConflitantes,
      alunos: e.alunos || [],
      alunos_a_vincular: serializarAlunosAVincular(e),
      existente: e.existente || null,
    })),
    ignored: (plano.ignored || []).slice(0, 500),
    conflicts: (plano.conflicts || []).slice(0, 500).map((c) => ({
      ...c,
      alunos_a_vincular: alunosParaVincular(c.alunos, c.nome),
    })),
    nome_sera_alterado: (plano.nomeSeraAlterado || []).slice(0, 500),
    nomes_manuais_protegidos: (plano.nomesManuaisProtegidos || []).slice(0, 500),
    ja_existentes: (plano.jaExistentesIguais || []).slice(0, 500),
  }
}

exports.previewImportacao = async (req, res) => {
  if (!requireFile(req, res)) return
  try {
    const companyId = Number(req.user?.company_id)
    const { headers, dataRows } = lerPlanilha(req.file.buffer)
    const mapping = resolverMapeamento(headers, parseBodyMapping(req))
    const nomesPrincipais = parseNomesPrincipais(req)

    const faltando = []
    if (mapping.nome == null) faltando.push('Nome')
    if (mapping.telefone == null) faltando.push('Telefone')

    let plano = planImport(dataRows, mapping, { nomesPrincipais })
    if (Number.isFinite(companyId) && companyId > 0) {
      plano = await enriquecerPlanoComExistentes(supabase, companyId, plano)
    }

    return res.status(200).json(serializarPlanoPreview(plano, {
      headers,
      nome: mapping.nome,
      telefone: mapping.telefone,
      serie: mapping.serie,
      auto: mapping.auto,
      faltando,
    }))
  } catch (err) {
    return responderErro(res, err, 'Erro ao analisar a planilha.')
  }
}

exports.confirmarImportacao = async (req, res) => {
  if (!requireFile(req, res)) return
  const companyId = Number(req.user?.company_id)
  if (!Number.isFinite(companyId) || companyId <= 0) {
    return res.status(401).json({ erro: 'Não autorizado' })
  }

  const lock = importLocks.get(companyId)
  if (lock && Date.now() - lock < 120000) {
    return res.status(409).json({
      erro: 'Já existe uma importação em andamento para esta empresa. Aguarde terminar.',
      codigo: 'IMPORTACAO_EM_ANDAMENTO',
    })
  }
  importLocks.set(companyId, Date.now())

  try {
    const { headers, dataRows } = lerPlanilha(req.file.buffer)
    const mapping = resolverMapeamento(headers, parseBodyMapping(req))

    if (mapping.nome == null || mapping.telefone == null) {
      return res.status(400).json({
        erro: 'Não foi possível identificar as colunas de nome e/ou telefone. Ajuste o mapeamento e tente novamente.',
        codigo: 'MAPEAMENTO_INCOMPLETO',
      })
    }

    const nomesPrincipais = parseNomesPrincipais(req)
    const confirmarNomeManual = parseFlagTrue(req.body?.confirmar_nomes_manuais ?? req.body?.confirmarNomesManuais)
    const vincularAlunosMesmoTelefone = parseVincularAlunos(req)

    let plano = planImport(dataRows, mapping, { nomesPrincipais })
    if (plano.entries.length === 0) {
      return res.status(400).json({
        erro: 'Nenhuma linha válida para importar (todas sem nome ou telefone válido).',
        codigo: 'NENHUMA_LINHA_VALIDA',
        stats: plano.stats,
        ignored: plano.ignored.slice(0, 500),
      })
    }

    plano = await enriquecerPlanoComExistentes(supabase, companyId, plano)
    const resultado = await executarImportacao(supabase, companyId, plano, {
      confirmarNomeManual,
      vincularAlunosMesmoTelefone,
    })
    return res.status(200).json(resultado)
  } catch (err) {
    return responderErro(res, err, 'Erro ao importar clientes.')
  } finally {
    importLocks.delete(companyId)
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

exports._test = { lerPlanilha, resolverMapeamento, importLocks, parseVincularAlunos, parseFlagTrue }
