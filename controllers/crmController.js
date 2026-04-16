const repo = require('../repositories/crmRepository')
const crmService = require('../services/crmService')
const crmGoogle = require('../services/crmGoogleService')
const { registrar } = require('../helpers/auditoriaLog')
const {
  safeParse,
  createLeadSchema,
  moveLeadSchema,
  reorderSchema,
  notaSchema,
  atividadeSchema,
} = require('../validators/crmValidators')

function emitCrm(req, companyId, event, payload) {
  try {
    const io = req.app.get('io')
    if (io && typeof io.to === 'function') {
      io.to(`empresa_${companyId}`).emit(event, payload)
    }
  } catch (_) {}
}

function err(res, e, fallback = 'Erro') {
  const status = Number(e?.status) || 500
  const msg = status < 500 ? (e?.message || fallback) : fallback
  if (status >= 500) console.error('[CRM]', e)
  return res.status(status).json({ error: e?.message || fallback })
}

// ---------- Pipelines ----------
exports.listPipelines = async (req, res) => {
  try {
    const { company_id } = req.user
    const ativo = req.query.ativo === 'true' ? true : req.query.ativo === 'false' ? false : undefined
    const data = await repo.listPipelines(company_id, { ativo })
    const inc = String(req.query.include || req.query.inc || '')
    if (inc.includes('stages')) {
      const out = []
      for (const p of data) {
        const stages = await repo.listStages(company_id, { pipeline_id: p.id, ativo: true })
        out.push({ ...p, stages })
      }
      return res.json(out)
    }
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro ao listar pipelines')
  }
}

exports.getPipelineFull = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await crmService.getPipelineComStages(company_id, Number(req.params.id))
    if (!data) return res.status(404).json({ error: 'Não encontrado' })
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro ao obter pipeline')
  }
}

exports.clonePipeline = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const nome = req.body?.nome ? String(req.body.nome).trim() : null
    const data = await crmService.clonePipeline(company_id, userId, Number(req.params.id), nome)
    return res.status(201).json(data)
  } catch (e) {
    return err(res, e, 'Erro ao clonar pipeline')
  }
}

exports.setPipelinePadrao = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await crmService.setPipelinePadrao(company_id, Number(req.params.id))
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro ao definir pipeline padrão')
  }
}

exports.createPipeline = async (req, res) => {
  try {
    const { company_id } = req.user
    const { nome, descricao, cor, ativo, ordem, padrao } = req.body || {}
    if (!nome || !String(nome).trim()) return res.status(400).json({ error: 'nome é obrigatório' })
    const existing = await repo.listPipelines(company_id, {})
    const isFirst = existing.length === 0
    const row = await repo.insertPipeline({
      company_id,
      nome: String(nome).trim(),
      descricao: descricao != null ? String(descricao) : null,
      cor: cor != null ? String(cor) : null,
      ativo: ativo !== false,
      ordem: ordem != null ? Number(ordem) : 0,
      padrao: padrao === true || isFirst,
    })
    if (row.padrao) await repo.clearPadraoExcept(company_id, row.id)
    await registrar({
      company_id,
      usuario_id: req.user.id,
      acao: 'crm_pipeline_criar',
      entidade: 'crm_pipeline',
      entidade_id: row.id,
      detalhes_json: {},
    })
    return res.status(201).json(row)
  } catch (e) {
    return err(res, e, 'Erro ao criar pipeline')
  }
}

exports.getPipeline = async (req, res) => {
  try {
    const { company_id } = req.user
    const row = await repo.getPipelineById(company_id, Number(req.params.id))
    if (!row) return res.status(404).json({ error: 'Não encontrado' })
    return res.json(row)
  } catch (e) {
    return err(res, e, 'Erro ao obter pipeline')
  }
}

