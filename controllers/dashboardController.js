const supabase = require('../config/supabase')
const ExcelJS = require('exceljs')
const PDFDocument = require('pdfkit')

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

exports.overview = async (req, res) => {
  const { company_id } = req.user

  try {
    /* ===============================
       1. STATUS DAS CONVERSAS (KPIs)
    =============================== */
    const { data: conversas, error: errConversas } = await supabase
      .from('conversas')
      .select('status_atendimento, criado_em, atendente_id')
      .eq('company_id', company_id)

    if (errConversas) throw errConversas

    const kpis = {
      total: conversas.length,
      abertas: 0,
      em_atendimento: 0,
      fechadas: 0,
      tempo_primeira_resposta_min: null,
      atendimentos_hoje: 0,
      tempo_medio_resposta_min: null,
      sla_percent: null,
      atendente_mais_produtivo: null,
      tickets_abertos: 0,
      taxa_conversao_percent: null,
    }

    conversas.forEach(c => {
      if (c.status_atendimento === 'aberta') kpis.abertas++
      if (c.status_atendimento === 'em_atendimento') kpis.em_atendimento++
      if (c.status_atendimento === 'fechada') kpis.fechadas++
    })

    kpis.tickets_abertos = kpis.abertas + kpis.em_atendimento
    if (kpis.total > 0) {
      kpis.taxa_conversao_percent = Math.round((kpis.fechadas / kpis.total) * 100)
    }

    /* ===============================
       ATENDIMENTOS HOJE (registros na tabela atendimentos)
    =============================== */
    const hoje = startOfToday()
    const { data: atendimentosHoje, error: errAtHoje } = await supabase
      .from('atendimentos')
      .select('id')
      .eq('company_id', company_id)
      .gte('criado_em', hoje)
    if (!errAtHoje) kpis.atendimentos_hoje = atendimentosHoje?.length ?? 0

    /* ===============================
       2. TEMPO MÉDIO DA 1ª RESPOSTA (SLA)
    =============================== */
    const { data: mensagens, error: errMensagens } = await supabase
      .from('mensagens')
      .select('conversa_id, criado_em, direcao')
      .eq('company_id', company_id)
      .in('direcao', ['in', 'out'])
      .order('criado_em', { ascending: true })

    if (errMensagens) throw errMensagens

    const mensagensPorConversa = {}

    mensagens.forEach(msg => {
      if (!mensagensPorConversa[msg.conversa_id]) {
        mensagensPorConversa[msg.conversa_id] = []
      }
      mensagensPorConversa[msg.conversa_id].push(msg)
    })

    let totalMinutos = 0
    let totalConversasComResposta = 0

    Object.values(mensagensPorConversa).forEach(msgs => {
      const primeiraIn = msgs.find(m => m.direcao === 'in')
      const primeiraOut = msgs.find(m => m.direcao === 'out')

      if (primeiraIn && primeiraOut) {
        const diff =
          (new Date(primeiraOut.criado_em) -
            new Date(primeiraIn.criado_em)) /
          60000

        if (diff >= 0) {
          totalMinutos += diff
          totalConversasComResposta++
        }
      }
    })

    if (totalConversasComResposta > 0) {
      const media = totalMinutos / totalConversasComResposta
      kpis.tempo_primeira_resposta_min = Math.round(media)
      kpis.tempo_medio_resposta_min = Math.round(media * 10) / 10
    }

    /* SLA: % de conversas com 1ª resposta em até 5 minutos */
    let conversasComSla = 0
    Object.values(mensagensPorConversa).forEach(msgs => {
      const primeiraIn = msgs.find(m => m.direcao === 'in')
      const primeiraOut = msgs.find(m => m.direcao === 'out')
      if (primeiraIn && primeiraOut) {
        const diff = (new Date(primeiraOut.criado_em) - new Date(primeiraIn.criado_em)) / 60000
        if (diff >= 0 && diff <= 5) conversasComSla++
      }
    })
    const totalComResposta = Object.values(mensagensPorConversa).filter(msgs => {
      const primeiraIn = msgs.find(m => m.direcao === 'in')
      const primeiraOut = msgs.find(m => m.direcao === 'out')
      return primeiraIn && primeiraOut
    }).length
    if (totalComResposta > 0) {
      kpis.sla_percent = Math.round((conversasComSla / totalComResposta) * 100)
    }

    /* ===============================
       3. CONVERSAS POR ATENDENTE + ATENDENTE MAIS PRODUTIVO
    =============================== */
    const { data: porAtendente, error: errAtendente } = await supabase
      .from('conversas')
      .select('atendente_id, usuarios!conversas_atendente_fk ( nome )')
      .eq('company_id', company_id)
      .not('atendente_id', 'is', null)

    if (errAtendente) throw errAtendente

    const atendentesMap = {}

    porAtendente.forEach(c => {
      const nome = c.usuarios?.nome || 'Sem nome'
      atendentesMap[nome] = (atendentesMap[nome] || 0) + 1
    })

    const conversasPorAtendente = Object.entries(atendentesMap).map(
      ([nome, total]) => ({
        nome,
        total,
      })
    )

    if (conversasPorAtendente.length > 0) {
      const top = conversasPorAtendente.sort((a, b) => b.total - a.total)[0]
      kpis.atendente_mais_produtivo = top?.nome ?? null
    }

    /* ===============================
       4. CONVERSAS POR HORA
    =============================== */
    const porHoraMap = {}

    conversas.forEach(c => {
      const hora = new Date(c.criado_em).getHours()
      porHoraMap[hora] = (porHoraMap[hora] || 0) + 1
    })

    const conversasPorHora = Object.entries(porHoraMap)
      .map(([hora, total]) => ({
        hora: `${hora.toString().padStart(2, '0')}:00`,
        total,
      }))
      .sort((a, b) => a.hora.localeCompare(b.hora))

    /* ===============================
       RESPONSE FINAL
    =============================== */
    res.json({
      kpis,
      conversas_por_atendente: conversasPorAtendente,
      conversas_por_hora: conversasPorHora,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao gerar dashboard' })
  }
}

// =====================================================
// DEPARTAMENTOS (setores: Financeiro, Suporte, Comercial)
// =====================================================
exports.listarDepartamentos = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('departamentos')
      .select('id, nome, criado_em')
      .eq('company_id', company_id)
      .order('nome')
    if (error) return res.status(500).json({ error: error.message })
    return res.json(data || [])
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar departamentos' })
  }
}

