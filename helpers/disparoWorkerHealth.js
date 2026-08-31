/**
 * Saúde do worker de Disparo — classificação a partir de disparo_worker_heartbeat.
 * Não marca "ativo" só porque existe uma linha: exige heartbeat recente e status running.
 */

const supabase = require('../config/supabase')
const { getDisparoFlags } = require('./disparoWorkerConfig')

const HEARTBEAT_SELECT =
  'worker_id, hostname, pid, dry_run, live_enabled, ultima_atividade_em, iniciado_em, meta'

/** Worker saudável se o último heartbeat chegou nesta janela. */
const HEARTBEAT_ATIVO_MS = 45_000
/** Após isto, some da janela de "sem heartbeat" e vira offline. */
const HEARTBEAT_STALE_MS = 10 * 60_000
/** Primeiros segundos após boot. */
const HEARTBEAT_INICIANDO_MS = 30_000

const STATUS_ATIVO = 'ativo'
const STATUS_INICIANDO = 'iniciando'
const STATUS_SEM_HEARTBEAT = 'sem_heartbeat'
const STATUS_DESABILITADO = 'desabilitado'
const STATUS_OFFLINE = 'offline'

const MOTIVO = {
  [STATUS_ATIVO]: 'Worker processando a fila',
  [STATUS_INICIANDO]: 'Worker iniciando',
  [STATUS_SEM_HEARTBEAT]: 'Worker sem heartbeat recente',
  [STATUS_DESABILITADO]: 'Worker em execução mas DISPARO_WORKER_ENABLED=false — a fila não será processada',
  [STATUS_OFFLINE]: 'Nenhum worker ativo detectado',
}

function parseMeta(meta) {
  if (!meta) return {}
  if (typeof meta === 'string') {
    try {
      return JSON.parse(meta) || {}
    } catch {
      return {}
    }
  }
  return typeof meta === 'object' ? meta : {}
}

function ageMs(iso, now) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return now - t
}

/**
 * Classifica um registro de heartbeat.
 * @param {object|null} row
 * @param {number} [now]
 */
function classifyHeartbeat(row, now = Date.now()) {
  if (!row) return STATUS_OFFLINE
  const meta = parseMeta(row.meta)
  const statusMeta = String(meta.status || '').toLowerCase()
  const age = ageMs(row.ultima_atividade_em, now)
  const bootAge = ageMs(row.iniciado_em, now)

  if (statusMeta === 'offline' || meta.shutdown === true) {
    return STATUS_OFFLINE
  }

  const disabled =
    statusMeta === 'disabled' ||
    meta.workerEnabled === false ||
    row.worker_enabled === false

  if (disabled) {
    return age <= HEARTBEAT_STALE_MS ? STATUS_DESABILITADO : STATUS_OFFLINE
  }

  const booting =
    meta.boot === true ||
    statusMeta === 'starting' ||
    bootAge <= HEARTBEAT_INICIANDO_MS

  if (booting && age <= HEARTBEAT_INICIANDO_MS) {
    return STATUS_INICIANDO
  }

  if (age <= HEARTBEAT_ATIVO_MS) return STATUS_ATIVO
  if (age <= HEARTBEAT_STALE_MS) return STATUS_SEM_HEARTBEAT
  return STATUS_OFFLINE
}

const STATUS_RANK = {
  [STATUS_ATIVO]: 5,
  [STATUS_INICIANDO]: 4,
  [STATUS_DESABILITADO]: 3,
  [STATUS_SEM_HEARTBEAT]: 2,
  [STATUS_OFFLINE]: 1,
}

/**
 * Agrega vários heartbeats no estado do painel.
 * @param {object[]} rows
 * @param {{ now?: number, flags?: object }} [opts]
 */
function classifyWorkerHealth(rows, { now = Date.now(), flags } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const workers = list.map((row) => {
    const status = classifyHeartbeat(row, now)
    return {
      ...row,
      status,
      saudavel: status === STATUS_ATIVO || status === STATUS_INICIANDO,
    }
  })

  let status = STATUS_OFFLINE
  for (const w of workers) {
    if ((STATUS_RANK[w.status] || 0) > (STATUS_RANK[status] || 0)) {
      status = w.status
    }
  }

  const saudaveis = workers.filter((w) => w.saudavel)
  const saudavel = saudaveis.length > 0
  const workersLive = saudaveis.filter((w) => {
    const meta = parseMeta(w.meta)
    return w.live_enabled === true && w.dry_run === false && meta.canSendLive === true
  })
  const workersDry = saudaveis.filter((w) => !workersLive.includes(w))
  const ultimo = list
    .map((r) => r.ultima_atividade_em)
    .filter(Boolean)
    .sort()
    .reverse()[0] || null

  return {
    status,
    saudavel,
    motivo: MOTIVO[status] || MOTIVO[STATUS_OFFLINE],
    workers_ativos: saudaveis.length,
    workers_live_ativos: workersLive.length,
    workers_dry_ativos: workersDry.length,
    saudavel_live: workersLive.length > 0,
    modos_divergentes: workersLive.length > 0 && workersDry.length > 0,
    workers,
    heartbeats: workers,
    ultimo_heartbeat_em: ultimo,
    janela_ativo_segundos: Math.round(HEARTBEAT_ATIVO_MS / 1000),
    janela_stale_minutos: Math.round(HEARTBEAT_STALE_MS / 60000),
    janela_minutos: Math.round(HEARTBEAT_STALE_MS / 60000),
    flags: flags || getDisparoFlags(),
  }
}

async function carregarHeartbeats(client = supabase) {
  const { data, error } = await client
    .from('disparo_worker_heartbeat')
    .select(HEARTBEAT_SELECT)
    .order('ultima_atividade_em', { ascending: false })
    .limit(50)
  if (error) throw error
  return data ?? []
}

/**
 * Snapshot de saúde do processo worker (global — a tabela não tem company_id).
 */
async function avaliarSaudeWorker({ client = supabase, now = Date.now() } = {}) {
  const rows = await carregarHeartbeats(client)
  return classifyWorkerHealth(rows, { now, flags: getDisparoFlags() })
}

module.exports = {
  HEARTBEAT_SELECT,
  HEARTBEAT_ATIVO_MS,
  HEARTBEAT_STALE_MS,
  HEARTBEAT_INICIANDO_MS,
  STATUS_ATIVO,
  STATUS_INICIANDO,
  STATUS_SEM_HEARTBEAT,
  STATUS_DESABILITADO,
  STATUS_OFFLINE,
  MOTIVO,
  parseMeta,
  classifyHeartbeat,
  classifyWorkerHealth,
  carregarHeartbeats,
  avaliarSaudeWorker,
}
