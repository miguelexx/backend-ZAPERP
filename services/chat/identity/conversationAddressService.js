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
const {
  getDefaultWhatsappInstance,
  getWhatsappInstanceById,
  listWhatsappInstances,
} = require('../../whatsappInstanceService')

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
 * Provider da instância default/única da empresa (alertas, sync company-level, perfil).
 * Sem instância, várias sem default, ou erro → 'ultramsg'.
 */
async function resolveCompanyWhatsappProvider(company_id) {
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) return 'ultramsg'
  try {
    const { instances } = await listWhatsappInstances(cid)
    const chosen = pickCompanyWhatsappInstance(instances)
    const p = String(chosen?.provider || '').trim().toLowerCase()
    return p === 'whapi' ? 'whapi' : 'ultramsg'
  } catch (_) {
    return 'ultramsg'
  }
}

/**
 * Instância inequívoca para amarrar conversa ainda sem whatsapp_instance_id.
 * is_default (qualquer provider) ou exatamente 1 ativa. 2+ sem default → null (não adivinhar).
 */
function pickInstanceForUnboundConversation(instances) {
  const active = (instances || []).filter((i) => i && i.ativo !== false)
  if (!active.length) return null
  const def = active.find((i) => i.is_default === true)
  if (def) return def
  if (active.length === 1) return active[0]
  return null
}

/**
 * Instância da empresa para sync/alertas company-level.
 * Igual à conversa unbound, mas com 2+ sem default prefere UltraMSG (histórico) em vez de Whapi.
 */
function pickCompanyWhatsappInstance(instances) {
  const unambiguous = pickInstanceForUnboundConversation(instances)
  if (unambiguous) return unambiguous
  const active = (instances || []).filter((i) => i && i.ativo !== false)
  if (!active.length) return null
  return active.find((i) => String(i.provider || '').toLowerCase() !== 'whapi') || active[0]
}

function isWhapiInstance(instance) {
  return String(instance?.provider || '').trim().toLowerCase() === 'whapi'
}

/**
 * Instância cuja agenda do celular deve ser importada.
 * pickCompanyWhatsappInstance prefere UltraMSG no company-level (alertas/legado).
 * A agenda do telefone vive no canal conectado — se existir Whapi, usar Whapi
 * mesmo quando UltraMSG ainda é default. 2+ Whapi: default Whapi, senão menor id.
 */
function pickContactSyncInstance(instances) {
  const active = (instances || []).filter((i) => i && i.ativo !== false)
  if (!active.length) return null
  const whapiList = active.filter(isWhapiInstance)
  if (whapiList.length === 1) return whapiList[0]
  if (whapiList.length > 1) {
    return whapiList.find((i) => i.is_default === true)
      || [...whapiList].sort((a, b) => Number(a.id) - Number(b.id))[0]
  }
  return pickCompanyWhatsappInstance(instances)
}

/**
 * Provider + id da instância para GET /contacts (sync de agenda).
 * Sem instância/erro → ultramsg (mesmo default histórico).
 */
async function resolveContactSyncInstance(company_id) {
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) {
    return { provider: 'ultramsg', whatsappInstanceId: null }
  }
  try {
    const { instances } = await listWhatsappInstances(cid)
    const chosen = pickContactSyncInstance(instances)
    const provider = isWhapiInstance(chosen) ? 'whapi' : 'ultramsg'
    const id = chosen?.id != null ? Number(chosen.id) : null
    return {
      provider,
      whatsappInstanceId: Number.isFinite(id) && id > 0 ? id : null,
    }
  } catch (_) {
    return { provider: 'ultramsg', whatsappInstanceId: null }
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
  const { instances } = await listWhatsappInstances(company_id)
  const active = (instances || []).filter((i) => i && i.ativo !== false)
  let chosen = pickInstanceForUnboundConversation(instances)
  // Só o legado empresa_zapi quando a empresa NÃO tem linha ativa em whatsapp_instances.
  // getDefaultWhatsappInstance filtra provider=ultramsg e, se vazio, cai no legado mesmo
  // com Whapi cadastrada — isso roteava empresa só-Whapi para UltraMSG.
  if (!chosen && active.length === 0) {
    const { instance } = await getDefaultWhatsappInstance(company_id)
    chosen = instance
  }
  const defaultId = Number(chosen?.id)
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
  resolveCompanyWhatsappProvider,
  resolveContactSyncInstance,
  resolverTelefoneEnvioDaConversa,
  pickInstanceForUnboundConversation,
  pickCompanyWhatsappInstance,
  pickContactSyncInstance,
}
