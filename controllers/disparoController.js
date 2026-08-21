const supabase = require('../config/supabase')

const CAMPANHA_STATUS_VALIDOS = new Set([
  'rascunho', 'configurando', 'agendada',
  'em_execucao', 'pausada', 'concluida', 'cancelada', 'arquivada',
])

const ORDER_FIELDS = { criado: 'criado_em', atualizado: 'atualizado_em' }
const DEFAULT_PAGE_LIMIT = 20
const MAX_PAGE_LIMIT = 100

function positiveInt(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function cleanText(value, maxLength = 255) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function paginationParams(query) {
  const page = Math.max(1, positiveInt(query.page) || 1)
  const limit = Math.min(
    MAX_PAGE_LIMIT,
    Math.max(1, positiveInt(query.limit) || DEFAULT_PAGE_LIMIT),
  )
  const offset = (page - 1) * limit
  return { page, limit, offset }
}

function requireAdmin(req, res) {
  if (String(req.user?.perfil || '').toLowerCase() !== 'admin') {
    res.status(403).json({ error: 'Acesso restrito a administradores.' })
    return false
  }
  return true
}

// GET /disparo/campanhas
exports.listarCampanhas = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const { page, limit, offset } = paginationParams(req.query)

    const search = cleanText(req.query.search || '', 100)
    const statusFiltro = cleanText(req.query.status || '', 30)
    const orderByKey = req.query.orderBy === 'atualizado' ? 'atualizado' : 'criado'
    const orderField = ORDER_FIELDS[orderByKey]
    const ascending = req.query.order === 'asc'

    let query = supabase
      .from('disparo_campanhas')
      .select(
        `id, nome, descricao, status, criado_em, atualizado_em, arquivado_em,
         criador:usuarios!disparo_campanhas_criado_por_fkey(id, nome)`,
        { count: 'exact' },
      )
      .eq('company_id', companyId)

    if (search) {
      query = query.ilike('nome', `%${search}%`)
    }
    if (statusFiltro && CAMPANHA_STATUS_VALIDOS.has(statusFiltro)) {
      query = query.eq('status', statusFiltro)
    }

    query = query
      .order(orderField, { ascending })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)

    const { data, error, count } = await query
    if (error) throw error

    res.json({
      campanhas: data || [],
      total: count || 0,
      page,
      limit,
    })
  } catch (err) {
    console.error('[disparo] listarCampanhas', err)
    res.status(500).json({ error: 'Erro ao listar campanhas.' })
  }
}

// GET /disparo/campanhas/:id
exports.obterCampanha = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const id = positiveInt(req.params.id)
    if (!id) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const { data, error } = await supabase
      .from('disparo_campanhas')
      .select(
        `*, criador:usuarios!disparo_campanhas_criado_por_fkey(id, nome)`,
      )
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Campanha não encontrada.' })

    res.json(data)
  } catch (err) {
    console.error('[disparo] obterCampanha', err)
    res.status(500).json({ error: 'Erro ao buscar campanha.' })
  }
}

// POST /disparo/campanhas
exports.criarCampanha = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const userId = Number(req.user.id || req.user.user_id)

    const nome = cleanText(req.body.nome || '', 180)
    const descricao = cleanText(req.body.descricao || '', 5000)

    if (!nome) {
      return res.status(400).json({ error: 'O nome da campanha é obrigatório.' })
    }

    const { data, error } = await supabase
      .from('disparo_campanhas')
      .insert({
        company_id: companyId,
        nome,
        descricao: descricao || null,
        status: 'rascunho',
        criado_por: userId,
      })
      .select('*')
      .single()

    if (error) throw error

    res.status(201).json(data)
  } catch (err) {
    console.error('[disparo] criarCampanha', err)
    res.status(500).json({ error: 'Erro ao criar campanha.' })
  }
}

