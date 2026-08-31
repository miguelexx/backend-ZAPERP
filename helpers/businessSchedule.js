/**
 * Horário comercial puro (janelas, timezone, minutos úteis).
 * Usado pelo alerta sem resposta e pelo SLA.
 * Sem I/O. O recorte de almoço do SLA (SLA_LUNCH_BREAK) permanece em slaCalculationService.
 */

function normalizeHorarioTime(value, fallback = '09:00') {
  const raw = String(value || '').trim()
  const m = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return fallback
  const h = Math.max(0, Math.min(23, parseInt(m[1], 10)))
  const min = Math.max(0, Math.min(59, parseInt(m[2], 10)))
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function normalizeDiasSemanaDesativados(value, fallback = [0, 6]) {
  if (!Array.isArray(value)) return fallback
  const days = [...new Set(value.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
  return days.length ? days : fallback
}

function normalizeDatasEspecificasFechadas(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(
    value
      .map((d) => String(d || '').trim())
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  )].sort()
}

function alertConfigHasOwnSchedule(cfg = {}) {
  return ['horarioInicio', 'horarioFim', 'horariosJanelas', 'diasSemanaDesativados', 'datasEspecificasFechadas']
    .some((key) => Object.prototype.hasOwnProperty.call(cfg, key))
}

function mergeScheduleSource(cfg = {}, ct = {}) {
  const src = alertConfigHasOwnSchedule(cfg) ? cfg : ct
  return {
    horarioInicio: src.horarioInicio || '09:00',
    horarioFim: src.horarioFim || '18:00',
    horariosJanelas: Array.isArray(src.horariosJanelas) ? src.horariosJanelas : [],
    diasSemanaDesativados: normalizeDiasSemanaDesativados(src.diasSemanaDesativados),
    datasEspecificasFechadas: normalizeDatasEspecificasFechadas(src.datasEspecificasFechadas),
  }
}

function minutesSince(iso, now = new Date()) {
  if (!iso) return 0
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((new Date(now).getTime() - ms) / 60000))
}

function parseTimeToMinutes(value, fallback) {
  const raw = String(value || '').trim()
  const m = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return fallback
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return fallback
  }
  return h * 60 + min
}

function normalizeBusinessWindows(ct = {}) {
  const rawJanelas = Array.isArray(ct.horariosJanelas) ? ct.horariosJanelas : []
  const source = rawJanelas.length > 0
    ? rawJanelas.map((j) => ({ inicio: j?.inicio, fim: j?.fim }))
    : [{ inicio: ct.horarioInicio || '09:00', fim: ct.horarioFim || '18:00' }]

  const windows = []
  for (const item of source) {
    const start = parseTimeToMinutes(item?.inicio, null)
    const end = parseTimeToMinutes(item?.fim, null)
    if (start == null || end == null || start === end) continue
    if (start < end) {
      windows.push({ start, end })
    } else {
      windows.push({ start, end: 1440 })
      windows.push({ start: 0, end })
    }
  }

  if (!windows.length) return [{ start: 9 * 60, end: 18 * 60 }]
  return windows
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .reduce((acc, win) => {
      const prev = acc[acc.length - 1]
      if (prev && win.start <= prev.end) {
        prev.end = Math.max(prev.end, win.end)
      } else {
        acc.push({ ...win })
      }
      return acc
    }, [])
}

function getZonedDateParts(date, timezone = 'America/Sao_Paulo') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(new Date(date))
  const get = (type) => parts.find((p) => p.type === type)?.value || ''
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const weekday = weekdayNames.indexOf(get('weekday'))
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday,
    dayKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minuteOfDay: hour * 60 + minute,
    dayNumber: Math.floor(Date.UTC(year, month - 1, day) / 86400000),
  }
}

function partsFromDayNumber(dayNumber) {
  const d = new Date(dayNumber * 86400000)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return {
    year,
    month,
    day,
    weekday: d.getUTCDay(),
    dayKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  }
}

function normalizeBusinessSchedule(cfg = {}, fullConfig = {}) {
  const ct = fullConfig.chatbot_triage && typeof fullConfig.chatbot_triage === 'object'
    ? fullConfig.chatbot_triage
    : {}
  const merged = mergeScheduleSource(cfg, ct)
  const timezone = String(cfg.timezone || ct.timezone || 'America/Sao_Paulo').trim() || 'America/Sao_Paulo'
  return {
    enabled: cfg.horario_comercial_ativo !== false,
    timezone,
    diasSemanaDesativados: merged.diasSemanaDesativados,
    datasEspecificasFechadas: merged.datasEspecificasFechadas,
    windows: normalizeBusinessWindows(merged),
  }
}

