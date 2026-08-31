const supabase = require('../../config/supabase')
const slaCalculationService = require('../../services/slaCalculationService')
const { getDisplayName } = require('../../helpers/contactEnrichment')
const ExcelJS = require('exceljs')
const { fetchUsuariosNomeMap } = require('./helpers')

async function getSlaConfig(req, res) {
  try {
    const { company_id } = req.user
    const config = await slaCalculationService.loadSlaConfig(company_id)
    const businessInfo = await slaCalculationService.loadSlaBusinessSchedule(company_id, config)
    return res.json({
      sla_minutos_sem_resposta: config.sla_minutos_sem_resposta,
      sla_meta_percentual: config.sla_meta_percentual,
      sla_usar_horario_comercial: config.sla_usar_horario_comercial,
      sla_contar_bot_como_resposta: config.sla_contar_bot_como_resposta,
      metas_departamentos: config.metas_departamentos,
      metas_usuarios: config.metas_usuarios,
      horario_comercial: businessInfo,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao obter config SLA' })
  }
}

async function setSlaConfig(req, res) {
  try {
    const { company_id } = req.user
    const saved = await slaCalculationService.saveSlaConfig(company_id, req.body || {})
    const businessInfo = await slaCalculationService.loadSlaBusinessSchedule(company_id, saved)
    return res.json({
      sla_minutos_sem_resposta: saved.sla_minutos_sem_resposta,
      sla_meta_percentual: saved.sla_meta_percentual,
      sla_usar_horario_comercial: saved.sla_usar_horario_comercial,
      sla_contar_bot_como_resposta: saved.sla_contar_bot_como_resposta,
      metas_departamentos: saved.metas_departamentos,
      metas_usuarios: saved.metas_usuarios,
      horario_comercial: businessInfo,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao salvar config SLA' })
  }
}

// =====================================================
// SLA: ALERTAS (conversas onde cliente está X min sem resposta)
// =====================================================
async function getSlaAlertas(req, res) {
  try {
    const { company_id } = req.user
    const { data: emp } = await supabase.from('empresas').select('sla_minutos_sem_resposta').eq('id', company_id).single()
    const limiteMin = emp?.sla_minutos_sem_resposta ?? 30

    const { data: conversas } = await supabase
      .from('conversas')
      .select('id, telefone, status_atendimento, criado_em, atendente_id, clientes!conversas_cliente_fk ( nome )')
      .eq('company_id', company_id)
      .in('status_atendimento', ['aberta', 'em_atendimento'])

    const atendenteNomeMap = await fetchUsuariosNomeMap(
      company_id,
      (conversas || []).map((c) => c?.atendente_id)
    )

    const { data: mensagens } = await supabase
      .from('mensagens')
      .select('conversa_id, criado_em, direcao')
      .eq('company_id', company_id)
      .in('direcao', ['in', 'out'])
      .order('criado_em', { ascending: false })

    const ultimaInPorConversa = {}
    ;(mensagens || []).forEach(m => {
      if (m.direcao === 'in' && !ultimaInPorConversa[m.conversa_id]) ultimaInPorConversa[m.conversa_id] = m
    })

    const now = Date.now()
    const alertas = []
    ;(conversas || []).forEach(c => {
      const ultimaIn = ultimaInPorConversa[c.id]
      if (!ultimaIn) return
      const minSemResponder = Math.floor((now - new Date(ultimaIn.criado_em).getTime()) / 60000)
      if (minSemResponder >= limiteMin) {
        alertas.push({
          conversa_id: c.id,
          cliente_nome: getDisplayName(c.clientes) || c.telefone,
          telefone: c.telefone,
          atendente_nome: atendenteNomeMap[String(c?.atendente_id)] || '—',
          tempo_sem_responder_min: minSemResponder,
          limite_min: limiteMin,
        })
      }
    })
    alertas.sort((a, b) => b.tempo_sem_responder_min - a.tempo_sem_responder_min)
    return res.json({ limite_min: limiteMin, alertas })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar alertas SLA' })
  }
}

async function slaResumo(req, res) {
  try {
    const { company_id } = req.user
    const data = await slaCalculationService.buildSlaAnalytics(company_id, req.query)
    return res.json({
      periodo: data.periodo,
      limite_min: data.limite_min,
      meta_percentual: data.meta_percentual,
      config: data.config,
      horario_comercial: data.horario_comercial,
      resumo: data.resumo,
      tendencia: data.tendencia,
      por_tipo: data.por_tipo,
      ranking_atendentes: data.ranking_atendentes,
      ranking_atendentes_melhor: data.ranking_atendentes_melhor,
      ranking_atendentes_violacoes: data.ranking_atendentes_violacoes,
      ranking_setores: data.ranking_setores,
      horarios_maior_violacao: data.horarios_maior_violacao,
      dias_semana_pior_sla: data.dias_semana_pior_sla,
      violacoes: data.violacoes,
      sem_resposta: data.sem_resposta,
      dados_insuficientes: data.dados_insuficientes,
      criticas_sem_resposta: data.criticas_sem_resposta,
      conversas_detalhadas: data.conversas_detalhadas,
      reabertura: data.reabertura,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao calcular SLA' })
  }
}

async function slaDiaria(req, res) {
  try {
    const { company_id } = req.user
    const data = await slaCalculationService.buildSlaAnalytics(company_id, req.query)
    return res.json({
      periodo: data.periodo,
      limite_min: data.limite_min,
      meta_percentual: data.meta_percentual,
      config: data.config,
      horario_comercial: data.horario_comercial,
      resumo: data.resumo,
      tendencia: data.tendencia,
      diario: data.diario,
      melhor_dia: data.melhor_dia,
      pior_dia: data.pior_dia,
      dias_abaixo_meta: data.dias_abaixo_meta,
      ranking_atendentes: data.ranking_atendentes,
      ranking_setores: data.ranking_setores,
      dia_detalhe: data.dia_filtro ? {
        dia: data.dia_filtro,
        violacoes: data.violacoes,
        sem_resposta: data.sem_resposta,
        dados_insuficientes: data.dados_insuficientes,
        conversas_detalhadas: data.conversas_detalhadas,
      } : null,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao calcular SLA diária' })
  }
}

async function slaValidacao(req, res) {
  try {
    const { company_id } = req.user
    const conversaId = req.params.conversa_id || req.query.conversa_id
    const result = await slaCalculationService.validateConversaSla(company_id, conversaId)
    if (result.error) return res.status(400).json({ error: result.error })
    return res.json(result)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao validar SLA da conversa' })
  }
}

function escapeCsvCell(value) {
  return String(value ?? '').replace(/;/g, ',').replace(/\n/g, ' ')
}

async function exportSla(req, res) {
  try {
    const { company_id } = req.user
    const format = (req.query.format || 'csv').toLowerCase()
    const tipo = String(req.query.tipo || 'detalhado').toLowerCase()
    const data = await slaCalculationService.buildSlaAnalytics(company_id, req.query)
    const exportRows = slaCalculationService.flattenSlaExportRows(data)

    if (tipo === 'resumo') {
      const resumoRows = [
        ['Período início', data.periodo?.data_inicio],
        ['Período fim', data.periodo?.data_fim],
        ['Meta minutos (global)', data.limite_min],
        ['Meta percentual', data.meta_percentual],
        ['Modo contagem', data.horario_comercial?.modo_contagem],
        ['Total analisadas', data.resumo?.total_analisadas],
        ['Dentro SLA', data.resumo?.dentro_sla],
        ['Fora SLA', data.resumo?.fora_sla],
        ['Sem resposta', data.resumo?.sem_resposta],
        ['Dados insuficientes', data.resumo?.dados_insuficientes],
        ['Percentual cumprido', data.resumo?.percentual_cumprido],
        ['Tempo médio (min)', data.resumo?.tempo_medio_primeira_resposta_min],
        ['Pior tempo (min)', data.resumo?.pior_tempo_resposta_min],
        ['Melhor tempo (min)', data.resumo?.melhor_tempo_resposta_min],
      ]
      if (format === 'xlsx' || format === 'excel') {
        const workbook = new ExcelJS.Workbook()
        const sheet = workbook.addWorksheet('Resumo SLA')
        resumoRows.forEach((row) => sheet.addRow(row))
        const buffer = await workbook.xlsx.writeBuffer()
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', 'attachment; filename=sla-resumo.xlsx')
        return res.send(Buffer.from(buffer))
      }
      const csv = '\uFEFF' + resumoRows.map((row) => row.map(escapeCsvCell).join(';')).join('\n')
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename=sla-resumo.csv')
      return res.send(csv)
    }

    const header = ['Tipo SLA', 'Status SLA', 'Cliente', 'Telefone', 'Atendente', 'Setor', 'Primeira msg cliente', 'Primeira resposta', 'Tempo (min)', 'Meta (min)', 'Origem meta', 'Tipo resposta', 'Status conversa', 'Conversa ID']
    const body = exportRows.map((r) => [
      r.tipo_sla,
      r.status_sla,
      r.cliente,
      r.telefone,
      r.atendente,
      r.setor,
      r.primeira_msg_cliente ? new Date(r.primeira_msg_cliente).toLocaleString('pt-BR') : '',
      r.primeira_resposta ? new Date(r.primeira_resposta).toLocaleString('pt-BR') : '',
      r.tempo_min,
      r.limite_min,
      r.meta_origem,
      r.tipo_resposta,
      r.status_conversa,
      r.conversa_id,
    ])

    if (format === 'xlsx' || format === 'excel') {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('SLA Detalhado', { views: [{ state: 'frozen', ySplit: 1 }] })
      sheet.addRow(header)
      sheet.getRow(1).font = { bold: true }
      body.forEach((row) => sheet.addRow(row))
      const buffer = await workbook.xlsx.writeBuffer()
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', 'attachment; filename=sla-detalhado.xlsx')
      return res.send(Buffer.from(buffer))
    }

    const csv = '\uFEFF' + [header, ...body].map((row) => row.map(escapeCsvCell).join(';')).join('\n')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename=sla-detalhado.csv')
    return res.send(csv)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao exportar SLA' })
  }
}

module.exports = {
  getSlaConfig,
  setSlaConfig,
  getSlaAlertas,
  slaResumo,
  slaDiaria,
  slaValidacao,
  exportSla,
}
