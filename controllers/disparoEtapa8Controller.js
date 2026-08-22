/**
 * Controller Etapa 8 — opt-out, respostas, reconciliação, relatório e exportação.
 * Admin-only; company_id sempre do JWT.
 */

const supabase = require('../config/supabase')
const { mascararTelefone } = require('../helpers/disparoRevisaoChecklist')
const { toCsv } = require('../helpers/disparoCsvExportHelper')
const {
  getEmpresaConfig,
  upsertEmpresaConfig,
  reativar,
} = require('../services/disparoOptOutService')
const { listarRespostas } = require('../services/disparoRespostaService')
const {
  reconciliarExecucao,
  registrarDecisaoManual,
  listarIncertos,
} = require('../services/disparoReconciliacaoService')
const {
  montarRelatorioCampanha,
  metricasPorInstancia,
  metricasPorVariacao,
  listarErrosAgrupados,
} = require('../services/disparoRelatorioService')

const OPTOUT_EVENTO_SELECT = [
  'id', 'telefone_normalizado', 'palavra', 'tipo', 'motivo',
  'campanha_id', 'execucao_id', 'fila_item_id', 'mensagem_id', 'conversa_id',
  'usuario_id', 'criado_em',
].join(', ')

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 200
const EXPORT_TIPOS = new Set(['resumo', 'destinatarios', 'falhas', 'optouts', 'eventos'])

function positiveInt(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

function requireAdmin(req, res) {
  if (String(req.user?.perfil ?? '').toLowerCase() !== 'admin') {
    res.status(403).json({ error: 'Acesso restrito a administradores.' })
    return false
  }
  return true
}

function getIo(req) {
  try {
    return req.app?.get?.('io') ?? null
  } catch (_) {
    return null
  }
}

async function carregarCampanha(campanhaId, companyId, res) {
  const { data, error } = await supabase
    .from('disparo_campanhas')
    .select('id, company_id, nome, status')
    .eq('id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!data) {
    res.status(404).json({ error: 'Campanha não encontrada.' })
    return null
  }
  return data
}

async function buscarExecucaoId(campanhaId, companyId) {
  const { data, error } = await supabase
    .from('disparo_execucoes')
    .select('id')
    .eq('campanha_id', campanhaId)
    .eq('company_id', companyId)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data?.id ?? null
}

// ─── Config opt-out ───────────────────────────────────────────────────────────

exports.obterConfigOptOut = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const config = await getEmpresaConfig(companyId)
    res.json(config)
  } catch (err) {
    console.error('[disparo:etapa8] obterConfigOptOut', err)
    res.status(500).json({ error: 'Erro ao obter configuração de opt-out.' })
  }
}

exports.salvarConfigOptOut = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = req.user?.id ?? null
    const config = await upsertEmpresaConfig(companyId, req.body ?? {}, userId)
    res.json(config)
  } catch (err) {
    console.error('[disparo:etapa8] salvarConfigOptOut', err)
    res.status(500).json({ error: 'Erro ao salvar configuração de opt-out.' })
  }
}

// ─── Opt-outs ─────────────────────────────────────────────────────────────────

exports.listarOptOuts = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const page = Math.max(1, positiveInt(req.query.page) ?? 1)
    const limit = Math.min(MAX_PAGE_LIMIT, positiveInt(req.query.limit) ?? DEFAULT_PAGE_LIMIT)
    const offset = (page - 1) * limit
    const tipo = String(req.query.tipo ?? '').trim()
    const mask = req.query.mask === '1' || req.query.mask === 'true'

    let query = supabase
      .from('disparo_optout_eventos')
      .select(OPTOUT_EVENTO_SELECT, { count: 'exact' })
      .eq('company_id', companyId)
      .order('criado_em', { ascending: false })
      .range(offset, offset + limit - 1)

    if (tipo) query = query.eq('tipo', tipo)

    const { data, error, count } = await query
    if (error) throw error

    const itens = (data ?? []).map((row) => ({
      ...row,
      telefone_normalizado: mask
        ? mascararTelefone(row.telefone_normalizado)
        : row.telefone_normalizado,
    }))

    res.json({
      page,
      limit,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / limit) || 0,
      itens,
    })
  } catch (err) {
    console.error('[disparo:etapa8] listarOptOuts', err)
    res.status(500).json({ error: 'Erro ao listar eventos de opt-out.' })
  }
}

exports.reativarOptOut = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = req.user?.id ?? null
    const { telefone, motivo } = req.body ?? {}

    const result = await reativar({
      companyId,
      telefone,
      motivo,
      userId,
      io: getIo(req),
    })

    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'Não foi possível reativar.' })
    }

    res.json(result)
  } catch (err) {
    if (err.code === 'MOTIVO_OBRIGATORIO' || err.code === 'TELEFONE_INVALIDO') {
      return res.status(400).json({ error: err.message })
    }
    console.error('[disparo:etapa8] reativarOptOut', err)
    res.status(500).json({ error: 'Erro ao reativar telefone.' })
  }
}