exports.criarDepartamento = async (req, res) => {
  try {
    const { company_id } = req.user
    const { nome } = req.body
    if (!nome?.trim()) return res.status(400).json({ error: 'nome é obrigatório' })
    const { data, error } = await supabase
      .from('departamentos')
      .insert({ company_id, nome: nome.trim() })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar departamento' })
  }
}

exports.atualizarDepartamento = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const { nome } = req.body
    if (!nome?.trim()) return res.status(400).json({ error: 'nome é obrigatório' })
    const { data, error } = await supabase
      .from('departamentos')
      .update({ nome: nome.trim() })
      .eq('id', id)
      .eq('company_id', company_id)
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Departamento não encontrado' })
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar departamento' })
  }
}

exports.excluirDepartamento = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const depId = Number(id)

    // Verifica se há usuários vinculados a este departamento
    const { data: usuariosNoSetor } = await supabase
      .from('usuarios')
      .select('id, nome')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)

    if (usuariosNoSetor && usuariosNoSetor.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir: ${usuariosNoSetor.length} usuário(s) ainda vinculado(s) a este setor. Reatribua-os em Configurações > Usuários antes de excluir.`
      })
    }

    // Verifica conversas no setor
    const { data: conversasNoSetor } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)

    if (conversasNoSetor && conversasNoSetor.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir: existem ${conversasNoSetor.length} conversa(s) neste setor. Transfira-as para outro setor antes de excluir.`
      })
    }

    // Verifica respostas salvas e regras automáticas vinculadas
    const { data: respostasVinculadas } = await supabase
      .from('respostas_salvas')
      .select('id')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)
    if (respostasVinculadas?.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir: ${respostasVinculadas.length} resposta(s) salva(s) vinculada(s). Altere ou remova o vínculo em Configurações > Respostas salvas.`
      })
    }

    const { data: regrasVinculadas } = await supabase
      .from('regras_automaticas')
      .select('id')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)
    if (regrasVinculadas?.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir: ${regrasVinculadas.length} regra(s) automática(s) vinculada(s). Altere em IA > Respostas automáticas.`
      })
    }

    const { error } = await supabase
      .from('departamentos')
      .delete()
      .eq('id', depId)
      .eq('company_id', company_id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao excluir departamento' })
  }
}

