/**
 * Exportação CSV segura — Etapa 8 Disparo.
 * UTF-8 BOM para Excel BR; proteção contra CSV injection.
 */

const { mascararTelefone } = require('./disparoRevisaoChecklist')

const CSV_INJECTION_PREFIX_RE = /^[=+\-@]/

function escapeCsvCell(val) {
  let s = val == null ? '' : String(val)
  if (CSV_INJECTION_PREFIX_RE.test(s)) {
    s = `'${s}`
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function applyMask(value, columnKey, maskPhone) {
  if (!maskPhone) return value
  const key = String(columnKey || '').toLowerCase()
  if (
    key.includes('telefone')
    || key.includes('phone')
    || key === 'telefone_normalizado'
    || key === 'telefone_original'
  ) {
    return mascararTelefone(value)
  }
  return value
}

/**
 * @param {object[]} rows
 * @param {{ key: string, label?: string }[]} columns
 * @param {{ maskPhone?: boolean, includeHeader?: boolean }} [opts]
 */
function toCsv(rows, columns, opts = {}) {
  const { maskPhone = false, includeHeader = true } = opts
  const cols = Array.isArray(columns) && columns.length
    ? columns
    : (rows[0] ? Object.keys(rows[0]).map((k) => ({ key: k, label: k })) : [])

  const linhas = []
  if (includeHeader && cols.length) {
    linhas.push(cols.map((c) => escapeCsvCell(c.label ?? c.key)).join(','))
  }

  for (const row of rows ?? []) {
    linhas.push(
      cols
        .map((c) => escapeCsvCell(applyMask(row?.[c.key], c.key, maskPhone)))
        .join(','),
    )
  }

  const body = `${linhas.join('\r\n')}\r\n`
  return `\uFEFF${body}`
}

module.exports = {
  escapeCsvCell,
  toCsv,
  applyMask,
}
