const sql = require('mssql')
const { getBooleanEnv } = require('./env')

let poolPromise = null

function getSqlServerConfig() {
  return {
    server: process.env.WM_SQLSERVER_HOST,
    port: Number(process.env.WM_SQLSERVER_PORT || 1433),
    user: process.env.WM_SQLSERVER_USER,
    password: process.env.WM_SQLSERVER_PASSWORD,
    database: process.env.WM_SQLSERVER_DATABASE,
    pool: {
      max: Number(process.env.WM_SQLSERVER_POOL_MAX || 5),
      min: 0,
      idleTimeoutMillis: Number(process.env.WM_SQLSERVER_IDLE_TIMEOUT_MS || 30000),
    },
    options: {
      encrypt: getBooleanEnv('WM_SQLSERVER_ENCRYPT', false),
      trustServerCertificate: getBooleanEnv('WM_SQLSERVER_TRUST_CERT', true),
      enableArithAbort: true,
    },
    connectionTimeout: Number(process.env.WM_SQLSERVER_CONNECTION_TIMEOUT_MS || 10000),
    requestTimeout: Number(process.env.WM_SQLSERVER_REQUEST_TIMEOUT_MS || 60000),
  }
}

async function getWmSqlServerPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(getSqlServerConfig()).catch((error) => {
      poolPromise = null
      throw error
    })
  }
  return poolPromise
}

module.exports = {
  sql,
  getWmSqlServerPool,
}
