const { Pool } = require('pg')
const { getBooleanEnv } = require('./env')

let pool = null

function getProdutosDbPool() {
  if (pool) return pool

  const sslEnabled = getBooleanEnv('PRODUTOS_DB_SSL', false)

  pool = new Pool({
    host: process.env.PRODUTOS_DB_HOST,
    port: Number(process.env.PRODUTOS_DB_PORT || 5432),
    database: process.env.PRODUTOS_DB_NAME || 'zaperp_produtos',
    user: process.env.PRODUTOS_DB_USER || 'postgres',
    password: process.env.PRODUTOS_DB_PASSWORD,
    ssl: sslEnabled ? { rejectUnauthorized: false } : false,
    max: Number(process.env.PRODUTOS_DB_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PRODUTOS_DB_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PRODUTOS_DB_CONNECTION_TIMEOUT_MS || 10000),
    application_name: 'zaperp-backend-produtos',
  })

  pool.on('error', (error) => {
    console.error('[PRODUTOS_DB] erro no pool:', error?.message || error)
  })

  return pool
}

module.exports = {
  getProdutosDbPool,
}