exports.updatePipeline = async (req, res) => {
  try {
    const { company_id } = req.user
    const id = Number(req.params.id)
    const patch = {}
    const { nome, descricao, cor, ativo, ordem, padrao } = req.body || {}
    if (nome !== undefined) patch.nome = String(nome).trim()
    if (descricao !== undefined) patch.descricao = descricao
    if (cor !== undefined) patch.cor = cor
    if (ativo !== undefined) patch.ativo = !!ativo
    if (ordem !== undefined) patch.ordem = Number(ordem)
    if (padrao === true) {
      await repo.clearPadraoExcept(company_id, id)
      patch.padrao = true
    } else if (padrao === false) {
      patch.padrao = false
    }
    const row = await repo.updatePipeline(company_id, id, patch)
    if (!row) return res.status(404).json({ error: 'Não encontrado' })
    return res.json(row)
  } catch (e) {
    return err(res, e, 'Erro ao atualizar pipeline')
  }
}

exports.deletePipeline = async (req, res) => {
  try {
    const { company_id } = req.user
    const id = Number(req.params.id)
    const leads = await repo.listLeadsByPipeline(company_id, id)
    if (leads.length) {
      return res.status(409).json({ error: 'Pipeline possui leads — mova ou exclua os leads antes' })
    }
    await repo.deletePipeline(company_id, id)
    await registrar({
      company_id,
      usuario_id: req.user.id,
      acao: 'crm_pipeline_excluir',
      entidade: 'crm_pipeline',
      entidade_id: id,
      detalhes_json: {},
    })
    return res.json({ ok: true })
  } catch (e) {
    return err(res, e, 'Erro ao excluir pipeline')
  }
}

// ---------- Stages ----------
exports.listStages = async (req, res) => {
  try {
    const { company_id } = req.user
    const pipeline_id = req.query.pipeline_id != null ? Number(req.query.pipeline_id) : undefined
    const ativo = req.query.ativo === 'true' ? true : req.query.ativo === 'false' ? false : undefined
    const data = await repo.listStages(company_id, { pipeline_id, ativo })
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro ao listar estágios')
  }
}

exports.createStage = async (req, res) => {
  try {
    const { company_id } = req.user
    const {
      pipeline_id, nome, descricao, cor, ordem, tipo_fechamento, exige_motivo_perda, ativo, inicial,
    } = req.body || {}
    if (!pipeline_id || !nome?.trim()) return res.status(400).json({ error: 'pipeline_id e nome são obrigatórios' })
    const pid = Number(pipeline_id)
    await crmService.assertStageTerminalUniqueness(company_id, pid, tipo_fechamento || null, null)
    const row = await repo.insertStage({
      company_id,
      pipeline_id: pid,
      nome: String(nome).trim(),
      descricao: descricao != null ? String(descricao) : null,
      cor: cor != null ? String(cor) : null,
      ordem: ordem != null ? Number(ordem) : 0,
      tipo_fechamento: tipo_fechamento || null,
      exige_motivo_perda: !!exige_motivo_perda,
      ativo: ativo !== false,
      inicial: false,
    })
    if (inicial === true) await crmService.setStageInicial(company_id, pid, row.id)
    const fresh = await repo.getStageById(company_id, row.id)
    return res.status(201).json(fresh)
  } catch (e) {
    return err(res, e, 'Erro ao criar estágio')
  }
}

exports.updateStage = async (req, res) => {
  try {
    const { company_id } = req.user
    const id = Number(req.params.id)
    const prev = await repo.getStageById(company_id, id)
    if (!prev) return res.status(404).json({ error: 'Não encontrado' })
    const patch = {}
    const b = req.body || {}
    if (b.nome !== undefined) patch.nome = String(b.nome).trim()
    if (b.descricao !== undefined) patch.descricao = b.descricao
    if (b.cor !== undefined) patch.cor = b.cor
    if (b.ordem !== undefined) patch.ordem = Number(b.ordem)
    if (b.tipo_fechamento !== undefined) {
      patch.tipo_fechamento = b.tipo_fechamento
      await crmService.assertStageTerminalUniqueness(
        company_id,
        prev.pipeline_id,
        b.tipo_fechamento || null,
        id
      )
    }
    if (b.exige_motivo_perda !== undefined) patch.exige_motivo_perda = !!b.exige_motivo_perda
    if (b.ativo !== undefined) patch.ativo = !!b.ativo
    if (b.inicial === false) patch.inicial = false
    const row = await repo.updateStage(company_id, id, patch)
    if (!row) return res.status(404).json({ error: 'Não encontrado' })
    if (b.inicial === true) await crmService.setStageInicial(company_id, prev.pipeline_id, id)
    const out = await repo.getStageById(company_id, id)
    return res.json(out)
  } catch (e) {
    return err(res, e, 'Erro ao atualizar estágio')
  }
}