// =====================================================
// RESPOSTAS SALVAS POR SETOR
// =====================================================
exports.listarRespostasSalvas = async (req, res) => {
  try {
    const { company_id } = req.user
    const { departamento_id } = req.query
    let q = supabase
      .from('respostas_salvas')
      .select('id, titulo, texto, departamento_id, criado_em, departamentos(nome)')
      .eq('company_id', company_id)
      .order('titulo')
    if (departamento_id) q = q.eq('departamento_id', departamento_id)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.json(data || [])
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar respostas salvas' })
  }
}

exports.criarRespostaSalva = async (req, res) => {
  try {
    const { company_id } = req.user
    const { titulo, texto, departamento_id } = req.body
    if (!titulo || !texto) return res.status(400).json({ error: 'titulo e texto obrigatórios' })
    const { data, error } = await supabase
      .from('respostas_salvas')
      .insert({ company_id, titulo, texto: String(texto).trim(), departamento_id: departamento_id || null })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar resposta salva' })
  }
}

exports.atualizarRespostaSalva = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const { titulo, texto, departamento_id } = req.body
    const update = {}
    if (titulo !== undefined) update.titulo = titulo.trim()
    if (texto !== undefined) update.texto = String(texto).trim()
    if (departamento_id !== undefined) update.departamento_id = departamento_id || null
    const { data, error } = await supabase
      .from('respostas_salvas')
      .update(update)
      .eq('id', id)
      .eq('company_id', company_id)
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Resposta não encontrada' })
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar resposta salva' })
  }
}

exports.excluirRespostaSalva = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const { error } = await supabase
      .from('respostas_salvas')
      .delete()
      .eq('id', id)
      .eq('company_id', company_id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao excluir resposta salva' })
  }
}

// =====================================================
// RELATÓRIO COMPLETO (conversas + cliente + observações + tags + atendente)
// =====================================================
async function buildRelatorioConversas(company_id, filters = {}) {
  const { data: conversas, error } = await supabase
    .from('conversas')
    .select(`
      id, telefone, status_atendimento, criado_em, atendente_id, departamento_id,
      clientes!conversas_cliente_fk ( nome, observacoes ),
      departamentos ( nome ),
      usuarios!conversas_atendente_fk ( nome ),
      conversa_tags ( tag_id, tags ( id, nome ) )
    `)
    .eq('company_id', company_id)

  if (error) throw error
  let list = conversas || []

  if (filters.data_inicio) list = list.filter(c => new Date(c.criado_em) >= new Date(filters.data_inicio))
  if (filters.data_fim) {
    const fim = new Date(filters.data_fim)
    fim.setHours(23, 59, 59, 999)
    list = list.filter(c => new Date(c.criado_em) <= fim)
  }
  if (filters.status_atendimento) list = list.filter(c => c.status_atendimento === filters.status_atendimento)
  if (filters.atendente_id) list = list.filter(c => Number(c.atendente_id) === Number(filters.atendente_id))
  if (filters.departamento_id) list = list.filter(c => Number(c.departamento_id) === Number(filters.departamento_id))

  const conversaIds = list.map(c => c.id)
  if (conversaIds.length === 0) return []

  const { data: mensagens } = await supabase
    .from('mensagens')
    .select('conversa_id, texto, criado_em, direcao')
    .eq('company_id', company_id)
    .in('conversa_id', conversaIds)
    .order('criado_em', { ascending: false })

  const ultimaPorConversa = {}
  const ultimaInPorConversa = {}
  ;(mensagens || []).forEach(m => {
    if (!ultimaPorConversa[m.conversa_id]) ultimaPorConversa[m.conversa_id] = m
    if (m.direcao === 'in' && !ultimaInPorConversa[m.conversa_id]) ultimaInPorConversa[m.conversa_id] = m
  })

  const now = Date.now()
  return list.map(c => {
    const ultima = ultimaPorConversa[c.id]
    const ultimaIn = ultimaInPorConversa[c.id]
    // Tempo sem responder: só quando a ÚLTIMA mensagem foi do cliente (aguardando resposta)
    let tempo_sem_responder_min = null
    if (ultima?.direcao === 'in' && ultimaIn?.criado_em) {
      tempo_sem_responder_min = Math.round((now - new Date(ultimaIn.criado_em).getTime()) / 60000)
    }
    const tags = (c.conversa_tags || []).map(ct => ct.tags).filter(Boolean)
    return {
      id: c.id,
      cliente_nome: c.clientes?.nome || '—',
      telefone: c.telefone,
      observacoes: c.clientes?.observacoes || '',
      setor: c.departamentos?.nome || '—',
      status_atendimento: c.status_atendimento,
      atendente_nome: c.usuarios?.nome || '—',
      tags: tags.map(t => t.nome).join(', '),
      criado_em: c.criado_em,
      ultima_mensagem: ultima?.texto?.slice(0, 200) || '—',
      ultima_mensagem_em: ultima?.criado_em || null,
      tempo_sem_responder_min,
    }
  })
}