// PATCH /disparo/campanhas/:id
exports.editarCampanha = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const id = positiveInt(req.params.id)
    if (!id) return res.status(400).json({ error: 'ID de campanha inválido.' })

    // Carrega a campanha para validar status e ownership
    const { data: existente, error: fetchErr } = await supabase
      .from('disparo_campanhas')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (fetchErr) throw fetchErr
    if (!existente) return res.status(404).json({ error: 'Campanha não encontrada.' })
    if (existente.status !== 'rascunho' && existente.status !== 'configurando') {
      return res.status(422).json({ error: 'Apenas campanhas em rascunho ou configurando podem ser editadas.' })
    }

    const nome = cleanText(req.body.nome || '', 180)
    const descricao = cleanText(req.body.descricao ?? '', 5000)

    if (!nome) {
      return res.status(400).json({ error: 'O nome da campanha é obrigatório.' })
    }

    const { data, error } = await supabase
      .from('disparo_campanhas')
      .update({
        nome,
        descricao: descricao || null,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('*')
      .single()

    if (error) throw error

    res.json(data)
  } catch (err) {
    console.error('[disparo] editarCampanha', err)
    res.status(500).json({ error: 'Erro ao editar campanha.' })
  }
}

// POST /disparo/campanhas/:id/arquivar
exports.arquivarCampanha = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const id = positiveInt(req.params.id)
    if (!id) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const { data: existente, error: fetchErr } = await supabase
      .from('disparo_campanhas')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (fetchErr) throw fetchErr
    if (!existente) return res.status(404).json({ error: 'Campanha não encontrada.' })
    if (existente.status === 'arquivada') {
      return res.status(422).json({ error: 'A campanha já está arquivada.' })
    }
    if (existente.status === 'em_execucao') {
      return res.status(422).json({ error: 'Não é possível arquivar uma campanha em execução.' })
    }

    const { data, error } = await supabase
      .from('disparo_campanhas')
      .update({
        status: 'arquivada',
        arquivado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('*')
      .single()

    if (error) throw error

    res.json(data)
  } catch (err) {
    console.error('[disparo] arquivarCampanha', err)
    res.status(500).json({ error: 'Erro ao arquivar campanha.' })
  }
}

// POST /disparo/campanhas/:id/restaurar
exports.restaurarCampanha = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)
    const id = positiveInt(req.params.id)
    if (!id) return res.status(400).json({ error: 'ID de campanha inválido.' })

    const { data: existente, error: fetchErr } = await supabase
      .from('disparo_campanhas')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (fetchErr) throw fetchErr
    if (!existente) return res.status(404).json({ error: 'Campanha não encontrada.' })
    if (existente.status !== 'arquivada') {
      return res.status(422).json({ error: 'Apenas campanhas arquivadas podem ser restauradas.' })
    }

    const { data, error } = await supabase
      .from('disparo_campanhas')
      .update({
        status: 'rascunho',
        arquivado_em: null,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('*')
      .single()

    if (error) throw error

    res.json(data)
  } catch (err) {
    console.error('[disparo] restaurarCampanha', err)
    res.status(500).json({ error: 'Erro ao restaurar campanha.' })
  }
}

// GET /disparo/campanhas/resumo — totais por status para os cards
exports.resumoCampanhas = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return
    const companyId = Number(req.user.company_id)

    const { data, error } = await supabase
      .from('disparo_campanhas')
      .select('status')
      .eq('company_id', companyId)
      .neq('status', 'arquivada')

    if (error) throw error

    const contagens = (data || []).reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1
      return acc
    }, {})

    res.json({
      total: (data || []).length,
      rascunho: contagens.rascunho || 0,
      agendada: contagens.agendada || 0,
      concluida: contagens.concluida || 0,
      em_execucao: contagens.em_execucao || 0,
      pausada: contagens.pausada || 0,
      cancelada: contagens.cancelada || 0,
      configurando: contagens.configurando || 0,
    })
  } catch (err) {
    console.error('[disparo] resumoCampanhas', err)
    res.status(500).json({ error: 'Erro ao buscar resumo.' })
  }
}
