const produtosService = require('../services/produtosService')
const { syncProdutosFromWm, getSyncStatus } = require('../services/produtosSyncService')

function parseBoolean(value) {
  if (value === undefined) return false
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0' || normalized === '') return false
  return null
}

exports.consulta = async (req, res) => {
  try {
    const companyId = Number(req.user?.company_id)
    const termo = req.query.q
    const somenteComEstoque = parseBoolean(req.query.somenteComEstoque)
    if (somenteComEstoque === null) {
      return res.status(400).json({ error: 'somenteComEstoque inválido. Use true/false.' })
    }
    const limit = req.query.limit
    const offset = req.query.offset

    const data = await produtosService.buscarProdutos({
      companyId,
      termo,
      somenteComEstoque,
      limit,
      offset,
    })

    return res.json(data)
  } catch (error) {
    if (error?.statusCode === 400) {
      return res.status(400).json({ error: error.message })
    }
    console.error('[PRODUTOS][consulta] erro:', error?.message || error)
    return res.status(503).json({ error: 'Serviço de produtos indisponível no momento.' })
  }
}

exports.syncWm = async (req, res) => {
  try {
    const result = await syncProdutosFromWm()
    return res.json(result)
  } catch (error) {
    if (error?.statusCode === 503) {
      return res.status(503).json({ error: error.message })
    }
    if (error?.statusCode === 409) {
      return res.status(409).json({ error: 'Sincronização já está em andamento.' })
    }
    console.error('[PRODUTOS][sync-wm] erro:', error?.message || error)
    return res.status(500).json({ error: 'Falha ao sincronizar produtos da WM.' })
  }
}

exports.syncStatus = async (req, res) => {
  try {
    return res.json(getSyncStatus())
  } catch (error) {
    console.error('[PRODUTOS][sync-status] erro:', error?.message || error)
    return res.status(500).json({ error: 'Falha ao obter status da sincronização.' })
  }
}
