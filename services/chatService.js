const supabase = require('../config/supabase')

/*
=====================================================
CHAT SERVICE (PADRÃO SUPABASE)
Somente acesso a dados (sem socket / sem regra)
=====================================================
*/

/* ================================
   LISTAR CONVERSAS
================================ */
exports.listarConversas = async (company_id) => {
  const { data, error } = await supabase
    .from('conversas')
    .select('*')
    .eq('company_id', company_id)
    .order('criado_em', { ascending: false })

  if (error) throw error
  return data || []
}


/* ================================
   BUSCAR CONVERSA POR ID
================================ */
exports.buscarPorId = async (company_id, conversa_id) => {
  const { data, error } = await supabase
    .from('conversas')
    .select('*')
    .eq('company_id', company_id)
    .eq('id', conversa_id)
    .single()

  if (error) throw error
  return data
}


/* ================================
   CRIAR CONVERSA
================================ */
exports.criarConversa = async ({
  company_id,
  cliente_id,
  telefone
}) => {
  const { data, error } = await supabase
    .from('conversas')
    .insert({
      company_id,
      cliente_id,
      telefone,
      status_atendimento: 'aberta',
      criado_em: new Date().toISOString()
    })
    .select()
    .single()

  if (error) throw error
  return data
}


/* ================================
   ENVIAR MENSAGEM
================================ */
exports.enviarMensagem = async ({
  company_id,
  conversa_id,
  texto,
  autor_usuario_id,
  direcao = 'out'
}) => {
  const { data, error } = await supabase
    .from('mensagens')
    .insert({
      company_id,
      conversa_id,
      texto,
      direcao,
      autor_usuario_id,
      criado_em: new Date().toISOString()
    })
    .select()
    .single()

  if (error) throw error
  return data
}


/* ================================
   LISTAR MENSAGENS (paginação)
================================ */
exports.listarMensagens = async ({
  company_id,
  conversa_id,
  limit = 50,
  cursor = null
}) => {
  let query = supabase
    .from('mensagens')
    .select('*')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    .order('criado_em', { ascending: false })
    .limit(limit)

  if (cursor) {
    query = query.lt('criado_em', cursor)
  }

  const { data, error } = await query
  if (error) throw error

  return (data || []).reverse()
}
