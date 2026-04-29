const { getProdutosDbPool } = require('../config/produtosDb')
const { sql, getWmSqlServerPool } = require('../config/wmSqlServer')
const { getBooleanEnv } = require('../config/env')

const DEFAULT_BATCH_SIZE = 500
const MAX_BATCH_SIZE = 1000

let isSyncRunning = false
let lastSyncStartedAt = null
let lastSyncFinishedAt = null
let lastSyncStatus = null
let lastError = null

function getBatchSize() {
  const parsed = Number.parseInt(process.env.PRODUTOS_SYNC_BATCH_SIZE || `${DEFAULT_BATCH_SIZE}`, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BATCH_SIZE
  return Math.min(parsed, MAX_BATCH_SIZE)
}

function getSyncEnabled() {
  return getBooleanEnv('PRODUTOS_SYNC_ENABLED', false)
}

function isInternalSyncEnabled() {
  return getBooleanEnv('PRODUTOS_SYNC_INTERNAL_ENABLED', false)
}

function validateWmSyncEnv() {
  const required = [
    'WM_SQLSERVER_HOST',
    'WM_SQLSERVER_DATABASE',
    'WM_SQLSERVER_USER',
    'WM_SQLSERVER_PASSWORD',
  ]
  return required.every((key) => String(process.env[key] || '').trim())
}

function mapRow(row) {
  return {
    codigoItem: row['Código Item'] != null ? String(row['Código Item']).trim() : null,
    descricaoItem: row['Descrição Item'] != null ? String(row['Descrição Item']).trim() : null,
    estoquePrevisto: row['Estoque Previsto'] != null ? Number(row['Estoque Previsto']) : null,
    precoUnitario: row['Preço Unitário'] != null ? Number(row['Preço Unitário']) : null,
    codigoFabricante: row['Código Fabricante'] != null ? String(row['Código Fabricante']).trim() : null,
    codigoBarras: row['Código Barras'] != null ? String(row['Código Barras']).trim() : null,
    codigoSaida: row['Código Saída'] != null ? String(row['Código Saída']).trim() : null,
  }
}

async function runBatchUpsert(client, companyId, batch) {
  if (!batch.length) return { inserted: 0, updated: 0 }

  const placeholders = []
  const values = []
  let idx = 1

  for (const item of batch) {
    placeholders.push(
      `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, TRUE, NOW(), NOW(), NOW())`
    )
    values.push(
      companyId,
      item.codigoItem,
      item.descricaoItem,
      item.estoquePrevisto,
      item.precoUnitario,
      item.codigoFabricante,
      item.codigoBarras,
      item.codigoSaida
    )
    idx += 8
  }

  const query = `
    INSERT INTO "Estoque" (
      "Company Id",
      "Código Item",
      "Descrição Item",
      "Estoque Previsto",
      "Preço Unitário",
      "Código Fabricante",
      "Código Barras",
      "Código Saída",
      "Ativo",
      "Última Sincronização",
      "Criado Em",
      "Atualizado Em"
    )
    VALUES ${placeholders.join(',')}
    ON CONFLICT ("Company Id", "Código Item")
    DO UPDATE SET
      "Descrição Item" = EXCLUDED."Descrição Item",
      "Estoque Previsto" = EXCLUDED."Estoque Previsto",
      "Preço Unitário" = EXCLUDED."Preço Unitário",
      "Código Fabricante" = EXCLUDED."Código Fabricante",
      "Código Barras" = EXCLUDED."Código Barras",
      "Código Saída" = EXCLUDED."Código Saída",
      "Ativo" = TRUE,
      "Última Sincronização" = NOW(),
      "Atualizado Em" = NOW()
    RETURNING (xmax = 0) AS inserted
  `

  const result = await client.query(query, values)
  let inserted = 0
  let updated = 0
  for (const row of result.rows || []) {
    if (row.inserted) inserted += 1
    else updated += 1
  }

  return { inserted, updated }
}

function getSyncStatus() {
  return {
    enabled: getSyncEnabled(),
    internalSyncEnabled: isInternalSyncEnabled(),
    running: isSyncRunning,
    lastSyncStartedAt,
    lastSyncFinishedAt,
    lastSyncStatus,
    lastError,
    intervalMinutes: Number.parseInt(process.env.PRODUTOS_SYNC_INTERVAL_MINUTES || '30', 10) || 30,
  }
}

async function syncProdutosFromWm() {
  if (!isInternalSyncEnabled()) {
    const error = new Error('Sincronização interna WM desativada.')
    error.statusCode = 503
    throw error
  }

  if (!validateWmSyncEnv()) {
    const error = new Error('Configuração da WM incompleta para sincronização interna.')
    error.statusCode = 503
    throw error
  }

  if (isSyncRunning) {
    const conflict = new Error('Sincronização já está em andamento.')
    conflict.statusCode = 409
    throw conflict
  }

  const companyId = Number.parseInt(process.env.WM_PRODUTOS_COMPANY_ID || '1', 10)
  if (!Number.isFinite(companyId) || companyId <= 0) {
    const error = new Error('WM_PRODUTOS_COMPANY_ID inválido')
    error.statusCode = 500
    throw error
  }

  isSyncRunning = true
  lastSyncStartedAt = new Date().toISOString()
  lastSyncStatus = 'running'
  lastError = null

  const startedAt = new Date()
  const stats = {
    status: 'running',
    totalLidos: 0,
    totalInseridos: 0,
    totalAtualizados: 0,
    inicio: startedAt.toISOString(),
    fim: null,
    erro: null,
  }

  try {
    const wmPool = await getWmSqlServerPool()
    const batchSize = getBatchSize()
    const produtosDbPool = getProdutosDbPool()
    let offset = 0

    while (true) {
      const request = wmPool.request()
      request.input('offset', sql.Int, offset)
      request.input('batchSize', sql.Int, batchSize)

      const queryResult = await request.query(`
        SELECT
          [Código Item],
          [Descrição Item],
          [Estoque Previsto],
          [Preço Unitário],
          [Código Fabricante],
          [Código Barras],
          [Código Saída]
        FROM Estoque
        WHERE Ativo = 1
        ORDER BY [Código Item]
        OFFSET @offset ROWS
        FETCH NEXT @batchSize ROWS ONLY
      `)

      const batch = (queryResult.recordset || []).map(mapRow).filter((item) => item.codigoItem)
      if (!batch.length) break
      stats.totalLidos += batch.length

      const client = await produtosDbPool.connect()
      try {
        await client.query('BEGIN')
        const batchResult = await runBatchUpsert(client, companyId, batch)
        await client.query('COMMIT')

        stats.totalInseridos += batchResult.inserted
        stats.totalAtualizados += batchResult.updated
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }

      offset += batch.length
      console.log('[PRODUTOS_SYNC] lote processado', {
        offset,
        batchSize: batch.length,
        totalLidos: stats.totalLidos,
      })
    }

    stats.status = 'success'
    stats.fim = new Date().toISOString()
    lastSyncFinishedAt = stats.fim
    lastSyncStatus = 'success'
    console.log('[PRODUTOS_SYNC] sincronização concluída', stats)
    return stats
  } catch (error) {
    const safeMessage = error?.message || 'Erro inesperado na sincronização'
    stats.status = 'error'
    stats.erro = safeMessage
    stats.fim = new Date().toISOString()
    lastSyncFinishedAt = stats.fim
    lastSyncStatus = 'error'
    lastError = safeMessage
    console.error('[PRODUTOS_SYNC] erro na sincronização:', safeMessage)
    throw error
  } finally {
    isSyncRunning = false
  }
}

module.exports = {
  syncProdutosFromWm,
  getSyncStatus,
}