exports.deleteStage = async (req, res) => {
  try {
    const { company_id } = req.user
    const id = Number(req.params.id)
    const leads = await repo.listLeadsByStage(company_id, id)
    if (leads.length) {
      return res.status(409).json({ error: 'Estágio possui leads' })
    }
    await repo.deleteStage(company_id, id)
    return res.json({ ok: true })
  } catch (e) {
    return err(res, e, 'Erro ao excluir estágio')
  }
}

// ---------- Origens ----------
exports.listOrigens = async (req, res) => {
  try {
    const { company_id } = req.user
    const ativo = req.query.ativo === 'true' ? true : req.query.ativo === 'false' ? false : undefined
    const data = await repo.listOrigens(company_id, { ativo })
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro ao listar origens')
  }
}

exports.createOrigem = async (req, res) => {
  try {
    const { company_id } = req.user
    const { nome, descricao, cor, ativo } = req.body || {}
    if (!nome?.trim()) return res.status(400).json({ error: 'nome é obrigatório' })
    const row = await repo.insertOrigem({
      company_id,
      nome: String(nome).trim(),
      descricao: descricao != null ? String(descricao) : null,
      cor: cor != null ? String(cor) : null,
      ativo: ativo !== false,
    })
    return res.status(201).json(row)
  } catch (e) {
    return err(res, e, 'Erro ao criar origem')
  }
}

exports.updateOrigem = async (req, res) => {
  try {
    const { company_id } = req.user
    const id = Number(req.params.id)
    const patch = {}
    const b = req.body || {}
    if (b.nome !== undefined) patch.nome = String(b.nome).trim()
    if (b.descricao !== undefined) patch.descricao = b.descricao
    if (b.cor !== undefined) patch.cor = b.cor
    if (b.ativo !== undefined) patch.ativo = !!b.ativo
    const row = await repo.updateOrigem(company_id, id, patch)
    if (!row) return res.status(404).json({ error: 'Não encontrado' })
    return res.json(row)
  } catch (e) {
    return err(res, e, 'Erro ao atualizar origem')
  }
}

// ---------- Leads ----------
exports.listLeads = async (req, res) => {
  try {
    const { company_id } = req.user
    const result = await crmService.listLeadsEnriched(company_id, req.query || {})
    return res.json(result)
  } catch (e) {
    return err(res, e, 'Erro ao listar leads')
  }
}

exports.exportLeadsCsv = async (req, res) => {
  try {
    const { company_id } = req.user
    const rows = await repo.listLeadsForExport(company_id, req.query || {}, req.query.max || 5000)
    const header = [
      'id', 'nome', 'empresa', 'telefone', 'email', 'valor_estimado', 'status', 'prioridade',
      'pipeline_id', 'stage_id', 'responsavel_id', 'origem_id', 'criado_em', 'atualizado_em',
    ]
    const lines = [header.join(';')]
    for (const r of rows) {
      lines.push(header.map((h) => {
        const v = r[h]
        if (v == null) return ''
        const s = String(v).replace(/"/g, '""')
        return `"${s}"`
      }).join(';'))
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="crm-leads.csv"')
    return res.send('\uFEFF' + lines.join('\n'))
  } catch (e) {
    return err(res, e, 'Erro ao exportar')
  }
}

exports.getLead = async (req, res) => {
  try {
    const { company_id } = req.user
    const id = Number(req.params.id)
    const data = await crmService.getLeadDetailEnriched(company_id, id)
    if (!data) return res.status(404).json({ error: 'Não encontrado' })
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro ao obter lead')
  }
}

exports.createLeadFromConversa = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const cid = Number(req.params.conversaId)
    const lead = await crmService.createLeadFromConversa(company_id, userId, cid, req.body || {})
    emitCrm(req, company_id, 'crm:lead_updated', { lead_id: lead.id, action: 'from_conversa' })
    emitCrm(req, company_id, 'crm:kanban_refresh', { pipeline_id: lead.pipeline_id })
    return res.status(201).json(lead)
  } catch (e) {
    return err(res, e, 'Erro ao criar lead a partir da conversa')
  }
}

