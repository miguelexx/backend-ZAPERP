const supabase = require('../../config/supabase')
const { getDisplayName } = require('../../helpers/contactEnrichment')
const ExcelJS = require('exceljs')
const PDFDocument = require('pdfkit')
const { fetchUsuariosNomeMap } = require('./helpers')

async function buildRelatorioConversas(company_id, filters = {}) {
  const { data: conversas, error } = await supabase
    .from('conversas')
    .select(`
      id, telefone, status_atendimento, criado_em, atendente_id, departamento_id,
      clientes!conversas_cliente_fk ( nome, observacoes ),
      conversa_tags ( tag_id, tags ( id, nome ) )
    `)
    .eq('company_id', company_id)

  if (error) throw error
  let list = conversas || []

  const atendenteNomeMap = await fetchUsuariosNomeMap(
    company_id,
    list.map((c) => c?.atendente_id)
  )

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

  // Resolve nomes de setor sem embed (evita relacionamento ambíguo)
  const depIds = [...new Set(list.map((c) => c?.departamento_id).filter((id) => id != null))]
  let depMap = {}
  if (depIds.length > 0) {
    const { data: deps } = await supabase
      .from('departamentos')
      .select('id, nome')
      .eq('company_id', company_id)
      .in('id', depIds)
    if (Array.isArray(deps)) {
      deps.forEach((d) => {
        if (d?.id != null) depMap[String(d.id)] = d?.nome || null
      })
    }
  }

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
      cliente_nome: getDisplayName(c.clientes) || '—',
      telefone: c.telefone,
      observacoes: c.clientes?.observacoes || '',
      setor: c?.departamento_id != null ? (depMap[String(c.departamento_id)] || '—') : '—',
      status_atendimento: c.status_atendimento,
      atendente_nome: atendenteNomeMap[String(c?.atendente_id)] || '—',
      tags: tags.map(t => t.nome).join(', '),
      criado_em: c.criado_em,
      ultima_mensagem: ultima?.texto?.slice(0, 200) || '—',
      ultima_mensagem_em: ultima?.criado_em || null,
      tempo_sem_responder_min,
    }
  })
}

async function relatorioConversas(req, res) {
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

// =====================================================
// RELATÓRIO (mensagens por dia/tipo/direção) — simples e claro
// =====================================================
async function relatorioMensagens(req, res) {
  try {
    const { company_id } = req.user
    const data_inicio = req.query.data_inicio || null
    const data_fim = req.query.data_fim || null

    let q = supabase
      .from('mensagens')
      .select('criado_em, direcao, tipo')
      .eq('company_id', company_id)
      .order('criado_em', { ascending: true })

    if (data_inicio) q = q.gte('criado_em', new Date(data_inicio).toISOString())
    if (data_fim) {
      const fim = new Date(data_fim)
      fim.setHours(23, 59, 59, 999)
      q = q.lte('criado_em', fim.toISOString())
    }

    const { data: rows, error } = await q
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const byDay = {}
    for (const r of rows || []) {
      const d = r?.criado_em ? new Date(r.criado_em) : null
      if (!d || Number.isNaN(d.getTime())) continue
      const key = d.toISOString().slice(0, 10) // YYYY-MM-DD
      if (!byDay[key]) {
        byDay[key] = {
          dia: key,
          total: 0,
          in: 0,
          out: 0,
          texto: 0,
          audio: 0,
          imagem: 0,
          video: 0,
          sticker: 0,
          arquivo: 0,
        }
      }
      const agg = byDay[key]
      agg.total++
      if (r?.direcao === 'in') agg.in++
      if (r?.direcao === 'out') agg.out++

      const t = String(r?.tipo || 'texto').toLowerCase()
      if (t === 'audio') agg.audio++
      else if (t === 'imagem') agg.imagem++
      else if (t === 'video') agg.video++
      else if (t === 'sticker') agg.sticker++
      else if (t === 'arquivo') agg.arquivo++
      else agg.texto++
    }

    const list = Object.values(byDay).sort((a, b) => a.dia.localeCompare(b.dia))
    return res.json(list)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao gerar relatório de mensagens' })
  }
}

function escapeCsv (str) {
  if (str == null) return ''
  return String(str).replace(/;/g, ',').replace(/\n/g, ' ')
}

async function exportRelatorio(req, res) {
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

module.exports = { relatorioConversas, relatorioMensagens, exportRelatorio }
