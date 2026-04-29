const { getProdutosDbPool } = require('../config/produtosDb')

function normalizeTerm(termo) {
  const normalized = String(termo || '').trim()
  if (!normalized) return ''
  return normalized.slice(0, 120)
}

function sanitizeLimit(limit) {
  const parsed = Number.parseInt(limit, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 50
  return Math.min(parsed, 100)
}

function sanitizeOffset(offset) {
  const parsed = Number.parseInt(offset, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

async function buscarProdutos({ companyId, termo, somenteComEstoque, limit, offset }) {
  const safeCompanyId = Number(companyId)
  if (!Number.isFinite(safeCompanyId) || safeCompanyId <= 0) {
    const error = new Error('companyId inválido')
    error.statusCode = 400
    throw error
  }

  const safeTermo = normalizeTerm(termo)
  const safeLimit = sanitizeLimit(limit)
  const safeOffset = sanitizeOffset(offset)
  const withStockOnly = somenteComEstoque === true

  const pool = getProdutosDbPool()

  const filters = ['"Company Id" = $1', '"Ativo" = TRUE']
  const params = [safeCompanyId]
  let paramIndex = 2

  if (withStockOnly) {
    filters.push('COALESCE("Estoque Previsto", 0) > 0')
  }

  if (safeTermo) {
    const likeValue = `%${safeTermo}%`
    filters.push(`(
      CAST("Código Item" AS TEXT) ILIKE $${paramIndex}
      OR "Descrição Item" ILIKE $${paramIndex}
      OR COALESCE("Código Fabricante", '') ILIKE $${paramIndex}
      OR COALESCE("Código Barras", '') ILIKE $${paramIndex}
      OR COALESCE("Código Saída", '') ILIKE $${paramIndex}
    )`)
    params.push(likeValue)
    paramIndex += 1
  }

  const whereClause = `WHERE ${filters.join(' AND ')}`

  const countSql = `
    SELECT COUNT(*)::bigint AS total
    FROM "Estoque"
    ${whereClause}
  `

  const listSql = `
    SELECT
      "Código Item" AS "codigoItem",
      "Descrição Item" AS "descricaoItem",
      "Estoque Previsto" AS "estoquePrevisto",
      "Preço Unitário" AS "precoUnitario",
      "Código Fabricante" AS "codigoFabricante",
      "Código Barras" AS "codigoBarras",
      "Código Saída" AS "codigoSaida",
      "Última Sincronização" AS "ultimaSincronizacao"
    FROM "Estoque"
    ${whereClause}
    ORDER BY "Descrição Item" ASC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `

  const listParams = [...params, safeLimit, safeOffset]

  const [countResult, listResult] = await Promise.all([
    pool.query(countSql, params),
    pool.query(listSql, listParams),
  ])

  const total = Number(countResult.rows?.[0]?.total || 0)

  return {
    items: listResult.rows || [],
    pagination: {
      limit: safeLimit,
      offset: safeOffset,
      total,
    },
  }
}

module.exports = {
  buscarProdutos,
  sanitizeLimit,
  sanitizeOffset,
}
