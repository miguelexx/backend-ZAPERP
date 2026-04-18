const supabase = require('../config/supabase')

async function registrarAtendimento({
  conversa_id,
  company_id,
  acao,
  de_usuario_id,
  para_usuario_id = null,
  observacao = null
}) {
  const { data, error } = await supabase
    .from('atendimentos')
    .insert({
      conversa_id: Number(conversa_id),
      company_id: Number(company_id),
      acao,
      de_usuario_id: de_usuario_id != null ? Number(de_usuario_id) : null,
      para_usuario_id: para_usuario_id != null ? Number(para_usuario_id) : null,
      observacao
    })
    .select('id')
    .single()
  if (error) return { error, atendimento: null }
  return { error: null, atendimento: data }
}

module.exports = { registrarAtendimento }
