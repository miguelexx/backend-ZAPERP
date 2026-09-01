/**
 * Consulta/atualização de mensagem por whatsapp_id com filtro de instância (e fallback legado sem instância).
 * Extraído de controllers/webhookZapiController.js (Fase 2 — doc 24) sem alteração de comportamento.
 * As funções recebem o supabaseClient por parâmetro (não importam supabase).
 */

const WEBHOOK_MSG_SELECT = 'id, conversa_id, company_id, whatsapp_instance_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'

/** URL pública remota (CDN UltraMsg) — diferente de /uploads/ gravado pelo CRM no envio. */
function isTraceableWhatsappMessageId(value) {
  if (!value) return false
  const s = String(value).trim()
  if (!s || s === 'null' || s === 'undefined' || s === 'false' || s === '0') return false
  if (s.includes('@')) return true
  if (/^[A-F0-9]{12,}$/i.test(s)) return true
  if (s.length > 20) return true
  return false
}

function isRemoteMediaUrl(url) {
  const u = String(url || '').trim().toLowerCase()
  return u.startsWith('http://') || u.startsWith('https://')
}

function isLocalUploadMediaUrl(url) {
  return String(url || '').trim().startsWith('/uploads/')
}

/**
 * No fallback de insert (erro de schema), nunca descartar tipo/url/nome da mídia já montados.
 * Mutates and returns fallbackPayload.
 */
function preserveMediaFieldsOnWebhookFallback(fallbackPayload, insertMsg) {
  if (!fallbackPayload || !insertMsg || typeof insertMsg !== 'object') return fallbackPayload
  if (insertMsg.tipo) fallbackPayload.tipo = insertMsg.tipo
  if (insertMsg.url) fallbackPayload.url = insertMsg.url
  if (insertMsg.nome_arquivo) fallbackPayload.nome_arquivo = insertMsg.nome_arquivo
  return fallbackPayload
}

function applyWhatsappInstanceFilter(query, whatsappInstanceId) {
  if (!query || !whatsappInstanceId) return query
  return query.eq('whatsapp_instance_id', whatsappInstanceId)
}

function applyWhatsappInstanceFilterOrLegacy(query, whatsappInstanceId) {
  if (!query) return query
  if (whatsappInstanceId) return query.eq('whatsapp_instance_id', whatsappInstanceId)
  return query.is('whatsapp_instance_id', null)
}

function logAmbiguousWhatsappId(context, { company_id, whatsapp_instance_id, whatsapp_id, count, conversa_ids }) {
  console.error('[webhook] whatsapp_id ambiguo; bloqueando atualizacao para evitar mistura multi-instancia', {
    context,
    company_id,
    whatsapp_instance_id: whatsapp_instance_id || null,
    whatsapp_id: whatsapp_id ? String(whatsapp_id).slice(0, 32) : null,
    count,
    conversa_ids: conversa_ids || undefined,
  })
}

async function selectSingleMensagemByWhatsappId(
  supabaseClient,
  { company_id, whatsapp_id, whatsapp_instance_id = null, select = WEBHOOK_MSG_SELECT, context = 'webhook' }
) {
  const waId = whatsapp_id != null ? String(whatsapp_id).trim() : ''
  if (!supabaseClient || !company_id || !waId) return { data: null, error: null, ambiguous: false }

  // Inclui conversa_id na busca interna para diagnóstico de ambiguidade e dedup por conversa.
  const internalSelect = select.includes('conversa_id') ? select : `${select}, conversa_id`
  let query = supabaseClient
    .from('mensagens')
    .select(internalSelect)
    .eq('company_id', company_id)
    .eq('whatsapp_id', waId)
    .order('id', { ascending: false })
    .limit(2)
  query = applyWhatsappInstanceFilterOrLegacy(query, whatsapp_instance_id)

  const { data, error } = await query
  if (error) return { data: null, error, ambiguous: false }
  const rows = Array.isArray(data) ? data : []
  if (rows.length > 1) {
    // Se ambas as linhas pertencem à mesma conversa, é reentrega dupla — usar a mais recente (id maior).
    const conversaIds = rows.map((r) => r.conversa_id)
    const allSameConversa = conversaIds.every((c) => c != null && c === conversaIds[0])
    if (allSameConversa) {
      return { data: rows[0], error: null, ambiguous: false }
    }
    logAmbiguousWhatsappId(context, {
      company_id,
      whatsapp_instance_id,
      whatsapp_id: waId,
      count: rows.length,
      conversa_ids: conversaIds,
    })
    return {
      data: null,
      error: { code: 'AMBIGUOUS_WHATSAPP_ID', message: 'whatsapp_id ambiguo para a empresa/instancia' },
      ambiguous: true,
    }
  }
  return { data: rows[0] || null, error: null, ambiguous: false }
}