function formatScheduleTime(minutes) {
  const n = Math.max(0, Math.min(1439, Math.floor(Number(minutes) || 0)))
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

function summarizeBusinessDays(schedule = {}) {
  if (!schedule?.enabled) return 'todos os dias'
  const closed = new Set(Array.isArray(schedule.diasSemanaDesativados) ? schedule.diasSemanaDesativados : [])
  const activeDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !closed.has(d))
  const names = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']
  if (activeDays.join(',') === '1,2,3,4,5') return 'segunda a sexta'
  if (activeDays.join(',') === '1,2,3,4,5,6') return 'segunda a sabado'
  if (activeDays.join(',') === '0,1,2,3,4,5,6') return 'todos os dias'
  if (!activeDays.length) return 'nenhum dia ativo'
  return activeDays.map((d) => names[d]).join(', ')
}

function describeBusinessSchedule(schedule = {}) {
  if (!schedule?.enabled) {
    return 'Contagem ativa: horario comercial desativado. Os minutos contam de forma corrida.'
  }
  const windows = Array.isArray(schedule.windows) && schedule.windows.length
    ? schedule.windows
    : [{ start: 9 * 60, end: 18 * 60 }]
  const windowsText = windows
    .map((w) => `${formatScheduleTime(w.start)} as ${formatScheduleTime(w.end)}`)
    .join(' e ')
  const daysText = summarizeBusinessDays(schedule)
  const holidayText = Array.isArray(schedule.datasEspecificasFechadas) && schedule.datasEspecificasFechadas.length
    ? ` Datas fechadas: ${schedule.datasEspecificasFechadas.join(', ')}.`
    : ''
  return `Contagem ativa: ${daysText}, das ${windowsText}. Fora desse horario, os minutos ficam pausados e continuam no proximo expediente.${holidayText}`
}

function isBusinessDayParts(parts, schedule) {
  if (!schedule?.enabled) return true
  if (schedule.diasSemanaDesativados?.includes(parts.weekday)) return false
  if (schedule.datasEspecificasFechadas?.includes(parts.dayKey)) return false
  return true
}

function isBusinessTime(date = new Date(), schedule) {
  if (!schedule?.enabled) return true
  const parts = getZonedDateParts(date, schedule.timezone)
  if (!isBusinessDayParts(parts, schedule)) return false
  return (schedule.windows || []).some((w) => parts.minuteOfDay >= w.start && parts.minuteOfDay < w.end)
}

function businessMinutesBetween(startIso, endDate = new Date(), schedule, capMinutes = null) {
  if (!schedule?.enabled) return minutesSince(startIso, endDate)

  const start = new Date(startIso)
  const end = new Date(endDate)
  const startMs = start.getTime()
  const endMs = end.getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0

  const startParts = getZonedDateParts(start, schedule.timezone)
  const endParts = getZonedDateParts(end, schedule.timezone)
  const cap = Number.isFinite(Number(capMinutes)) && Number(capMinutes) > 0 ? Number(capMinutes) : null
  let total = 0

  for (let dayNumber = startParts.dayNumber; dayNumber <= endParts.dayNumber; dayNumber += 1) {
    const dayParts = partsFromDayNumber(dayNumber)
    if (!isBusinessDayParts(dayParts, schedule)) continue

    const rangeStart = dayNumber === startParts.dayNumber ? startParts.minuteOfDay : 0
    const rangeEnd = dayNumber === endParts.dayNumber ? endParts.minuteOfDay : 1440
    if (rangeEnd <= rangeStart) continue

    for (const win of schedule.windows || []) {
      const overlapStart = Math.max(rangeStart, win.start)
      const overlapEnd = Math.min(rangeEnd, win.end)
      if (overlapEnd > overlapStart) total += overlapEnd - overlapStart
      if (cap != null && total >= cap) return Math.floor(total)
    }
  }

  return Math.floor(total)
}

module.exports = {
  normalizeHorarioTime,
  normalizeDiasSemanaDesativados,
  normalizeDatasEspecificasFechadas,
  alertConfigHasOwnSchedule,
  mergeScheduleSource,
  minutesSince,
  normalizeBusinessSchedule,
  formatScheduleTime,
  describeBusinessSchedule,
  isBusinessTime,
  businessMinutesBetween,
}