exports.relatorioConversas = async (req, res) => {
  try {
    const { company_id } = req.user
    const filters = {
      data_inicio: req.query.data_inicio,
      data_fim: req.query.data_fim,
      status_atendimento: req.query.status_atendimento,
      atendente_id: req.query.atendente_id,
      departamento_id: req.query.departamento_id,
    }
    const data = await buildRelatorioConversas(company_id, filters)
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao gerar relatório' })
  }
}

function escapeCsv (str) {
  if (str == null) return ''
  return String(str).replace(/;/g, ',').replace(/\n/g, ' ')
}

exports.exportRelatorio = async (req, res) => {
  try {
    const { company_id } = req.user
    const format = (req.query.format || 'csv').toLowerCase()
    const filters = {
      data_inicio: req.query.data_inicio,
      data_fim: req.query.data_fim,
      status_atendimento: req.query.status_atendimento,
      atendente_id: req.query.atendente_id,
      departamento_id: req.query.departamento_id,
    }
    const data = await buildRelatorioConversas(company_id, filters)

    if (format === 'csv') {
      const header = 'Cliente;Telefone;Observações;Setor;Status;Atendente;Tags;Criado em;Última msg;Tempo sem responder (min)\n'
      const rows = data.map(r =>
        [
          escapeCsv(r.cliente_nome),
          escapeCsv(r.telefone),
          escapeCsv(r.observacoes),
          escapeCsv(r.setor),
          escapeCsv(r.status_atendimento),
          escapeCsv(r.atendente_nome),
          escapeCsv(r.tags),
          r.criado_em ? new Date(r.criado_em).toLocaleString('pt-BR') : '',
          escapeCsv(r.ultima_mensagem),
          r.tempo_sem_responder_min != null ? r.tempo_sem_responder_min : '',
        ].join(';')
      ).join('\n')
      const csv = '\uFEFF' + header + rows
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename=relatorio-conversas.csv')
      return res.send(csv)
    }

    if (format === 'xlsx' || format === 'excel') {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Conversas', { views: [{ state: 'frozen', ySplit: 1 }] })
      const cols = [
        { header: 'Cliente', key: 'cliente_nome', width: 22 },
        { header: 'Telefone', key: 'telefone', width: 16 },
        { header: 'Observações', key: 'observacoes', width: 30 },
        { header: 'Setor', key: 'setor', width: 14 },
        { header: 'Status', key: 'status_atendimento', width: 14 },
        { header: 'Atendente', key: 'atendente_nome', width: 18 },
        { header: 'Tags', key: 'tags', width: 20 },
        { header: 'Criado em', key: 'criado_em', width: 18 },
        { header: 'Última msg', key: 'ultima_mensagem', width: 35 },
        { header: 'Tempo sem responder (min)', key: 'tempo_sem_responder_min', width: 14 },
      ]
      sheet.columns = cols
      sheet.getRow(1).font = { bold: true }
      data.forEach(r => {
        sheet.addRow({
          cliente_nome: r.cliente_nome || '',
          telefone: r.telefone || '',
          observacoes: (r.observacoes || '').slice(0, 32000),
          setor: r.setor || '',
          status_atendimento: r.status_atendimento || '',
          atendente_nome: r.atendente_nome || '',
          tags: r.tags || '',
          criado_em: r.criado_em ? new Date(r.criado_em) : null,
          ultima_mensagem: (r.ultima_mensagem || '').slice(0, 32000),
          tempo_sem_responder_min: r.tempo_sem_responder_min != null ? r.tempo_sem_responder_min : '',
        })
      })
      const buffer = await workbook.xlsx.writeBuffer()
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', 'attachment; filename=relatorio-conversas.xlsx')
      return res.send(Buffer.from(buffer))
    }

    if (format === 'pdf') {
      const doc = new PDFDocument({ margin: 30, size: 'A4' })
      const chunks = []
      doc.on('data', chunk => chunks.push(chunk))
      doc.on('end', () => res.send(Buffer.concat(chunks)))
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', 'attachment; filename=relatorio-conversas.pdf')
      doc.fontSize(14).text('Relatório de conversas', { align: 'center' })
      doc.moveDown(0.5)
      doc.fontSize(9)
      const headers = ['Cliente', 'Telefone', 'Setor', 'Status', 'Atendente', 'Criado em', 'Min sem resp.']
      const colWidths = [80, 75, 50, 50, 70, 75, 45]
      let y = doc.y
      headers.forEach((h, i) => {
        doc.text(h, 30 + colWidths.slice(0, i).reduce((a, b) => a + b, 0), y, { width: colWidths[i], continued: false })
      })
      y += 18
      doc.moveTo(30, y).lineTo(570, y).stroke()
      y += 8
      for (const r of data) {
        if (y > 750) {
          doc.addPage()
          y = 30
        }
        const row = [
          (r.cliente_nome || '—').slice(0, 18),
          (r.telefone || '—').slice(0, 14),
          (r.setor || '—').slice(0, 10),
          (r.status_atendimento || '—').slice(0, 12),
          (r.atendente_nome || '—').slice(0, 14),
          r.criado_em ? new Date(r.criado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—',
          r.tempo_sem_responder_min != null ? String(r.tempo_sem_responder_min) : '—',
        ]
        let x = 30
        row.forEach((cell, i) => {
          doc.text(cell, x, y, { width: colWidths[i], ellipsis: true })
          x += colWidths[i]
        })
        y += 16
      }
      doc.end()
      return
    }

    res.setHeader('Content-Type', 'application/json')
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao exportar' })
  }
}

// =====================================================
// SLA: CONFIG (minutos sem resposta para alerta)
// =====================================================
exports.getSlaConfig = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('empresas')
      .select('sla_minutos_sem_resposta')
      .eq('id', company_id)
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ sla_minutos_sem_resposta: data?.sla_minutos_sem_resposta ?? 30 })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao obter config SLA' })
  }
}

exports.setSlaConfig = async (req, res) => {
  try {
    const { company_id } = req.user
    const minutos = Math.max(1, Math.min(1440, Number(req.body.sla_minutos_sem_resposta) || 30))
    const { error } = await supabase
      .from('empresas')
      .update({ sla_minutos_sem_resposta: minutos })
      .eq('id', company_id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ sla_minutos_sem_resposta: minutos })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao salvar config SLA' })
  }
}

// =====================================================
// SLA: ALERTAS (conversas onde cliente está X min sem resposta)
// =====================================================
exports.getSlaAlertas = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data: emp } = await supabase.from('empresas').select('sla_minutos_sem_resposta').eq('id', company_id).single()
    const limiteMin = emp?.sla_minutos_sem_resposta ?? 30

    const { data: conversas } = await supabase
      .from('conversas')
      .select('id, telefone, status_atendimento, criado_em, atendente_id, clientes!conversas_cliente_fk ( nome ), usuarios!conversas_atendente_fk ( nome )')
      .eq('company_id', company_id)
      .in('status_atendimento', ['aberta', 'em_atendimento'])

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
          cliente_nome: c.clientes?.nome || c.telefone,
          telefone: c.telefone,
          atendente_nome: c.usuarios?.nome || '—',
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