// ─── Respostas ────────────────────────────────────────────────────────────────

exports.listarRespostasCampanha = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID da campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const result = await listarRespostas(campanhaId, companyId, {
      page: req.query.page,
      limit: req.query.limit,
    })

    const mask = req.query.mask === '1' || req.query.mask === 'true'
    if (mask) {
      result.itens = result.itens.map((r) => ({
        ...r,
        telefone_normalizado: mascararTelefone(r.telefone_normalizado),
      }))
    }

    res.json({ campanha: { id: campanha.id, nome: campanha.nome }, ...result })
  } catch (err) {
    console.error('[disparo:etapa8] listarRespostasCampanha', err)
    res.status(500).json({ error: 'Erro ao listar respostas da campanha.' })
  }
}

// ─── Reconciliação ────────────────────────────────────────────────────────────

exports.listarIncertosCampanha = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID da campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const result = await listarIncertos(campanhaId, companyId, {
      page: req.query.page,
      limit: req.query.limit,
    })

    res.json({ campanha: { id: campanha.id, nome: campanha.nome }, ...result })
  } catch (err) {
    console.error('[disparo:etapa8] listarIncertosCampanha', err)
    res.status(500).json({ error: 'Erro ao listar itens incertos.' })
  }
}

exports.reconciliarCampanha = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID da campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const execucaoId = await buscarExecucaoId(campanhaId, companyId)
    if (!execucaoId) {
      return res.status(404).json({ error: 'Nenhuma execução encontrada para esta campanha.' })
    }

    const limit = positiveInt(req.body?.limit ?? req.query?.limit) ?? 50
    const result = await reconciliarExecucao(execucaoId, companyId, {
      limit,
      io: getIo(req),
    })

    res.json({
      campanha: { id: campanha.id, nome: campanha.nome },
      ...result,
    })
  } catch (err) {
    console.error('[disparo:etapa8] reconciliarCampanha', err)
    res.status(500).json({ error: 'Erro ao reconciliar itens incertos.' })
  }
}

exports.decisaoManualIncerto = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    const itemId = positiveInt(req.params.itemId)
    if (!campanhaId || !itemId) {
      return res.status(400).json({ error: 'IDs inválidos.' })
    }

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const { decisao, justificativa, confirmacao, evidencias, autorizarRetentativa } = req.body ?? {}
    if (confirmacao !== true) {
      return res.status(400).json({
        error: 'Confirmação explícita obrigatória (confirmacao: true).',
        code: 'CONFIRMACAO_OBRIGATORIA',
      })
    }

    const { data: itemCheck } = await supabase
      .from('disparo_fila_itens')
      .select('id, campanha_id')
      .eq('id', itemId)
      .eq('company_id', companyId)
      .eq('campanha_id', campanhaId)
      .maybeSingle()

    if (!itemCheck) {
      return res.status(404).json({ error: 'Item incerto não encontrado nesta campanha.' })
    }

    const result = await registrarDecisaoManual({
      companyId,
      filaItemId: itemId,
      decisao,
      justificativa,
      usuarioId: req.user?.id ?? null,
      evidencias: evidencias ?? {},
      autorizarRetentativa: Boolean(autorizarRetentativa),
      io: getIo(req),
    })

    res.json(result)
  } catch (err) {
    const clientCodes = new Set([
      'DECISAO_INVALIDA',
      'JUSTIFICATIVA_OBRIGATORIA',
      'STATUS_INVALIDO',
      'EVIDENCIA_REATENTAR',
      'MAX_TENTATIVAS',
      'TRANSICAO_INVALIDA',
    ])
    if (clientCodes.has(err.code)) {
      return res.status(400).json({ error: err.message, code: err.code })
    }
    console.error('[disparo:etapa8] decisaoManualIncerto', err)
    res.status(500).json({ error: 'Erro ao registrar decisão manual.' })
  }
}

// ─── Relatório ────────────────────────────────────────────────────────────────

exports.relatorioCampanha = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID da campanha inválido.' })

    const relatorio = await montarRelatorioCampanha(campanhaId, companyId)
    res.json(relatorio)
  } catch (err) {
    if (err.code === 'CAMPANHA_NAO_ENCONTRADA') {
      return res.status(404).json({ error: err.message })
    }
    console.error('[disparo:etapa8] relatorioCampanha', err)
    res.status(500).json({ error: 'Erro ao montar relatório da campanha.' })
  }
}

