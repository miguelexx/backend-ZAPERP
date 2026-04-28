const supervisaoService = require('../services/supervisaoService')

function parseBoolean(value) {
  if (value === undefined) return null
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  return null
}

function parseNullableInt(value) {
  if (value === undefined || value === null || value === '') return null
  const num = Number(value)
  if (!Number.isInteger(num) || num <= 0) return null
  return num
}

exports.resumo = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await supervisaoService.getResumo(company_id)
    return res.json(data)
  } catch (error) {
    console.error('[SUPERVISAO][resumo] erro:', error)
    return res.status(500).json({ error: 'Erro ao gerar resumo de supervisão' })
  }
}

exports.clientesPendentes = async (req, res) => {
  try {
    const { company_id } = req.user
    const atendenteId = parseNullableInt(req.query.atendente_id)
    const departamentoId = parseNullableInt(req.query.departamento_id)
    const nivel = req.query.nivel ? String(req.query.nivel).trim().toLowerCase() : null
    const somenteAtrasados = parseBoolean(req.query.somente_atrasados)
    const periodo = req.query.periodo ? String(req.query.periodo).trim().toLowerCase() : null
    const busca = req.query.busca ? String(req.query.busca) : null

    if (req.query.atendente_id !== undefined && atendenteId == null) {
      return res.status(400).json({ error: 'atendente_id inválido' })
    }
    if (req.query.departamento_id !== undefined && departamentoId == null) {
      return res.status(400).json({ error: 'departamento_id inválido' })
    }
    if (nivel && !['normal', 'atencao', 'prioritario', 'critico'].includes(nivel)) {
      return res.status(400).json({ error: 'nivel inválido. Use: normal, atencao, prioritario ou critico' })
    }
    if (req.query.somente_atrasados !== undefined && somenteAtrasados == null) {
      return res.status(400).json({ error: 'somente_atrasados inválido. Use true/false' })
    }
    if (periodo && !['hoje', '7dias', 'mes'].includes(periodo)) {
      return res.status(400).json({ error: 'periodo inválido. Use: hoje, 7dias ou mes' })
    }

    const data = await supervisaoService.getClientesPendentes(company_id, {
      atendenteId,
      departamentoId,
      nivel,
      somenteAtrasados: somenteAtrasados === true,
      periodo,
      busca,
    })
    return res.json(data)
  } catch (error) {
    console.error('[SUPERVISAO][clientes-pendentes] erro:', error)
    return res.status(500).json({ error: 'Erro ao listar clientes pendentes' })
  }
}

exports.relatorioDiarioGestor = async (req, res) => {
  try {
    const { company_id } = req.user
    const data = await supervisaoService.getRelatorioDiarioGestor(company_id, req.query.data)
    return res.json(data)
  } catch (error) {
    if (error?.statusCode === 400) {
      return res.status(400).json({ error: error.message })
    }
    console.error('[SUPERVISAO][relatorio-diario] erro:', error)
    return res.status(500).json({ error: 'Erro ao gerar relatório diário do gestor' })
  }
}

exports.movimentacaoFuncionario = async (req, res) => {
  try {
    const { company_id } = req.user
    const usuarioId = parseNullableInt(req.params.usuarioId)
    if (!usuarioId) {
      return res.status(400).json({ error: 'usuarioId inválido' })
    }

    const data = await supervisaoService.getMovimentacaoFuncionario(company_id, usuarioId)
    return res.json(data)
  } catch (error) {
    if (error?.statusCode === 404) {
      return res.status(404).json({ error: error.message })
    }
    console.error('[SUPERVISAO][movimentacao] erro:', error)
    return res.status(500).json({ error: 'Erro ao buscar movimentação do funcionário' })
  }
}