exports.createLeadFromCliente = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const clienteId = Number(req.params.clienteId)
    const lead = await crmService.createLeadFromCliente(company_id, userId, clienteId, req.body || {})
    emitCrm(req, company_id, 'crm:lead_updated', { lead_id: lead.id, action: 'from_cliente' })
    emitCrm(req, company_id, 'crm:kanban_refresh', { pipeline_id: lead.pipeline_id })
    return res.status(201).json(lead)
  } catch (e) {
    return err(res, e, 'Erro ao criar lead a partir do cliente')
  }
}

exports.createLead = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const body = safeParse(createLeadSchema, req.body || {})
    const lead = await crmService.createLead(company_id, userId, body, true)
    emitCrm(req, company_id, 'crm:lead_updated', { lead_id: lead.id, action: 'create' })
    emitCrm(req, company_id, 'crm:kanban_refresh', { pipeline_id: lead.pipeline_id })
    return res.status(201).json(lead)
  } catch (e) {
    return err(res, e, 'Erro ao criar lead')
  }
}

exports.updateLead = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const leadId = Number(req.params.id)
    const updated = await crmService.updateLead(company_id, userId, leadId, req.body || {})
    emitCrm(req, company_id, 'crm:lead_updated', { lead_id: leadId, action: 'update' })
    emitCrm(req, company_id, 'crm:kanban_refresh', { pipeline_id: updated.pipeline_id })
    return res.json(updated)
  } catch (e) {
    return err(res, e, 'Erro ao atualizar lead')
  }
}

exports.moveLead = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const leadId = Number(req.params.id)
    const parsed = safeParse(moveLeadSchema, req.body || {})
    const { retornar_snapshot, ...moveBody } = parsed
    const updated = await crmService.moveLead(company_id, userId, leadId, moveBody)
    emitCrm(req, company_id, 'crm:lead_updated', { lead_id: leadId, action: 'move' })
    emitCrm(req, company_id, 'crm:kanban_refresh', { pipeline_id: updated.pipeline_id })
    const wantSnap = retornar_snapshot === true || req.query.snapshot === '1'
    if (wantSnap) {
      const column_totals = await crmService.getColumnTotalsForPipeline(company_id, updated.pipeline_id)
      return res.json({ lead: updated, column_totals })
    }
    return res.json(updated)
  } catch (e) {
    return err(res, e, 'Erro ao mover lead')
  }
}

exports.reorderLeads = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const body = safeParse(reorderSchema, req.body || {})
    const out = await crmService.reorderLeads(company_id, userId, body)
    emitCrm(req, company_id, 'crm:kanban_refresh', {})
    return res.json(out)
  } catch (e) {
    return err(res, e, 'Erro ao reordenar')
  }
}

exports.getLeadHistory = async (req, res) => {
  try {
    const { company_id } = req.user
    const leadId = Number(req.params.id)
    const data = await repo.listMovements(company_id, leadId, { limit: 200 })
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro ao obter histórico')
  }
}

// ---------- Notas ----------
exports.listNotas = async (req, res) => {
  try {
    const { company_id } = req.user
    const leadId = Number(req.params.id)
    const data = await repo.listNotas(company_id, leadId)
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro ao listar notas')
  }
}

