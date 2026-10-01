/**
 * Recupera a URL REMOTA (provedor) de uma mídia recebida cuja cópia local em /uploads
 * sumiu do disco (limpeza de espaço, deploy que recriou a pasta, troca de host).
 *
 * Contexto: ao persistir, `inboundMediaPersistenceService` SOBRESCREVE `mensagens.url`
 * com o caminho /uploads — a URL original do provedor se perde. Se depois o arquivo em
 * disco desaparecer, a linha aponta para um 404 e nenhum fluxo automático reparava
 * (backfill/persist tratam "/uploads/" como estado final).
 *
 * Estratégia (só leitura no provedor; quem re-copia é o chamador via persist force):
 *  1) Busca direta da mensagem pelo whatsapp_id (Whapi: GET /messages/{MessageID}).
 *  2) Fallback: histórico do chat — a MESMA máquina do botão "Carregar mensagens
 *     antigas" (provider.getChatMessages) — e localiza a mensagem pelo whatsapp_id.
 * Em ambos, a URL é extraída com `normalizeOldMessage` (normalizador já testado do
 * oldMessagesSync), aceitando apenas https (exigência do persist) e SOMENTE quando o
 * whatsapp_id normalizado confere — nunca a mídia de outra mensagem.
 *
 * Retorna a URL https (string) ou null. Nunca lança.
 */

const { getProvider } = require('./providers')
const { resolveConversationProvider } = require('./chat/identity/conversationAddressService')
const { normalizeOldMessage, resolveChatIdsForConversation } = require('./oldMessagesSyncService')
const { mapWhapiMessageForSync } = require('./providers/whapi/chatMessages')

const FALLBACK_CHAT_FETCH_AMOUNT = 100

/**
 * Extrai a URL https da mídia de um payload cru do provedor, garantindo que o payload
 * é MESMO a mensagem procurada (whatsapp_id normalizado igual).
 */
function urlHttpsSeMesmaMensagem(raw, whatsappId, isGroup) {
  try {
    const norm = normalizeOldMessage(raw, { isGroup: !!isGroup })
    if (!norm?.insert) return null
    if (String(norm.insert.whatsapp_id || '').trim() !== whatsappId) return null
    const u = String(norm.insert.url || '').trim()
    return /^https:\/\//i.test(u) ? u : null
  } catch (_) {
    return null
  }
}

/**
 * @param {{ supabase:any, company_id:number, mensagem:{ id:number, conversa_id:number, whatsapp_id?:string, whatsapp_instance_id?:number } }} ctx
 * @returns {Promise<string|null>} URL https fresca do provedor, ou null se irrecuperável.
 */
async function recuperarUrlRemotaDaMensagem({ supabase, company_id, mensagem }) {
  const whatsappId = String(mensagem?.whatsapp_id || '').trim()
  const conversaId = Number(mensagem?.conversa_id)
  if (!whatsappId || !Number.isFinite(conversaId)) return null

  let conversa = null
  try {
    const { data } = await supabase
      .from('conversas')
      .select('id, company_id, cliente_id, telefone, chat_lid, whatsapp_instance_id, tipo, clientes!conversas_cliente_fk ( id, telefone, company_id )')
      .eq('company_id', Number(company_id))
      .eq('id', conversaId)
      .maybeSingle()
    conversa = data || null
  } catch (_) {
    conversa = null
  }
  if (!conversa?.id) return null

  const whatsappInstanceId = mensagem?.whatsapp_instance_id ?? conversa.whatsapp_instance_id ?? null
  const isGroup = conversa.tipo === 'grupo' || String(conversa.telefone || '').endsWith('@g.us')

  let provider = null
  let instanceProvider = 'ultramsg'
  try {
    instanceProvider = await resolveConversationProvider(company_id, whatsappInstanceId)
    provider = getProvider({ provider: instanceProvider })
  } catch (_) {
    return null
  }
  const providerOpts = {
    companyId: Number(company_id),
    whatsappInstanceId: whatsappInstanceId || undefined,
  }

  // 1) Busca direta pelo id da mensagem (Whapi: GET /messages/{MessageID}).
  if (typeof provider?.getMessages === 'function') {
    try {
      const res = await provider.getMessages({ ...providerOpts, id: whatsappId })
      const rows = Array.isArray(res?.data) ? res.data : []
      for (const raw of rows) {
        // O shape cru da Whapi usa `document.link` etc.; o mapper do próprio provider
        // converte para o formato que o normalizador entende. Para UltraMSG o cru já serve.
        const candidato = instanceProvider === 'whapi' ? (mapWhapiMessageForSync(raw) || raw) : raw
        const url = urlHttpsSeMesmaMensagem(candidato, whatsappId, isGroup)
        if (url) return url
      }
    } catch (_) { /* tenta o fallback */ }
  }

  // 2) Fallback: histórico do chat (só conversas individuais — grupos não têm candidato de chat).
  if (isGroup || typeof provider?.getChatMessages !== 'function') return null
  let chatCandidates = []
  try {
    chatCandidates = await resolveChatIdsForConversation(company_id, conversa)
  } catch (_) {
    chatCandidates = []
  }
  if (!chatCandidates.length) return null

  try {
    const providerResult = await provider.getChatMessages(
      chatCandidates[0],
      FALLBACK_CHAT_FETCH_AMOUNT,
      null,
      { ...providerOpts, returnDetails: true, chatIdCandidates: chatCandidates }
    )
    const rows = Array.isArray(providerResult?.data) ? providerResult.data : []
    for (const raw of rows) {
      const url = urlHttpsSeMesmaMensagem(raw, whatsappId, isGroup)
      if (url) return url
    }
  } catch (_) { /* irrecuperável por aqui */ }

  return null
}

module.exports = {
  recuperarUrlRemotaDaMensagem,
  _test: { urlHttpsSeMesmaMensagem },
}
