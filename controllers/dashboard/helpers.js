const supabase = require('../../config/supabase')

const PAGE_SIZE = 1000
const SAO_PAULO_TZ = 'America/Sao_Paulo'

function clampInt(n, min, max) {
  const x = Number(n)
  if (!Number.isFinite(x)) return null
  return Math.max(min, Math.min(max, Math.trunc(x)))
}

async function fetchAllRows(buildQuery) {
  const all = []
  let from = 0
  for (;;) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await buildQuery().range(from, to)
    if (error) throw error
    const rows = data || []
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

/** Nomes de atendentes sem embed PostgREST (FK `conversas_atendente_fk` foi removida na dedupe). */
async function fetchUsuariosNomeMap(company_id, userIds) {
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
  const map = {}
  if (ids.length === 0) return map
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome')
    .eq('company_id', company_id)
    .in('id', ids)
  if (error) throw error
  for (const u of data || []) {
    if (u?.id != null) map[String(u.id)] = u?.nome || 'Sem nome'
  }
  return map
}

function parseDateOnly(value) {
  const s = String(value || '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  return { y, m, d, value: s }
}

function saoPauloDateStartIso(value) {
  const parsed = parseDateOnly(value)
  if (!parsed) return null
  // Brasil nao usa DST atualmente; 00:00 em America/Sao_Paulo = 03:00 UTC.
  return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, 3, 0, 0, 0)).toISOString()
}

function saoPauloDateEndIso(value) {
  const parsed = parseDateOnly(value)
  if (!parsed) return null
  return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d + 1, 2, 59, 59, 999)).toISOString()
}

function formatSaoPauloDateKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SAO_PAULO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const map = {}
  for (const part of parts) map[part.type] = part.value
  return `${map.year}-${map.month}-${map.day}`
}

function todaySaoPauloDateKey() {
  return formatSaoPauloDateKey(new Date())
}

function addDaysDateKey(dateKey, days) {
  const parsed = parseDateOnly(dateKey)
  if (!parsed) return todaySaoPauloDateKey()
  return formatSaoPauloDateKey(new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d + days, 12, 0, 0, 0)))
}

function chunkArray(items, size) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

module.exports = {
  SAO_PAULO_TZ,
  clampInt,
  fetchAllRows,
  fetchUsuariosNomeMap,
  saoPauloDateStartIso,
  saoPauloDateEndIso,
  todaySaoPauloDateKey,
  addDaysDateKey,
  chunkArray,
}