exports.createNota = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const leadId = Number(req.params.id)
    const b = safeParse(notaSchema, req.body || {})
    const lead = await repo.getLeadById(company_id, leadId)
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' })
    const row = await repo.insertNota({
      company_id,
      lead_id: leadId,
      texto: b.texto,
      criado_por: userId,
    })
    await repo.updateLead(company_id, leadId, { ultima_interacao_em: new Date().toISOString() })
    await registrar({
      company_id,
      usuario_id: userId,
      acao: 'crm_nota_criar',
      entidade: 'crm_lead',
      entidade_id: leadId,
      detalhes_json: { nota_id: row.id },
    })
    emitCrm(req, company_id, 'crm:lead_updated', { lead_id: leadId, action: 'nota' })
    return res.status(201).json(row)
  } catch (e) {
    return err(res, e, 'Erro ao criar nota')
  }
}

exports.updateNota = async (req, res) => {
  try {
    const { company_id } = req.user
    const leadId = Number(req.params.id)
    const notaId = Number(req.params.notaId)
    const prev = await repo.getNotaById(company_id, notaId)
    if (!prev || prev.lead_id !== leadId) return res.status(404).json({ error: 'Não encontrado' })
    const b = req.body || {}
    if (b.texto === undefined) return res.status(400).json({ error: 'texto é obrigatório' })
    const row = await repo.updateNota(company_id, notaId, { texto: String(b.texto) })
    if (!row) return res.status(404).json({ error: 'Não encontrado' })
    return res.json(row)
  } catch (e) {
    return err(res, e, 'Erro ao atualizar nota')
  }
}

exports.deleteNota = async (req, res) => {
  try {
    const { company_id } = req.user
    const leadId = Number(req.params.id)
    const notaId = Number(req.params.notaId)
    const prev = await repo.getNotaById(company_id, notaId)
    if (!prev || prev.lead_id !== leadId) return res.status(404).json({ error: 'Não encontrado' })
    await repo.deleteNota(company_id, notaId)
    return res.json({ ok: true })
  } catch (e) {
    return err(res, e, 'Erro ao excluir nota')
  }
}

// ---------- Atividades ----------
exports.listAtividades = async (req, res) => {
  try {
    const { company_id } = req.user
    const leadId = Number(req.params.id)
    const data = await repo.listAtividades(company_id, leadId)
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro ao listar atividades')
  }
}

exports.createAtividade = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const leadId = Number(req.params.id)
    const b = safeParse(atividadeSchema, req.body || {})
    const lead = await repo.getLeadById(company_id, leadId)
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' })
    const row = await repo.insertAtividade({
      company_id,
      lead_id: leadId,
      tipo: b.tipo,
      titulo: b.titulo,
      descricao: b.descricao ?? null,
      status: b.status || 'pendente',
      data_agendada: b.data_agendada || null,
      data_fim: b.data_fim || null,
      participantes: Array.isArray(b.participantes) ? b.participantes : [],
      timezone: b.timezone || 'America/Sao_Paulo',
      responsavel_id: b.responsavel_id ?? null,
      criado_por: userId,
    })
    await repo.updateLead(company_id, leadId, { ultima_interacao_em: new Date().toISOString() })
    let google = null
    if (b.sync_google && row.data_agendada) {
      try {
        google = await crmService.syncActivityToGoogle(company_id, userId, row, lead)
      } catch (ge) {
        google = { erro: ge?.message || String(ge) }
      }
    }
    await registrar({
      company_id,
      usuario_id: userId,
      acao: 'crm_atividade_criar',
      entidade: 'crm_atividade',
      entidade_id: row.id,
      detalhes_json: { lead_id: leadId, google: !!google?.synced },
    })
    const fresh = await repo.getAtividadeById(company_id, row.id)
    emitCrm(req, company_id, 'crm:lead_updated', { lead_id: leadId, action: 'atividade' })
    return res.status(201).json({ ...fresh, google_sync: google })
  } catch (e) {
    return err(res, e, 'Erro ao criar atividade')
  }
}

