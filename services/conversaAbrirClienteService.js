const supabase = require('../config/supabase')
const { possiblePhonesBR } = require('../helpers/phoneHelper')
const { getCanonicalPhone } = require('../helpers/conversationSync')
const { getDisplayName } = require('../helpers/contactEnrichment')

/**
 * Garante uma conversa 1:1 para o cliente (localiza por telefone ou cria).
 * Usado por POST /chats/abrir-conversa e POST /clientes (flags abrir_conversa / assumir).
 */
async function ensureConversaForCliente({
  company_id,
  usuario_id,
  cliente
}) {
  const telefone = cliente.telefone || ''
  if (!telefone) {
    return { ok: false, error: 'Cliente sem telefone cadastrado', conversa: null, criada: false }
  }

  const convPhones = possiblePhonesBR(telefone)
  let qConv = supabase
    .from('conversas')
    .select('id, telefone, cliente_id, status_atendimento, nome_grupo, tipo')
    .eq('company_id', company_id)
    .neq('status_atendimento', 'fechada')
    .order('id', { ascending: false })
    .limit(5)
  if (convPhones.length > 0) qConv = qConv.in('telefone', convPhones)
  else qConv = qConv.eq('telefone', telefone)
  const { data: convRows } = await qConv
  const convList = Array.isArray(convRows) ? convRows : (convRows ? [convRows] : [])
  const conversaExistente =
    convList.find((c) => c && Number(c.cliente_id) === Number(cliente.id)) ||
    convList[0] ||
    null

  if (conversaExistente?.id && conversaExistente.cliente_id && Number(conversaExistente.cliente_id) !== Number(cliente.id)) {
    await supabase
      .from('conversas')
      .update({ cliente_id: cliente.id })
      .eq('company_id', company_id)
      .eq('id', conversaExistente.id)
  }

  if (conversaExistente) {
    const payload = {
      id: conversaExistente.id,
      cliente_id: cliente.id,
      telefone: conversaExistente.telefone,
      tipo: 'cliente',
      contato_nome: getDisplayName(cliente) || conversaExistente.telefone,
      foto_perfil: cliente.foto_perfil || null,
      unread_count: 0,
      tags: []
    }
    return { ok: true, error: null, conversa: payload, criada: false }
  }

  const telefoneCanonico = getCanonicalPhone(telefone) || telefone
  const { data: novaConversa, error: errConv } = await supabase
    .from('conversas')
    .insert({
      cliente_id: cliente.id,
      telefone: telefoneCanonico,
      company_id,
      status_atendimento: 'aberta',
      usuario_id,
      tipo: 'cliente',
      ultima_atividade: new Date().toISOString()
    })
    .select('id, telefone, cliente_id, status_atendimento, tipo')
    .single()

  if (errConv) return { ok: false, error: errConv.message, conversa: null, criada: false }

  const payload = {
    id: novaConversa.id,
    cliente_id: cliente.id,
    telefone: novaConversa.telefone,
    tipo: 'cliente',
    contato_nome: getDisplayName(cliente) || novaConversa.telefone,
    foto_perfil: cliente.foto_perfil || null,
    unread_count: 0,
    tags: []
  }

  return { ok: true, error: null, conversa: payload, criada: true, novaConversaId: novaConversa.id }
}

module.exports = { ensureConversaForCliente }
