/**
 * Consultas auxiliares de leitura do chat: metadados de instâncias WhatsApp para a lista,
 * resolução do msgId de reply para o provider e busca de conversas por texto de mensagem.
 * Extraído de controllers/chatController.js (Fase 4 da modularização) sem alteração de comportamento.
 */

const supabase = require('../../../config/supabase')
const { escapeIlikePattern } = require('../../../helpers/chatSearchHelper')
const {
  getSearchMessagesPageSize,
  getChatSearchScanLimit,
  getChatSearchIdLimit,
} = require('./searchLimits')

async function loadWhatsappInstanceMetaMap(company_id, instanceIds) {
  const ids = [...new Set((instanceIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
  if (ids.length === 0) return new Map()
  try {
    const { data, error } = await supabase
      .from('whatsapp_instances')
      .select('id, company_id, nome, provider, display_phone')
      .eq('company_id', Number(company_id))
      .in('id', ids)
    if (error) {
      console.warn('[whatsapp_instances] metadados indisponiveis para conversas:', error.message || error)
      return new Map()
    }
    return new Map((data || []).map((row) => [Number(row.id), row]))
  } catch (err) {
    console.warn('[whatsapp_instances] falha ao enriquecer conversas:', err?.message || err)
    return new Map()
  }
}

/**
 * Para POST /messages/chat com reply: `msgId` deve ser o id da mensagem no WhatsApp (webhook),
 * não o id interno da tabela `mensagens`. Aceita já no formato UltraMsg/WA ou resolve por `mensagens.id`.
 */
async function resolveUltraMsgReplyMessageId(supabaseClient, company_id, conversa_id, replyToIdRaw) {
  const rid = String(replyToIdRaw ?? '').trim()
  if (!rid) return null

  // 1) Se já existir mensagem com whatsapp_id igual ao rid, ele já é o id canônico do WhatsApp.
  try {
    const { data: byWhatsappId } = await supabaseClient
      .from('mensagens')
      .select('id')
      .eq('company_id', company_id)
      .eq('conversa_id', Number(conversa_id))
      .eq('whatsapp_id', rid)
      .maybeSingle()
    if (byWhatsappId) return rid
  } catch (_) {}

  // 2) Se o frontend enviou mensagens.id (UUID/bigint), resolver para whatsapp_id real.
  // Nunca enviar id interno para UltraMsg `msgId`, pois não cria citação no WhatsApp.
  try {
    const { data: refMsg } = await supabaseClient
      .from('mensagens')
      .select('whatsapp_id')
      .eq('company_id', company_id)
      .eq('conversa_id', Number(conversa_id))
      .eq('id', rid)
      .maybeSingle()
    const wa = refMsg?.whatsapp_id != null ? String(refMsg.whatsapp_id).trim() : ''
    if (wa) return wa
  } catch (_) {}

  // 3) Fallback seguro: aceitar apenas formatos que parecem id real de mensagem WA/UltraMsg.
  // Evita enviar UUID/ID interno como msgId (causa mensagem avulsa no WhatsApp do cliente).
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rid)
  const looksLikeWhatsAppId = rid.includes('@') || rid.includes('_')
  if (!isUuid && looksLikeWhatsAppId) return rid
  return null
}

async function buscarConversaIdsPorTextoMensagens({ company_id, term }) {
  const pageSize = getSearchMessagesPageSize()
  const scanLimit = getChatSearchScanLimit()
  const idLimit = getChatSearchIdLimit()
  const ids = new Set()
  // term chega sem wildcards; construímos aqui para manter contrato uniforme com o service
  const likePattern = `%${escapeIlikePattern(term)}%`

  for (let start = 0; start < scanLimit && ids.size < idLimit; start += pageSize) {
    const end = Math.min(start + pageSize - 1, scanLimit - 1)
    const { data, error } = await supabase
      .from('mensagens')
      .select('conversa_id')
      .eq('company_id', Number(company_id))
      .ilike('texto', likePattern)
      .order('criado_em', { ascending: false })
      .order('id', { ascending: false })
      .range(start, end)

    if (error) {
      console.warn('[busca-msg] erro na varredura de mensagens:', error.message)
      break
    }

    const rows = Array.isArray(data) ? data : []
    for (const row of rows) {
      if (row?.conversa_id != null) ids.add(row.conversa_id)
      if (ids.size >= idLimit) break
    }

    if (rows.length < (end - start + 1)) break
  }

  return [...ids]
}

module.exports = {
  loadWhatsappInstanceMetaMap,
  resolveUltraMsgReplyMessageId,
  buscarConversaIdsPorTextoMensagens,
}
