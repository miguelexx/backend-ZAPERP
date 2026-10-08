const supabase = require('../config/supabase')
const { getDisplayName } = require('../helpers/contactEnrichment')
const { findOrCreateConversation } = require('../helpers/conversationSync')
const {
  resolveWhatsappInstanceForManualAction,
  sanitizeWhatsappInstance,
} = require('./whatsappInstanceService')

function safeWhatsappInstanceMeta(instance) {
  const safe = sanitizeWhatsappInstance(instance)
  if (!safe) return {}
  return {
    whatsapp_instance_id: safe.id ?? null,
    whatsapp_instance_nome: safe.nome ?? null,
    whatsapp_instance_provider: safe.provider ?? null,
    whatsapp_instance_display_phone: safe.display_phone ?? null,
  }
}

/**
 * Garante uma conversa 1:1 para o cliente (localiza por telefone + instância ou cria).
 * Usado por POST /chats/abrir-conversa e POST /clientes (flags abrir_conversa / assumir).
 */
async function ensureConversaForCliente({
  company_id,
  usuario_id,
  cliente,
  whatsapp_instance_id = null,
}) {
  const telefone = cliente.telefone || ''
  if (!telefone) {
    return { ok: false, error: 'Cliente sem telefone cadastrado', conversa: null, criada: false }
  }

  const instanceRes = await resolveWhatsappInstanceForManualAction(company_id, whatsapp_instance_id)
  if (instanceRes.code === 'SELECIONE_WHATSAPP_INSTANCE') {
    return {
      ok: false,
      error: instanceRes.error,
      codigo: instanceRes.code,
      whatsapp_instances: instanceRes.instances || [],
      conversa: null,
      criada: false,
    }
  }
  if (instanceRes.error || !instanceRes.instanceId) {
    return {
      ok: false,
      error: instanceRes.error || 'Não foi possível resolver instância WhatsApp',
      conversa: null,
      criada: false,
    }
  }

  let result
  try {
    result = await findOrCreateConversation(supabase, {
      company_id,
      phone: telefone,
      cliente_id: cliente.id,
      isGroup: false,
      whatsapp_instance_id: instanceRes.instanceId,
      whatsapp_instance_is_default: instanceRes.isDefault === true,
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
    .select('id, telefone, cliente_id, status_atendimento, tipo, whatsapp_instance_id')
    .eq('company_id', company_id)
    .eq('id', convId)
    .maybeSingle()

  const convRow = row || result.conversa
  const instanceMeta = safeWhatsappInstanceMeta(instanceRes.instance)
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
    whatsapp_instance_id: convRow.whatsapp_instance_id ?? instanceRes.instanceId,
    ...instanceMeta,
  }

  return {
    ok: true,
    error: null,
    conversa: payload,
    criada,
    novaConversaId: criada ? convId : undefined,
  }
}

module.exports = { ensureConversaForCliente, safeWhatsappInstanceMeta }
