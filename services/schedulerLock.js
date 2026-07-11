const os = require('os')

const OWNER_PREFIX = `${os.hostname()}:${process.pid}`
const missingTableCodes = new Set(['42P01', 'PGRST205', 'PGRST204'])
let missingTableWarned = false
let supabaseClient = null

function getSupabase() {
  if (!supabaseClient) supabaseClient = require('../config/supabase')
  return supabaseClient
}

function isMissingSchedulerLockTable(error) {
  const msg = String(error?.message || error?.details || '').toLowerCase()
  return missingTableCodes.has(String(error?.code || '')) ||
    msg.includes('scheduler_locks') ||
    msg.includes('could not find the table')
}

async function tryAcquireSchedulerLock(name, ttlMs) {
  const lockName = String(name || '').trim()
  if (!lockName) return { acquired: false, unavailable: false }
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
    return { acquired: true, owner: null, name: lockName, unavailable: true }
  }

  const nowIso = new Date().toISOString()
  const owner = `${OWNER_PREFIX}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const lockedUntil = new Date(Date.now() + Math.max(30_000, Number(ttlMs) || 120_000)).toISOString()
  const supabase = getSupabase()
  const row = {
    name: lockName,
    locked_by: owner,
    locked_until: lockedUntil,
    updated_at: nowIso,
  }

  const inserted = await supabase
    .from('scheduler_locks')
    .insert(row)
    .select('name')
    .maybeSingle()

  if (!inserted.error && inserted.data?.name) {
    return { acquired: true, owner, name: lockName }
  }

  if (isMissingSchedulerLockTable(inserted.error)) {
    if (!missingTableWarned) {
      missingTableWarned = true
      console.warn('[schedulerLock] tabela scheduler_locks ausente; usando apenas lock local ate aplicar migration.')
    }
    return { acquired: true, owner: null, name: lockName, unavailable: true }
  }

  const updated = await supabase
    .from('scheduler_locks')
    .update(row)
    .eq('name', lockName)
    .lt('locked_until', nowIso)
    .select('name')
    .maybeSingle()

  if (!updated.error && updated.data?.name) {
    return { acquired: true, owner, name: lockName }
  }

  if (isMissingSchedulerLockTable(updated.error)) {
    if (!missingTableWarned) {
      missingTableWarned = true
      console.warn('[schedulerLock] tabela scheduler_locks ausente; usando apenas lock local ate aplicar migration.')
    }
    return { acquired: true, owner: null, name: lockName, unavailable: true }
  }

  return { acquired: false, owner: null, name: lockName }
}

async function releaseSchedulerLock(lock) {
  if (!lock?.owner || !lock?.name || lock.unavailable) return
  const supabase = getSupabase()
  const unlockedUntil = new Date(0).toISOString()
  const { error } = await supabase
    .from('scheduler_locks')
    .update({
      locked_until: unlockedUntil,
      locked_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq('name', lock.name)
    .eq('locked_by', lock.owner)

  if (error && !isMissingSchedulerLockTable(error)) {
    console.warn('[schedulerLock] falha ao liberar lock:', error.message || error)
  }
}

async function withSchedulerRunLock(name, ttlMs, fn) {
  const lock = await tryAcquireSchedulerLock(name, ttlMs)
  if (!lock.acquired) return { skipped: true, reason: 'locked' }
  try {
    return await fn()
  } finally {
    await releaseSchedulerLock(lock)
  }
}

module.exports = {
  withSchedulerRunLock,
  _test: {
    isMissingSchedulerLockTable,
  },
}
