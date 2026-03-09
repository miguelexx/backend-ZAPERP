/**
 * Opt-in e Opt-out — APIs para campanhas e conformidade.
 */

const supabase = require('../config/supabase')

function getCompanyId(req) {
  return req.user?.company_id
}

// POST /opt-in — Registrar opt-in manual
exports.registrarOptIn = async (req, res) => {
  try {
    const company_id = getCompanyId(req)
    if (!company_id) return res.status(401).json({ error: 'Não autorizado' })
    const { cliente_id, origem = 'manual' } = req.body
    if (!cliente_id) return res.status(400).json({ error: 'cliente_id é obrigatório' })
    const { data, error } = await supabase
      .from('contato_opt_in')
      .upsert(
        { company_id, cliente_id, origem, ativo: true },
        { onConflict: 'company_id,cliente_id' }
      )
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  } catch (e) {
    console.error('[optInOptOutController] registrarOptIn:', e)
    return res.status(500).json({ error: e?.message || 'Erro' })
  }
}

// GET /opt-out — Listar opt-outs
exports.listarOptOut = async (req, res) => {
  try {
    const company_id = getCompanyId(req)
    if (!company_id) return res.status(401).json({ error: 'Não autorizado' })
    const limit = Math.min(Number(req.query.limit || 50), 200)
    const { data, error } = await supabase
      .from('contato_opt_out')
      .select('id, cliente_id, telefone, criado_em, motivo, canal, clientes(nome, telefone)')
      .eq('company_id', company_id)
      .order('criado_em', { ascending: false })
      .limit(limit)
    if (error) return res.status(500).json({ error: error.message })
    return res.json(data || [])
  } catch (e) {
    console.error('[optInOptOutController] listarOptOut:', e)
    return res.status(500).json({ error: e?.message || 'Erro' })
  }
}