exports.updateAtividade = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const activityId = Number(req.params.activityId)
    const existing = await repo.getAtividadeById(company_id, activityId)
    if (!existing) return res.status(404).json({ error: 'Não encontrado' })
    const b = req.body || {}
    if (b.status === 'cancelada') {
      const row = await crmService.patchActivityStatus(company_id, userId, activityId, 'cancelada', {
        sync_google: false,
      })
      emitCrm(req, company_id, 'crm:lead_updated', { lead_id: existing.lead_id, action: 'atividade' })
      return res.json(row)
    }
    const patch = {}
    if (b.titulo !== undefined) patch.titulo = String(b.titulo)
    if (b.descricao !== undefined) patch.descricao = b.descricao
    if (b.status !== undefined) patch.status = b.status
    if (b.data_agendada !== undefined) patch.data_agendada = b.data_agendada
    if (b.data_fim !== undefined) patch.data_fim = b.data_fim
    if (b.timezone !== undefined) patch.timezone = b.timezone
    if (b.participantes !== undefined) patch.participantes = Array.isArray(b.participantes) ? b.participantes : []
    if (b.responsavel_id !== undefined) patch.responsavel_id = b.responsavel_id
    if (b.status === 'concluida' && !existing.data_conclusao) {
      patch.data_conclusao = new Date().toISOString()
    }
    const row = await repo.updateAtividade(company_id, activityId, patch)
    if (b.status === 'concluida') {
      await registrar({
        company_id,
        usuario_id: userId,
        acao: 'crm_atividade_concluir',
        entidade: 'crm_atividade',
        entidade_id: activityId,
        detalhes_json: {},
      })
    }
    const lead = await repo.getLeadById(company_id, existing.lead_id)
    if (b.sync_google && row.data_agendada && lead) {
      try {
        await crmService.syncActivityToGoogle(company_id, userId, row, lead)
      } catch (_) {}
    }
    emitCrm(req, company_id, 'crm:lead_updated', { lead_id: existing.lead_id, action: 'atividade' })
    return res.json(row)
  } catch (e) {
    return err(res, e, 'Erro ao atualizar atividade')
  }
}

exports.patchAtividadeStatus = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const activityId = Number(req.params.activityId)
    const status = req.body?.status
    if (!status || !['pendente', 'concluida', 'cancelada'].includes(String(status))) {
      return res.status(400).json({ error: 'status inválido' })
    }
    const row = await crmService.patchActivityStatus(company_id, userId, activityId, String(status), {
      sync_google: req.body?.sync_google === true,
    })
    emitCrm(req, company_id, 'crm:lead_updated', { lead_id: row.lead_id, action: 'atividade' })
    return res.json(row)
  } catch (e) {
    return err(res, e, 'Erro ao atualizar status')
  }
}

exports.deleteAtividade = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const activityId = Number(req.params.activityId)
    const out = await crmService.deleteAtividadeFull(company_id, userId, activityId)
    emitCrm(req, company_id, 'crm:lead_updated', { lead_id: out.lead_id, action: 'atividade_excluir' })
    return res.json(out)
  } catch (e) {
    return err(res, e, 'Erro ao excluir atividade')
  }
}

// ---------- Kanban / Agenda / Dashboard ----------
exports.getKanban = async (req, res) => {
  try {
    const { company_id } = req.user
    const pipeline_id = req.query.pipeline_id != null ? Number(req.query.pipeline_id) : null
    const data = await crmService.getKanban(company_id, pipeline_id)
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro ao montar kanban')
  }
}

exports.getAgenda = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await crmService.getAgendaComercial(company_id, req.query || {})
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro na agenda')
  }
}

exports.getAgendaResumo = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await crmService.getAgendaResumo(company_id)
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro no resumo da agenda')
  }
}

exports.getDashboard = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await crmService.getDashboardExtended(company_id, req.query || {})
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro no dashboard')
  }
}

exports.getDashboardFunnel = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await crmService.getDashboardFunnel(company_id, req.query || {})
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro no funil')
  }
}

exports.getDashboardResponsaveis = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await crmService.getDashboardResponsaveis(company_id, req.query || {})
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro no ranking')
  }
}

exports.getDashboardOrigens = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await crmService.getDashboardOrigens(company_id, req.query || {})
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro no ranking de origens')
  }
}

