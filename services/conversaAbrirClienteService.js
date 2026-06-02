const supabase = require('../config/supabase')
const { getDisplayName } = require('../helpers/contactEnrichment')
const { findOrCreateConversation } = require('../helpers/conversationSync')

/**
 * Garante uma conversa 1:1 para o cliente (localiza por telefone ou cria).
 * Usado por POST /chats/abrir-conversa e POST /clientes (flags abrir_conversa / assumir).
 *
 * Reutiliza conversa fechada com o mesmo telefone — evita 23505 em idx_conversas_company_telefone*.
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

  let result
  try {
    result = await findOrCreateConversation(supabase, {
      company_id,
      phone: telefone,
      cliente_id: cliente.id,
      isGroup: false,
      logPrefix: '[ensureConversaForCliente]',
    })
  } catch (e) {
    const msg = String(e?.message || e || 'Erro ao localizar conversa')
    return { ok: false, error: msg, conversa: null, criada: false }
  }

  if (!result?.conversa?.id) {
    return { ok: false, error: 'Não foi possível localizar ou criar conversa', conversa: null, criada: false }
  }

  const convId = Number(result.conversa.id)
  const criada = result.created === true

  const needsClienteLink =
    !result.conversa.cliente_id || Number(result.conversa.cliente_id) !== Number(cliente.id)
  if (needsClienteLink || !result.conversa.tipo) {
    await supabase
      .from('conversas')
      .update({ tipo: 'cliente', cliente_id: cliente.id })
      .eq('company_id', company_id)
      .eq('id', convId)
  }

  const { data: row } = await supabase
    .from('conversas')
    .select('id, telefone, cliente_id, status_atendimento, tipo')
    .eq('company_id', company_id)
    .eq('id', convId)
    .maybeSingle()

  const convRow = row || result.conversa
  const payload = {
    id: convId,
    cliente_id: cliente.id,
    telefone: convRow.telefone || telefone,
    tipo: 'cliente',
    status_atendimento: convRow.status_atendimento || null,
    contato_nome: getDisplayName(cliente) || convRow.telefone || telefone,
    foto_perfil: cliente.foto_perfil || null,
    unread_count: 0,
    tags: [],
  }

  return {
    ok: true,
    error: null,
    conversa: payload,
    criada,
    novaConversaId: criada ? convId : undefined,
  }
}

module.exports = { ensureConversaForCliente }
