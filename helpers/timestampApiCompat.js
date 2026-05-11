/**
 * PostgREST / Postgres `timestamp without time zone` costuma serializar como ISO sem fuso
 * (ex.: `2025-05-11T19:09:00`). Em navegadores, ISO 8601 *sem* offset é interpretado como
 * horário **local** (ECMA-262), não como UTC — gerando ~+3h em relação ao instante real
 * quando o valor na verdade representa relógio UTC gravado pelo backend (`toISOString()`).
 *
 * Normaliza para string com `Z` (instante inequívoco). Valores que já trazem `Z` ou `±HH:MM`
 * só são repassados por `Date` → `toISOString()`.
 *
 * @param {string|number|Date|null|undefined} val
 * @returns {string|number|Date|null|undefined}
 */
function normalizarTimestampSemFusoAmbiguoParaApi(val) {
  if (val == null || val === '') return val
  if (val instanceof Date) {
    const t = val.getTime()
    return Number.isNaN(t) ? val : val.toISOString()
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    const d = new Date(val)
    return Number.isNaN(d.getTime()) ? val : d.toISOString()
  }
  const s = String(val).trim()
  if (!s) return val

  // Já com zona explícita (incl. +00:00 / -03:00)
  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? val : d.toISOString()
  }

  // "YYYY-MM-DD HH:mm:ss" ou "YYYY-MM-DDTHH:mm:ss[.frac]" sem offset → componentes como UTC
  const isoSpace = s.replace(' ', 'T')
  const m = isoSpace.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?$/
  )
  if (m) {
    const [, y, mo, d, h, mi, se, frac] = m
    let msFrac = 0
    if (frac) {
      const padded = (frac + '000').slice(0, 3)
      msFrac = Number(padded) || 0
    }
    const t = Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      se ? Number(se) : 0,
      msFrac
    )
    const dObj = new Date(t)
    return Number.isNaN(dObj.getTime()) ? val : dObj.toISOString()
  }

  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? val : d.toISOString()
}

module.exports = { normalizarTimestampSemFusoAmbiguoParaApi }