async function updateSingleMensagemByWhatsappId(
  supabaseClient,
  { company_id, whatsapp_id, whatsapp_instance_id = null, updates, select = WEBHOOK_MSG_SELECT, context = 'webhook' }
) {
  const found = await selectSingleMensagemByWhatsappId(supabaseClient, {
    company_id,
    whatsapp_id,
    whatsapp_instance_id,
    select: 'id, whatsapp_id',
    context,
  })
  if (found.error || !found.data?.id) return { data: null, error: found.error || null, ambiguous: Boolean(found.ambiguous) }

  const { data, error } = await supabaseClient
    .from('mensagens')
    .update(updates)
    .eq('company_id', company_id)
    .eq('id', found.data.id)
    .select(select)
    .maybeSingle()
  return { data, error, ambiguous: false }
}

/** Busca mensagem por whatsapp_id sem filtrar instância (fallback quando ACK não encontra por instance_id). */
async function selectSingleMensagemByWhatsappIdRelaxed(
  supabaseClient,
  { company_id, whatsapp_id, select = 'id, conversa_id, company_id, autor_usuario_id, whatsapp_id, status, whatsapp_instance_id', context = 'webhook' }
) {
  const waId = whatsapp_id != null ? String(whatsapp_id).trim() : ''
  if (!supabaseClient || !company_id || !waId) return { data: null, ambiguous: false }

  const { data, error } = await supabaseClient
    .from('mensagens')
    .select(select)
    .eq('company_id', company_id)
    .eq('whatsapp_id', waId)
    .order('id', { ascending: false })
    .limit(2)
  if (error) return { data: null, ambiguous: false, error }
  const rows = Array.isArray(data) ? data : []
  if (rows.length > 1) {
    logAmbiguousWhatsappId(context, { company_id, whatsapp_instance_id: null, whatsapp_id: waId, count: rows.length })
    return { data: null, ambiguous: true }
  }
  return { data: rows[0] || null, ambiguous: false }
}

async function patchMensagemStatusById(supabaseClient, { company_id, mensagem_id, effectiveStatus, whatsapp_id, select }) {
  const updates = { status: effectiveStatus, status_mensagem: effectiveStatus }
  if (whatsapp_id) updates.whatsapp_id = whatsapp_id
  const { data, error } = await supabaseClient
    .from('mensagens')
    .update(updates)
    .eq('company_id', company_id)
    .eq('id', mensagem_id)
    .select(select || 'id, conversa_id, company_id, autor_usuario_id, whatsapp_id')
    .maybeSingle()
  return { data, error }
}

module.exports = {
  isTraceableWhatsappMessageId,
  isRemoteMediaUrl,
  isLocalUploadMediaUrl,
  preserveMediaFieldsOnWebhookFallback,
  applyWhatsappInstanceFilter,
  applyWhatsappInstanceFilterOrLegacy,
  logAmbiguousWhatsappId,
  selectSingleMensagemByWhatsappId,
  updateSingleMensagemByWhatsappId,
  selectSingleMensagemByWhatsappIdRelaxed,
  patchMensagemStatusById,
}
