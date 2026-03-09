/**
 * Logger estruturado (JSON) para produção.
 * Quando LOG_JSON=1, emite logs em JSON. Caso contrário, mantém console padrão.
 */
const LOG_JSON = String(process.env.LOG_JSON || '').toLowerCase() === '1' || String(process.env.LOG_JSON || '').toLowerCase() === 'true'

function formatEntry(level, msg, meta = {}) {
  const base = {
    ts: new Date().toISOString(),
    level,
    msg: String(msg || ''),
    ...(typeof meta === 'object' && meta !== null ? meta : { meta }),
  }
  return LOG_JSON ? JSON.stringify(base) : `[${level.toUpperCase()}] ${base.msg} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`
}

const logger = {
  info(msg, meta = {}) {
    console.log(formatEntry('info', msg, meta))
  },
  warn(msg, meta = {}) {
    console.warn(formatEntry('warn', msg, meta))
  },
  error(msg, meta = {}) {
    console.error(formatEntry('error', msg, meta))
  },
  debug(msg, meta = {}) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(formatEntry('debug', msg, meta))
    }
  },
}

module.exports = logger
