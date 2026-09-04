/**
 * Serviço canônico de endereço de destino de uma conversa: resolução de instância WhatsApp,
 * de telefone real a partir de LID e de telefone de envio.
 *
 * Extraído de controllers/chatController.js (Fase 2 da modularização) sem alteração de comportamento.
 * Antes essa resolução aparecia duplicada em vários fluxos de saída/encaminhamento/reenvio; agora
 * há uma única implementação. Depende diretamente do supabase (SERVICE_ROLE) e do whatsappInstanceService,
 * exatamente como no controller original.
 */

const supabase = require('../../../config/supabase')
const { getDefaultWhatsappInstance, getWhatsappInstanceById } = require('../../whatsappInstanceService')

/**
 * Provider WhatsApp da instância resolvida da conversa. Default 'ultramsg' — sem instância,
 * instância desconhecida ou erro → 'ultramsg' (comportamento idêntico ao histórico).
 * Usado para rotear getProvider({ provider }) por instância. Ver docs/ai-handoff/25.
 */
async function resolveConversationProvider(company_id, whatsappInstanceId) {
  const id = Number(whatsappInstanceId)
  if (!Number.isFinite(id) || id <= 0) return 'ultramsg'
  try {
    const { instance } = await getWhatsappInstanceById(company_id, id)
    const p = String(instance?.provider || '').trim().toLowerCase()
    return p === 'whapi' ? 'whapi' : 'ultramsg'
  } catch (_) {
    return 'ultramsg'
  }
}

/**
 * Quando a conversa é por LID, procura uma conversa irmã (mesmo chat_lid) que já tenha telefone real.
 * Respeita a instância WhatsApp (ou a ausência dela) para não misturar números entre instâncias.
 */
async function resolveTelefoneFromLidSiblingConversation(company_id, conversa, whatsappInstanceId) {
  if (!conversa?.chat_lid) return null
  let query = supabase
    .from('conversas')
    .select('telefone')
    .eq('company_id', company_id)
    .eq('chat_lid', conversa.chat_lid)
    .not('telefone', 'like', 'lid:%')
  if (whatsappInstanceId) {
    query = query.eq('whatsapp_instance_id', whatsappInstanceId)
  } else {
    query = query.is('whatsapp_instance_id', null)
  }
  const { data: outra } = await query.limit(1).maybeSingle()
  return outra?.telefone || null
}

/**
 * Resolve a instância WhatsApp da conversa. Se a conversa não tem instância, adota a padrão da empresa
 * e persiste o vínculo (apenas quando ainda estava nulo, para não sobrescrever outra instância).
 */
async function resolveConversationWhatsappInstance(company_id, conversa) {
  const current = Number(conversa?.whatsapp_instance_id)
  if (Number.isFinite(current) && current > 0) return current
  const { instance } = await getDefaultWhatsappInstance(company_id)
  const defaultId = Number(instance?.id)
  if (!Number.isFinite(defaultId) || defaultId <= 0) return null
  if (conversa?.id) {
    try {
      await supabase
        .from('conversas')
        .update({ whatsapp_instance_id: defaultId })
        .eq('company_id', Number(company_id))
        .eq('id', Number(conversa.id))
        .is('whatsapp_instance_id', null)
      conversa.whatsapp_instance_id = defaultId
    } catch (_) {}
  }
  return defaultId
}

/** Telefone real de envio da conversa (resolve LID). */
async function resolverTelefoneEnvioDaConversa(company_id, conversa, whatsappInstanceId) {
  let telefone = String(conversa?.telefone || '').trim()
  if (telefone && telefone.toLowerCase().startsWith('lid:')) {
    if (conversa?.cliente_id) {
      const { data: cli } = await supabase
        .from('clientes')
        .select('telefone')
        .eq('id', conversa.cliente_id)
        .eq('company_id', company_id)
        .maybeSingle()
      if (cli?.telefone && !String(cli.telefone).startsWith('lid:')) telefone = String(cli.telefone).trim()
    }
    if (telefone.startsWith('lid:') && conversa?.chat_lid) {
      const telSibling = await resolveTelefoneFromLidSiblingConversation(company_id, conversa, whatsappInstanceId)
      if (telSibling) telefone = String(telSibling).trim()
    }
    if (telefone.startsWith('lid:')) {
      return {
        telefone: null,
        erro: 'Número do contato indisponível (conversa por LID). Aguarde o contato enviar uma mensagem ou sincronize os contatos.',
      }
    }
  }
  if (!telefone) return { telefone: null, erro: 'Conversa sem telefone para envio.' }
  return { telefone, erro: null }
}

module.exports = {
  resolveTelefoneFromLidSiblingConversation,
  resolveConversationWhatsappInstance,
  resolveConversationProvider,
  resolverTelefoneEnvioDaConversa,
}
