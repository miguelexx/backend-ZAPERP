/**
 * Módulo de campanhas: disparos com opt-in, segmentação e limites.
 * Desacoplado — não altera fluxos existentes.
 */

const supabase = require('../config/supabase')
const { verificarOptOut } = require('./optOutService')
const zapiProvider = require('./providers/zapi')

/**
 * Lista campanhas da empresa.
 */
async function listar(company_id, filtros = {}) {
  let q = supabase.from('campanhas').select('*').eq('company_id', company_id).order('criado_em', { ascending: false })
  if (filtros.status) q = q.eq('status', filtros.status)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

/**
 * Cria campanha em rascunho.
 */
async function criar(company_id, payload) {
  const { nome, tipo = 'promocional', texto_template, filtros_json = {} } = payload
  if (!nome || !texto_template) throw new Error('Nome e texto_template são obrigatórios')
  const { data, error } = await supabase
    .from('campanhas')
    .insert({
      company_id,
      nome,
      tipo,
      texto_template,
      filtros_json,
      status: 'rascunho',
    })
    .select()
    .single()
  if (error) throw error
  return data
}

/**
 * Atualiza campanha.
 */
async function atualizar(company_id, id, payload) {
  const { data, error } = await supabase
    .from('campanhas')
    .update(payload)
    .eq('id', id)
    .eq('company_id', company_id)
    .select()
    .single()
  if (error) throw error
  return data
}

/**
 * Exclui campanha (apenas rascunho).
 */
async function excluir(company_id, id) {
  const { data: camp } = await supabase.from('campanhas').select('status').eq('id', id).eq('company_id', company_id).maybeSingle()
  if (!camp) throw new Error('Campanha não encontrada')
  if (camp.status !== 'rascunho') throw new Error('Apenas campanhas em rascunho podem ser excluídas')
  const { error } = await supabase.from('campanhas').delete().eq('id', id).eq('company_id', company_id)
  if (error) throw error
  return { ok: true }
}

/**
 * Pausa campanha em andamento.
 */
async function pausar(company_id, id) {
  const { data, error } = await supabase
    .from('campanhas')
    .update({ status: 'pausada' })
    .eq('id', id)
    .eq('company_id', company_id)
    .in('status', ['em_andamento'])
    .select()
    .single()
  if (error) throw error
  if (!data) throw new Error('Campanha não encontrada ou não está em andamento')
  return data
}

/**
 * Retoma campanha pausada.
 */
async function retomar(company_id, id) {
  const { data, error } = await supabase
    .from('campanhas')
    .update({ status: 'em_andamento' })
    .eq('id', id)
    .eq('company_id', company_id)
    .in('status', ['pausada'])
    .select()
    .single()
  if (error) throw error
  if (!data) throw new Error('Campanha não encontrada ou não está pausada')
  return data
}

/**
 * Valida opt-in antes de incluir contato na campanha.
 * Retorna lista de cliente_ids válidos (com opt-in e sem opt-out).
 */
async function filtrarContatosValidos(company_id, cliente_ids) {
  if (!cliente_ids?.length) return []
  const validos = []
  for (const cid of cliente_ids) {
    const { data: cliente } = await supabase.from('clientes').select('id, telefone').eq('id', cid).eq('company_id', company_id).maybeSingle()
    if (!cliente) continue
    const emOptOut = await verificarOptOut(supabase, company_id, cliente.id, cliente.telefone)
    if (emOptOut) continue
    const { data: optIn } = await supabase.from('contato_opt_in').select('id').eq('company_id', company_id).eq('cliente_id', cid).eq('ativo', true).maybeSingle()
    if (!optIn) continue
    validos.push(cid)
  }
  return validos
}

/**
 * Lista envios de uma campanha.
 */
async function listarEnvios(company_id, campanha_id, filtros = {}) {
  const { data: camp } = await supabase.from('campanhas').select('id').eq('id', campanha_id).eq('company_id', company_id).maybeSingle()
  if (!camp) throw new Error('Campanha não encontrada')
  let q = supabase
    .from('campanha_envios')
    .select('*, clientes(nome, telefone)')
    .eq('campanha_id', campanha_id)
    .order('id', { ascending: false })
  if (filtros.status) q = q.eq('status', filtros.status)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

module.exports = {
  listar,
  criar,
  atualizar,
  excluir,
  pausar,
  retomar,
  filtrarContatosValidos,
  listarEnvios,
}