exports.relatorioInstancias = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID da campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const execucaoId = await buscarExecucaoId(campanhaId, companyId)
    const instancias = await metricasPorInstancia(campanhaId, companyId, execucaoId)
    res.json({ campanha: { id: campanha.id, nome: campanha.nome }, instancias })
  } catch (err) {
    console.error('[disparo:etapa8] relatorioInstancias', err)
    res.status(500).json({ error: 'Erro ao obter métricas por instância.' })
  }
}

exports.relatorioVariacoes = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID da campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const execucaoId = await buscarExecucaoId(campanhaId, companyId)
    const variacoes = await metricasPorVariacao(campanhaId, companyId, execucaoId)
    res.json({ campanha: { id: campanha.id, nome: campanha.nome }, variacoes })
  } catch (err) {
    console.error('[disparo:etapa8] relatorioVariacoes', err)
    res.status(500).json({ error: 'Erro ao obter métricas por variação.' })
  }
}

exports.relatorioErros = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    if (!campanhaId) return res.status(400).json({ error: 'ID da campanha inválido.' })

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const execucaoId = await buscarExecucaoId(campanhaId, companyId)
    const erros = await listarErrosAgrupados(campanhaId, companyId, execucaoId)
    res.json({ campanha: { id: campanha.id, nome: campanha.nome }, erros })
  } catch (err) {
    console.error('[disparo:etapa8] relatorioErros', err)
    res.status(500).json({ error: 'Erro ao agrupar erros da campanha.' })
  }
}

// ─── Exportação ───────────────────────────────────────────────────────────────

async function montarDadosExport(tipo, campanhaId, companyId, execucaoId, maskPhone) {
  const mask = (tel) => (maskPhone ? mascararTelefone(tel) : tel)

  if (tipo === 'resumo') {
    const rel = await montarRelatorioCampanha(campanhaId, companyId)
    return {
      columns: [
        { key: 'campo', label: 'campo' },
        { key: 'valor', label: 'valor' },
      ],
      rows: [
        { campo: 'campanha_id', valor: rel.campanha?.id },
        { campo: 'campanha_nome', valor: rel.campanha?.nome },
        { campo: 'execucao_id', valor: rel.execucao?.id ?? '' },
        { campo: 'planejado', valor: rel.metricas?.planejado },
        { campo: 'processado', valor: rel.metricas?.processado },
        { campo: 'enviadas', valor: rel.metricas?.enviadas },
        { campo: 'entregues', valor: rel.metricas?.entregues },
        { campo: 'lidas', valor: rel.metricas?.lidas },
        { campo: 'respondidas', valor: rel.metricas?.respondidas },
        { campo: 'optouts', valor: rel.metricas?.optouts },
        { campo: 'falhas', valor: rel.metricas?.falhas },
        { campo: 'incertos', valor: rel.metricas?.incertos },
        { campo: 'duracao_segundos', valor: rel.duracao_segundos ?? '' },
      ],
      json: rel,
    }
  }

  if (tipo === 'destinatarios') {
    const { data, error } = await supabase
      .from('disparo_fila_itens')
      .select(`
        id, status, instancia_id, variacao_id, destinatario_id,
        enviado_em, entregue_em, lido_em, respondida_em, optout_em,
        erro_codigo, erro_mensagem,
        destinatario:disparo_campanha_destinatarios(nome, telefone_normalizado, origem)
      `)
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .eq('execucao_id', execucaoId)
      .order('id', { ascending: true })
    if (error) throw error

    const rows = (data ?? []).map((row) => ({
      item_id: row.id,
      status: row.status,
      nome: row.destinatario?.nome ?? '',
      telefone: mask(row.destinatario?.telefone_normalizado),
      origem: row.destinatario?.origem ?? '',
      instancia_id: row.instancia_id,
      variacao_id: row.variacao_id,
      enviado_em: row.enviado_em,
      entregue_em: row.entregue_em,
      lido_em: row.lido_em,
      respondida_em: row.respondida_em,
      optout_em: row.optout_em,
      erro_codigo: row.erro_codigo,
      erro_mensagem: row.erro_mensagem,
    }))

    return {
      columns: [
        { key: 'item_id', label: 'item_id' },
        { key: 'status', label: 'status' },
        { key: 'nome', label: 'nome' },
        { key: 'telefone', label: 'telefone' },
        { key: 'origem', label: 'origem' },
        { key: 'instancia_id', label: 'instancia_id' },
        { key: 'variacao_id', label: 'variacao_id' },
        { key: 'enviado_em', label: 'enviado_em' },
        { key: 'entregue_em', label: 'entregue_em' },
        { key: 'lido_em', label: 'lido_em' },
        { key: 'respondida_em', label: 'respondida_em' },
        { key: 'optout_em', label: 'optout_em' },
        { key: 'erro_codigo', label: 'erro_codigo' },
        { key: 'erro_mensagem', label: 'erro_mensagem' },
      ],
      rows,
      json: rows,
    }
  }

  if (tipo === 'falhas') {
    const { data, error } = await supabase
      .from('disparo_fila_itens')
      .select(`
        id, status, erro_codigo, erro_mensagem, erro_classificacao, tentativas,
        destinatario:disparo_campanha_destinatarios(nome, telefone_normalizado)
      `)
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .eq('execucao_id', execucaoId)
      .in('status', ['falhou', 'incerta'])
      .order('id', { ascending: true })
    if (error) throw error

    const rows = (data ?? []).map((row) => ({
      item_id: row.id,
      status: row.status,
      nome: row.destinatario?.nome ?? '',
      telefone: mask(row.destinatario?.telefone_normalizado),
      erro_codigo: row.erro_codigo,
      erro_mensagem: row.erro_mensagem,
      erro_classificacao: row.erro_classificacao,
      tentativas: row.tentativas,
    }))

    return {
      columns: Object.keys(rows[0] || { item_id: '', status: '' }).map((k) => ({ key: k, label: k })),
      rows,
      json: rows,
    }
  }

  if (tipo === 'optouts') {
    const { data, error } = await supabase
      .from('disparo_optout_eventos')
      .select(OPTOUT_EVENTO_SELECT)
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .order('criado_em', { ascending: false })
    if (error) throw error

    const rows = (data ?? []).map((row) => ({
      ...row,
      telefone_normalizado: mask(row.telefone_normalizado),
    }))

    return {
      columns: [
        { key: 'id', label: 'id' },
        { key: 'tipo', label: 'tipo' },
        { key: 'telefone_normalizado', label: 'telefone' },
        { key: 'palavra', label: 'palavra' },
        { key: 'motivo', label: 'motivo' },
        { key: 'criado_em', label: 'criado_em' },
      ],
      rows,
      json: rows,
    }
  }

  if (tipo === 'eventos') {
    const { data, error } = await supabase
      .from('disparo_execucao_eventos')
      .select('id, tipo, payload, usuario_id, criado_em')
      .eq('campanha_id', campanhaId)
      .eq('company_id', companyId)
      .eq('execucao_id', execucaoId)
      .order('criado_em', { ascending: true })
    if (error) throw error

    const rows = (data ?? []).map((row) => ({
      id: row.id,
      tipo: row.tipo,
      payload: JSON.stringify(row.payload ?? {}),
      usuario_id: row.usuario_id,
      criado_em: row.criado_em,
    }))

    return {
      columns: [
        { key: 'id', label: 'id' },
        { key: 'tipo', label: 'tipo' },
        { key: 'payload', label: 'payload' },
        { key: 'usuario_id', label: 'usuario_id' },
        { key: 'criado_em', label: 'criado_em' },
      ],
      rows,
      json: data ?? [],
    }
  }

  return null
}

