const { z } = require('zod')

const prioridadeEnum = z.enum(['baixa', 'normal', 'alta', 'urgente'])
const statusLeadEnum = z.enum(['ativo', 'ganho', 'perdido', 'arquivado'])

const createLeadSchema = z.object({
  nome: z.string().min(1).max(500),
  empresa: z.string().max(500).optional().nullable(),
  telefone: z.string().max(50).optional().nullable(),
  email: z.string().max(320).optional().nullable(),
  valor_estimado: z.number().optional().nullable(),
  probabilidade: z.number().int().min(0).max(100).optional().nullable(),
  prioridade: prioridadeEnum.optional(),
  pipeline_id: z.number().int().positive().optional().nullable(),
  stage_id: z.number().int().positive().optional().nullable(),
  cliente_id: z.number().int().positive().optional().nullable(),
  conversa_id: z.number().int().positive().optional().nullable(),
  responsavel_id: z.union([z.number().int().positive(), z.null()]).optional(),
  origem_id: z.number().int().positive().optional().nullable(),
  data_proximo_contato: z.string().optional().nullable(),
  observacoes: z.string().max(20000).optional().nullable(),
  tag_ids: z.array(z.number().int().positive()).optional(),
  vincular_cliente_por_telefone: z.boolean().optional(),
})

const moveLeadSchema = z.object({
  pipeline_id: z.number().int().positive().optional(),
  stage_id: z.number().int().positive(),
  ordem: z.number().int().min(0).optional(),
  motivo: z.string().max(2000).optional().nullable(),
  motivo_perda: z.string().max(2000).optional().nullable(),
  perdido_motivo: z.string().max(2000).optional().nullable(),
  bloquear_cruzamento_pipeline: z.boolean().optional(),
  retornar_snapshot: z.boolean().optional(),
})

const reorderSchema = z.object({
  stage_id: z.number().int().positive(),
  lead_ids: z.array(z.number().int().positive()).min(1),
})

const notaSchema = z.object({
  texto: z.string().min(1).max(20000),
})

/** Body opcional em POST /leads/from-conversa/:id — sobrescreve ou complementa dados inferidos. */
const fromConversaBodySchema = z.object({
  nome: z.string().min(1).max(500).optional(),
  empresa: z.string().max(500).optional().nullable(),
  telefone: z.string().max(50).optional().nullable(),
  email: z.string().max(320).optional().nullable(),
  pipeline_id: z.number().int().positive().optional().nullable(),
  stage_id: z.number().int().positive().optional().nullable(),
  origem_id: z.number().int().positive().optional().nullable(),
  responsavel_id: z.union([z.number().int().positive(), z.null()]).optional(),
  tag_ids: z.array(z.number().int().positive()).optional(),
  prioridade: prioridadeEnum.optional(),
  valor_estimado: z.number().optional().nullable(),
  probabilidade: z.number().int().min(0).max(100).optional().nullable(),
  observacoes: z.string().max(20000).optional().nullable(),
  /** default true — copia tags de conversa_tags para o lead */
  vincular_tags_da_conversa: z.boolean().optional(),
  /** default true — cria nota interna com trecho do histórico recente */
  criar_nota_com_resumo: z.boolean().optional(),
  /** Se já existir lead para esta conversa: mescla tags e atualiza última interação (default true) */
  sincronizar_duplicata: z.boolean().optional(),
  /** Só quando sincronizar_duplicata: também define responsável (default false) */
  atualizar_responsavel_em_duplicata: z.boolean().optional(),
})

const atividadeSchema = z.object({
  tipo: z.enum([
    'ligacao', 'reuniao', 'whatsapp', 'email', 'tarefa', 'nota',
    'visita', 'proposta', 'demo', 'outro',
  ]),
  titulo: z.string().min(1).max(500),
  descricao: z.string().max(20000).optional().nullable(),
  status: z.enum(['pendente', 'concluida', 'cancelada']).optional(),
  data_agendada: z.string().optional().nullable(),
  data_fim: z.string().optional().nullable(),
  timezone: z.string().max(64).optional().nullable(),
  participantes: z.array(z.object({ email: z.string().email(), nome: z.string().optional() })).optional(),
  responsavel_id: z.number().int().positive().optional().nullable(),
  sync_google: z.boolean().optional(),
})

function safeParse(schema, data) {
  const r = schema.safeParse(data)
  if (!r.success) {
    const msg = r.error?.issues?.map((i) => i.message).join('; ') || 'Validação inválida'
    const err = new Error(msg)
    err.status = 400
    throw err
  }
  return r.data
}

module.exports = {
  createLeadSchema,
  fromConversaBodySchema,
  moveLeadSchema,
  reorderSchema,
  notaSchema,
  atividadeSchema,
  prioridadeEnum,
  statusLeadEnum,
  safeParse,
}
