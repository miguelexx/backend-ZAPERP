/**
 * Planejamento de retenção do Disparo (Etapa 9).
 *
 * IMPORTANTE: este módulo é DRY RUN — retorna apenas o plano de limpeza.
 * Nenhum DELETE é executado aqui. Qualquer limpeza real exige autorização
 * explícita do operador (ambiente, janela de manutenção e backup).
 */

const DEFAULT_BATCH_SIZE = 500
const MAX_BATCH_SIZE = 2000
const MIN_DIAS = 1
const MAX_DIAS = 3650

function clampDias(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_DIAS, Math.max(MIN_DIAS, Math.floor(n)))
}

function clampBatch(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_BATCH_SIZE
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(n)))
}

/**
 * Gera plano de retenção (informativo) sem executar deletes.
 * @param {{ diasEventos?: number, diasHeartbeat?: number, batchSize?: number }} [opts]
 */
function planRetencao({
  diasEventos = 90,
  diasHeartbeat = 7,
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  const diasEv = clampDias(diasEventos, 90)
  const diasHb = clampDias(diasHeartbeat, 7)
  const lote = clampBatch(batchSize)
  const agora = new Date()
  const cutoffEventos = new Date(agora.getTime() - diasEv * 86400000).toISOString()
  const cutoffHeartbeat = new Date(agora.getTime() - diasHb * 86400000).toISOString()

  return {
    aviso:
      'Plano informativo apenas — NÃO executa deletes. Limpeza requer autorização explícita do operador.',
    autorizacao_necessaria: true,
    executado: false,
    gerado_em: agora.toISOString(),
    batch_size: lote,
    parametros: {
      dias_eventos: diasEv,
      dias_heartbeat: diasHb,
    },
    operacoes: [
      {
        ordem: 1,
        tabela: 'disparo_execucao_eventos',
        acao: 'DELETE',
        descricao: 'Eventos de execução antigos',
        condicao_sql: `criado_em < timestamptz '${cutoffEventos}'`,
        cutoff_iso: cutoffEventos,
        estrategia: `DELETE ... WHERE criado_em < $cutoff LIMIT ${lote} (repetir em lotes até esgotar)`,
        estimativa_lotes: 'desconhecida até COUNT prévio',
      },
      {
        ordem: 2,
        tabela: 'disparo_worker_heartbeat',
        acao: 'DELETE',
        descricao: 'Heartbeats de workers inativos',
        condicao_sql: `ultima_atividade_em < timestamptz '${cutoffHeartbeat}'`,
        cutoff_iso: cutoffHeartbeat,
        estrategia: `DELETE ... WHERE ultima_atividade_em < $cutoff LIMIT ${lote}`,
        estimativa_lotes: 'desconhecida até COUNT prévio',
      },
    ],
    pre_requisitos: [
      'Autorização explícita do responsável técnico',
      'Janela de manutenção acordada',
      'Backup/snapshot recente do banco',
      'Validar contagem (SELECT COUNT) antes do primeiro lote',
    ],
  }
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  planRetencao,
}