exports.exportarCampanha = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const campanhaId = positiveInt(req.params.id)
    const tipo = String(req.params.tipo ?? '').trim().toLowerCase()
    const format = String(req.query.format ?? 'json').toLowerCase() === 'csv' ? 'csv' : 'json'
    const maskPhone = req.query.mask === '1' || req.query.mask === 'true'

    if (!campanhaId) return res.status(400).json({ error: 'ID da campanha inválido.' })
    if (!EXPORT_TIPOS.has(tipo)) {
      return res.status(400).json({ error: 'Tipo de exportação inválido.', tipos: [...EXPORT_TIPOS] })
    }

    const campanha = await carregarCampanha(campanhaId, companyId, res)
    if (!campanha) return

    const execucaoId = await buscarExecucaoId(campanhaId, companyId)
    if (tipo !== 'resumo' && tipo !== 'optouts' && !execucaoId) {
      return res.status(404).json({ error: 'Nenhuma execução encontrada para exportação.' })
    }

    const dados = await montarDadosExport(tipo, campanhaId, companyId, execucaoId, maskPhone)
    if (!dados) {
      return res.status(400).json({ error: 'Tipo de exportação não suportado.' })
    }

    if (format === 'csv') {
      const csv = toCsv(dados.rows, dados.columns, { maskPhone: false })
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="disparo-${tipo}-${campanhaId}.csv"`,
      )
      return res.send(csv)
    }

    res.json({
      campanha: { id: campanha.id, nome: campanha.nome },
      tipo,
      dados: dados.json,
    })
  } catch (err) {
    console.error('[disparo:etapa8] exportarCampanha', err)
    res.status(500).json({ error: 'Erro ao exportar dados da campanha.' })
  }
}
