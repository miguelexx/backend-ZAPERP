/**
 * Observabilidade do Disparo (Etapa 9) — leitura apenas, sem mutar env nem executar deletes.
 */

const supabase = require('../config/supabase')
const { getDisparoFlags } = require('./disparoWorkerConfig')

/** Status relevantes para snapshot de fila por empresa. */
const FILA_STATUS_SNAPSHOT = [
  'pendente',
  'reservada',
  'enviando',
  'incerta',
  'enviada',
  'entregue',
  'lida',
  'respondida',
  'falhou',
  'ignorada',
  'optout',
  'cancelada',
]

const HEARTBEAT_SELECT =
  'worker_id, hostname, pid, dry_run, live_enabled, ultima_atividade_em, iniciado_em, meta'

/**
 * Snapshot de saúde do Disparo para uma empresa.
 * @param {number} companyId
 * @param {{ client?: object, janelaMinutos?: number }} [opts]
 */
async function snapshotSaudeDisparo(companyId, { client = supabase, janelaMinutos = 15 } = {}) {
  const cid = Number(companyId)
  if (!Number.isInteger(cid) || cid <= 0) {
    throw new Error('companyId inválido')
  }

  const flags = getDisparoFlags()
  const limiteIso = new Date(Date.now() - janelaMinutos * 60 * 1000).toISOString()

  const [statusCounts, heartbeatResult] = await Promise.all([
    contarFilaPorStatus(client, cid),
    client
      .from('disparo_worker_heartbeat')
      .select(HEARTBEAT_SELECT)
      .gte('ultima_atividade_em', limiteIso)
      .order('ultima_atividade_em', { ascending: false }),
  ])

  if (heartbeatResult.error) throw heartbeatResult.error

  const heartbeats = heartbeatResult.data ?? []
  const pendente = statusCounts.pendente ?? 0
  const reservada = statusCounts.reservada ?? 0
  const enviando = statusCounts.enviando ?? 0
  const incerta = statusCounts.incerta ?? 0

  return {
    company_id: cid,
    flags,
    janela_minutos: janelaMinutos,
    fila_por_status: statusCounts,
    fila_pendente: pendente + reservada + enviando,
    incertos: incerta,
    heartbeats,
    workers_ativos: heartbeats.length,
    ultimo_heartbeat_em: heartbeats[0]?.ultima_atividade_em ?? null,
  }
}

async function contarFilaPorStatus(client, companyId) {
  const counts = Object.fromEntries(FILA_STATUS_SNAPSHOT.map((s) => [s, 0]))

  await Promise.all(
    FILA_STATUS_SNAPSHOT.map(async (status) => {
      const { count, error } = await client
        .from('disparo_fila_itens')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('status', status)
      if (error) throw error
      counts[status] = count ?? 0
    }),
  )

  return counts
}

module.exports = {
  FILA_STATUS_SNAPSHOT,
  HEARTBEAT_SELECT,
  snapshotSaudeDisparo,
  contarFilaPorStatus,
}