exports.listLostReasons = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await repo.listLostReasons(company_id)
    return res.json(data)
  } catch (e) {
    return err(res, e, 'Erro ao listar motivos')
  }
}

// ---------- Google ----------
exports.googleConnect = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const state = crmGoogle.signState({ cid: company_id, uid: userId, ts: Date.now() })
    const url = crmGoogle.buildAuthUrl(state)
    if (req.query.redirect === '0' || req.query.json === '1') {
      return res.json({ url })
    }
    return res.redirect(302, url)
  } catch (e) {
    return err(res, e, 'Erro ao iniciar OAuth Google')
  }
}

exports.googleCallback = async (req, res) => {
  const { code, state, error: oauthErr } = req.query || {}
  const base = String(process.env.APP_URL || '').trim().replace(/\/$/, '')
  const failRedirect = `${base}/?crm_google=error`
  const okRedirect = `${base}/?crm_google=connected`

  if (oauthErr) {
    return res.redirect(302, `${failRedirect}&reason=${encodeURIComponent(oauthErr)}`)
  }
  try {
    const payload = crmGoogle.verifyState(state)
    if (!payload) return res.redirect(302, failRedirect)
    const company_id = Number(payload.cid)
    const usuario_id = Number(payload.uid)
    const tokens = await crmGoogle.exchangeCode(code)
    const access = tokens.access_token
    let email = null
    try {
      email = await crmGoogle.fetchGoogleUserEmail(access)
    } catch (_) {}
    const expiry = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : Date.now() + 3600 * 1000
    await repo.upsertGoogleTokens({
      company_id,
      usuario_id,
      access_token: access,
      refresh_token: tokens.refresh_token || null,
      scope: tokens.scope || crmGoogle.SCOPES,
      token_type: tokens.token_type || 'Bearer',
      expiry_date: expiry,
      email_google: email,
      calendar_id: 'primary',
      ativo: true,
    })
    await registrar({
      company_id,
      usuario_id,
      acao: 'crm_google_conectar',
      entidade: 'crm_google',
      entidade_id: usuario_id,
      detalhes_json: { email },
    })
    return res.redirect(302, okRedirect)
  } catch (e) {
    console.error('[CRM Google callback]', e)
    return res.redirect(302, failRedirect)
  }
}

exports.googleStatus = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const row = await repo.getGoogleTokens(company_id, userId)
    if (!row) return res.json({ connected: false })
    return res.json({
      connected: !!row.ativo,
      email_google: row.email_google,
      calendar_id: row.calendar_id,
      expiry_date: row.expiry_date,
    })
  } catch (e) {
    return err(res, e, 'Erro ao consultar status')
  }
}

exports.googleDisconnect = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    await repo.deleteGoogleTokens(company_id, userId)
    await registrar({
      company_id,
      usuario_id: userId,
      acao: 'crm_google_desconectar',
      entidade: 'crm_google',
      entidade_id: userId,
      detalhes_json: {},
    })
    return res.json({ ok: true })
  } catch (e) {
    return err(res, e, 'Erro ao desconectar')
  }
}

exports.googleCalendars = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const items = await crmGoogle.fetchCalendarList(company_id, userId)
    return res.json(items)
  } catch (e) {
    return err(res, e, 'Erro ao listar calendários')
  }
}

exports.googleSyncLead = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const leadId = Number(req.params.leadId)
    const out = await crmService.syncLeadToGoogle(company_id, userId, leadId)
    return res.json({ resultados: out })
  } catch (e) {
    return err(res, e, 'Erro ao sincronizar com Google')
  }
}

exports.putGoogleCalendar = async (req, res) => {
  try {
    const { company_id, id: userId } = req.user
    const calendar_id = req.body?.calendar_id
    if (!calendar_id || !String(calendar_id).trim()) {
      return res.status(400).json({ error: 'calendar_id é obrigatório' })
    }
    await repo.updateGoogleTokens(company_id, userId, { calendar_id: String(calendar_id).trim() })
    return res.json({ ok: true })
  } catch (e) {
    return err(res, e, 'Erro ao salvar calendário')
  }
}
