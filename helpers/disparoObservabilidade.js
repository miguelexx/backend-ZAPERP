/**
 * Observabilidade do Disparo (Etapa 9) — leitura apenas, sem mutar env nem executar deletes.
 */

const supabase = require('../config/supabase')
const { getDisparoFlags } = require('./disparoWorkerConfig')
const { avaliarSaudeWorker, HEARTBEAT_SELECT } = require('./disparoWorkerHealth')

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

/**
 * Snapshot de saúde do Disparo para uma empresa.
 * @param {number} companyId
 * @param {{ client?: object, janelaMinutos?: number }} [opts]
 */
async function snapshotSaudeDisparo(companyId, { client = supabase } = {}) {
  const cid = Number(companyId)
  if (!Number.isInteger(cid) || cid <= 0) {
    throw new Error('companyId inválido')
  }

  const flags = getDisparoFlags()
  const [statusCounts, workerSaude] = await Promise.all([
    contarFilaPorStatus(client, cid),
    avaliarSaudeWorker({ client }),
  ])

  const pendente = statusCounts.pendente ?? 0
  const reservada = statusCounts.reservada ?? 0
  const enviando = statusCounts.enviando ?? 0
  const incerta = statusCounts.incerta ?? 0

  return {
    company_id: cid,
    flags,
    janela_minutos: workerSaude.janela_minutos,
    janela_ativo_segundos: workerSaude.janela_ativo_segundos,
    fila_por_status: statusCounts,
    fila_pendente: pendente + reservada + enviando,
    incertos: incerta,
    heartbeats: workerSaude.heartbeats,
    workers_ativos: workerSaude.workers_ativos,
    ultimo_heartbeat_em: workerSaude.ultimo_heartbeat_em,
    worker_status: workerSaude.status,
    worker_saudavel: workerSaude.saudavel,
    worker_motivo: workerSaude.motivo,
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
