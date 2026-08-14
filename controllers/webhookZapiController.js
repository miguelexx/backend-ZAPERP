/**
 * Processamento central de webhooks WhatsApp (UltraMSG na entrada atual).
 * O ficheiro mantém o nome histórico `webhookZapiController`; funções como `receberZapi`/`statusZapi` são o núcleo interno
 * após normalização em `webhookUltramsgController`. Não implica provider Z-API público.
 * @see ../docs/_OFICIAL/ADR-LEGACY-NAMING.md
 *
 * Usado pelo webhookUltramsgController: UltraMSG normaliza payload e delega para este controlador.
 * Suporta: texto, imagem, áudio,
 * vídeo, documento, figurinha, reação, localização, contato, PTV, templates, botões, listas.
 * Suporta conversas individuais e de GRUPO.
 * Espelhamento WhatsApp Web: mensagens enviadas pelo celular (fromMe) TAMBÉM são
 * persistidas e emitidas via WebSocket; idempotência por (conversa_id, whatsapp_id).
 */

const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { syncUltraMsgContact } = require('../services/ultramsgSyncContact')
const { getCompanyIdByInstanceId } = require('../services/whatsappConfigService')
const { getWhatsappInstanceByProviderInstanceId } = require('../services/whatsappInstanceService')
const { getStatus } = require('../services/ultramsgIntegrationService')
const { normalizePhoneBR, possiblePhonesBR, normalizeGroupIdForStorage } = require('../helpers/phoneHelper')
const { getCanonicalPhone, getOrCreateCliente, findOrCreateConversation, mergeConversasIntoCanonico, mergeConversationLidToPhone } = require('../helpers/conversationSync')
const { chooseBestName, isBadName, getDisplayName } = require('../helpers/contactEnrichment')
const { parseVcardForContact } = require('../helpers/vcardHelper')
const { resolvePeerPhone } = require('../helpers/conversationKeyHelper')
const { incrementarUnreadParaConversa, emitirParaUsuariosQuePodemVerConversa } = require('./chatController')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../helpers/timestampApiCompat')
const { scheduleInboundWebPush } = require('../services/webPushDispatchService')
const {
  schedulePersistInboundMediaIfNeeded,
  tipoQualificaPersistencia,
} = require('../services/inboundMediaPersistenceService')
const {
  scheduleInboundMediaBackfill,
} = require('../services/inboundMediaBackfillService')

const {
  processIncomingMessage: processChatbotTriage,
  logBotAction,
} = require('../services/chatbotTriageService')
const { emitBotMensagemRealtime, emitReaberturaSemSetorRealtime } = require('../helpers/chatbotRealtimeEmitter')
const { clearReabertaFaltaInteracao } = require('../helpers/reabertaFaltaInteracaoHelper')
const { processarOptOut } = require('../services/optOutService')
const { processarRegras } = require('../services/regrasAutomaticasService')
const {
  loadChatbotTriageMergeAndAbsence,
  tryMarkWaitingAfterHumanOutbound,
  clearWaitingForClient,
  fetchLastAbsenceEncerramentoSnap,
  resolveReopenAssignmentAfterAbsence,
} = require('../services/absenceFinalizationService')
const {
  aplicarModoSimplesNoPayload,
  recalcularStatusPorUltimaMensagem,
} = require('../services/atendimentoModoSimplesService')
const { isEnabled, FLAGS } = require('../helpers/featureFlags')
const { parseNota, tentarRegistrarAvaliacao } = require('../services/avaliacaoService')
const {
  isUltramsgNumericQueueId,
  parseCrmReferenceMensagemId,
  isReconcilablePendingWhatsappId,
  areEquivalentWhatsAppIds,
} = require('../helpers/whatsappMessageIdHelper')
const {
  STATUS_RANK,
  normalizeRawAckStatus,
  normalizeMessageAckStatus,
  canonStatusForEmit,
  statusRank,
} = require('../helpers/messageStatusHelper')

// company_id NUNCA mais via ENV — resolvido por instanceId do payload em cada webhook
const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'
// Seleção enxuta para evitar payload desnecessário em caminhos quentes de webhook.
// IMPORTANTE: não depender de colunas opcionais para manter compatibilidade com bancos legados.
const WEBHOOK_MSG_SELECT = 'id, conversa_id, company_id, whatsapp_instance_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'

// Ordem de progresso dos ticks de status. Usado em statusZapi para evitar que um ack atrasado
// (ex.: "delivered" chegando depois de "read") regrida visualmente o status já persistido.
// STATUS_RANK importado de messageStatusHelper (inclui sending=0).

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

function normalizeMediaFileNameForMatch(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function normalizeMediaBaseNameForMatch(name) {
  const clean = normalizeMediaFileNameForMatch(name).split(/[?#]/)[0].split(/[\\/]/).pop() || ''
  return clean.replace(/\.[a-z0-9]{2,5}$/i, '')
}

function mediaFamilyForStorageTipo(tipo) {
  const t = String(tipo || '').toLowerCase().trim()
  if (t === 'text' || t === 'texto' || t === 'chat') return 'texto'
  if (t === 'audio' || t === 'voice' || t === 'ptt') return 'audio'
  // Figurinha e imagem compartilham família na reconciliação fromMe (webp pode vir como image no webhook).
  if (t === 'image' || t === 'imagem' || t === 'sticker') return 'imagem'
  if (t === 'video' || t === 'vídeo') return 'video'
  if (t === 'document' || t === 'file' || t === 'arquivo' || t === 'documento') return 'arquivo'
  return t || ''
}

function whatsappIdCompativelParaReconcile(row, whatsappId) {
  const atual = row?.whatsapp_id != null ? String(row.whatsapp_id).trim() : ''
  const alvo = whatsappId != null ? String(whatsappId).trim() : ''
  if (!atual || !alvo) return true
  if (atual === alvo) return true
  // Mesmo envio UltraMSG em formatos diferentes (sid hex vs false_jid@c.us_sid).
  if (areEquivalentWhatsAppIds(atual, alvo)) return true
  // CRM pode ter guardado id de fila UltraMSG (ex: 35096); webhook traz id real do WhatsApp.
  if (isUltramsgNumericQueueId(atual) && !isUltramsgNumericQueueId(alvo)) return true
  return false
}

function filterRowsForFromMeReconcile(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => isReconcilablePendingWhatsappId(r?.whatsapp_id))
}

function getCrmReferenceIdFromPayload(payload) {
  return payload?.ultramsgReferenceId ?? payload?.referenceId ?? null
}

async function tryReconcileFromMeByCrmReferenceId(supabase, {
  company_id,
  conversa_id,
  whatsapp_instance_id,
  payload,
  whatsappIdStr,
  statusPayload = null,
}) {
  const crmMsgId = parseCrmReferenceMensagemId(getCrmReferenceIdFromPayload(payload))
  if (!crmMsgId || !whatsappIdStr) return null
  try {
    // company_id + id (chave primaria) ja identifica a mensagem sem ambiguidade.
    // Filtrar por instancia aqui so produz falso negativo quando um dos lados esta null,
    // e o eco cai na heuristica por conteudo, criando linha duplicada.
    const q = supabase
      .from('mensagens')
      .select(WEBHOOK_MSG_SELECT)
      .eq('company_id', company_id)
      .eq('id', crmMsgId)
      .eq('direcao', 'out')
    const { data: row } = await q.maybeSingle()
    if (!row?.id) return null
    // Divergencia real de instancia (ambos conhecidos) segue bloqueada: nao misturar instancias.
    if (
      whatsapp_instance_id &&
      row.whatsapp_instance_id &&
      Number(row.whatsapp_instance_id) !== Number(whatsapp_instance_id)
    ) {
      return null
    }

    const idsCompat = whatsappIdCompativelParaReconcile(row, whatsappIdStr)
    const updates = {}
    // referenceId crm-{id} e identidade forte: absorve o eco sem INSERT.
    // So promove whatsapp_id quando e promocao segura (null/fila→real ou formatos equivalentes).
    // IDs reais genuinamente distintos: nao sobrescreve o canonico (ACK/delete/reacao).
    if (idsCompat) {
      updates.whatsapp_id = whatsappIdStr
    } else {
      console.warn('[Z-API] fromMe reconcile referenceId: IDs divergentes, absorvendo eco sem overwrite', {
        mensagem_id: row.id,
        referenceId: getCrmReferenceIdFromPayload(payload),
        whatsapp_id_atual: String(row.whatsapp_id || '').slice(0, 40),
        whatsapp_id_webhook: String(whatsappIdStr).slice(0, 40),
      })
    }

    const ackStatus = normalizeRawAckStatus(statusPayload ?? payload?.status ?? payload?.ack)
    if (ackStatus && statusRank(ackStatus) >= statusRank(row.status || row.status_mensagem || 'pending')) {
      updates.status = ackStatus
      updates.status_mensagem = ackStatus
    }

    if (Object.keys(updates).length === 0) {
      return row
    }

    const { data: updated } = await supabase
      .from('mensagens')
      .update(updates)
      .eq('company_id', company_id)
      .eq('id', row.id)
      .select(WEBHOOK_MSG_SELECT)
      .maybeSingle()
    if (WHATSAPP_DEBUG && (updated || row)) {
      console.log('[Z-API] fromMe reconcile via referenceId crm:', {
        mensagem_id: row.id,
        referenceId: getCrmReferenceIdFromPayload(payload),
        whatsapp_id: String(whatsappIdStr).slice(0, 24),
        ids_compat: idsCompat,
      })
    }
    return updated || row
  } catch (e) {
    console.warn('[Z-API] fromMe reconcile referenceId:', e?.message || e)
    return null
  }
}

function mapWebhookTypeToStorageTipo(type) {
  const t = String(type || '').toLowerCase().trim()
  if (t === 'text' || t === 'chat') return 'texto'
  if (t === 'ptt') return 'voice'
  if (t === 'document' || t === 'file') return 'arquivo'
  if (t === 'image') return 'imagem'
  if (t === 'video') return 'video'
  if (t === 'audio') return 'audio'
  if (t === 'sticker') return 'sticker'
  return t || null
}

/**
 * Casa eco fromMe (webhook) com mensagem outbound recente do CRM.
 * Não usa URL remota vs /uploads/ — evita segunda linha no chat ao enviar PDF/arquivo.
 */
const {
  textosOutboundFromMeEquivalentes,
  extrairNomePrefixoTexto,
} = require('../helpers/mensagemAtendenteNomeHelper')

function findFromMeOutboundMediaCandidate(rows, { fileName, texto, tipo, nomeAtendente, whatsappId }) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const nomeW = normalizeMediaFileNameForMatch(fileName)
  const nomeBaseW = normalizeMediaBaseNameForMatch(fileName)
  const tipoW = tipo ? String(tipo).toLowerCase() : null
  const familiaW = mediaFamilyForStorageTipo(tipoW)
  const candidates = rows.filter((c) => whatsappIdCompativelParaReconcile(c, whatsappId))
  if (candidates.length === 0) return null

  if (nomeW) {
    const byNome = candidates.find((c) => {
      const candNome = normalizeMediaFileNameForMatch(c.nome_arquivo || c.texto)
      const candBase = normalizeMediaBaseNameForMatch(c.nome_arquivo || c.texto)
      if (!candNome || (candNome !== nomeW && candBase !== nomeBaseW)) return false
      if (familiaW && mediaFamilyForStorageTipo(c.tipo) !== familiaW) return false
      return true
    })
    if (byNome) return byNome
  }

  if (texto) {
    const textoNorm = String(texto || '').trim()
    const byTexto = candidates.find((c) => {
      const t = String(c.texto || '').trim()
      if (!t) return false
      if (familiaW && mediaFamilyForStorageTipo(c.tipo) !== familiaW) return false
      if (textosOutboundFromMeEquivalentes(textoNorm, t, nomeAtendente)) return true
      return false
    })
    if (byTexto) return byTexto
  }

  if (familiaW) {
    const byTipoCrm = candidates.find(
      (c) =>
        mediaFamilyForStorageTipo(c.tipo) === familiaW &&
        (c.autor_usuario_id != null || isLocalUploadMediaUrl(c.url))
    )
    if (byTipoCrm) return byTipoCrm
  }

  return null
}

function normalizeReopenText(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s!?.,]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Decide se conversa encerrada deve reabrir ao receber nova mensagem do cliente.
 * Regra: reabrir por defeito; manter fechada só para nota de avaliação (0-10),
 * agradecimentos / ACKs de encerramento ou frases que indicam ausência de nova demanda.
 */
function shouldReopenFinishedConversation(message, context = {}) {
  const raw = String(message || '').trim()
  const normalized = normalizeReopenText(message)
  const compact = normalized.replace(/[!?.,]/g, '').trim()

  if (!compact) {
    return { shouldReopen: false, reason: 'empty_or_symbols_only', normalized }
  }

  // Mesma regra do avaliacaoService: só dígitos 0-10 — não reabre (avaliação ou tentativa)
  if (/^\d{1,2}$/.test(compact) && parseNota(raw) !== null) {
    return { shouldReopen: false, reason: 'evaluation_score_0_10', normalized }
  }

  const stayClosedPatterns = [
    /^(ok|okay|blz|beleza|certo|entendi|entendido|perfeito|show|sim|nao|não|ta|t[áa])$/,
    /^(obrigad[oa]|muito obrigad[oa]|valeu|vlw|obg|brigad[oa]|obgd|agrade[cç]o|grat[oa]|thanks|thank you|ty|thx)$/,
    /^(obrigad[oa] pela ajuda|muito obrigad[oa] pela ajuda)$/,
    // Agradecimento + vocativo / reforço curto (ex.: "obrigada vc", "valeu voce", "brigada tbm") — não reabrir menu
    /^obrigad[oa]\s+(vc|voce|tbm|tb|tambem|demais|tbem)(\s+(vc|voce|tbm|tb|tambem))?$/,
    /^muito\s+obrigad[oa]\s+(vc|voce|tbm|tb|tambem|demais)?$/,
    /^obrigad[oa]\s+(a|pra|para)\s+(vc|voce)$/,
    /^brigad[oa]\s+(vc|voce|tbm|tb|tambem)?$/,
    /^valeu\s+(vc|voce|tbm|tb|tambem|demais)$/,
    /^vlw\s+(vc|voce|tbm|tb)?$/,
    /^obg\s+(vc|voce|tbm|tb|demais)?$/,
    /^(tchau|xau|ate mais|ate logo|ate breve|flw|falou)$/,
    /^(so|só) isso[!., ]*$/,
    /^(nada mais|era (so|só) isso)[!. ]*$/,
    /^(so|só) (um )?(obrigad[oa]|agradecimento|agradecer)$/,
    /^(so|só|apenas) (pra|para) agradecer$/,
    /^pra agradecer$/,
    /^ok[,!. ]+(valeu|obrigad[oa]|vlw|obg)\b/,
    /^(bom|boa)(,)? (obrigad[oa]|valeu|vlw)\b/,
    /^(ate mais|ate logo).{0,20}(obrigad[oa]|valeu|vlw)\b/,
    /^(tudo resolvido|problema resolvido|deu certo|tudo certo)$/
  ]

  if (stayClosedPatterns.some((rx) => rx.test(compact))) {
    return { shouldReopen: false, reason: 'thanks_or_closing_ack', normalized }
  }

  // Frase curta só de cortesia: poucas palavras conhecidas, sem sinais de nova demanda
  const palavrasCortesia = new Set([
    'ok', 'okay', 'blz', 'beleza', 'certo', 'entendi', 'entendido', 'perfeito', 'show', 'sim', 'nao', 'ta', 'obrigada', 'obrigado',
    'muito', 'valeu', 'vlw', 'obg', 'brigada', 'brigado', 'obgd', 'agradeco', 'grato', 'grata', 'thanks', 'thank', 'you', 'ty', 'thx',
    'tchau', 'xau', 'ate', 'mais', 'logo', 'breve', 'flw', 'falou', 'vc', 'voce', 'tbm', 'tb', 'tambem', 'demais',
    'tbem', 'pra', 'para', 'a', 'igualmente', 'disponha', 'imagina', 'de', 'nada', 'por', 'tudo', 'pela', 'pelo',
    'atencao', 'atendimento', 'preferencia', 'carinho', 'ajuda', 'info',
  ])
  const sinaisDemanda =
    /\b(preciso|precisar|precisa|quero|gostaria|poderia|pode\s+me|d[uú]vida|problema|reclama|cancelar|devolver|trocar|defeito|or[çc]amento|orcamento|pedido|entrega|atraso|valor|pre[çc]o|preco|como\s+(fa[çc]o|posso|fazer)|onde|quando|urgente)\b/i
  const tokens = compact.split(/\s+/).filter(Boolean)
  if (tokens.length > 0 && tokens.length <= 6 && compact.length <= 72 && !sinaisDemanda.test(compact)) {
    const soCortesia = tokens.every((w) => palavrasCortesia.has(w))
    if (soCortesia) {
      return { shouldReopen: false, reason: 'thanks_or_closing_ack_short', normalized }
    }
  }

  return { shouldReopen: true, reason: 'default_reopen_after_close', normalized }
}

/** Log [ZAPI_CERT] uma linha por ação — só quando WHATSAPP_DEBUG=true (apenas dev). Sem token, sem conteúdo da msg. */
function logZapiCert(opts) {
  if (!WHATSAPP_DEBUG) return
  const ts = new Date().toISOString()
  const line = JSON.stringify({
    ts,
    companyId: opts.companyId ?? null,
    instanceId: opts.instanceId ? String(opts.instanceId).slice(0, 24) + (opts.instanceId.length > 24 ? '…' : '') : null,
    type: opts.type ?? null,
    fromMe: opts.fromMe ?? null,
    hasDest: opts.hasDest ?? null,
    phoneTail: opts.phoneTail ?? null,
    connectedTail: opts.connectedTail ?? null,
    messageId: opts.messageId ? String(opts.messageId).slice(0, 24) + (String(opts.messageId).length > 24 ? '…' : '') : null,
    resolvedKeyType: opts.resolvedKeyType ?? null,
    conversaId: opts.conversaId ?? null,
    action: opts.action ?? 'unknown'
  })
  console.log('[ZAPI_CERT]', line)
}

// Buffer em memória das últimas 30 requisições webhook recebidas (diagnóstico)
const _webhookLog = []
function _logWebhook(entry) {
  _webhookLog.unshift({ ts: new Date().toISOString(), ...entry })
  if (_webhookLog.length > 30) _webhookLog.pop()
}

/** Detecta se o payload é de um grupo (remoteJid @g.us, isGroup ou tipo grupo). */
function isGroupPayload(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (payload.isGroup === true) return true
  // UltraMsg usa isGroupMsg em vez de isGroup
  if (payload.isGroupMsg === true) return true
  const tipo = String(payload.tipo || payload.type || '').toLowerCase()
  if (tipo === 'grupo' || tipo === 'group') return true

  const candidates = [
    payload.key?.remoteJid,
    payload.remoteJid,
    payload.chat?.id,
    payload.chat?.remoteJid,
    payload.chatId,
    payload.phone,
    payload.groupId,
    payload.group?.id,
    payload.data?.remoteJid,
    payload.data?.key?.remoteJid,
    // UltraMsg envia o group JID em payload.to / payload.data.to
    payload.to,
    payload.data?.to,
  ].filter(Boolean).map((v) => String(v).trim())

  // 1) Sinais explícitos: @g.us ou sufixo -group
  if (candidates.some((c) => c.endsWith('@g.us') || c.includes('-group'))) return true

  // 2) ID numérico de grupo (120...) + presença de participante/autor
  const hasParticipant =
    !!payload.participantPhone ||
    !!payload.participant ||
    !!payload.author ||
    !!payload.key?.participant

  if (hasParticipant) {
    for (const c of candidates) {
      const d = String(c || '').replace(/\D/g, '')
      if (d.startsWith('120') && d.length >= 15 && d.length <= 22) return true
    }
  }

  // 3) ID de grupo típico (120... 15-22 dígitos) — sem exigir participant.
  // Crítico para fromMe=true: ao enviar para grupo, Z-API pode mandar só phone="120..." sem participantPhone.
  for (const c of candidates) {
    const d = String(c || '').replace(/\D/g, '')
    if (d.startsWith('120') && d.length >= 15 && d.length <= 22) return true
  }

  return false
}

/** Retorna identificador do grupo, quando houver. */
function pickGroupChatId(payload) {
  if (!payload || typeof payload !== 'object') return ''

  const candidates = [
    payload.key?.remoteJid,
    payload.remoteJid,
    payload.chat?.id,
    payload.chat?.remoteJid,
    payload.chatId,
    payload.phone,
    payload.groupId,
    payload.group?.id,
    payload.data?.remoteJid,
    payload.data?.key?.remoteJid,
    // UltraMsg envia o group JID em payload.to / payload.data.to
    payload.to,
    payload.data?.to,
  ]
    .filter((v) => v != null)
    .map((v) => String(v).trim())
    .filter(Boolean)

  // 1) Formato canônico @g.us
  for (const c of candidates) {
    if (c.endsWith('@g.us')) return c
  }

  // 2) Alguns providers mandam "...-group"
  for (const c of candidates) {
    if (c.includes('-group')) return c
  }

  // 3) ID numérico 120... (15-22 dígitos) — heurística WhatsApp. Inclui fromMe (envio para grupo).
  for (const c of candidates) {
    const d = c.replace(/\D/g, '')
    if (d.startsWith('120') && d.length >= 15 && d.length <= 22) return d
  }

  return ''
}

function looksLikeBRPhoneDigits(digits) {
  const d = String(digits || '').replace(/\D/g, '')
  if (!d) return false
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return true
  // às vezes vem só DDD+numero (10/11) no payload
  if (d.length === 10 || d.length === 11) return true
  return false
}

/**
 * Resolve a chave de conversa a partir de um payload Z-API.
 *
 * Contrato Z-API (fonte: documentação oficial):
 *   - connectedPhone = MEU número (instância). NUNCA usar como destino de conversa.
 *   - phone          = "Número de telefone, ou do grupo que enviou a mensagem." = chave do chat.
 *     Para fromMe=true: phone ainda é o contato/grupo (não meu número).
 *   - isGroup        = true → grupo; participantPhone = remetente dentro do grupo.
 *   - @lid           = identificador interno do WhatsApp Multi-Device. NUNCA é phone real.
 *
 * @param {object} payload
 * @returns {{ key: string, isGroup: boolean, participantPhone: string, debugReason: string }}
 */
function resolveConversationKeyFromZapi(payload) {
  const clean    = (v) => (v == null ? '' : String(v).trim())
  const digits   = (v) => clean(v).replace(/\D/g, '')
  const tail11   = (v) => digits(v).slice(-11)
  const isLidJid = (v) => { const s = clean(v); return s.endsWith('@lid') || s.endsWith('@broadcast') }
  const isGrpJid = (v) => { const s = clean(v); return s.endsWith('@g.us') || s.includes('-group') }

  // ─── Grupo ───
  const isGroup = isGroupPayload(payload)
  if (isGroup) {
    const groupKey = pickGroupChatId(payload)
    const key = groupKey ? normalizeGroupIdForStorage(groupKey) : ''
    // UltraMsg usa payload.from / payload.data.from como JID do remetente dentro do grupo
    const participantPhone = digits(payload.participantPhone ?? payload.participant ?? payload.author ?? payload.key?.participant ?? payload.from ?? payload.data?.from ?? '')
    return {
      key,
      isGroup: true,
      participantPhone,
      debugReason: key ? `group via pickGroupChatId (${groupKey})` : 'group but no groupChatId found — drop'
    }
  }

  // ─── Individual ───
  const fromMeHint = Boolean(payload.fromMe ?? payload.key?.fromMe)

  // Meu número: APENAS campos que identificam a INSTÂNCIA conectada.
  // NUNCA usar senderPhone para identificar "meu número":
  //   - fromMe=false: senderPhone É o cliente (remetente) — usá-lo como myDigits causa o sistema
  //     a identificar o cliente como "eu", descartando a mensagem inteira (phone → '').
  //   - fromMe=true: senderPhone pode ser o contato destinatário em algumas versões da Z-API.
  const myDigits =
    digits(payload.connectedPhone) ||
    digits(payload.ownerPhone)     ||
    digits(payload.instancePhone)  ||
    digits(payload.phoneNumber)    ||
    digits(payload.me?.phone)      ||
    ''

  if (!myDigits) {
    // Aviso diagnóstico: connectedPhone ausente é inofensivo (myTail = '' → isMyNumber sempre false),
    // mas registrar ajuda a identificar configurações da Z-API que não enviam connectedPhone.
    console.warn('[Z-API] resolveKey: connectedPhone ausente no payload — verifique a versão/configuração da instância Z-API. phone:', clean(payload.phone).slice(-8) || '(vazio)')
  }
  const myTail = myDigits ? tail11(myDigits) : ''
  const isMyNumber = (d) => myTail && d && tail11(d) === myTail

  // Extrai dígitos de um campo raw (JID, número puro ou formato misto)
  const extractDigits = (raw) => {
    if (!raw) return ''
    const s = clean(raw)
    if (!s || isLidJid(s) || isGrpJid(s)) return ''
    const d = s.includes('@') ? s.replace(/@[^@]+$/, '').replace(/\D/g, '') : digits(s)
    return (d && d.length >= 8) ? d : ''
  }

  // Normaliza candidato → telefone armazenável ou ''
  // skipMyNumber: usado no último recurso onde queremos log mas não usar meu número
  const normCandidate = (raw, { allowNonBR = false, skipMyNumber = true } = {}) => {
    const d = extractDigits(raw)
    if (!d) return ''
    if (!allowNonBR && !looksLikeBRPhoneDigits(d)) return ''
    if (skipMyNumber && isMyNumber(d)) return ''
    return normalizePhoneBR(d) || d
  }

  // ─── Quando fromMe=true: DESTINO da mensagem (contato que recebeu) ─────────────────────────
  // CRÍTICO: NUNCA usar connectedPhone. Usar resolvePeerPhone (centralizado) para máxima confiabilidade.
  const fromMe = fromMeHint
  if (fromMe) {
    const { peerPhone, source } = resolvePeerPhone(payload)
    if (peerPhone) {
      if (WHATSAPP_DEBUG) {
        console.log('[Z-API] resolveKey fromMe:', { peerPhone: peerPhone.slice(-6), source })
      }
      return { key: peerPhone, isGroup: false, participantPhone: '', debugReason: `fromMe ${source}` }
    }
    const destinationSources = [
      [payload.key?.remoteJid,  'key.remoteJid'],
      [payload.remoteJid,       'remoteJid'],
      [payload.chat?.remoteJid, 'chat.remoteJid'],
      [payload.chatId,          'chatId'],
      [payload.chat?.id,        'chat.id'],
      [payload.to,             'to'],
      [payload.toPhone,        'toPhone'],
      [payload.recipientPhone, 'recipientPhone'],
      [payload.recipient,      'recipient'],
      [payload.destination,    'destination'],
      [payload.key?.participant, 'key.participant'],
      [payload.data?.key?.remoteJid, 'data.key.remoteJid'],
      [payload.data?.remoteJid, 'data.remoteJid'],
      [payload.data?.chatId,    'data.chatId'],
      [payload.data?.to,        'data.to'],
      [payload.data?.toPhone,   'data.toPhone'],
      [payload.data?.recipientPhone, 'data.recipientPhone'],
      [payload.value?.to,       'value.to'],
      [payload.value?.toPhone,  'value.toPhone'],
      [payload.value?.recipientPhone, 'value.recipientPhone'],
      [payload.value?.key?.remoteJid, 'value.key.remoteJid'],
      [payload.value?.remoteJid, 'value.remoteJid'],
      [payload.message?.key?.remoteJid, 'message.key.remoteJid'],
      [payload.referencedMessage?.phone, 'referencedMessage.phone'],
      [payload.reaction?.referencedMessage?.phone, 'reaction.referencedMessage.phone'],
      [payload.senderPhone,    'senderPhone (fromMe)'],
    ]
    for (const [raw, fieldName] of destinationSources) {
      const norm = normCandidate(raw)
      if (norm) {
        return { key: norm, isGroup: false, participantPhone: '', debugReason: `fromMe destination ${fieldName}` }
      }
    }
  }

  // ─── Fonte primária: payload.phone (SOMENTE quando for número real, NUNCA quando for @lid) ───
  // Z-API envia "phone": "5544999999999" (número real) OU "phone": "24601656598766@lid" (LID interno).
  // Para fromMe=false: phone = remetente (contato). Para fromMe=true: já tentamos destino acima.
  const phoneRaw = clean(payload.phone)
  const phoneIsLid = phoneRaw && (phoneRaw.endsWith('@lid') || phoneRaw.endsWith('@broadcast'))
  const phonePrimary = !phoneIsLid ? normCandidate(payload.phone) : ''
  if (phonePrimary) {
    return { key: phonePrimary, isGroup: false, participantPhone: '', debugReason: 'from payload.phone (Z-API primary)' }
  }

  // ─── Fontes secundárias (quando fromMe já tentamos destino acima) ─────────────────────────
  const fallbackSources = [
    [payload.key?.remoteJid,  'key.remoteJid'],
    [payload.remoteJid,       'remoteJid'],
    [payload.chatId,          'chatId'],
    [payload.chat?.id,        'chat.id'],
    ...(fromMe ? [] : [[payload.senderPhone, 'senderPhone']]),
  ]

  for (const [raw, fieldName] of fallbackSources) {
    const norm = normCandidate(raw)
    if (norm) {
      return { key: norm, isGroup: false, participantPhone: '', debugReason: `fallback ${fieldName}` }
    }
  }

  // ─── Último recurso: aceita número não-BR ────────────────────────────────
  const lastResortAll = [
    payload.to, payload.toPhone, payload.recipientPhone, payload.recipient,
    payload.destination, payload.phone, payload.key?.remoteJid, payload.key?.participant,
    payload.remoteJid, payload.chatId, payload.chat?.id, payload.senderPhone,
    payload.data?.key?.remoteJid, payload.data?.remoteJid, payload.data?.to,
    payload.data?.toPhone, payload.data?.recipientPhone,
    payload.value?.to, payload.value?.toPhone, payload.value?.recipientPhone,
    payload.value?.key?.remoteJid, payload.value?.remoteJid,
    payload.message?.key?.remoteJid, payload.referencedMessage?.phone,
  ]
  for (const raw of lastResortAll) {
    const norm = normCandidate(raw, { allowNonBR: true })
    if (norm) {
      return { key: norm, isGroup: false, participantPhone: '', debugReason: `last resort non-BR (${raw})` }
    }
  }

  // ─── LID (espelhamento: mensagem enviada pelo celular pode vir só com phone/chatLid @lid) ───
  // Z-API às vezes envia phone/chatLid como "280396956696801@lid" sem número real.
  // Usamos chave sintética "lid:XXXX" para encontrar/criar a mesma conversa e registrar a mensagem no front.
  // Inclui payload.data e payload.value para payloads encapsulados
  const lidRaw = clean(payload.phone) || clean(payload.chatLid) || clean(payload.data?.phone) || clean(payload.value?.phone) || ''
  if (lidRaw.endsWith('@lid')) {
    const lidPart = lidRaw.replace(/@lid$/i, '').trim()
    if (lidPart) {
      return { key: `lid:${lidPart}`, isGroup: false, participantPhone: '', debugReason: 'from payload.phone/chatLid (@lid)' }
    }
  }

  // ─── Sem destino válido ───
  const candidateSummary = {
    phone: payload.phone,
    remoteJid: payload.key?.remoteJid ?? payload.remoteJid,
    chatId: payload.chatId,
    to: payload.to,
    connectedPhone: myDigits ? `...${myDigits.slice(-6)}` : null,
    fromMe,
  }
  return {
    key: '',
    isGroup: false,
    participantPhone: '',
    debugReason: `drop — no valid dest. candidates: ${JSON.stringify(candidateSummary)}`
  }
}

function extractMessage(payload) {
  if (!payload || typeof payload !== 'object') {
    return { phone: '', texto: '(vazio)', fromMe: false, messageId: null, criado_em: new Date().toISOString(), type: 'text', imageUrl: null, documentUrl: null, audioUrl: null, videoUrl: null, stickerUrl: null, locationUrl: null, fileName: null, isGroup: false, isEdit: false, isNewsletter: false, waitingMessage: false, participantPhone: null, senderName: null, senderLid: null, nomeGrupo: null, senderPhoto: null, chatPhoto: null }
  }
  const fromMe = Boolean(payload.fromMe ?? payload.key?.fromMe)
  const isEdit        = Boolean(payload.isEdit)
  const isNewsletter  = Boolean(payload.isNewsletter)
  const waitingMessage = Boolean(payload.waitingMessage)
  const senderLid     = payload.senderLid ? String(payload.senderLid).trim() : null

  // Resolver chave de conversa usando resolveConversationKeyFromZapi (contrato Z-API).
  // - isGroup: true → grupo (key = id normalizado do grupo)
  // - isGroup: false → individual (key = telefone BR canônico do CONTATO, nunca do connectedPhone)
  const { key: phone, isGroup, participantPhone: partPhoneResolved, debugReason } = resolveConversationKeyFromZapi(payload)
  // Doc Z-API: messageId e zaapId = identificador da mensagem (ReceivedCallback e DeliveryCallback)
  const messageId = payload.messageId ?? payload.zaapId ?? payload.id ?? payload.instanceId ?? payload.key?.id ?? null
  let ts = payload.timestamp ?? payload.momment ?? payload.t ?? payload.reaction?.time ?? Date.now()
  // Timestamp pode vir em segundos (ex: API histórico) ou ms. Valores antigos/inválidos geram data 1970.
  const tsNum = Number(ts)
  if (tsNum && tsNum < 1e12) ts = tsNum * 1000
  const dateFromTs = ts ? new Date(Number(ts)) : null
  if (!dateFromTs || dateFromTs.getFullYear() < 2020) ts = Date.now()

  // Texto: Z-API envia text.message, template, botões, list, reação, localização, contato
  const rawMessage =
    payload.message ??
    payload.text?.message ??
    payload.body ??
    payload.hydratedTemplate?.message ??
    payload.buttonsResponseMessage?.message ??
    payload.listResponseMessage?.message ??
    ''
  let type = String(payload.type || payload.msgType || 'text').toLowerCase()
  if (type === 'receivedcallback' || type === 'receivedcall') type = 'text'

  // Reação (Z-API: reaction.value)
  if (payload.reaction && typeof payload.reaction === 'object') {
    type = 'reaction'
  }
  // Localização (Z-API: location.name, address, url, latitude, longitude)
  if (payload.location && typeof payload.location === 'object') {
    type = 'location'
  }
  // Contato (Z-API: contact.displayName, vCard)
  if (payload.contact && typeof payload.contact === 'object') {
    type = 'contact'
  }
  // Fallback: texto bruto com vCard (ex: UltraMsg envia type=chat com body=vCard)
  if ((!type || type === 'text') && typeof rawMessage === 'string' && String(rawMessage).trim().includes('BEGIN:VCARD') && String(rawMessage).trim().includes('END:VCARD')) {
    type = 'contact'
    if (!payload.contact || typeof payload.contact !== 'object') {
      payload = { ...payload, contact: { vCard: String(rawMessage).trim(), displayName: null, formattedName: null } }
    }
  }
  if (!type || type === 'text') {
    if (payload.image || payload.imageUrl) type = 'image'
    else if (payload.audio || payload.audioUrl) type = 'audio'
    else if (payload.video || payload.videoUrl || payload.ptv) type = 'video'
    else if (payload.document || payload.documentUrl) type = 'document'
    else if (payload.sticker || payload.stickerUrl) type = 'sticker'
  }

  let texto = String(rawMessage || '').trim()
  // URLs de mídia
  let imageUrl =
    payload.image?.imageUrl ??
    payload.image?.url ??
    payload.imageUrl ??
    payload.message?.image?.imageUrl ??
    payload.message?.image?.url ??
    payload.message?.imageUrl ??
    payload.image ??
    null
  if (imageUrl && typeof imageUrl === 'object') imageUrl = imageUrl.url ?? imageUrl.imageUrl ?? null
  let documentUrl =
    payload.document?.documentUrl ??
    payload.document?.url ??
    payload.documentUrl ??
    payload.message?.document?.documentUrl ??
    payload.message?.document?.url ??
    payload.message?.documentUrl ??
    null
  if (documentUrl && typeof documentUrl === 'object') documentUrl = documentUrl.url ?? documentUrl.documentUrl ?? null
  let fileName = payload.document?.fileName ?? payload.document?.title ?? payload.fileName ?? null
  // Áudio: diferentes formatos (Z-API pode mandar em payload.audio, payload.message.audio, ou fields diretos)
  let audioUrl =
    payload.audio?.audioUrl ??
    payload.audio?.url ??
    payload.audioUrl ??
    payload.message?.audio?.audioUrl ??
    payload.message?.audio?.url ??
    payload.message?.audioUrl ??
    null
  if (audioUrl && typeof audioUrl === 'object') audioUrl = audioUrl.url ?? audioUrl.audioUrl ?? null
  let videoUrl =
    payload.video?.videoUrl ??
    payload.video?.url ??
    payload.videoUrl ??
    payload.message?.video?.videoUrl ??
    payload.message?.video?.url ??
    payload.message?.videoUrl ??
    payload.ptv?.url ??
    null
  if (videoUrl && typeof videoUrl === 'object') videoUrl = videoUrl.url ?? videoUrl.videoUrl ?? null

  let stickerUrl =
    payload.sticker?.stickerUrl ??
    payload.sticker?.url ??
    payload.stickerUrl ??
    payload.message?.sticker?.stickerUrl ??
    payload.message?.sticker?.url ??
    payload.message?.stickerUrl ??
    null
  if (stickerUrl && typeof stickerUrl === 'object') stickerUrl = stickerUrl.url ?? stickerUrl.stickerUrl ?? null
  let locationUrl = payload.location?.url ?? payload.location?.thumbnailUrl ?? null
  // Se não tiver URL mas tiver lat/lng (ex: UltraMsg), monta link do Google Maps
  const loc = payload.location || {}
  if (!locationUrl && (loc.latitude != null || loc.lat != null) && (loc.longitude != null || loc.lng != null)) {
    const lat = Number(loc.latitude ?? loc.lat)
    const lng = Number(loc.longitude ?? loc.lng)
    if (!isNaN(lat) && !isNaN(lng)) locationUrl = `https://www.google.com/maps?q=${lat},${lng}`
  }

  // participantPhone: remetente dentro do grupo (só relevante para grupos; usamos o valor resolvido por resolveConversationKeyFromZapi + o bruto do payload como fallback)
  const participantPhoneRaw = partPhoneResolved ||
    String(payload.participantPhone ?? payload.participant ?? payload.author ?? payload.key?.participant ?? '').replace(/\D/g, '')
  // Doc Z-API: name = nome completo salvo no celular; chatName/short = abreviados. Priorizar name sempre.
  const fromMeForExtract = Boolean(payload.fromMe ?? payload.key?.fromMe)
  const senderName = fromMeForExtract
    ? (payload.name ?? payload.formattedName ?? payload.chatName ?? payload.chat?.name ?? payload.groupName ?? payload.short ?? payload.notifyName ?? payload.senderName ?? payload.displayName ?? payload.pushName ?? payload.sender?.name ?? null)
    : (payload.name ?? payload.formattedName ?? payload.short ?? payload.notifyName ?? payload.senderName ?? payload.chatName ?? payload.chat?.name ?? payload.displayName ?? payload.pushName ?? payload.sender?.name ?? null)
  const senderPhoto = fromMeForExtract
    ? (payload.chatPhoto ?? payload.chat?.photo ?? payload.senderPhoto ?? payload.photo ?? payload.profilePicture ?? payload.sender?.photo ?? payload.profilePictureUrl ?? null)
    : (payload.senderPhoto ?? payload.photo ?? payload.profilePicture ?? payload.sender?.photo ?? payload.profilePictureUrl ?? null)
  // Para grupos, a Z-API costuma enviar a foto do grupo apenas em `photo`.
  // Usamos chatPhoto/groupPicture/groupPhoto e, como fallback quando isGroup, o campo photo.
  const chatPhoto =
    payload.chatPhoto ??
    payload.groupPicture ??
    payload.groupPhoto ??
    (payload.isGroup ? payload.photo ?? null : null)

  // Texto por tipo (TUDO que a Z-API envia vira registro legível no sistema)
  if (type === 'reaction') {
    const val = payload.reaction?.value ?? payload.reaction?.emoji ?? ''
    texto = val ? `Reação: ${String(val).trim()}` : 'Reação'
  } else if (type === 'location') {
    const loc = payload.location || {}
    const parts = [loc.name, loc.address].filter(Boolean).map(String).map(s => s.trim())
    const lat = loc.latitude ?? loc.lat
    const lng = loc.longitude ?? loc.lng
    const latNum = Number(lat)
    const lngNum = Number(lng)
    const hasValidCoords = lat != null && lng != null && !isNaN(latNum) && !isNaN(lngNum)
    const coordsFormatted = hasValidCoords ? `${Number(latNum).toFixed(5)}, ${Number(lngNum).toFixed(5)}` : ''
    texto = parts.length
      ? parts.join(' • ') + (coordsFormatted ? ` (${coordsFormatted})` : '')
      : (coordsFormatted || loc.url || '(localização)')
  } else if (type === 'contact') {
    const c = payload.contact || {}
    texto = (c.displayName && String(c.displayName).trim()) || (c.formattedName && String(c.formattedName).trim()) || (c.vCard && String(c.vCard).slice(0, 120)) || '(contato)'
  }

  // contactMeta: { nome, telefone, foto_perfil?, descricao_negocio? } para cartão de contato no frontend
  let contactMeta = null
  if (type === 'contact') {
    const c = payload.contact || {}
    const displayName = (c.displayName && String(c.displayName).trim()) || (c.formattedName && String(c.formattedName).trim()) || null
    const vcard = c.vCard || c.vcard || (typeof rawMessage === 'string' && rawMessage.includes('BEGIN:VCARD') ? rawMessage : null)
    const parsed = vcard ? parseVcardForContact(vcard) : { nome: null, telefone: null }
    const contactPhone = c.phone || c.telefone || parsed.telefone || (Array.isArray(c.fullContactData?.phoneNumbers) && c.fullContactData.phoneNumbers[0] ? String(c.fullContactData.phoneNumbers[0]).replace(/\D/g, '') : null)
    contactMeta = {
      nome: displayName || parsed.nome || texto || null,
      telefone: contactPhone || null,
      foto_perfil: (c.profilePicture || c.profilePictureUrl || c.photo) && String(c.profilePicture || c.profilePictureUrl || c.photo).startsWith('http') ? String(c.profilePicture || c.profilePictureUrl || c.photo).trim() : null
    }
    if (parsed.descricao_negocio) contactMeta.descricao_negocio = parsed.descricao_negocio
    if (!contactMeta.nome && !contactMeta.telefone) contactMeta = null
  }

  // locationMeta: { latitude, longitude, nome, endereco } — paridade com contact_meta
  let locationMeta = null
  if (type === 'location') {
    const loc = payload.location || {}
    const lat = Number(loc.latitude ?? loc.lat)
    const lng = Number(loc.longitude ?? loc.lng)
    if (!isNaN(lat) && !isNaN(lng)) {
      locationMeta = {
        latitude: lat,
        longitude: lng,
        nome: (loc.name && String(loc.name).trim()) || null,
        endereco: (loc.address && String(loc.address).trim()) || null
      }
    }
  }

  if (type === 'image' && imageUrl) {
    texto = texto || (payload.image?.caption && String(payload.image.caption).trim()) || '(imagem)'
  } else if ((type === 'document' || type === 'file') && documentUrl) {
    texto = texto || fileName || '(arquivo)'
  } else if (type === 'audio') {
    texto = texto || '(áudio)'
  } else if (type === 'video' && videoUrl) {
    texto = texto || (payload.video?.caption && String(payload.video.caption).trim()) || (payload.ptv ? '(vídeo visualização única)' : '(vídeo)')
  } else if (type === 'sticker') {
    texto = texto || '(figurinha)'
  }
  if (!texto) texto = '(mídia)'

  // Heurística: se for texto puro com URL http/https, marcamos como tipo "link"
  // para o frontend poder exibir estilo preview/clicável.
  if (type === 'text' && texto && /(https?:\/\/\S+)/i.test(texto)) {
    type = 'link'
  }

  // phone já foi resolvido por resolveConversationKeyFromZapi: é a chave canônica do chat.
  // Para grupos com id muito longo (>20 chars), normalizeGroupIdForStorage já truncou para dígitos.
  // Não há mais processamento adicional de LID/JID aqui.

  return {
    phone,      // chave canônica do chat (contato ou grupo) — nunca o nosso próprio número
    debugReason, // motivo de seleção (usado no log de debug abaixo)
    texto,
    fromMe,
    messageId,
    criado_em: (ts ? new Date(Number(ts)) : new Date()).toISOString(),
    type,
    imageUrl,
    documentUrl,
    audioUrl,
    videoUrl,
    stickerUrl,
    locationUrl,
    fileName,
    isGroup,
    isEdit,
    isNewsletter,
    waitingMessage,
    participantPhone: participantPhoneRaw || null,
    senderName: senderName ? String(senderName).trim() : null,
    senderLid,
    nomeGrupo: (isGroup && (payload.chatName ?? payload.groupName ?? payload.subject)) ? String(payload.chatName ?? payload.groupName ?? payload.subject).trim() : null,
    senderPhoto: senderPhoto && String(senderPhoto).trim() ? String(senderPhoto).trim() : null,
    chatPhoto: chatPhoto && String(chatPhoto).trim() ? String(chatPhoto).trim() : null,
    contactMeta,
    locationMeta
  }
}

/**
 * POST /webhooks/ultramsg — recebe callback principal de mensagem (entrada/saída). Suporta grupos e lote.
 */
/** Retorna array de payloads para processar (1 ou N mensagens).
 * Mescla campos de body (key, instanceId, etc.) quando payload vem de body.value/data —
 * Z-API pode enviar key.remoteJid no nível raiz com a mensagem em value/data. */
function getPayloads(body) {
  if (!body || typeof body !== 'object') return [{}]
  const merge = (parent, child) => {
    if (!child || typeof child !== 'object') return parent || {}
    const out = { ...parent, ...child }
    // key.remoteJid pode estar só em parent (Z-API envia mensagem em value, key no raiz)
    if (parent?.key && (!child?.key || !child.key?.remoteJid) && parent.key?.remoteJid) {
      out.key = { ...(child?.key || {}), ...parent.key }
    }
    return out
  }
  if (Array.isArray(body) && body.length > 0) return body
  if (body.data && Array.isArray(body.data) && body.data.length > 0) {
    return body.data.map((item) => merge(body, item))
  }
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return [merge(body, body.data)]
  }
  if (body.value && typeof body.value === 'object') {
    return [merge(body, body.value)]
  }
  if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages.map((item) => merge(body, item))
  }
  if (body.message && typeof body.message === 'object') {
    return [merge(body, body.message)]
  }
  return [body]
}

/** Log seguro (sem tokens/conteúdo sensível) — diagnóstico end-to-end webhook. Nunca logar tokens nem URL com /token/ */
function _logWebhookSafe(entry) {
  const safe = { ts: new Date().toISOString(), received: true, ...entry }
  console.log('[Z-API-WEBHOOK]', JSON.stringify(safe))
}

/** Extrai instanceId do payload (body) Z-API — mesma lógica do middleware */
function _extractInstanceIdFromBody(body) {
  if (!body || typeof body !== 'object') return ''
  const v = body.instanceId ?? body.instance_id ?? body.instance?.id ?? body.instance
  if (v == null) return ''
  if (typeof v === 'object' && v != null && typeof v.id === 'string') return String(v.id).trim()
  if (typeof v === 'object' && v != null && v.instance_id != null) return String(v.instance_id).trim()
  return String(v).trim()
}

/** Verifica se o payload tem campos de destino (to, remoteJid, etc.). Para fromMe, destino = contato que recebeu. */
function hasDestFields(payload) {
  if (!payload || typeof payload !== 'object') return false
  const dest = [
    payload.to, payload.toPhone, payload.recipientPhone, payload.recipient,
    payload.destination, payload.key?.remoteJid, payload.remoteJid,
    payload.chatId, payload.chat?.id, payload.chat?.remoteJid, payload.participant
  ]
  return dest.some(v => v != null && String(v).trim() !== '')
}

/**
 * True só se a mensagem inserida for a PRIMEIRA da conversa (por criado_em, id) e for outbound
 * sem autor_usuario_id — critério de envio pelo WhatsApp/celular fora do ZapERP (CRM grava autor).
 */
async function mensagemInseridaEhPrimeiraDisparoWhatsappExterno(supabaseClient, company_id, conversa_id, mensagemIdInserida) {
  if (!supabaseClient || company_id == null || conversa_id == null || mensagemIdInserida == null) return false
  try {
    const { data: first, error } = await supabaseClient
      .from('mensagens')
      .select('id, direcao, autor_usuario_id')
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .order('criado_em', { ascending: true })
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) {
      console.warn('[webhook] mensagemInseridaEhPrimeiraDisparoWhatsappExterno:', error?.message || error)
      return false
    }
    if (!first?.id || Number(first.id) !== Number(mensagemIdInserida)) return false
    if (String(first.direcao || '') !== 'out') return false
    if (first.autor_usuario_id != null) return false
    return true
  } catch (e) {
    console.warn('[webhook] mensagemInseridaEhPrimeiraDisparoWhatsappExterno exceção:', e?.message || e)
    return false
  }
}

/** True se já existir mensagem inbound na conversa (histórico importado ou respostas do cliente). */
async function conversaTemAlgumaMensagemInbound(supabaseClient, company_id, conversa_id) {
  if (!supabaseClient || company_id == null || conversa_id == null) return false
  try {
    const { count, error } = await supabaseClient
      .from('mensagens')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .eq('direcao', 'in')
    if (error) return false
    return Number(count || 0) > 0
  } catch (e) {
    console.warn('[webhook] conversaTemAlgumaMensagemInbound:', e?.message || e)
    return false
  }
}

exports.receberZapi = async (req, res) => {
  try {
    const body = req.body || {}
    // 1) Resolver instanceId e company_id — SEMPRE explícito, NUNCA depender do DEFAULT do banco
    const instanceIdRaw = _extractInstanceIdFromBody(body) || req.zapiContext?.instanceId || ''
    const instanceId = instanceIdRaw ? String(instanceIdRaw).trim() : ''
    let company_id = req.zapiContext?.company_id
    let whatsapp_instance_id = req.zapiContext?.whatsapp_instance_id ?? null
    let whatsapp_instance_is_default = req.zapiContext?.whatsapp_instance_is_default === true
    if (company_id == null && instanceId) {
      const resolved = await getWhatsappInstanceByProviderInstanceId('ultramsg', instanceId)
      if (resolved?.code === 'DUPLICATE_PROVIDER_INSTANCE') {
        _logWebhookSafe({
          instanceId: instanceId.slice(0, 24) + (instanceId.length > 24 ? '…' : ''),
          companyId: 'duplicate_blocked',
          type: body.type || body.event || 'unknown',
          ignored: 'duplicate_provider_instance',
        })
        return res.status(200).json({ ok: true, ignored: 'duplicate_provider_instance' })
      }
      if (resolved?.instance) {
        company_id = resolved.instance.company_id
        whatsapp_instance_id = resolved.instance.id ?? null
        whatsapp_instance_is_default = resolved.instance.is_default === true
      } else {
        company_id = await getCompanyIdByInstanceId(instanceId)
      }
    }
    if (!instanceId || company_id == null) {
      const logData = { instanceId: instanceId ? instanceId.slice(0, 24) + (instanceId.length > 24 ? '…' : '') : '(empty)', companyId: 'not_mapped', type: body.type || body.event || 'unknown', ignored: 'instance_not_mapped' }
      _logWebhookSafe(logData)
      console.warn('[WEBHOOK_CORE_RESOLVE] ignored_not_mapped no pipeline legado', {
        has_zapi_context: Boolean(req.zapiContext),
        context_company_id: req.zapiContext?.company_id ?? null,
        context_whatsapp_instance_id: req.zapiContext?.whatsapp_instance_id ?? null,
        instance_id_raw: instanceId || null,
        provider: 'ultramsg',
      })
      
      return res.status(200).json({ ok: true, ignored: 'instance_not_mapped' })
    }

    // 2) Log DEV uma linha — diagnóstico sem vazar tokens
    const firstPayload = getPayloads(body)[0] || body
    const msgId = firstPayload?.messageId ?? firstPayload?.zaapId ?? firstPayload?.id ?? ''
    const phoneTail = (firstPayload?.phone || '').toString().trim().slice(-10)
    console.log('[ULTRAMSG_WEBHOOK]', JSON.stringify({
      instanceId: instanceId.slice(0, 20) + (instanceId.length > 20 ? '…' : ''),
      companyId: company_id,
      type: body.type || body.event || firstPayload?.type || 'unknown',
      messageId: msgId ? String(msgId).slice(0, 20) + (String(msgId).length > 20 ? '…' : '') : null,
      phone: phoneTail ? '…' + phoneTail : null,
      fromMe: firstPayload?.fromMe ?? firstPayload?.key?.fromMe ?? null
    }))

    // Salva no buffer de diagnóstico (GET /webhooks/ultramsg/debug)
    _logWebhook({
      type: body.type || body.event || 'unknown',
      phone: (body.phone || '').toString().slice(-12),
      fromMe: body.fromMe ?? body.key?.fromMe,
      hasText: !!(body.text?.message || body.message || body.body),
      hasMedia: !!(body.image || body.audio || body.video || body.document || body.sticker),
      status: body.status || body.ack,
      ip: req.ip || req.socket?.remoteAddress || '?',
      rawBody: WHATSAPP_DEBUG ? JSON.stringify(body).slice(0, 600) : undefined
    })

    // Callback específico de atualização de foto de grupo:
    // docs: { "groupId": "...", "groupPhoto": "https://..." }
    // Quando vier sem campos de mensagem/phone, tratamos direto aqui.
    const rawGroupId = body.groupId != null ? String(body.groupId).trim() : ''
    const rawGroupPhoto = body.groupPhoto != null ? String(body.groupPhoto).trim() : ''
    const hasOnlyGroupPhotoPayload =
      rawGroupId &&
      rawGroupPhoto &&
      !body.phone &&
      !body.text &&
      !body.message &&
      !body.body &&
      !body.image &&
      !body.audio &&
      !body.video &&
      !body.document &&
      !body.sticker

    if (hasOnlyGroupPhotoPayload) {
      const groupIdForStorage = normalizeGroupIdForStorage(rawGroupId) || rawGroupId
      try {
        const { data, error } = await supabase
          .from('conversas')
          .update({ foto_grupo: rawGroupPhoto })
          .eq('company_id', company_id)
          .in('telefone', [groupIdForStorage, rawGroupId])
          .select('id')

        if (error) {
          console.error('[Z-API] ❌ Erro ao atualizar foto de grupo via callback groupPhoto:', error)
          // Webhook: sempre 200 para o UltraMsg não reentregar um callback puramente cosmético.
          req.webhookLogData = { ...(req.webhookLogData || {}), status: 'error', error_message: 'group_photo_update_failed' }
          return res.status(200).json({ ok: false, error: 'Erro ao atualizar foto de grupo' })
        }

        const updatedCount = Array.isArray(data) ? data.length : 0
        console.log('[Z-API] ✅ Foto de grupo atualizada via callback groupPhoto:', {
          groupId: rawGroupId,
          storedId: groupIdForStorage,
          updated: updatedCount
        })

        // Emite atualização de conversa para atualizar avatar no front
        if (updatedCount > 0) {
          const io = req.app.get('io')
          if (io) {
            for (const row of data) {
              await emitirParaUsuariosQuePodemVerConversa(io, company_id, row.id, 'conversa_atualizada', {
                id: row.id,
                foto_grupo: rawGroupPhoto
              })
            }
          }
        }

        return res.status(200).json({ ok: true, updated: updatedCount })
      } catch (e) {
        console.error('[Z-API] ❌ Exceção ao processar callback groupPhoto:', e?.message || e)
        // Webhook: sempre 200 para o UltraMsg não reentregar um callback puramente cosmético.
        req.webhookLogData = { ...(req.webhookLogData || {}), status: 'error', error_message: e?.message || 'group_photo_exception' }
        return res.status(200).json({ ok: false, error: 'Erro ao processar callback de foto de grupo' })
      }
    }

    const payloads = getPayloads(body)
    let lastResult = { ok: true }

    let separarMensagensDisparadasEmpresa = false
    try {
      const { data: empCfgRow, error: empCfgErr } = await supabase
        .from('empresas')
        .select('separar_mensagens_disparadas')
        .eq('id', company_id)
        .maybeSingle()
      if (!empCfgErr && empCfgRow) separarMensagensDisparadasEmpresa = !!empCfgRow.separar_mensagens_disparadas
    } catch (_) {
      separarMensagensDisparadasEmpresa = false
    }

    for (const payload of payloads) {
      // Normaliza status Z-API / UltraMSG para canônico interno (inclui device→delivered, server→sent)
      const normalizeZapiStatus = (raw) => normalizeRawAckStatus(raw)

      // Helper: emite status_mensagem via socket (empresa + conversa + usuario do autor para garantir tempo real)
      const emitStatusMsg = (msg, statusNorm, whatsappId = null) => {
        const io = req.app.get('io')
        if (io && msg) {
          const payload = {
            mensagem_id: msg.id,
            conversa_id: msg.conversa_id,
            status: statusNorm,
            status_mensagem: statusNorm,
            ...(msg.whatsapp_id ? { whatsapp_id: msg.whatsapp_id } : {}),
            ...(whatsappId ? { whatsapp_id: whatsappId } : {})
          }
          let chain = io.to(`empresa_${msg.company_id}`).to(`conversa_${msg.conversa_id}`)
          if (msg.autor_usuario_id != null) chain = chain.to(`usuario_${msg.autor_usuario_id}`)
          chain.emit('status_mensagem', payload)
        }
      }

      const resolveEffectiveStatus = (current, next) => {
        const currentStatus = current || 'pending'
        if (next === 'erro' || next === 'failed') {
          return statusRank(currentStatus) >= statusRank('delivered') ? currentStatus : next
        }
        return statusRank(currentStatus) > statusRank(next) ? currentStatus : next
      }

      // Helper: atualiza status no banco por whatsapp_id sem permitir regressao de ACK atrasado.
      const updateStatusByWaId = async (waId, statusNorm, opts = {}) => {
        const returnResult = opts?.returnResult === true
        const emptyResult = { data: null, error: null, ambiguous: false, effectiveStatus: statusNorm || null }
        if (!waId || !statusNorm) return returnResult ? emptyResult : null
        const waIdStr = String(waId)
        const statusSelect = 'id, conversa_id, company_id, whatsapp_instance_id, whatsapp_id, autor_usuario_id, status, status_mensagem'
        const found = await selectSingleMensagemByWhatsappId(supabase, {
          company_id,
          whatsapp_id: waIdStr,
          whatsapp_instance_id,
          select: statusSelect,
          context: opts?.context || 'receberZapi.status',
        })
        if (found.error || !found.data?.id) {
          const result = { ...emptyResult, error: found.error || null, ambiguous: Boolean(found.ambiguous) }
          return returnResult ? result : null
        }

        const currentStatus = found.data.status || found.data.status_mensagem || 'pending'
        const effectiveStatus = resolveEffectiveStatus(currentStatus, statusNorm)
        const { data: msg, error } = await patchMensagemStatusById(supabase, {
          company_id,
          mensagem_id: found.data.id,
          effectiveStatus,
          whatsapp_id: waIdStr,
          select: statusSelect,
        })
        if (msg) msg.whatsapp_id = msg.whatsapp_id || waIdStr
        if (msg) msg._effective_status = effectiveStatus
        const result = { data: msg || null, error: error || null, ambiguous: false, effectiveStatus }
        return returnResult ? result : msg || null
      }

      // payloadType: usa type > event como fonte primária de classificação.
      // payloadTypeOrStatus: fallback inclui o campo "status" para Z-API que envia tipo no campo status.
      const payloadType = String(payload?.type ?? payload?.event ?? '').toLowerCase()
      // Em alguns callbacks, o status vem em "ack" (número) em vez de "status" (string).
      const payloadStatusRaw =
        payload?.ack != null ? String(payload.ack).trim() : String(payload?.status ?? '').trim()
      const payloadTypeOrStatus = payloadType || payloadStatusRaw.toLowerCase()

      if (WHATSAPP_DEBUG) {
        const msgId = payload?.messageId ?? payload?.zaapId ?? payload?.id ?? payload?.key?.id
        console.log('[Z-API] webhook payload', {
          eventType: payloadType || '(vazio)',
          messageId: msgId ? String(msgId).slice(0, 32) : null,
          from: (payload?.senderPhone ?? payload?.from ?? payload?.phone ?? '').toString().slice(-14),
          to: (payload?.to ?? payload?.recipientPhone ?? '').toString().slice(-14),
          chatId: (payload?.chatId ?? payload?.key?.remoteJid ?? '').toString().slice(0, 36),
          fromMe: Boolean(payload?.fromMe ?? payload?.key?.fromMe),
          hasText: !!(payload?.text?.message ?? payload?.message ?? payload?.body)
        })
      }

      // ─── MessageStatusCallback: READ / RECEIVED / PLAYED (ticks ✓✓ e azul) ───
      // Z-API envia este tipo quando o destinatário recebe ou lê a mensagem.
      // Se o payload tiver conteúdo de mensagem (text.message, message, body), é ReceivedCallback — NÃO status.
      const payloadFromMe = Boolean(payload?.fromMe ?? payload?.key?.fromMe)
      // Z-API pode enviar mídia em payload.message.* (objeto aninhado) sem text.message.
      // Ex.: ReceivedCallback em grupo com imagem vem sem payload.text, mas payload.message.image existe.
      const hasMessageContent =
        (payload?.text?.message != null && String(payload.text.message).trim() !== '') ||
        (payload?.message != null && typeof payload.message === 'string' && String(payload.message).trim() !== '') ||
        (payload?.body != null && String(payload.body).trim() !== '') ||
        payload?.image != null || payload?.imageUrl != null ||
        payload?.audio != null || payload?.audioUrl != null ||
        payload?.video != null || payload?.videoUrl != null ||
        payload?.document != null || payload?.documentUrl != null ||
        payload?.sticker != null || payload?.stickerUrl != null ||
        // Mídia aninhada em payload.message (Z-API grupos, callbacks variados)
        payload?.message?.image != null || payload?.message?.imageUrl != null ||
        payload?.message?.audio != null || payload?.message?.audioUrl != null ||
        payload?.message?.video != null || payload?.message?.videoUrl != null ||
        payload?.message?.document != null || payload?.message?.documentUrl != null ||
        payload?.message?.sticker != null || payload?.message?.stickerUrl != null ||
        payload?.message?.ptv != null || payload?.message?.location != null || payload?.message?.contact != null ||
        // Tipos extras que a Z-API envia como ReceivedCallback sem campo de texto/mídia
        payload?.reaction != null ||
        payload?.location != null ||
        payload?.contact != null  ||
        payload?.ptv != null      ||
        // Mensagem enviada pelo celular (espelhamento): tratar como conteúdo para gravar no sistema
        (payloadFromMe && (payload?.messageId || payload?.zaapId || (Array.isArray(payload?.ids) && payload.ids.length > 0)))

      // isStatusCallback: SOMENTE quando o payload NÃO tem conteúdo de mensagem E o tipo é
      // explicitamente de status (MessageStatusCallback, ReadCallback, etc.) OU o status é
      // read/played (nunca "received" isolado, pois ReceivedCallback envia status="RECEIVED").
      // ATENÇÃO: "received" como status NÃO qualifica sozinho — ReceivedCallback também tem
      // status="RECEIVED" mas é uma mensagem real. Apenas "read" e "played" são exclusivos de status.
      const STATUS_ONLY_KEYWORDS = ['read', 'played']
      const isStatusCallback =
        !hasMessageContent &&
        (payloadType === 'messagestatuscallback' ||
          payloadType === 'message_status_callback' ||
          payloadType === 'readcallback' ||
          payloadType === 'read_callback' ||
          payloadType === 'receivedcallback_ack' ||
          (STATUS_ONLY_KEYWORDS.includes(payloadStatusRaw.toLowerCase()) && (payload?.messageId || payload?.zaapId)))

      // Log de pipeline — sempre visível, para rastrear o que chega e como é classificado
      console.log(`[ULTRAMSG] 🔍 pipeline: type="${payloadType || '(vazio)'}" status="${payloadStatusRaw || '(vazio)'}" fromMe=${payloadFromMe} hasContent=${hasMessageContent} isStatus=${isStatusCallback} phone=${String(payload?.phone || '').slice(-10) || '(vazio)'}`)

      if (isStatusCallback) {
        const msgId = payload?.messageId ?? payload?.zaapId ?? null
        if (!msgId) continue
        const statusNorm = normalizeZapiStatus(payloadStatusRaw)
        if (!statusNorm) continue

        // Mesclagem LID→PHONE quando payload traz ambos (MessageStatusCallback)
        const lidStatus = String(payload?.phone ?? payload?.chatLid ?? '').trim()
        const lidPartStatus = lidStatus.endsWith('@lid') ? lidStatus.replace(/@lid$/i, '').trim() : ''
        const { peerPhone: peerStatus } = resolvePeerPhone(payload)
        const canonicalStatus = peerStatus || (payload?.to || payload?.recipientPhone ? getCanonicalPhone(payload.to || payload.recipientPhone) : null)
        if (lidPartStatus && canonicalStatus) {
          try {
            const io = req.app.get('io')
            await mergeConversationLidToPhone(supabase, company_id, lidPartStatus, canonicalStatus, { io, whatsapp_instance_id })
            logZapiCert({
              companyId: company_id,
              instanceId,
              type: payloadType,
              fromMe: payloadFromMe,
              hasDest: hasDestFields(payload),
              phoneTail: canonicalStatus?.slice(-6) || null,
              connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
              messageId: String(msgId),
              resolvedKeyType: 'lid→phone',
              conversaId: null,
              action: 'merged_lid_phone'
            })
          } catch (_) {}
        }

        const msg = await updateStatusByWaId(String(msgId), statusNorm)
        const effectiveStatus = msg?._effective_status || statusNorm
        if (msg) {
          emitStatusMsg(msg, effectiveStatus, String(msgId))
          console.log(`✅ Z-API status ${effectiveStatus.toUpperCase()} → msg ${msg.id} (conversa ${msg.conversa_id})`)
          logZapiCert({
            companyId: company_id,
            instanceId,
            type: payloadType,
            fromMe: payloadFromMe,
            hasDest: hasDestFields(payload),
            phoneTail: (payload?.phone ?? '').toString().slice(-6) || null,
            connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
            messageId: String(msgId),
            conversaId: msg.conversa_id,
            action: 'updated_status'
          })
          // IMPORTANTE: read/played = o CONTATO visualizou NOSSA mensagem (ticks ✓✓).
          // Isso NÃO significa que nós (atendentes) visualizamos a conversa no CRM.
          // Unread só deve ser zerado quando abrimos o chat (detalharChat → marcarComoLidaPorUsuario).
          // NÃO chamar marcarConversaComoLidaParaTodos aqui — zeraria incorretamente as bolhas.
        } else {
          console.warn(`⚠️ Z-API status ${statusNorm.toUpperCase()} recebido mas messageId não encontrado: ${String(msgId).slice(0, 25)}`)
        }
        lastResult = { ok: true, statusUpdate: true, messageId: String(msgId), status: effectiveStatus }
        continue
      }

      // DeliveryCallback (on-message-send)
      // Regra:
      // - Se for apenas ACK/status (sem conteúdo e sem fromMe), trata como status e NÃO grava nova mensagem.
      // - Se vier de notifySentByMe (fromMe=true) COM messageId, tratamos como MENSAGEM:
      //   deixa cair no pipeline normal (extractMessage → findOrCreateConversation → insert).
      if (payloadTypeOrStatus === 'deliverycallback') {
        if (payloadFromMe && (hasMessageContent || payload?.messageId || payload?.zaapId)) {
          const delivMsgId = payload?.messageId ?? payload?.zaapId ?? null
          const hasRealContent =
            (payload?.text?.message != null && String(payload.text.message).trim() !== '') ||
            (payload?.message != null && typeof payload.message === 'string' && String(payload.message).trim() !== '') ||
            (payload?.body != null && String(payload.body).trim() !== '') ||
            payload?.image != null || payload?.imageUrl != null ||
            payload?.audio != null || payload?.audioUrl != null ||
            payload?.video != null || payload?.videoUrl != null ||
            payload?.document != null || payload?.documentUrl != null ||
            payload?.sticker != null || payload?.stickerUrl != null ||
            payload?.message?.image != null || payload?.message?.imageUrl != null ||
            payload?.message?.audio != null || payload?.message?.audioUrl != null ||
            payload?.message?.video != null || payload?.message?.videoUrl != null ||
            payload?.message?.document != null || payload?.message?.documentUrl != null ||
            payload?.message?.sticker != null || payload?.message?.stickerUrl != null ||
            payload?.message?.ptv != null || payload?.message?.location != null || payload?.message?.contact != null

          console.log('[Z-API] DeliveryCallback fromMe:', {
            messageId: delivMsgId ? String(delivMsgId).slice(0, 32) : null,
            phone: (payload?.phone || '').toString().slice(-12),
            hasRealContent
          })

          // Regra: DeliveryCallback SEM conteúdo = APENAS status. Nunca inserir mensagem.
          // Se a mensagem já existe (CRM enviou antes), atualiza status. Se não existe, ignora (não criar placeholder).
          if (!hasRealContent && delivMsgId) {
            const existByWaId = await updateStatusByWaId(String(delivMsgId), 'sent', {
              context: 'deliverycallback.fromMe.no_content',
            })
            if (existByWaId?.id) {
              const effectiveStatus = existByWaId._effective_status || 'sent'
              const io = req.app.get('io')
              if (io) {
                const statusEventPayload = {
                  mensagem_id: existByWaId.id,
                  conversa_id: existByWaId.conversa_id,
                  status: effectiveStatus,
                  status_mensagem: effectiveStatus,
                  whatsapp_id: String(delivMsgId)
                }
                let chain = io.to(`empresa_${existByWaId.company_id}`).to(`conversa_${existByWaId.conversa_id}`)
                if (existByWaId.autor_usuario_id != null) chain = chain.to(`usuario_${existByWaId.autor_usuario_id}`)
                chain.emit('status_mensagem', statusEventPayload)
              }
              logZapiCert({
                companyId: company_id,
                instanceId,
                type: 'deliverycallback',
                fromMe: true,
                hasDest: false,
                phoneTail: (payload?.phone ?? '').toString().slice(-6) || null,
                connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
                messageId: String(delivMsgId),
                conversaId: existByWaId.conversa_id,
                action: 'updated_status'
              })
              lastResult = { ok: true, delivery: true, fromMe: true, messageId: String(delivMsgId) }
              continue
            }
            lastResult = { ok: true, delivery: true, fromMe: true, messageId: String(delivMsgId), skip: 'no_content_no_insert' }
            continue
          }
          // NÃO faz continue → segue para pipeline de mensagem abaixo.
        } else {
        // Mesma prioridade de resolvePeerPhone: to, recipientPhone, toPhone, key.remoteJid, data.*, value.*, etc.
        const { peerPhone: peerDeliv } = resolvePeerPhone(payload)
        const phoneDestCandidates = [
          payload?.to, payload?.toPhone, payload?.recipientPhone, payload?.recipient,
          payload?.destination, payload?.key?.remoteJid, payload?.key?.participant,
          payload?.remoteJid, payload?.chatId, payload?.data?.to, payload?.data?.toPhone,
          payload?.data?.recipientPhone, payload?.data?.key?.remoteJid, payload?.data?.remoteJid,
          payload?.value?.to, payload?.value?.toPhone, payload?.value?.recipientPhone,
          payload?.value?.key?.remoteJid, payload?.value?.remoteJid,
          payload?.phone,
        ]
        const phoneDestRaw = phoneDestCandidates.find(v => v != null && String(v).trim() !== '') ?? ''
        const phoneDest = peerDeliv || (normalizePhoneBR(phoneDestRaw) || String(phoneDestRaw || '').replace(/\D/g, ''))
        const messageId = payload?.messageId ?? payload?.zaapId ?? null
        const errorText = payload?.error != null ? String(payload.error) : ''

        if (!messageId) {
          console.log('📦 Z-API DeliveryCallback (sem messageId):', phoneDest ? String(phoneDest).slice(-12) : '(sem phone)')
          continue
        }

        const statusNorm = errorText ? 'erro' : 'sent'

        // 1) tenta atualizar por whatsapp_id (inclui autor_usuario_id para emit ao remetente)
        const statusUpdate = await updateStatusByWaId(String(messageId), statusNorm, {
          returnResult: true,
          context: 'deliverycallback.status',
        })
        let msg = statusUpdate.data || null
        let error = statusUpdate.error || null
        let statusForEmit = statusUpdate.effectiveStatus || statusNorm

        // 1.1) Mesclagem LID→PHONE: sempre que temos chatLid + canonicalPhone no payload
        const lidFromPayload = String(payload?.phone ?? payload?.chatLid ?? payload?.chat?.id ?? payload?.data?.phone ?? payload?.value?.phone ?? '').trim()
        const lidPartDeliv = lidFromPayload.endsWith('@lid') ? lidFromPayload.replace(/@lid$/i, '').trim() : ''
        const canonicalDeliv = peerDeliv || (phoneDest && !String(phoneDest).startsWith('120') ? getCanonicalPhone(phoneDest) : null)
        if (lidPartDeliv && canonicalDeliv) {
          try {
            const io = req.app.get('io')
            // DeliveryCallback: NÃO enriquecer nome/foto — apenas merge LID→PHONE (evita regressão de nome)
            const mergeRes = await mergeConversationLidToPhone(supabase, company_id, lidPartDeliv, canonicalDeliv, { io, whatsapp_instance_id })
            if (mergeRes.merged && msg && mergeRes.conversa_id) msg = { ...msg, conversa_id: mergeRes.conversa_id }
            if (mergeRes.merged) {
              logZapiCert({
                companyId: company_id,
                instanceId,
                type: 'deliverycallback',
                fromMe: payloadFromMe,
                hasDest: hasDestFields(payload),
                phoneTail: canonicalDeliv?.slice(-6) || null,
                connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
                messageId: String(messageId),
                resolvedKeyType: 'lid→phone',
                conversaId: mergeRes.conversa_id ?? null,
                action: 'merged_lid_phone'
              })
            }
          } catch (e) {
            console.warn('[Z-API] DeliveryCallback mergeConversationLidToPhone:', e?.message || e)
          }
        }

        // 1.2) Se achou a mensagem e temos phoneDest real, tentar corrigir conversa com telefone LID → telefone real (atualização simples, não merge).
        // CRÍTICO: preservar nome_contato_cache e foto — nunca sobrescrever com vazio (evita contato sumir da lista).
        if (!error && msg && phoneDest) {
          try {
            const { data: convRow } = await supabase
              .from('conversas')
              .select('id, telefone, cliente_id, nome_contato_cache, foto_perfil_contato_cache')
              .eq('company_id', company_id)
              .eq('id', msg.conversa_id)
              .maybeSingle()
            const canonical = getCanonicalPhone(phoneDest)
            if (convRow && canonical) {
              const telAtual = convRow.telefone ? String(convRow.telefone).trim() : ''
              const isLidTel = telAtual.toLowerCase().startsWith('lid:')
              const isGroupDest = String(phoneDest).startsWith('120')
              const nomeCache = convRow.nome_contato_cache ? String(convRow.nome_contato_cache).trim() : null
              const fotoCache = convRow.foto_perfil_contato_cache ? String(convRow.foto_perfil_contato_cache).trim() : null
              if ((!telAtual || isLidTel) && !isGroupDest) {
                // DeliveryCallback: passar nome/foto existentes para getOrCreateCliente (evita criar cliente com nome=número)
                const { cliente_id: cid } = await getOrCreateCliente(supabase, company_id, canonical, {
                  nome: nomeCache || undefined,
                  nomeSource: 'chatName',
                  foto_perfil: fotoCache || undefined
                })
                await supabase
                  .from('conversas')
                  .update({ telefone: canonical, ...(cid ? { cliente_id: cid } : {}) })
                  .eq('company_id', company_id)
                  .eq('id', convRow.id)
                const io = req.app.get('io')
                if (io) {
                  // Sempre incluir nome/foto no emit para não sobrescrever com vazio no frontend
                  const emitPayload = {
                    id: convRow.id,
                    telefone: canonical,
                    ...(cid ? { cliente_id: cid } : {})
                  }
                  if (nomeCache) {
                    emitPayload.nome_contato_cache = nomeCache
                    emitPayload.contato_nome = nomeCache
                  }
                  if (fotoCache) {
                    emitPayload.foto_perfil_contato_cache = fotoCache
                    emitPayload.foto_perfil = fotoCache
                  }
                  await emitirParaUsuariosQuePodemVerConversa(io, company_id, convRow.id, 'conversa_atualizada', emitPayload)
                }
              } else if ((!telAtual || isLidTel) && isGroupDest) {
                await supabase
                  .from('conversas')
                  .update({ telefone: canonical })
                  .eq('company_id', company_id)
                  .eq('id', convRow.id)
                const io = req.app.get('io')
                if (io) {
                  const emitPayload = { id: convRow.id, telefone: canonical }
                  if (nomeCache) { emitPayload.nome_contato_cache = nomeCache; emitPayload.contato_nome = nomeCache }
                  if (fotoCache) { emitPayload.foto_perfil_contato_cache = fotoCache; emitPayload.foto_perfil = fotoCache }
                  await emitirParaUsuariosQuePodemVerConversa(io, company_id, convRow.id, 'conversa_atualizada', emitPayload)
                }
              }
            }
          } catch (e) {
            console.warn('[Z-API] DeliveryCallback: falha ao atualizar telefone da conversa:', e?.message || e)
          }
        }

        // 2) se não achou, prioriza referenceId CRM quando o provedor envia esse vínculo.
        if (!error && !msg) {
          const byReference = await tryReconcileFromMeByCrmReferenceId(supabase, {
            company_id,
            conversa_id: null,
            whatsapp_instance_id,
            payload,
            whatsappIdStr: String(messageId),
            statusPayload: statusNorm,
          })
          if (byReference?.id) {
            msg = byReference
            statusForEmit = byReference.status || byReference.status_mensagem || statusForEmit
          }
        }

        // 3) se não achou, tenta reconciliar mensagem out sem whatsapp_id na conversa de destino.
        // Só aplica quando houver exatamente uma candidata; com duas ou mais, o ACK é ambíguo.
        if (!error && !msg && phoneDest) {
          try {
            const isGroup = String(phoneDest).startsWith('120')
            const phones = isGroup ? [phoneDest] : possiblePhonesBR(phoneDest)
            let qConv = supabase
              .from('conversas')
              .select('id, whatsapp_instance_id')
              .eq('company_id', company_id)
              .neq('status_atendimento', 'fechada')
              .order('id', { ascending: false })
              .limit(3)
            qConv = applyWhatsappInstanceFilterOrLegacy(qConv, whatsapp_instance_id)
            if (phones.length > 0) qConv = qConv.in('telefone', phones)
            const { data: convs } = await qConv
            const convId = Array.isArray(convs) && convs[0]?.id ? convs[0].id : null

            if (convId) {
              const ts = Date.now()
              const fromIso = new Date(ts - 5 * 60 * 1000).toISOString()
              const toIso = new Date(ts + 5 * 60 * 1000).toISOString()
              let candQuery = supabase
                .from('mensagens')
                .select('id, conversa_id, company_id, autor_usuario_id, status, status_mensagem')
                .eq('company_id', company_id)
                .eq('conversa_id', convId)
                .eq('direcao', 'out')
                .is('whatsapp_id', null)
                .gte('criado_em', fromIso)
                .lte('criado_em', toIso)
                .order('criado_em', { ascending: false })
                .order('id', { ascending: false })
                .limit(2)
              candQuery = applyWhatsappInstanceFilterOrLegacy(candQuery, whatsapp_instance_id)
              const { data: candRows } = await candQuery

              const candidates = Array.isArray(candRows) ? candRows : []
              const picked = candidates.length === 1 ? candidates[0] : null
              if (!picked && candidates.length > 1) {
                console.warn('[Z-API] DeliveryCallback fallback ambíguo; ACK ignorado para evitar associar mensagem errada', {
                  company_id,
                  conversa_id: convId,
                  messageId: String(messageId).slice(0, 24),
                  count: candidates.length,
                })
              }
              if (picked?.id) {
                const currentStatus = picked.status || picked.status_mensagem || 'pending'
                const effectiveStatus = resolveEffectiveStatus(currentStatus, statusNorm)
                const patched = await patchMensagemStatusById(supabase, {
                  company_id,
                  mensagem_id: picked.id,
                  effectiveStatus,
                  whatsapp_id: String(messageId),
                  select: 'id, conversa_id, company_id, autor_usuario_id, status, status_mensagem, whatsapp_id',
                })
                msg = patched.data || null
                statusForEmit = effectiveStatus
              }
            }
          } catch (_) {}
        }

        if (errorText) {
          console.warn('❌ Z-API DeliveryCallback erro:', String(phoneDest || '').slice(-12), String(errorText).slice(0, 220))
        }

        if (!error && msg) {
          const io = req.app.get('io')
          if (io) {
            const payload = {
              mensagem_id: msg.id,
              conversa_id: msg.conversa_id,
              status: statusForEmit,
              status_mensagem: statusForEmit,
              whatsapp_id: String(messageId)
            }
            let chain = io.to(`empresa_${msg.company_id}`).to(`conversa_${msg.conversa_id}`)
            if (msg.autor_usuario_id != null) chain = chain.to(`usuario_${msg.autor_usuario_id}`)
            chain.emit('status_mensagem', payload)
          }
          logZapiCert({
            companyId: company_id,
            instanceId,
            type: 'deliverycallback',
            fromMe: payloadFromMe,
            hasDest: hasDestFields(payload),
            phoneTail: (phoneDest || '').toString().slice(-6) || null,
            connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
            messageId: String(messageId),
            conversaId: msg.conversa_id,
            action: 'updated_status'
          })
        }

        lastResult = { ok: true, delivery: true, messageId: String(messageId), status: statusForEmit }
        continue
      }
      }

      // ─── Caso especial: fromMe=true, phone=connectedPhone, sem destino (self-echo) ───
      // Evita DROPPED; reconcilia por messageId → atualiza status apenas, nunca criar conversa.
      const _digits = (v) => String(v ?? '').replace(/\D/g, '')
      const _tail11 = (d) => (d && d.length >= 11) ? d.slice(-11) : (d || '')
      const fromMeSelf = Boolean(payload?.fromMe ?? payload?.key?.fromMe)
      const phoneRaw = (payload?.phone ?? '').toString().trim()
      const connectedRaw = (payload?.connectedPhone ?? payload?.ownerPhone ?? payload?.instancePhone ?? payload?.phoneNumber ?? payload?.me?.phone ?? '').toString().trim()
      const phoneDig = _digits(phoneRaw)
      const connectedDig = _digits(connectedRaw)
      const phonesMatch = phoneDig && connectedDig && _tail11(phoneDig) === _tail11(connectedDig)

      if (fromMeSelf && phonesMatch && !hasDestFields(payload)) {
        const msgId = payload?.messageId ?? payload?.zaapId ?? payload?.id ?? payload?.key?.id ?? null
        const statusRaw = payload?.ack != null ? String(payload.ack).trim() : String(payload?.status ?? '').trim()
        const statusNorm = statusRaw ? normalizeZapiStatus(statusRaw) : null
        console.log('[ULTRAMSG_WEBHOOK]', JSON.stringify({ companyIdResolved: company_id, messageId: msgId ? String(msgId).slice(0, 20) : null, status: statusNorm, note: 'self_echo' }))
        if (msgId) {
          const { data: existing } = await selectSingleMensagemByWhatsappId(supabase, {
            company_id,
            whatsapp_id: String(msgId),
            whatsapp_instance_id,
            select: 'id, conversa_id, company_id, whatsapp_id',
            context: 'self_echo',
          })
          if (existing) {
            if (statusNorm) {
              const updated = await updateStatusByWaId(String(msgId), statusNorm)
              if (updated) emitStatusMsg(updated, updated._effective_status || statusNorm, String(msgId))
            }
            logZapiCert({
              companyId: company_id,
              instanceId,
              type: payload?.type ?? payload?.event ?? 'receivedcallback',
              fromMe: true,
              hasDest: false,
              phoneTail: phoneDig?.slice(-6) || null,
              connectedTail: connectedDig?.slice(-6) || null,
              messageId: String(msgId),
              resolvedKeyType: 'self_echo',
              conversaId: existing.conversa_id,
              action: 'self_echo_status_update'
            })
            lastResult = { ok: true, handled: 'fromMe_self_echo_status' }
            continue
          }
        }
        logZapiCert({
          companyId: company_id,
          instanceId,
          type: payload?.type ?? payload?.event ?? 'receivedcallback',
          fromMe: true,
          hasDest: false,
          phoneTail: phoneDig?.slice(-6) || null,
          connectedTail: connectedDig?.slice(-6) || null,
          messageId: String(msgId),
          resolvedKeyType: 'self_echo',
          conversaId: null,
          action: 'self_echo_ignored_no_match'
        })
        lastResult = { ok: true, ignored: 'fromMe_self_echo_no_match' }
        continue
      }

      const extracted = extractMessage(payload)
      let {
        phone,
        debugReason,
        texto,
        fromMe,
        messageId,
        criado_em,
        type,
        imageUrl,
        documentUrl,
        audioUrl,
        videoUrl,
        stickerUrl,
        locationUrl,
        fileName,
        isGroup,
        isEdit,
        isNewsletter,
        waitingMessage,
        participantPhone,
        senderName,
        nomeGrupo,
        senderPhoto,
        chatPhoto,
        contactMeta,
        locationMeta
      } = extracted

      // Newsletters (canais) não são conversas de atendimento — ignorar silenciosamente
      if (isNewsletter) {
        console.log('[Z-API] ⏭️ isNewsletter=true — newsletter ignorada:', phone || '(sem phone)')
        continue
      }

      // ── Log de resolução de chave — SEMPRE visível (crítico para diagnóstico) ──
      console.log('[ULTRAMSG] 📞 resolveKey:', {
        type: payload?.type ?? payload?.event ?? '(sem type)',
        fromMe,
        isGroup,
        phone_raw: (payload?.phone ?? '').toString().slice(-14) || '(vazio)',
        connectedPhone_tail: (payload?.connectedPhone ?? '').toString().slice(-6) || '(ausente)',
        resolvedKey: phone ? ('...' + String(phone).slice(-8)) : '❌ VAZIO → SERÁ DROPADO',
        messageId: messageId ? String(messageId).slice(0, 20) : null,
        reason: debugReason,
      })

      if (!phone) {
        logZapiCert({
          companyId: company_id,
          instanceId,
          type: payload?.type ?? payload?.event ?? 'receivedcallback',
          fromMe,
          hasDest: hasDestFields(payload),
          phoneTail: (payload?.phone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
          connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
          messageId: messageId ? String(messageId) : null,
          resolvedKeyType: debugReason ?? 'drop',
          conversaId: null,
          action: 'dropped_invalid_payload'
        })
        // Log SEMPRE do payload completo para diagnóstico — crítico para entender o que Z-API envia
        console.warn('⚠️ [Z-API] DROPPED — phone não resolvido:', debugReason)
        const droppedMeta = {
          type: payload?.type,
          fromMe: payload?.fromMe,
          phone: payload?.phone,
          senderPhone: payload?.senderPhone,
          connectedPhone: payload?.connectedPhone,
          chatId: payload?.chatId,
          remoteJid: payload?.remoteJid,
          to: payload?.to,
          toPhone: payload?.toPhone,
          recipientPhone: payload?.recipientPhone,
          'key.remoteJid': payload?.key?.remoteJid,
          'key.participant': payload?.key?.participant,
          isGroup: payload?.isGroup,
          messageId: payload?.messageId,
          status: payload?.status,
        }
        if (WHATSAPP_DEBUG && (payload?.data != null || payload?.key != null || payload?.value != null)) {
          droppedMeta.data = payload?.data
          droppedMeta.key = payload?.key
          droppedMeta.value = payload?.value
        }
        console.warn('⚠️ [Z-API] DROPPED — payload completo (diagnóstico):', JSON.stringify(droppedMeta))
        continue
      }

    if (isGroup) {
      console.log('📩 Z-API [GRUPO]', phone, nomeGrupo || '', fromMe ? '(de mim)' : `(${senderName || participantPhone || 'participante'})`, texto?.slice(0, 50))
    } else {
      console.log('📩 ULTRAMSG mensagem recebida:', phone, fromMe ? '(enviada por nós)' : '(recebida)', texto?.slice(0, 50))
    }

    let cliente_id = null
    let pendingContactSync = null
    let nomeParaCache = null // Nome resolvido (syncUltramsg ou payload) para atualizar cache da conversa
    let nomeSourceParaCache = null

    if (!isGroup) {
      // LID sintético (@lid): mensagem espelhada enviada pelo celular sem número real conhecido.
      // Chave "lid:XXXX" NÃO é um número de telefone → nunca criar/vincular cliente.
      const isLidKey = String(phone).startsWith('lid:')

      if (isLidKey) {
        console.log('[Z-API] LID key — conversa sem cliente vinculado (número real não disponível):', phone)
      } else {
        const nomePayloadRaw = fromMe
          ? (payload.name ?? payload.formattedName ?? payload.chatName ?? payload.chat?.name ?? payload.groupName ?? payload.short ?? payload.notifyName ?? payload.senderName ?? payload.displayName ?? payload.pushName ?? null)
          : (payload.name ?? payload.formattedName ?? payload.short ?? payload.notifyName ?? payload.senderName ?? payload.chatName ?? payload.chat?.name ?? payload.displayName ?? payload.pushName ?? null)
        let nomePayload = nomePayloadRaw ? String(nomePayloadRaw).trim() : null
        let nomeSource = (payload.name && String(payload.name).trim()) ? 'name' : (fromMe ? 'chatName' : 'senderName')

        // Sincroniza nome/foto: UltraMsg webhook NUNCA traz profile picture — usar GET /contacts/image.
        // Passar chatId (ex. payload.chatId = data.from) quando disponível para chamada correta à API.
        if (phone) {
          const syncChatId = !isGroup && payload.chatId && String(payload.chatId).trim().endsWith('@c.us')
            ? String(payload.chatId).trim()
            : phone
          const syncTimeoutMs = fromMe ? 6000 : 5000
          const syncOpts = { skipCache: true }
          if (fromMe) syncOpts.skipCache = true
          try {
            const syncResult = await Promise.race([
              syncUltraMsgContact(syncChatId, company_id, syncOpts),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), syncTimeoutMs))
            ])
            // syncUltraMsgContact pode retornar telefone como fallback quando API não tem nome — ignorar e usar pushname do payload
            const syncNome = syncResult?.nome ? String(syncResult.nome).trim() : null
            if (syncNome && !isBadName(syncNome)) {
              nomePayload = syncNome
              nomeSource = 'syncUltramsg'
              nomeParaCache = nomePayload
              nomeSourceParaCache = 'syncUltramsg'
            }
            // Foto: sempre usar da API quando disponível (payload só traz quando contato envia; when fromMe precisamos da API)
            const syncFoto = syncResult?.foto_perfil && String(syncResult.foto_perfil).trim()
            if (syncFoto && syncFoto.startsWith('http')) senderPhoto = syncFoto
          } catch (_) {
            // fallback: usa nome do payload (senderName/chatName) — SOMENTE quando !fromMe (payload traz pushname do contato)
            // Quando fromMe: payload traz NOSSO nome — nunca usar como nome do contato
          }
        }
        // Quando fromMe: nome do payload é do remetente (nós) — só usar nome vindo do sync (destinatário)
        if (nomePayload && !nomeParaCache && !fromMe) {
          nomeParaCache = nomePayload
          nomeSourceParaCache = nomeSource
        }

        const pushnameRaw = payload.notifyName ?? payload.pushName ?? payload.notify ?? nomePayloadRaw
        const pushnamePayload = pushnameRaw ? String(pushnameRaw).trim() : null
        const { cliente_id: cid } = await getOrCreateCliente(supabase, company_id, phone, {
          nome: nomePayload,
          nomeSource,
          fromMe,
          pushname: pushnamePayload || undefined,
          foto_perfil: senderPhoto || undefined
        })
        cliente_id = cid
        if (cliente_id) {
          const chatIdForSync = !isGroup && payload.chatId && String(payload.chatId).trim().endsWith('@c.us')
            ? String(payload.chatId).trim()
            : (payload.key?.remoteJid && String(payload.key.remoteJid).trim().endsWith('@c.us') ? String(payload.key.remoteJid).trim() : null)
          pendingContactSync = { phone, cliente_id, chatId: chatIdForSync || phone }
        }
        // Pipeline NUNCA aborta por cliente: mesmo sem cliente_id, mensagem e socket seguem
      }
    }

    // 2) Conversa — uma única conversa por contato; quando Z-API envia chatLid/senderLid, unificar por chat_lid
    //    para que "recebido" (phone real) e "enviado pelo celular" (phone @lid) caiam no mesmo chat.
    //    Sempre priorizar número real (phone) do payload; LID só para vincular/atualizar.
    let conversa_id = null
    let departamento_id = null
    let isNewConversation = false

    const lidFromPhone = String(payload?.chatLid ?? payload?.phone ?? payload?.chat?.id ?? payload?.key?.remoteJid ?? '').trim()
    const lidFromSender = String(payload?.senderLid ?? '').trim()
    const lidRaw = lidFromPhone.endsWith('@lid') ? lidFromPhone : (lidFromSender.endsWith('@lid') ? lidFromSender : '')
    const lidPart = lidRaw ? lidRaw.replace(/@lid$/i, '').trim() : (phone.startsWith('lid:') ? phone.slice(4) : null)

    try {
      if (lidPart) {
        const { data: convByLidRows } = await supabase
          .from('conversas')
          .select('id, departamento_id, telefone, whatsapp_instance_id')
          .eq('company_id', company_id)
          .eq('chat_lid', lidPart)
          .order('ultima_atividade', { ascending: false })
          .limit(20)
        const convByLid = (Array.isArray(convByLidRows) ? convByLidRows : []).find((row) =>
          !whatsapp_instance_id ||
          Number(row?.whatsapp_instance_id) === Number(whatsapp_instance_id) ||
          (whatsapp_instance_is_default && row?.whatsapp_instance_id == null)
        ) || null

        const hasRealPhone = phone && !phone.startsWith('lid:')
        let convByPhone = null
        if (hasRealPhone) {
          const canonical = getCanonicalPhone(phone)
          const variants = canonical ? possiblePhonesBR(canonical) : []
          const list = variants.length > 0 ? variants : [phone]
          const { data: rows } = await supabase
            .from('conversas')
            .select('id, departamento_id, telefone, whatsapp_instance_id')
            .eq('company_id', company_id)
            .in('telefone', list)
            .order('ultima_atividade', { ascending: false })
            .limit(20)
          convByPhone = (Array.isArray(rows) ? rows : []).find((row) =>
            !whatsapp_instance_id ||
            Number(row?.whatsapp_instance_id) === Number(whatsapp_instance_id) ||
            (whatsapp_instance_is_default && row?.whatsapp_instance_id == null)
          ) || null
        }

        if (convByLid && convByPhone && convByLid.id !== convByPhone.id) {
          await mergeConversasIntoCanonico(supabase, company_id, convByPhone.id, [convByLid.id], {
            io: req.app.get('io'),
          })
          await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', convByPhone.id).eq('company_id', company_id)
          conversa_id = convByPhone.id
          departamento_id = convByPhone.departamento_id ?? null
          isNewConversation = false
          console.log('[Z-API] 🔗 Unificado por chat_lid: conv LID mesclada em conv telefone', { conversa_id, lidPart })
        } else if (convByLid && hasRealPhone) {
          // Temos número real + conv com chat_lid: atualizar telefone se estava lid e usar.
          const canonical = getCanonicalPhone(phone)
          if (canonical) {
            await supabase.from('conversas').update({ telefone: canonical, chat_lid: lidPart }).eq('id', convByLid.id).eq('company_id', company_id)
          } else {
            await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', convByLid.id).eq('company_id', company_id)
          }
          conversa_id = convByLid.id
          departamento_id = convByLid.departamento_id ?? null
          isNewConversation = false
        } else if (convByLid && !hasRealPhone) {
          // LID-only (contato enviou, Z-API mandou só @lid): usar conversa existente com esse chat_lid.
          // Evita duplicar: quando fromMe criou conv com telefone real + chat_lid, mensagem do contato cai na mesma.
          conversa_id = convByLid.id
          departamento_id = convByLid.departamento_id ?? null
          isNewConversation = false
          console.log('[Z-API] 🔗 LID-only: reutilizando conv existente por chat_lid', { conversa_id, lidPart })
        } else if (convByPhone) {
          await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', convByPhone.id).eq('company_id', company_id)
          conversa_id = convByPhone.id
          departamento_id = convByPhone.departamento_id ?? null
          isNewConversation = false
        }
      }

      if (conversa_id == null) {
        const syncResult = await findOrCreateConversation(supabase, {
          company_id,
          phone,
          cliente_id: isGroup ? null : cliente_id,
          isGroup,
          nomeGrupo,
          chatPhoto,
          chatLid: lidPart || null,
          whatsapp_instance_id,
          whatsapp_instance_is_default,
          logPrefix: `[Z-API fromMe=${fromMe}]`,
          // Sempre aberta ao criar; mensagem_disparada só após insert se for 1ª msg e WhatsApp externo (sem autor).
          initial_status_atendimento: 'aberta',
          io: req.app.get('io'),
        })

        if (!syncResult) {
          console.error('[Z-API] findOrCreateConversation retornou null para phone:', phone)
          // IMPORTANTE: payload é 1 de N num lote (ver getPayloads) — abortar a requisição aqui
          // descartaria as demais mensagens do lote. Pula só esta e segue para a próxima.
          lastResult = { ok: false, error: 'Não foi possível identificar conversa para o número' }
          continue
        }

        conversa_id = syncResult.conversa.id
        departamento_id = syncResult.conversa.departamento_id ?? null
        isNewConversation = syncResult.created

        if (lidPart) {
          await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', conversa_id).eq('company_id', company_id)
        }
      }

      // Atualiza foto do grupo quando disponível no payload
      if (isGroup && chatPhoto && !isNewConversation) {
        await supabase.from('conversas')
          .update({ foto_grupo: chatPhoto })
          .eq('id', conversa_id)
          .eq('company_id', company_id)
      }

      // Se grupo sem nome, busca em background (UltraMsg nem sempre envia chatName no webhook)
      if (isGroup && !nomeGrupo && conversa_id) {
        const io = req.app.get('io')
        if (io) {
          setImmediate(() => {
            const { syncConversationGroupOnJoin } = require('../services/ultramsgGroupsSyncService')
            syncConversationGroupOnJoin(supabase, conversa_id, company_id, io, { skipIfRecent: false }).catch(() => {})
          })
        }
      }

      // Vincular conversa ao cliente quando obtido via LID ou conversa existente sem cliente_id
      if (!isGroup && conversa_id && cliente_id) {
        const { data: convRow } = await supabase
          .from('conversas')
          .select('cliente_id')
          .eq('id', conversa_id)
          .eq('company_id', company_id)
          .maybeSingle()
        if (convRow && convRow.cliente_id == null) {
          await supabase.from('conversas').update({ cliente_id }).eq('id', conversa_id).eq('company_id', company_id)
          console.log('[Z-API] Conversa vinculada ao cliente', { conversa_id, cliente_id })
        }
      }

      // Cache nome/foto do contato. Prioriza nome da API (syncUltramsg = como salvo no celular).
      if (!isGroup && conversa_id && (nomeParaCache || senderName || senderPhoto)) {
        const { data: convAtual } = await supabase
          .from('conversas')
          .select('nome_contato_cache, foto_perfil_contato_cache')
          .eq('id', conversa_id)
          .eq('company_id', company_id)
          .maybeSingle()
        const cacheUpdates = {}
        const nomeCandidato = (nomeParaCache && String(nomeParaCache).trim()) || (senderName && String(senderName).trim())
        const sourceCache = nomeSourceParaCache || ((payload.name && String(payload.name).trim()) ? 'name' : (fromMe ? 'chatName' : 'senderName'))
        if (nomeCandidato) {
          const { name: bestNome, decision } = chooseBestName(
            convAtual?.nome_contato_cache || null,
            String(nomeCandidato).trim(),
            sourceCache,
            { fromMe, company_id, telefoneTail: String(phone).replace(/\D/g, '').slice(-6) || null }
          )
          if (bestNome && decision === 'updated') cacheUpdates.nome_contato_cache = bestNome
        }
        const fotoCacheVazia = !convAtual?.foto_perfil_contato_cache || !String(convAtual.foto_perfil_contato_cache).trim()
        if (fotoCacheVazia && senderPhoto && String(senderPhoto).trim().startsWith('http')) {
          // Preferir foto já estável em clientes antes da URL fresca do sync (evita gravar foto errada/CDN).
          let fotoParaCache = String(senderPhoto).trim()
          if (cliente_id) {
            try {
              const { data: cliFoto } = await supabase
                .from('clientes')
                .select('foto_perfil')
                .eq('id', cliente_id)
                .eq('company_id', company_id)
                .maybeSingle()
              const existente = cliFoto?.foto_perfil ? String(cliFoto.foto_perfil).trim() : ''
              if (existente.startsWith('http')) fotoParaCache = existente
            } catch (_) {}
          }
          cacheUpdates.foto_perfil_contato_cache = fotoParaCache
        }
        if (Object.keys(cacheUpdates).length > 0) {
          await supabase.from('conversas')
            .update(cacheUpdates)
            .eq('id', conversa_id)
            .eq('company_id', company_id)
        }
      }

      if (isNewConversation) {
        const io = req.app.get('io')
        if (io) {
          // Unread: mensagem recebida (!fromMe) = 1; mensagem enviada por nós (fromMe) = 0
          const unreadInicial = fromMe ? 0 : 1
          // LID: enviar telefone: null e telefone_lid: true para frontend não exibir lid:xxx; permite atualização via conversa_atualizada
          const isLidPhone = !isGroup && phone && String(phone).trim().toLowerCase().startsWith('lid:')
          const telefoneForEmit = isLidPhone ? null : (getCanonicalPhone(phone) || phone)
          const novaConversaPayload = {
            id: conversa_id,
            telefone: telefoneForEmit,
            ...(isLidPhone ? { telefone_lid: true } : {}),
            tipo: isGroup ? 'grupo' : 'cliente',
            nome_grupo: isGroup ? (nomeGrupo || null) : null,
            foto_grupo: isGroup ? (chatPhoto || null) : null,
            contato_nome: isGroup ? (nomeGrupo || phone || 'Grupo') : (nomeParaCache || senderName || payload?.chatName || phone || null),
            foto_perfil: isGroup ? null : (senderPhoto || payload?.photo || null),
            unread_count: unreadInicial,
            tags: [],
          }
          const emittedNovaConversa = await emitirParaUsuariosQuePodemVerConversa(
            io,
            company_id,
            conversa_id,
            io.EVENTS?.NOVA_CONVERSA || 'nova_conversa',
            novaConversaPayload
          )
          if (!emittedNovaConversa && !isGroup) {
            io.to(`empresa_${company_id}`).emit(io.EVENTS?.NOVA_CONVERSA || 'nova_conversa', novaConversaPayload)
          }
        }
      }
    } catch (errConv) {
      console.error('[Z-API] ❌ Erro ao obter/criar conversa:', errConv?.message || errConv)
      // IMPORTANTE: payload é 1 de N num lote (ver getPayloads) — abortar a requisição aqui
      // descartaria as demais mensagens do lote. Pula só esta e segue para a próxima.
      lastResult = { ok: false, error: 'Erro ao obter conversa' }
      continue
    }

    // Idempotência de EFEITOS COLATERAIS antes do insert.
    // A dedup por whatsapp_id que evita linha duplicada só roda mais abaixo (ver ~2775), mas a
    // reabertura de conversa encerrada e o chatbot de triagem executam ANTES dela. Sem esta guarda,
    // uma REENTREGA/replay de um inbound antigo (reconexão da instância, retry de webhook UltraMSG,
    // re-sync) dispara boas-vindas/menu "sem o cliente ter mandado mensagem" — o bug relatado.
    // Mensagem genuinamente nova tem whatsapp_id inédito e nunca é bloqueada aqui.
    let inboundReentregue = false
    if (!fromMe && !isGroup && conversa_id && messageId) {
      const waIdReentrega = String(messageId).trim()
      if (waIdReentrega) {
        const { data: jaProcessado } = await selectSingleMensagemByWhatsappId(supabase, {
          company_id,
          whatsapp_id: waIdReentrega,
          whatsapp_instance_id,
          select: 'id, direcao',
          context: 'received.preprocess.idempotency',
        })
        if (jaProcessado?.id) {
          inboundReentregue = true
          console.log('[Z-API] ⏭️ inbound reentregue/replay — pulando reabertura e chatbot (sem novo menu de boas-vindas)', {
            conversa_id,
            company_id,
            whatsappIdTail: waIdReentrega.slice(-8),
          })
        }
      }
    }

    // Captura avaliação (nota 0-10) e reabertura automática em conversa encerrada (fechada ou finalizada)
    let conversaReabertaAposFinalizacao = false
    let reopenedFromAbsence = false
    let absenceReopenExplicitlyDisabled = false
    if (!fromMe && !isGroup && conversa_id && !inboundReentregue) {
      const { data: convStatus } = await supabase
        .from('conversas')
        .select('id, status_atendimento, cliente_id, departamento_id, finalizacao_motivo, atendente_id')
        .eq('id', conversa_id)
        .eq('company_id', company_id)
        .maybeSingle()
      const st = convStatus?.status_atendimento
      const motivoFinalizacao = String(convStatus?.finalizacao_motivo || '').trim().toLowerCase()

      if (st === 'aguardando_cliente') {
        const { data: retomadaManual } = await supabase
          .from('conversas')
          .update({
            status_atendimento: 'em_atendimento',
            aguardando_cliente_desde: null,
          })
          .eq('id', conversa_id)
          .eq('company_id', company_id)
          .eq('status_atendimento', 'aguardando_cliente')
          .select()
          .maybeSingle()
        if (retomadaManual?.id) {
          await supabase.from('historico_atendimentos').insert({
            conversa_id,
            usuario_id: null,
            acao: 'retomada_em_atendimento_resposta_cliente',
            observacao:
              'Cliente enviou mensagem — conversa saiu de aguardando cliente (manual) e voltou para em atendimento',
          })
        }
      }

      const conversaEncerrada = st === 'fechada' || st === 'finalizada'
      if (conversaEncerrada) {
        if (motivoFinalizacao === 'ausencia_cliente') {
          const { absence: cfg } = await loadChatbotTriageMergeAndAbsence(company_id)
          if (cfg.reabrirAutomaticamente) {
            const depAntesReabrir =
              convStatus?.departamento_id != null ? Number(convStatus.departamento_id) : null
            const snap = await fetchLastAbsenceEncerramentoSnap(conversa_id)
            const assign = await resolveReopenAssignmentAfterAbsence(company_id, snap)
            const deptoRestaurar =
              snap?.departamento_id != null && Number(snap.departamento_id) > 0
                ? Number(snap.departamento_id)
                : depAntesReabrir
            const { data: reabertaAusencia } = await supabase
              .from('conversas')
              .update({
                status_atendimento: assign.status_atendimento,
                departamento_id: deptoRestaurar,
                atendente_id: assign.atendente_id,
                atendente_atribuido_em: assign.atendente_atribuido_em,
                finalizacao_motivo: null,
                finalizada_automaticamente: false,
                finalizada_automaticamente_em: null,
                aguardando_cliente_desde: null,
              })
              .eq('id', conversa_id)
              .eq('company_id', company_id)
              .select()
              .single()
            if (reabertaAusencia) {
              departamento_id = reabertaAusencia.departamento_id != null ? Number(reabertaAusencia.departamento_id) : null
              conversaReabertaAposFinalizacao = true
              reopenedFromAbsence = true
              await clearReabertaFaltaInteracao(company_id, conversa_id)
              reabertaAusencia.reaberta_falta_interacao_em = null
              reabertaAusencia.reaberta_por_falta_interacao = false
              await supabase.from('historico_atendimentos').insert({
                conversa_id,
                usuario_id: null,
                acao: 'reabertura_automatica_ausencia',
                observacao:
                  'Reaberto pelo cliente após encerramento automático por ausência — retomada sem novo menu de triagem',
              })
              await logBotAction(company_id, conversa_id, 'reabertura_automatica_ausencia', {
                bypass_chatbot: cfg.reabrirSemChatbot,
                status_atendimento: assign.status_atendimento,
                atendente_restaurado: assign.atendente_id,
              })
              const io = req.app.get('io')
              if (io) {
                emitReaberturaSemSetorRealtime({
                  io,
                  company_id,
                  conversa_id,
                  reabertaRow: reabertaAusencia,
                  departamentoIdAntigo: depAntesReabrir,
                })
                io.to(`empresa_${company_id}`).emit(io.EVENTS?.CONVERSA_REABERTA || 'conversa_reaberta', reabertaAusencia)
              }
            }
          } else {
            absenceReopenExplicitlyDisabled = true
          }
        }
        if (reopenedFromAbsence) {
          await clearWaitingForClient(company_id, conversa_id)
        }
        // Tentar registrar nota de avaliação se o texto for 0-10
        const textoNorm = String(texto || '').trim()
        const avalResult = await tentarRegistrarAvaliacao({
          company_id,
          conversa_id,
          cliente_id: convStatus.cliente_id || cliente_id || null,
          texto: textoNorm,
        })
        if (avalResult.registered) {
          console.log('[Webhook] 📊 Avaliação registrada (UltraMSG):', { conversa_id, nota: textoNorm })
        }
        // Reabrir por defeito após encerramento; não reabrir se for avaliação registrada,
        // nota 0-10 isolada, agradecimento/ACK de encerramento ou mensagem claramente sem nova demanda.
        if (!avalResult.registered && !reopenedFromAbsence && !absenceReopenExplicitlyDisabled) {
          const reopenDecision = shouldReopenFinishedConversation(textoNorm, {
            company_id,
            conversa_id,
            status_atendimento: st
          })
          if (reopenDecision.shouldReopen) {
            const depAntesReabrir =
              convStatus?.departamento_id != null ? Number(convStatus.departamento_id) : null
            const { data: reaberta } = await supabase
              .from('conversas')
              .update({
                status_atendimento: 'aberta',
                departamento_id: null,
                atendente_id: null,
                atendente_atribuido_em: null,
              })
              .eq('id', conversa_id)
              .eq('company_id', company_id)
              .select()
              .single()
            if (reaberta) {
              departamento_id = null
              conversaReabertaAposFinalizacao = true
              await clearReabertaFaltaInteracao(company_id, conversa_id)
              reaberta.reaberta_falta_interacao_em = null
              reaberta.reaberta_por_falta_interacao = false
              const { resetChatbotStateForConversa } = require('../services/chatbotTriageService')
              await resetChatbotStateForConversa(supabase, company_id, conversa_id)
              const io = req.app.get('io')
              if (io) {
                emitReaberturaSemSetorRealtime({
                  io,
                  company_id,
                  conversa_id,
                  reabertaRow: reaberta,
                  departamentoIdAntigo: depAntesReabrir,
                })
                io.to(`empresa_${company_id}`).emit(io.EVENTS?.CONVERSA_REABERTA || 'conversa_reaberta', reaberta)
              }
              console.log('[Z-API] 🔄 Conversa reaberta automaticamente após encerramento — chatbot reiniciado', {
                conversa_id,
                texto: textoNorm,
                reason: reopenDecision.reason
              })
            }
          } else {
            console.log('[Z-API] 🔒 Conversa mantida fechada (avaliação, agradecimento ou ACK de encerramento)', {
              conversa_id,
              texto: textoNorm,
              reason: reopenDecision.reason
            })
          }
        } else if (absenceReopenExplicitlyDisabled) {
          console.log('[Z-API] 🔒 Conversa mantida fechada — reabertura automática por ausência desativada', {
            conversa_id,
            texto: textoNorm,
            motivo_finalizacao: motivoFinalizacao,
          })
        }
      }
    }

    if (!isGroup && conversa_id) {
      if (!fromMe) {
        await clearWaitingForClient(company_id, conversa_id)
      } else {
        await tryMarkWaitingAfterHumanOutbound({
          company_id,
          conversa_id,
          texto,
          criado_em: criado_em || new Date().toISOString(),
        })
      }
    }

    // 2.5) Chatbot de triagem (Z-API): mensagem do cliente, conversa sem departamento → menu ou processar opção
    // APENAS contatos (não grupos). Telefone deve ser enviável (não lid:).
    let phoneParaChatbot = phone
    if (phone && String(phone).startsWith('lid:')) {
      const { data: convRow } = await supabase
        .from('conversas')
        .select('telefone')
        .eq('id', conversa_id)
        .eq('company_id', company_id)
        .maybeSingle()
      const telefoneConv = convRow?.telefone
      if (telefoneConv && !String(telefoneConv).startsWith('lid:')) {
        phoneParaChatbot = telefoneConv
        console.log('[Z-API] 🤖 Chatbot: usando telefone da conversa (payload tinha LID):', telefoneConv?.slice(-8))
      } else {
        console.log('[Z-API] 🤖 Chatbot: ignorado — phone é LID e conversa não tem número real para envio')
        phoneParaChatbot = null
      }
    }
    // Human takeover: não processar chatbot se atendente já assumiu a conversa
    // Revalida departamento/atendente no banco (snapshot inicial pode estar stale em webhooks paralelos).
    let atendente_id = null
    if (!fromMe && !isGroup && phoneParaChatbot) {
      const { data: convEstado } = await supabase
        .from('conversas')
        .select('atendente_id, departamento_id')
        .eq('id', conversa_id)
        .eq('company_id', company_id)
        .maybeSingle()
      atendente_id = convEstado?.atendente_id ?? null
      if (convEstado?.departamento_id != null) {
        departamento_id = Number(convEstado.departamento_id)
      }
    }
    if (!fromMe && !isGroup && !inboundReentregue && departamento_id == null && atendente_id == null && phoneParaChatbot) {
      try {
        const sendMessage = async (ph, msg, o = {}) => {
          const r = await getProvider().sendText(ph, msg, {
            companyId: company_id,
            conversaId: conversa_id,
            whatsappInstanceId: whatsapp_instance_id || undefined,
            ...o,
            sendOrigin: o?.sendOrigin || o?.origin || 'chatbot_triage',
          })
          return { ok: !!r?.ok, messageId: r?.messageId || null }
        }
        let skipChatbot = false
        const chatbotHints = {}
        const ioAutomacao = req.app.get('io')
        const emitAutomacaoRealtime =
          ioAutomacao &&
          (async (mensagemRow) =>
            emitBotMensagemRealtime({
              io: ioAutomacao,
              supabase,
              company_id,
              conversa_id,
              mensagem: mensagemRow,
            }))

        // Opt-out (complementar): PARAR, SAIR, DESCADASTRAR — antes do chatbot
        if (isEnabled(FLAGS.FEATURE_OPT_OUT_WEBHOOK)) {
          const optResult = await processarOptOut({
            supabase,
            company_id,
            cliente_id: cliente_id || null,
            telefone: phoneParaChatbot,
            texto: texto || '',
          })
          if (optResult.isOptOut && optResult.mensagemConfirmacao) {
            const optSendResult = await sendMessage(phoneParaChatbot, optResult.mensagemConfirmacao, { sendOrigin: 'opt_out_confirmacao' })
            const optMessageId = optSendResult?.messageId ? String(optSendResult.messageId).trim() : null
            const optTraceable = isTraceableWhatsappMessageId(optMessageId)
            const optQueueId = !!optMessageId && isUltramsgNumericQueueId(optMessageId)
            const { data: optMensagemRow, error: optMensagemError } = await supabase.from('mensagens').insert({
              conversa_id,
              texto: optResult.mensagemConfirmacao,
              direcao: 'out',
              company_id,
              status: optSendResult?.ok ? (optTraceable ? 'sent' : 'pending') : 'erro',
              status_mensagem: optSendResult?.ok ? (optTraceable ? 'sent' : 'sending') : 'failed',
              ...(optTraceable ? { whatsapp_id: optMessageId } : {}),
              ...(optQueueId ? { provider_queue_id: optMessageId } : {}),
              ...(whatsapp_instance_id ? { whatsapp_instance_id } : {}),
            }).select('*').single()
            if (optMensagemError) {
              console.warn('[optOut] erro ao salvar confirmacao enviada:', optMensagemError.message || optMensagemError)
            } else if (optMensagemRow && emitAutomacaoRealtime) {
              await emitAutomacaoRealtime(optMensagemRow).catch((e) => {
                console.warn('[optOut] erro ao emitir confirmacao enviada:', e?.message || e)
              })
            }
            skipChatbot = true
          }
        }

        // Regras automáticas (complementar): palavra-chave → resposta — antes do chatbot
        if (!skipChatbot && isEnabled(FLAGS.FEATURE_REGRA_AUTO_WEBHOOK)) {
          const regrasResult = await processarRegras({
            supabase,
            company_id,
            conversa_id,
            texto: texto || '',
            telefone: phoneParaChatbot,
            whatsapp_instance_id,
            sendMessage,
            emitMensagemRealtime: emitAutomacaoRealtime || null,
          })
          if (regrasResult.matched) skipChatbot = true
        }

        // Chatbot só envia quando o CLIENTE iniciou a conversa. Se o usuário/atendente enviou a 1ª msg, não enviar nada.
        // Exceção 1: conversaReabertaAposFinalizacao — cliente enviou msg após finalização, tratar como novo contato.
        // Exceção 2: bot já estava ativo (menu_enviado em bot_logs) — mesmo que a msg do cliente não tenha sido
        //            salva corretamente, o bot deve continuar processando as respostas do menu.
        const { absence: cfgAbs } = await loadChatbotTriageMergeAndAbsence(company_id)
        if (reopenedFromAbsence && cfgAbs.reabrirSemChatbot) {
          skipChatbot = true
          await logBotAction(company_id, conversa_id, 'chatbot_bypass_retorno_ausencia', {
            reason: 'reopened_from_absence',
          })
        }
        if (!skipChatbot && !conversaReabertaAposFinalizacao) {
          // Prioridade: verificar se o chatbot já estava ativo para esta conversa via bot_logs.
          // Isso evita o bug onde a mensagem inicial do cliente falha ao salvar mas a resposta
          // do bot é salva, fazendo a primeira msg parecer 'out' e silenciando o chatbot.
          const { data: botLogAtivo } = await supabase
            .from('bot_logs')
            .select('id, tipo')
            .eq('conversa_id', conversa_id)
            .eq('company_id', company_id)
            .in('tipo', ['menu_enviado', 'menu_reenviado', 'opcao_invalida', 'opcao_valida'])
            .limit(1)
            .maybeSingle()

          if (botLogAtivo) {
            // Bot já estava ativo — sempre processar (cliente está respondendo ao menu do bot)
            chatbotHints.menuAlreadySent = true
            console.log('[Z-API] 🤖 Chatbot: conversa com bot ativo (bot_logs) — processando resposta', {
              conversa_id, tipo: botLogAtivo.tipo
            })
          } else {
            // Bot não esteve ativo ainda — verificar se foi o operador quem iniciou a conversa
            const { data: mensagensAnteriores } = await supabase
              .from('mensagens')
              .select('direcao, texto')
              .eq('conversa_id', conversa_id)
              .eq('company_id', company_id)
              .order('criado_em', { ascending: true })
              .limit(25)

            console.log('[Z-API] 🤖 Chatbot: verificando histórico (sem bot_logs)', {
              conversa_id,
              totalMensagens: mensagensAnteriores?.length || 0,
              primeiraMensagem: mensagensAnteriores?.[0]
                ? { direcao: mensagensAnteriores[0].direcao, texto: String(mensagensAnteriores[0].texto || '').slice(0, 30) }
                : null
            })

            if (!mensagensAnteriores || mensagensAnteriores.length === 0) {
              chatbotHints.menuAlreadySent = false
              chatbotHints.isPrimeiraMensagemCliente = true
              console.log('[Z-API] 🤖 Chatbot: primeira mensagem do cliente — permitindo chatbot', { conversa_id })
            } else {
              const primeiraMsg = mensagensAnteriores[0]
              if (primeiraMsg?.direcao === 'out') {
                skipChatbot = true
                chatbotHints.menuAlreadySent = false
                chatbotHints.isPrimeiraMensagemCliente = false
                console.log('[Z-API] 🤖 Chatbot: ignorado — operador iniciou a conversa (1ª msg foi direcao out)', {
                  conversa_id, primeiraMsg: String(primeiraMsg.texto || '').slice(0, 30)
                })
              } else {
                // Cliente falou primeiro, mas já pode existir resposta do bot (menu) — ex.: [in, out, in atual]
                const temRespostaBot = mensagensAnteriores.some((m) => m.direcao === 'out')
                if (temRespostaBot) {
                  chatbotHints.menuAlreadySent = true
                  chatbotHints.isPrimeiraMensagemCliente = false
                  console.log('[Z-API] 🤖 Chatbot: histórico já tem msg do bot — cliente respondendo ao menu', {
                    conversa_id,
                  })
                } else {
                  chatbotHints.menuAlreadySent = false
                  chatbotHints.isPrimeiraMensagemCliente = true
                  console.log('[Z-API] 🤖 Chatbot: cliente iniciou a conversa — permitindo chatbot', {
                    conversa_id, totalMensagensCliente: mensagensAnteriores.filter(m => m.direcao === 'in').length
                  })
                }
              }
            }
          }
        }

        if (!skipChatbot) {
          console.log('[Z-API] 🤖 Chatbot: processando mensagem', { company_id, conversa_id, phoneTail: String(phoneParaChatbot).slice(-8) })
          const ioChatbot = req.app.get('io')
          const emitChatbotRealtime =
            ioChatbot &&
            (async (mensagemRow) =>
              emitBotMensagemRealtime({
                io: ioChatbot,
                supabase,
                company_id,
                conversa_id,
                mensagem: mensagemRow,
              }))
          const result = await processChatbotTriage({
            company_id,
            conversa_id,
            telefone: phoneParaChatbot,
            texto: texto || '',
            supabase,
            sendMessage,
            opts: {
              companyId: company_id,
              ...(whatsapp_instance_id
                ? { whatsappInstanceId: whatsapp_instance_id, whatsapp_instance_id }
                : {}),
            },
            conversaReabertaAposFinalizacao,
            hints: chatbotHints,
            emitChatbotRealtime,
            mensagemClienteCriadoEm: criado_em || null,
          })
          if (result?.handled && result?.departamento_id != null) {
            departamento_id = result.departamento_id
            console.log('[Z-API] 🤖 Chatbot: conversa direcionada para departamento', departamento_id)
          }
        }
      } catch (errChatbot) {
        console.warn('[Z-API] Chatbot triagem:', errChatbot?.message || errChatbot)
      }
    }

    // 3) Salvar mensagem. TUDO que a Z-API envia (recebido, !fromMe) é gravado; sem messageId grava com whatsapp_id null.
    // Mensagens enviadas por nós (fromMe): não inserir — evita eco/duplicata.
    const whatsappIdStr = messageId ? String(messageId).trim() : null
    let mensagemSalva = null
    /** true apenas quando inserimos nova mensagem; false quando idempotência ou reconciliação (CRM já emitiu nova_mensagem) */
    let mensagemFoiInseridaPeloWebhook = false

    // fromMe: também persiste (você pediu "todas as mensagens"). O índice único por (conversa_id, whatsapp_id)
    // evita duplicatas quando o provider reenviar o mesmo evento.

    // Não gravar evento que virou só "(mídia)" sem mídia real — exceto fromMe (espelhamento: mensagem enviada pelo celular deve aparecer)
    const nowIso = new Date().toISOString()
    const soPlaceholderMidia = texto === '(mídia)' && !imageUrl && !documentUrl && !audioUrl && !videoUrl && !stickerUrl && !locationUrl
    if (soPlaceholderMidia && !fromMe) {
      await supabase
        .from('conversas')
        .update({ ultima_atividade: nowIso })
        .eq('id', conversa_id)
        .eq('company_id', company_id)
      // IMPORTANTE: payload é 1 de N num lote (ver getPayloads) — abortar a requisição aqui
      // descartaria as demais mensagens do lote. Pula só esta (nada para salvar) e segue.
      lastResult = { ok: true, conversa_id, skip: 'placeholderMidia' }
      continue
    }
    if (soPlaceholderMidia && fromMe) texto = '(mensagem)' // espelhamento: mostrar algo no chat

    // Histórico de nova conversa: agendado DEPOIS de persistir a mensagem atual + regra mensagem_disparada
    // (evita race: import antigo tornava outra linha a "primeira" e a conversa ficava aberta indevidamente).

    // Idempotencia: chave por instancia quando disponivel; legado fica restrito a whatsapp_instance_id null.
    if (whatsappIdStr) {
      let { data: existente } = await selectSingleMensagemByWhatsappId(supabase, {
        company_id,
        whatsapp_id: whatsappIdStr,
        whatsapp_instance_id,
        select: WEBHOOK_MSG_SELECT,
        context: 'received.idempotency',
      })
      
      // Se não encontrou por whatsapp_id e é mensagem enviada por nós, reconciliar com outbound do CRM
      if (!existente && fromMe) {
        const recentFromIso = new Date(Date.now() - 15 * 60 * 1000).toISOString()
        let tempExistente = await tryReconcileFromMeByCrmReferenceId(supabase, {
          company_id,
          conversa_id,
          whatsapp_instance_id,
          payload,
          whatsappIdStr,
          statusPayload: payload.status ?? payload.ack ?? null,
        })

        let tempNullWaQuery = supabase
          .from('mensagens')
          .select(WEBHOOK_MSG_SELECT)
          .eq('company_id', company_id)
          .eq('conversa_id', conversa_id)
          .eq('direcao', 'out')
          .gte('criado_em', recentFromIso)
          .order('criado_em', { ascending: false })
          .order('id', { ascending: false })
          .limit(15)
        tempNullWaQuery = applyWhatsappInstanceFilterOrLegacy(tempNullWaQuery, whatsapp_instance_id)
        const { data: tempExistenteRecentOut } = await tempNullWaQuery

        const nomeAtendenteFromMe = extrairNomePrefixoTexto(texto)
        if (!tempExistente) {
          tempExistente =
            findFromMeOutboundMediaCandidate(filterRowsForFromMeReconcile(tempExistenteRecentOut), {
              fileName,
              texto,
              tipo: mapWebhookTypeToStorageTipo(type),
              nomeAtendente: nomeAtendenteFromMe,
              whatsappId: whatsappIdStr,
            }) || null
        }

        // ACK pode ter preenchido whatsapp_id (sid) antes do message_create (id) — buscar por nome/tipo
        if (!tempExistente && mapWebhookTypeToStorageTipo(type)) {
          let recentOutQuery = supabase
            .from('mensagens')
            .select(WEBHOOK_MSG_SELECT)
            .eq('company_id', company_id)
            .eq('conversa_id', conversa_id)
            .eq('direcao', 'out')
            .gte('criado_em', recentFromIso)
            .order('criado_em', { ascending: false })
            .order('id', { ascending: false })
            .limit(15)
          recentOutQuery = applyWhatsappInstanceFilterOrLegacy(recentOutQuery, whatsapp_instance_id)
          const { data: recentOut } = await recentOutQuery
          tempExistente =
            findFromMeOutboundMediaCandidate(filterRowsForFromMeReconcile(recentOut), {
              fileName,
              texto,
              tipo: mapWebhookTypeToStorageTipo(type),
              nomeAtendente: nomeAtendenteFromMe,
              whatsappId: whatsappIdStr,
            }) || null
        }

        if (tempExistente) {
          // Atualizar com o whatsapp_id real apenas quando a promoção é segura.
          // referenceId pode ter absorvido o eco sem overwrite — não reescrever o id canônico aqui.
          try {
            const updateFromMe = {}
            if (whatsappIdCompativelParaReconcile(tempExistente, whatsappIdStr)) {
              updateFromMe.whatsapp_id = whatsappIdStr
            }
            const ackStatus = normalizeRawAckStatus(payload?.status ?? payload?.ack)
            if (ackStatus && statusRank(ackStatus) >= statusRank(tempExistente.status || tempExistente.status_mensagem || 'pending')) {
              updateFromMe.status = ackStatus
              updateFromMe.status_mensagem = ackStatus
            }
            if ((audioUrl || imageUrl || documentUrl || videoUrl || stickerUrl) && !tempExistente.url) {
              if (imageUrl) { updateFromMe.url = imageUrl; updateFromMe.tipo = 'imagem' }
              else if (documentUrl) { updateFromMe.url = documentUrl; updateFromMe.tipo = 'arquivo' }
              else if (audioUrl) { updateFromMe.url = audioUrl; updateFromMe.tipo = tempExistente.tipo === 'voice' ? 'voice' : mapWebhookTypeToStorageTipo(type) }
              else if (videoUrl) { updateFromMe.url = videoUrl; updateFromMe.tipo = 'video' }
              else if (stickerUrl) { updateFromMe.url = stickerUrl; updateFromMe.tipo = 'sticker' }
            }
            if (Object.keys(updateFromMe).length === 0) {
              existente = tempExistente
            } else {
              const { data: updatedMsg } = await supabase
                .from('mensagens')
                .update(updateFromMe)
                .eq('company_id', company_id)
                .eq('id', tempExistente.id)
                .select(WEBHOOK_MSG_SELECT)
                .single()
              existente = updatedMsg || tempExistente
            }
          } catch (e) {
            console.warn('Erro ao atualizar whatsapp_id:', e.message)
            existente = tempExistente
          }
        }
      }
      
      if (existente) {
        // Se a mensagem salva tem texto placeholder (DeliveryCallback chegou antes do ReceivedCallback)
        // e o webhook atual traz conteúdo real → atualizar com o texto/mídia corretos.
        // Também: webhook_message_download_media pode chegar DEPOIS com URL da mídia — atualizar mensagem existente sem url.
        const savedTexto = String(existente.texto || '')
        const isPlaceholder = savedTexto === '(mensagem)' || savedTexto === '(mídia)'
        const textoReal = texto && texto !== '(mensagem)' && texto !== '(mídia)' ? texto : null
        const hasMediaToUpdate = (imageUrl || documentUrl || audioUrl || videoUrl || stickerUrl) && !String(existente.url || '').trim()
        const shouldUpdate = (isPlaceholder && textoReal) || hasMediaToUpdate
        if (shouldUpdate) {
          const upFields = {}
          if (textoReal && isPlaceholder) upFields.texto = textoReal
          if (imageUrl && !existente.url) { upFields.url = imageUrl; upFields.tipo = 'imagem' }
          else if (documentUrl && !existente.url) { upFields.url = documentUrl; upFields.tipo = 'arquivo' }
          else if (audioUrl && !existente.url) { upFields.url = audioUrl; upFields.tipo = (existente.tipo === 'voice' ? 'voice' : 'audio') }
          else if (videoUrl && !existente.url) { upFields.url = videoUrl; upFields.tipo = 'video' }
          else if (stickerUrl && !existente.url) { upFields.url = stickerUrl; upFields.tipo = 'sticker' }
          if (Object.keys(upFields).length > 0) {
            try {
              const { data: updMsg } = await supabase
                .from('mensagens')
                .update(upFields)
                .eq('id', existente.id)
                .select(WEBHOOK_MSG_SELECT)
                .single()
              mensagemSalva = updMsg || existente
              if (WHATSAPP_DEBUG || hasMediaToUpdate) console.log('[Z-API] idempotência: mensagem atualizada com mídia/placeholder', existente.id, Object.keys(upFields))
              // Emitir nova_mensagem para frontend atualizar player de áudio quando URL chega via webhook_message_download_media
              if (hasMediaToUpdate && req.app?.get('io')) {
                const io2 = req.app.get('io')
                const rooms = [`conversa_${conversa_id}`, `empresa_${company_id}`]
                const emitPayload = {
                  ...mensagemSalva,
                  criado_em: normalizarTimestampSemFusoAmbiguoParaApi(mensagemSalva.criado_em),
                  conversa_id: mensagemSalva.conversa_id ?? conversa_id,
                  status: mensagemSalva.status || 'delivered',
                  status_mensagem: mensagemSalva.status_mensagem || mensagemSalva.status || 'delivered',
                  fromMe,
                  direcao: mensagemSalva.direcao ?? (fromMe ? 'out' : 'in'),
                }
                io2.to(rooms).emit(io2.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', emitPayload)
                scheduleInboundWebPush(company_id, conversa_id, 'nova_mensagem', emitPayload)
              }
            } catch (_) {
              mensagemSalva = existente
            }
          } else {
            mensagemSalva = existente
          }
        } else {
          mensagemSalva = existente
        }
      }
    }

    // ─── Reply/citação: extraído ANTES da reconciliação para que ambos os caminhos usem ───
    // Z-API usa "referencedMessage.messageId" como campo principal; outros formatos são fallbacks.
    let webhookReplyMeta = null
    {
      const refMsg = payload?.referencedMessage ?? payload?.quotedMsg ?? payload?.quoted ?? null
      const quotedIdRaw =
        payload?.referenceMessageId ??          // campo oficial Z-API ReceivedCallback
        payload?.referencedMessage?.messageId ??
        payload?.referencedMessage?.id ??
        payload?.quotedMsgId ??
        payload?.quotedMessageId ??
        payload?.quotedStanzaId ??
        payload?.context?.messageId ??          // Z-API context (algumas versões)
        payload?.context?.id ??
        payload?.contextInfo?.stanzaId ??
        payload?.contextInfo?.quotedStanzaId ??
        payload?.contextInfo?.quotedMessageId ??
        refMsg?.id ??
        refMsg?.messageId ??
        payload?.message?.contextInfo?.stanzaId ??
        payload?.message?.contextInfo?.quotedStanzaId ??
        payload?.message?.context?.messageId ??
        payload?.message?.context?.id ??
        null
      const quotedId = quotedIdRaw ? String(quotedIdRaw).trim() : null

      const refBodyFallback =
        String(
          payload?.referencedMessage?.body ??
          payload?.referencedMessage?.text?.message ??
          payload?.referencedMessage?.caption ??
          refMsg?.message ??
          refMsg?.body ??
          refMsg?.text?.message ??
          ''
        ).trim().slice(0, 180) || null

      const refFromMe = payload?.referencedMessage?.fromMe ?? refMsg?.fromMe ?? null

      if (quotedId) {
        const replyTs = Date.now()
        try {
          let quotedQuery = supabase
            .from('mensagens')
            .select('texto, direcao, remetente_nome')
            .eq('company_id', company_id)
            .eq('conversa_id', conversa_id)
            .eq('whatsapp_id', quotedId)
          quotedQuery = applyWhatsappInstanceFilterOrLegacy(quotedQuery, whatsapp_instance_id)
          const { data: quoted } = await quotedQuery.maybeSingle()

          const snippet =
            String(quoted?.texto || '').trim().slice(0, 180) ||
            refBodyFallback ||
            'Mensagem'

          let name
          if (quoted) {
            name = quoted.direcao === 'out' ? 'Você' : (String(quoted.remetente_nome || '').trim() || 'Contato')
          } else {
            name = (refFromMe === true) ? 'Você' : 'Contato'
          }
          webhookReplyMeta = { name, snippet, ts: replyTs, replyToId: quotedId }
        } catch (_) {
          webhookReplyMeta = { name: (refFromMe === true ? 'Você' : 'Mensagem'), snippet: refBodyFallback || 'Mensagem', ts: replyTs, replyToId: quotedId }
        }
      }
    }

    // ✅ Anti-duplicação profissional (envio pelo sistema + eco do webhook fromMe):
    // Quando enviamos pelo CRM, a mensagem é inserida com whatsapp_id = null.
    // Em seguida o Z-API pode disparar webhook fromMe com whatsapp_id real.
    // Para não duplicar, tentamos "reconciliar" atualizando a mensagem recente do CRM com o whatsapp_id.
    if (!mensagemSalva && fromMe && whatsappIdStr) {
      try {
        const statusPayload = (payload.status && String(payload.status).toLowerCase()) || null

        // referenceId crm-{id} enviado no POST UltraMSG — reconciliação mais confiável que texto
        if (!mensagemSalva) {
          mensagemSalva = await tryReconcileFromMeByCrmReferenceId(supabase, {
            company_id,
            conversa_id,
            whatsapp_instance_id,
            payload,
            whatsappIdStr,
          })
        }

        if (!mensagemSalva) {
        // assinatura da mídia para bater com a mensagem enviada pelo sistema
        const urlSig =
          (type === 'image' && imageUrl) ? imageUrl :
          ((type === 'document' || type === 'file') && documentUrl) ? documentUrl :
          (type === 'audio' && audioUrl) ? audioUrl :
          (type === 'video' && videoUrl) ? videoUrl :
          (type === 'sticker' && stickerUrl) ? stickerUrl :
          (type === 'location' && locationUrl) ? locationUrl :
          null

        const tsMs = Date.parse(criado_em)
        // Janela ampliada para 15 min: cobre delay de envio UltraMsg e diferenças de relógio entre servidores
        const windowMs = 15 * 60 * 1000
        const fromIso = Number.isFinite(tsMs) ? new Date(tsMs - windowMs).toISOString() : null
        const toIso = Number.isFinite(tsMs) ? new Date(tsMs + windowMs).toISOString() : null

        const buildQuery = (filterConversa) => {
          let q = supabase
            .from('mensagens')
            .select('id, criado_em, texto, url, nome_arquivo, tipo, whatsapp_id, reply_meta, conversa_id, autor_usuario_id')
            .eq('company_id', company_id)
            .eq('direcao', 'out')
            .order('criado_em', { ascending: false })
            .order('id', { ascending: false })
            .limit(15)
          if (filterConversa) q = q.eq('conversa_id', conversa_id)
          q = applyWhatsappInstanceFilterOrLegacy(q, whatsapp_instance_id)
          if (fromIso && toIso) q = q.gte('criado_em', fromIso).lte('criado_em', toIso)
          // URL do webhook (CDN) ≠ /uploads/ do CRM — não filtrar por url remota
          if (urlSig && !isRemoteMediaUrl(urlSig)) q = q.eq('url', urlSig)
          return q
        }

        const nomeAtendenteReconcile = extrairNomePrefixoTexto(texto)
        const findCand = (rows) =>
          findFromMeOutboundMediaCandidate(filterRowsForFromMeReconcile(rows), {
            fileName,
            texto,
            tipo: mapWebhookTypeToStorageTipo(type),
            nomeAtendente: nomeAtendenteReconcile,
            whatsappId: whatsappIdStr,
          })

        // Busca 1: na conversa específica resolvida pelo webhook
        const { data: candidates } = await buildQuery(true)
        let cand = findCand(candidates)

        // Busca 2 (fallback): na empresa inteira — cobre divergência de conversa_id entre
        // chatController (URL param) e webhook (findOrCreateConversation pode resolver diferente)
        if (!cand) {
          const { data: fallbackCandidates } = await buildQuery(false)
          cand = findCand(fallbackCandidates)
          if (cand && WHATSAPP_DEBUG) {
            console.log('[Z-API] fromMe reconcile fallback: encontrado fora da conversa', {
              cand_conversa: cand.conversa_id, webhook_conversa: conversa_id
            })
          }
        }

        if (!cand && WHATSAPP_DEBUG) {
          console.warn('[Z-API] fromMe reconcile: nenhum candidato encontrado', {
            conversa_id, texto: String(texto || '').slice(0, 30), fromIso, toIso
          })
        }

        if (cand?.id) {
          const updates = {}
          if (whatsappIdCompativelParaReconcile(cand, whatsappIdStr)) {
            updates.whatsapp_id = whatsappIdStr
          }
          const ackStatus = normalizeRawAckStatus(statusPayload ?? payload?.status ?? payload?.ack)
          if (ackStatus && statusRank(ackStatus) >= statusRank(cand.status || 'pending')) {
            updates.status = ackStatus
            updates.status_mensagem = ackStatus
          }
          if (webhookReplyMeta && !cand.reply_meta) updates.reply_meta = webhookReplyMeta

          if (Object.keys(updates).length === 0) {
            mensagemSalva = cand
          } else {
            const { data: patched, error: patchErr } = await supabase
              .from('mensagens')
              .update(updates)
              .eq('company_id', company_id)
              .eq('id', cand.id)
              .select(WEBHOOK_MSG_SELECT)
              .single()

            if (!patchErr && patched) {
              mensagemSalva = patched
            } else if (patchErr) {
              console.warn('⚠️ fromMe reconcile: falha ao atualizar candidato:', patchErr?.message)
            } else {
              mensagemSalva = cand
            }
          }
        }
        }

        if (mensagemSalva?.id && statusPayload) {
          const ackStatus = normalizeRawAckStatus(statusPayload)
          const cur = mensagemSalva.status || mensagemSalva.status_mensagem || 'pending'
          if (ackStatus && statusRank(ackStatus) >= statusRank(cur)) {
            const { data: statusPatched } = await supabase
              .from('mensagens')
              .update({ status: ackStatus, status_mensagem: ackStatus })
              .eq('company_id', company_id)
              .eq('id', mensagemSalva.id)
              .select(WEBHOOK_MSG_SELECT)
              .maybeSingle()
            if (statusPatched) mensagemSalva = statusPatched
          }
        }

        // Rollout R2 (empresa 1): mensagem outbound confirmada pelo webhook → espelha para o R2
        // agora (mesmo gatilho inline do inbound). Cobre envios que ficaram pending por ID de fila
        // e só chegam a status final aqui. No-op para outras empresas / R2 desligado / tipo não-mídia.
        if (mensagemSalva?.id && String(mensagemSalva.direcao || '') === 'out') {
          try {
            const { scheduleR2MirrorIfNeeded } = require('../services/mediaR2MirrorService')
            scheduleR2MirrorIfNeeded({ supabase, io: req.app.get('io'), company_id, mensagem_id: mensagemSalva.id })
          } catch (_) { /* best-effort; nunca afeta o webhook */ }
        }
      } catch (e) {
        console.warn('⚠️ fromMe reconcile: erro ao reconciliar:', e?.message || e)
      }
    }

    // isEdit: mensagem editada → atualizar texto da mensagem existente, não inserir nova
    if (!mensagemSalva && isEdit && whatsappIdStr) {
      try {
        const { data: editTarget } = await updateSingleMensagemByWhatsappId(supabase, {
          company_id,
          whatsapp_id: whatsappIdStr,
          whatsapp_instance_id,
          updates: { texto },
          select: WEBHOOK_MSG_SELECT,
          context: 'received.isEdit',
        })
        if (editTarget) {
          mensagemSalva = editTarget
          console.log(`✏️ Z-API isEdit: mensagem ${editTarget.id} atualizada (conversa ${conversa_id})`)
          const io = req.app.get('io')
          if (io) {
            io.to(`conversa_${conversa_id}`).to(`empresa_${company_id}`).emit('mensagem_editada', {
              id: editTarget.id,
              conversa_id,
              texto,
            })
          }
        }
      } catch (editErr) {
        console.warn('[Z-API] isEdit: erro ao atualizar mensagem:', editErr?.message)
      }
    }

    if (!mensagemSalva) {
      // waitingMessage: status inicial 'pending' enquanto a mensagem está em fila de envio
      const statusPayload = waitingMessage
        ? 'pending'
        : ((payload.status && String(payload.status).toLowerCase()) || null)
      const reply_meta = webhookReplyMeta || null

      const insertMsg = {
        conversa_id,
        texto,
        direcao: fromMe ? 'out' : 'in',
        company_id,
        ...(whatsapp_instance_id ? { whatsapp_instance_id } : {}),
        whatsapp_id: whatsappIdStr || null,
        criado_em,
        ...(statusPayload ? { status: statusPayload } : {})
      }
      if (reply_meta) insertMsg.reply_meta = reply_meta
      if (isGroup && !fromMe) {
        // Grupo: salvar SEMPRE no grupo, e armazenar remetente (membro) na mensagem.
        const pNorm = participantPhone ? (normalizePhoneBR(participantPhone) || String(participantPhone).replace(/\D/g, '')) : ''
        if (pNorm) insertMsg.remetente_telefone = pNorm

        // Tenta resolver nome do membro pelo cadastro de clientes (contatos já sincronizados).
        let remetenteNomeFinal = senderName || pNorm || null
        if (pNorm) {
          try {
            const pPhones = possiblePhonesBR(pNorm)
            let qM = supabase.from('clientes').select('id, nome, pushname, telefone').order('id', { ascending: true }).limit(3)
            if (pPhones.length > 0) qM = qM.in('telefone', pPhones)
            else qM = qM.eq('telefone', pNorm)
            qM = qM.eq('company_id', company_id)
            const { data: rowsM } = await qM
            const ex = Array.isArray(rowsM) && rowsM.length > 0 ? rowsM[0] : null
            if (ex) {
              remetenteNomeFinal = getDisplayName(ex) || remetenteNomeFinal
            } else {
              // se não existe no banco, usa getOrCreateCliente para evitar duplicata (mesmo contato 12 vs 13 dígitos)
              if (pNorm) {
                const nomeMin = senderName ? String(senderName).trim() : pNorm
                const { cliente_id: cidGrupo } = await getOrCreateCliente(supabase, company_id, pNorm, {
                  nome: nomeMin,
                  nomeSource: 'grupo_sender',
                  pushname: senderName ? String(senderName).trim() : undefined,
                })
                if (cidGrupo) {
                  // sync em background (nome/foto reais) — chooseBestName evita regressão
                  setImmediate(async () => {
                    try {
                      const { data: current } = await supabase.from('clientes').select('nome, pushname, foto_perfil').eq('id', cidGrupo).maybeSingle()
                      const sync = await syncUltraMsgContact(pNorm, company_id, { skipPersistence: true }).catch(() => null)
                      if (!sync) return
                      const up = {}
                      const telefoneTail = String(pNorm).replace(/\D/g, '').slice(-6) || null
                      const { name: bestNome } = chooseBestName(current?.nome, sync.nome, 'syncUltramsg', { fromMe: false, company_id, telefoneTail })
                      if (bestNome && bestNome !== (current?.nome || '')) up.nome = bestNome
                      if (!current?.pushname && sync.pushname) up.pushname = sync.pushname
                      if (!current?.foto_perfil && sync.foto_perfil) up.foto_perfil = sync.foto_perfil
                      if (Object.keys(up).length > 0) await supabase.from('clientes').update(up).eq('id', cidGrupo)
                    } catch (_) {}
                  })
                }
              }
            }
          } catch (_) {}
        }
        if (remetenteNomeFinal) insertMsg.remetente_nome = String(remetenteNomeFinal).trim()
      }
      if (type === 'image' && imageUrl) {
        insertMsg.tipo = 'imagem'
        insertMsg.url = imageUrl
        insertMsg.nome_arquivo = fileName || 'imagem.jpg'
      } else if ((type === 'document' || type === 'file') && documentUrl) {
        insertMsg.tipo = 'arquivo'
        insertMsg.url = documentUrl
        insertMsg.nome_arquivo = fileName || 'arquivo'
      } else if (type === 'audio' || type === 'ptt') {
        insertMsg.tipo = type === 'ptt' ? 'voice' : 'audio'
        if (audioUrl) {
          insertMsg.url = audioUrl
          insertMsg.nome_arquivo = fileName || (type === 'ptt' ? 'voice.ogg' : 'audio')
        } else {
          console.warn('[webhook] áudio inbound sem URL de mídia:', {
            company_id,
            conversa_id,
            whatsapp_id: whatsappIdStr || null,
            whatsapp_instance_id: whatsapp_instance_id || null,
            type,
            fromMe,
            fileName: fileName || null,
            hasImageUrl: !!imageUrl,
            hasDocumentUrl: !!documentUrl,
            hasVideoUrl: !!videoUrl,
            hasStickerUrl: !!stickerUrl,
          })
        }
      } else if (type === 'video' && videoUrl) {
        insertMsg.tipo = 'video'
        insertMsg.url = videoUrl
        insertMsg.nome_arquivo = fileName || 'video'
      } else if (type === 'sticker' && stickerUrl) {
        insertMsg.tipo = 'sticker'
        insertMsg.url = stickerUrl
        insertMsg.nome_arquivo = fileName || 'sticker.webp'
      } else if (type === 'location') {
        insertMsg.tipo = 'location'
        if (locationUrl) insertMsg.url = locationUrl
        insertMsg.nome_arquivo = 'localização'
        if (locationMeta && (locationMeta.latitude != null || locationMeta.longitude != null)) {
          insertMsg.location_meta = locationMeta
        }
      } else if (type === 'contact') {
        insertMsg.tipo = 'contact'
        if (contactMeta && (contactMeta.nome || contactMeta.telefone)) {
          insertMsg.contact_meta = contactMeta
        }
      } else if (type === 'reaction') {
        insertMsg.tipo = 'reaction'
      }
      // Demais tipos: já têm texto preenchido; tipo padrão é texto

      let { data: inserted, error: errMsg } = await supabase
        .from('mensagens')
        .insert(insertMsg)
        .select(WEBHOOK_MSG_SELECT)
        .single()

      // Compatibilidade: se a coluna reply_meta não existir ainda, remove e tenta de novo
      if (errMsg && (String(errMsg.message || '').includes('reply_meta') || String(errMsg.message || '').includes('does not exist'))) {
        delete insertMsg.reply_meta
        const retryReply = await supabase.from('mensagens').insert(insertMsg).select(WEBHOOK_MSG_SELECT).single()
        inserted = retryReply.data
        errMsg = retryReply.error
      }

      if (errMsg && (String(errMsg.message || '').includes('remetente_nome') || String(errMsg.message || '').includes('remetente_telefone') || String(errMsg.message || '').includes('does not exist'))) {
        delete insertMsg.remetente_nome
        delete insertMsg.remetente_telefone
        const retry = await supabase.from('mensagens').insert(insertMsg).select(WEBHOOK_MSG_SELECT).single()
        inserted = retry.data
        errMsg = retry.error
      }
      if (errMsg && (String(errMsg.message || '').includes('contact_meta') || String(errMsg.message || '').includes('location_meta') || String(errMsg.message || '').includes('does not exist'))) {
        delete insertMsg.contact_meta
        delete insertMsg.location_meta
        const retryMeta = await supabase.from('mensagens').insert(insertMsg).select(WEBHOOK_MSG_SELECT).single()
        inserted = retryMeta.data
        errMsg = retryMeta.error
      }
      if (errMsg) {
        if (String(errMsg.code || '') === '23505' || String(errMsg.message || '').includes('duplicate') || String(errMsg.message || '').includes('unique')) {
          const { data: existente } = await selectSingleMensagemByWhatsappId(supabase, {
            company_id,
            whatsapp_id: whatsappIdStr,
            whatsapp_instance_id,
            select: WEBHOOK_MSG_SELECT,
            context: 'received.insert.duplicate',
          })
          // Corrida: outro processo inseriu primeiro (sem URL) e este webhook traz mídia https —
          // sem merge, a linha fica sem url até expirar o link remoto. Mescla só mídia persistível.
          let mergedDup = existente
          const insUrl = String(insertMsg.url || '').trim()
          const exUrl = String(existente?.url || '').trim()
          if (
            existente?.id &&
            insUrl.startsWith('https://') &&
            !exUrl &&
            insertMsg.tipo &&
            tipoQualificaPersistencia(insertMsg.tipo)
          ) {
            try {
              const upDup = {
                url: insUrl,
                tipo: insertMsg.tipo || existente.tipo,
              }
              if (insertMsg.nome_arquivo) upDup.nome_arquivo = insertMsg.nome_arquivo
              if (insertMsg.location_meta && typeof insertMsg.location_meta === 'object') {
                upDup.location_meta = insertMsg.location_meta
              }
              if (insertMsg.contact_meta && typeof insertMsg.contact_meta === 'object') {
                upDup.contact_meta = insertMsg.contact_meta
              }
              const { data: patchedDup, error: patchDupErr } = await supabase
                .from('mensagens')
                .update(upDup)
                .eq('id', existente.id)
                .eq('company_id', company_id)
                .select(WEBHOOK_MSG_SELECT)
                .single()
              if (!patchDupErr && patchedDup) {
                mergedDup = patchedDup
                if (req.app?.get('io')) {
                  const io2 = req.app.get('io')
                  const rooms = [`conversa_${conversa_id}`, `empresa_${company_id}`]
                  const emitPayload = {
                    ...patchedDup,
                    criado_em: normalizarTimestampSemFusoAmbiguoParaApi(patchedDup.criado_em),
                    conversa_id: patchedDup.conversa_id ?? conversa_id,
                    status: patchedDup.status || 'delivered',
                    status_mensagem: patchedDup.status_mensagem || patchedDup.status || 'delivered',
                    fromMe,
                    direcao: patchedDup.direcao ?? (fromMe ? 'out' : 'in'),
                  }
                  io2.to(rooms).emit(io2.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', emitPayload)
                  scheduleInboundWebPush(company_id, conversa_id, 'nova_mensagem', emitPayload)
                }
              }
            } catch (e) {
              console.warn('[webhook] duplicate+media merge:', e?.message || e)
            }
          }
          mensagemSalva = mergedDup
        } else {
          // Fallback: qualquer mensagem que chega TEM que ficar no sistema — tenta inserir com payload mínimo
          console.warn('⚠️ ULTRAMSG fallback insert após erro:', errMsg.message)
          let fallbackPayload = {
            conversa_id,
            texto: texto || '(mensagem)',
            direcao: fromMe ? 'out' : 'in',
            company_id,
            whatsapp_id: whatsappIdStr || null,
            criado_em
          }
          // Nunca remover tipo/url/caminho da mídia já resolvidos no insertMsg.
          preserveMediaFieldsOnWebhookFallback(fallbackPayload, insertMsg)
          if (isGroup && senderName) fallbackPayload.remetente_nome = senderName
          if (isGroup && participantPhone) fallbackPayload.remetente_telefone = participantPhone
          let fallback = await supabase.from('mensagens').insert(fallbackPayload).select(WEBHOOK_MSG_SELECT).single()
          if (fallback.error && (String(fallback.error.message || '').includes('remetente_nome') || String(fallback.error.message || '').includes('remetente_telefone'))) {
            delete fallbackPayload.remetente_nome
            delete fallbackPayload.remetente_telefone
            fallback = await supabase.from('mensagens').insert(fallbackPayload).select(WEBHOOK_MSG_SELECT).single()
          }
          if (!fallback.error) {
            mensagemSalva = fallback.data
            mensagemFoiInseridaPeloWebhook = true
            console.log('✅ Mensagem salva (fallback):', mensagemSalva.id)
          } else {
            console.error('❌ ULTRAMSG Erro ao salvar mensagem:', errMsg?.code, errMsg?.message, errMsg?.details)
            // IMPORTANTE: payload é 1 de N num lote (ver getPayloads) — abortar a requisição aqui
            // descartaria as demais mensagens do lote. Pula só esta e segue para a próxima.
            lastResult = { ok: false, error: 'Erro ao salvar mensagem' }
            continue
          }
        }
      } else {
        mensagemSalva = inserted
        mensagemFoiInseridaPeloWebhook = true
      }
    }

    if (mensagemSalva) {
      // Mídia remota (UltraMSG/S3): copiar para /uploads em background para não depender de URL com TTL curto.
      const mPersist = mensagemSalva
      if (
        mPersist?.id &&
        mPersist?.url &&
        String(mPersist.url).startsWith('https://') &&
        tipoQualificaPersistencia(mPersist.tipo)
      ) {
        schedulePersistInboundMediaIfNeeded({
          supabase,
          io: req.app.get('io'),
          company_id,
          mensagem_id: mPersist.id,
          fromMe,
          departamento_id,
        })
      }

      // Repara URL ausente: quando o webhook entrega áudio/imagem sem media URL,
      // busca via GET /chats/messages (mesma fonte do "Carregar mensagens antigas").
      scheduleInboundMediaBackfill({
        supabase,
        io: req.app.get('io'),
        company_id,
        conversa_id: mPersist?.conversa_id ?? conversa_id,
        mensagemSalva: mPersist,
      })

      // Usar conversa_id da mensagem quando idempotência retornou existente de outra conversa
      const convIdForUpdate = mensagemSalva.conversa_id ?? conversa_id
      const nowIsoUpdate = new Date().toISOString()
      const { error: errUpdate } = await supabase
        .from('conversas')
        .update({ ultima_atividade: nowIsoUpdate })
        .eq('id', convIdForUpdate)
        .eq('company_id', company_id)
      if (errUpdate && (String(errUpdate.message || '').includes('ultima_atividade') || String(errUpdate.code || '') === 'PGRST204')) {
        console.warn('⚠️ Atualização ultima_atividade ignorada (coluna ausente). Execute RUN_IN_SUPABASE.sql no Supabase.')
      }

      // CRM: atualiza último contato do cliente (apenas conversas individuais)
      try {
        if (!isGroup) {
          const { data: convRow } = await supabase
            .from('conversas')
            .select('cliente_id, tipo, telefone')
            .eq('company_id', company_id)
            .eq('id', convIdForUpdate)
            .maybeSingle()
          const convIsGroup = String(convRow?.tipo || '').toLowerCase() === 'grupo' || String(convRow?.telefone || '').includes('@g.us')
          if (!convIsGroup && convRow?.cliente_id != null) {
            await supabase
              .from('clientes')
              .update({ ultimo_contato: mensagemSalva.criado_em || nowIsoUpdate, atualizado_em: nowIsoUpdate })
              .eq('company_id', company_id)
              .eq('id', Number(convRow.cliente_id))
          }
        }
      } catch (_) {}

      // Cliente respondeu: sair de mensagem_disparada → aberta (após persistir a inbound; não altera se insert falhou antes).
      if (!fromMe && separarMensagensDisparadasEmpresa && !isGroup) {
        try {
          await supabase
            .from('conversas')
            .update({
              status_atendimento: 'aberta',
              departamento_id: null,
              atendente_id: null,
              atendente_atribuido_em: null,
            })
            .eq('id', convIdForUpdate)
            .eq('company_id', company_id)
            .eq('status_atendimento', 'mensagem_disparada')
        } catch (e) {
          console.warn('[webhook] mensagem_disparada→aberta (resposta cliente):', e?.message || e)
        }
      }

      // Opcional por empresa: outbound sem autor (WhatsApp/celular). mensagem_disparada se for a 1ª msg da conversa.
      // Não exige mensagemFoiInseridaPeloWebhook: reconciliação (eco CRM → mesmo id) ainda pode ser a única linha válida.
      if (
        separarMensagensDisparadasEmpresa &&
        fromMe &&
        !isGroup &&
        mensagemSalva.autor_usuario_id == null
      ) {
        try {
          const ehPrimeiraDisparoExterno = await mensagemInseridaEhPrimeiraDisparoWhatsappExterno(
            supabase,
            company_id,
            convIdForUpdate,
            mensagemSalva.id
          )
          if (ehPrimeiraDisparoExterno) {
            const temInboundHistorico = await conversaTemAlgumaMensagemInbound(
              supabase,
              company_id,
              convIdForUpdate
            )
            if (temInboundHistorico) {
              // Já há fala do cliente no histórico: não tratar como disparo isolado (import/sync ou estado inconsistente).
            } else {
            const { data: convSt } = await supabase
              .from('conversas')
              .select('status_atendimento, atendente_id')
              .eq('id', convIdForUpdate)
              .eq('company_id', company_id)
              .maybeSingle()
            const st = String(convSt?.status_atendimento || '')
            const aid = convSt?.atendente_id
            const semAtendente = aid == null || aid === ''
            if (!semAtendente) {
              // assumida — não reclassificar
            } else if (st === 'em_atendimento' || st === 'aguardando_cliente') {
              // já em atendimento humano / aguardando cliente
            } else if (st === 'aberta' || st === 'mensagem_disparada' || st === 'fechada' || st === 'finalizada') {
              await supabase
                .from('conversas')
                .update({
                  status_atendimento: 'mensagem_disparada',
                  departamento_id: null,
                  atendente_id: null,
                  atendente_atribuido_em: null,
                })
                .eq('id', convIdForUpdate)
                .eq('company_id', company_id)
                .in('status_atendimento', ['aberta', 'mensagem_disparada', 'fechada', 'finalizada'])
                .is('atendente_id', null)
            }
            }
          }
        } catch (e) {
          console.warn('[webhook] separar_mensagens_disparadas:', e?.message || e)
        }
      }

      console.log('✅ Mensagem salva no sistema:', { conversa_id, mensagem_id: mensagemSalva.id, phone: phone?.slice(-6), direcao: fromMe ? 'out' : 'in' })
      if (fromMe) console.log('📤 Espelhamento: mensagem enviada pelo celular registrada no sistema')
      logZapiCert({
        companyId: company_id,
        instanceId,
        type: payload?.type ?? payload?.event ?? 'receivedcallback',
        fromMe,
        hasDest: hasDestFields(payload),
        phoneTail: phone?.slice(-6) || null,
        connectedTail: (payload?.connectedPhone ?? '').toString().replace(/\D/g, '').slice(-6) || null,
        messageId: mensagemSalva?.whatsapp_id ? String(mensagemSalva.whatsapp_id) : null,
        resolvedKeyType: debugReason ?? null,
        conversaId: conversa_id ?? mensagemSalva?.conversa_id,
        action: 'inserted_message'
      })

      // Histórico do celular: nova conversa — importar após a mensagem atual (evita quebrar "primeira mensagem" / mensagem_disparada).
      if (isNewConversation) {
        const provider = getProvider()
        if (provider && provider.getChatMessages && provider.isConfigured) {
          const convIdForHistory = conversa_id
          const phoneForHistory = phone
          const isGroupForHistory = isGroup
          setImmediate(async () => {
            try {
              const history = await provider.getChatMessages(phoneForHistory, 25, null, { companyId: company_id, whatsappInstanceId: whatsapp_instance_id || undefined }).catch(() => [])
              if (!Array.isArray(history) || history.length === 0) return

              const ordered = history
                .map((m) => m)
                .sort((a, b) => Number(a?.momment || a?.timestamp || 0) - Number(b?.momment || b?.timestamp || 0))

              for (const m of ordered) {
                const p = { ...(m || {}), isGroup: isGroupForHistory, phone: phoneForHistory }
                const ex = extractMessage(p)
                const wId = ex.messageId ? String(ex.messageId).trim() : null
                if (!ex.texto) continue
                const placeholder = ex.texto === '(mídia)' && !ex.imageUrl && !ex.documentUrl && !ex.audioUrl && !ex.videoUrl && !ex.stickerUrl && !ex.locationUrl
                if (placeholder) continue
                if (!wId) continue

                const direcaoHistory = ex.fromMe ? 'out' : 'in'
                const insertMsg = {
                  conversa_id: convIdForHistory,
                  texto: ex.texto,
                  direcao: direcaoHistory,
                  company_id,
                  ...(whatsapp_instance_id ? { whatsapp_instance_id } : {}),
                  whatsapp_id: wId,
                  criado_em: ex.criado_em
                }

                if (ex.fromMe) {
                  let existOutQuery = supabase
                    .from('mensagens')
                    .select('id, criado_em, whatsapp_id')
                    .eq('company_id', company_id)
                    .eq('conversa_id', convIdForHistory)
                    .eq('direcao', 'out')
                    .eq('texto', ex.texto)
                    .order('id', { ascending: false })
                    .limit(1)
                  existOutQuery = applyWhatsappInstanceFilterOrLegacy(existOutQuery, whatsapp_instance_id)
                  const { data: existOut } = await existOutQuery.maybeSingle()
                  if (existOut && !existOut.whatsapp_id) {
                    const updatePayload = { whatsapp_id: wId }
                    const yearExist = existOut.criado_em ? new Date(existOut.criado_em).getFullYear() : 0
                    const yearNew = ex.criado_em ? new Date(ex.criado_em).getFullYear() : 0
                    if (yearExist < 2020 && yearNew >= 2020) updatePayload.criado_em = ex.criado_em
                    await supabase.from('mensagens').update(updatePayload).eq('company_id', company_id).eq('id', existOut.id)
                    continue
                  }
                }

                if (isGroupForHistory && !ex.fromMe) {
                  if (ex.senderName) insertMsg.remetente_nome = ex.senderName
                  if (ex.participantPhone) insertMsg.remetente_telefone = ex.participantPhone
                }

                if (ex.type === 'image' && ex.imageUrl) {
                  insertMsg.tipo = 'imagem'
                  insertMsg.url = ex.imageUrl
                  insertMsg.nome_arquivo = ex.fileName || 'imagem.jpg'
                } else if ((ex.type === 'document' || ex.type === 'file') && ex.documentUrl) {
                  insertMsg.tipo = 'arquivo'
                  insertMsg.url = ex.documentUrl
                  insertMsg.nome_arquivo = ex.fileName || 'arquivo'
                } else if (ex.type === 'audio' && ex.audioUrl) {
                  insertMsg.tipo = 'audio'
                  insertMsg.url = ex.audioUrl
                  insertMsg.nome_arquivo = ex.fileName || 'audio'
                } else if (ex.type === 'video' && ex.videoUrl) {
                  insertMsg.tipo = 'video'
                  insertMsg.url = ex.videoUrl
                  insertMsg.nome_arquivo = ex.fileName || 'video'
                } else if (ex.type === 'sticker' && ex.stickerUrl) {
                  insertMsg.tipo = 'sticker'
                  insertMsg.url = ex.stickerUrl
                  insertMsg.nome_arquivo = ex.fileName || 'sticker.webp'
                } else if (ex.type === 'location') {
                  insertMsg.tipo = 'location'
                  if (ex.locationUrl) insertMsg.url = ex.locationUrl
                  insertMsg.nome_arquivo = 'localização'
                  if (ex.locationMeta && (ex.locationMeta.latitude != null || ex.locationMeta.longitude != null)) {
                    insertMsg.location_meta = ex.locationMeta
                  }
                }

                const { data: histRow, error: histErr } = await supabase
                  .from('mensagens')
                  .insert(insertMsg)
                  .select(WEBHOOK_MSG_SELECT)
                  .single()
                if (histErr && String(histErr.code || '') !== '23505') {
                  console.warn('⚠️ Histórico Z-API: falha ao inserir msg:', String(histErr.message || '').slice(0, 120))
                } else if (!histErr && histRow?.id && histRow.url && String(histRow.url).startsWith('https://') && tipoQualificaPersistencia(histRow.tipo)) {
                  schedulePersistInboundMediaIfNeeded({
                    supabase,
                    io: req.app.get('io'),
                    company_id,
                    mensagem_id: histRow.id,
                    fromMe: !!ex.fromMe,
                    departamento_id: null,
                  })
                }
              }
            } catch (e) {
              console.warn('⚠️ Histórico Z-API: erro ao importar:', e?.message || e)
            }
          })
        }
      }
    }

    // Mensagem de entrada: incrementa unread no banco para todos os usuários (igual WhatsApp; refetch da lista já vem com contador certo)
    const convIdForEmit = mensagemSalva?.conversa_id ?? conversa_id
    if (!fromMe) {
      await incrementarUnreadParaConversa(company_id, convIdForEmit)
    }

    // 4) Realtime: nova_mensagem + atualizar_conversa + conversa_atualizada (igual WhatsApp Web)
    // IMPORTANTE: só emite nova_mensagem quando a mensagem foi INSERIDA pelo webhook.
    // Quando idempotência ou reconciliação (msg enviada pelo CRM), o chatController já emitiu — evita duplicata.
    const io = req.app.get('io')
    if (io && mensagemSalva) {
      // Status canônico para os ticks no frontend (sent, delivered, read, pending, erro, played)
      const canon = canonStatusForEmit(mensagemSalva.status_mensagem ?? mensagemSalva.status ?? (fromMe ? 'sent' : 'delivered'))
      const emitPayload = {
        ...mensagemSalva,
        criado_em: normalizarTimestampSemFusoAmbiguoParaApi(mensagemSalva.criado_em),
        conversa_id: mensagemSalva.conversa_id ?? convIdForEmit,
        status: canon,
        status_mensagem: canon,
        // fromMe e direcao EXPLÍCITOS: garantem que o frontend saiba se deve ou não
        // exibir notificação/som — NUNCA notificar para mensagens enviadas por nós (fromMe=true).
        fromMe,
        direcao: mensagemSalva.direcao ?? (fromMe ? 'out' : 'in'),
      }
      // Incluir nome e foto para o frontend exibir ao adicionar/atualizar conversa na lista
      const nomeContato = (nomeParaCache || senderName || '').toString().trim()
      const fotoContato = (senderPhoto && String(senderPhoto).trim().startsWith('http')) ? String(senderPhoto).trim() : null
      if (nomeContato && !nomeContato.replace(/\D/g, '').match(/^\d{10,15}$/)) {
        emitPayload.senderName = nomeContato
        emitPayload.chatName = nomeContato
      }
      if (fotoContato) {
        emitPayload.senderPhoto = fotoContato
        emitPayload.photo = fotoContato
      }
      if (mensagemFoiInseridaPeloWebhook) {
        // Emitir nova_mensagem para todas as mensagens inseridas pelo webhook:
        // - fromMe=false (recebida do cliente) → frontend DEVE notificar
        // - fromMe=true  (espelhamento: enviada pelo celular) → frontend NÃO deve notificar
        // O campo fromMe e direcao no payload permitem o frontend filtrar corretamente.
        const emittedScoped = await emitirParaUsuariosQuePodemVerConversa(
          io,
          company_id,
          convIdForEmit,
          'nova_mensagem',
          emitPayload
        )
        if (!emittedScoped) {
          const rooms = [`conversa_${convIdForEmit}`]
          if (departamento_id != null) rooms.push(`departamento_${departamento_id}`)
          io.to(rooms).emit('nova_mensagem', emitPayload)
        }
        scheduleInboundWebPush(company_id, convIdForEmit, 'nova_mensagem', emitPayload)
      } else {
        // Mensagem já existe (enviada pelo usuário): apenas atualizar status, não duplicar mensagem
        const statusPayload = {
          mensagem_id: mensagemSalva.id,
          conversa_id: convIdForEmit,
          status: canon,
          status_mensagem: canon,
          whatsapp_id: mensagemSalva.whatsapp_id || null,
          whatsapp_instance_id: mensagemSalva.whatsapp_instance_id ?? whatsapp_instance_id ?? null
        }
        let chain = io.to(`empresa_${company_id}`).to(`conversa_${convIdForEmit}`)
        if (mensagemSalva.autor_usuario_id != null) chain = chain.to(`usuario_${mensagemSalva.autor_usuario_id}`)
        chain.emit('status_mensagem', statusPayload)
      }
      // NÃO emitir atualizar_conversa para mensagens enviadas por nós (fromMe)
      // — evita refetch que causa duplicação visual e flicker. status_mensagem já atualiza os ticks.
      // Só emitir para mensagens recebidas (inseridas pelo webhook)
      if (!fromMe) {
        const emittedScoped = await emitirParaUsuariosQuePodemVerConversa(
          io,
          company_id,
          convIdForEmit,
          'atualizar_conversa',
          { id: convIdForEmit }
        )
        if (!emittedScoped) io.to(`conversa_${convIdForEmit}`).emit('atualizar_conversa', { id: convIdForEmit })
      }
      // conversa_atualizada: priorizar nome do sync (name) sobre cache; fallback nome_contato_cache
      let modoSimplesRecalc = null
      if (!isGroup && convIdForEmit && mensagemFoiInseridaPeloWebhook && mensagemSalva) {
        modoSimplesRecalc = await recalcularStatusPorUltimaMensagem({
          company_id,
          conversa_id: convIdForEmit,
          mensagemNova: mensagemSalva,
          io: null,
        }).catch(() => null)
      }
      const { data: convRow } = await supabase
        .from('conversas')
        .select('id, ultima_atividade, nome_contato_cache, foto_perfil_contato_cache, telefone, cliente_id, departamento_id, status_atendimento, atendente_id, aguardando_cliente_desde, modo_simples_aguardando, whatsapp_instance_id')
        .eq('id', convIdForEmit)
        .eq('company_id', company_id)
        .maybeSingle()
      let contatoNome = (nomeParaCache && String(nomeParaCache).trim()) || (convRow?.nome_contato_cache ? String(convRow.nome_contato_cache).trim() : null)
      let fotoPerfil = convRow?.foto_perfil_contato_cache ? String(convRow.foto_perfil_contato_cache).trim() : null
      
      // Foto: fallback cliente só se cache vazio
      if (!fotoPerfil && convRow?.cliente_id && !isGroup) {
        try {
          const { data: cli } = await supabase
            .from('clientes')
            .select('foto_perfil')
            .eq('id', convRow.cliente_id)
            .eq('company_id', company_id)
            .maybeSingle()
          if (cli?.foto_perfil) fotoPerfil = String(cli.foto_perfil).trim()
        } catch (e) {
          console.warn('Erro ao buscar foto do cliente no webhook:', e.message)
        }
      }
      const depId = departamento_id ?? convRow?.departamento_id ?? null
      const temNotificacaoDiscretaEmAtendimento =
        !fromMe &&
        !isGroup &&
        (convRow?.status_atendimento === 'em_atendimento' ||
          convRow?.status_atendimento === 'aguardando_cliente') &&
        convRow?.atendente_id != null
      const convPayload = aplicarModoSimplesNoPayload(
        {
          id: convIdForEmit,
          whatsapp_instance_id: convRow?.whatsapp_instance_id ?? whatsapp_instance_id ?? null,
          ultima_atividade: convRow?.ultima_atividade ?? new Date().toISOString(),
          telefone: convRow?.telefone ?? null,
          atendente_id: convRow?.atendente_id ?? null,
          // Grupos nunca mostram badge "aberta" — não precisam ser assumidos
          exibir_badge_aberta: !isGroup && convRow?.status_atendimento !== 'mensagem_disparada',
          ...(isGroup
            ? { status_atendimento: null, status_atendimento_real: null }
            : {
                status_atendimento: convRow?.status_atendimento ?? null,
                status_atendimento_real: convRow?.status_atendimento ?? null,
                aguardando_cliente_desde: convRow?.aguardando_cliente_desde ?? null,
              }),
          ...(depId != null ? { departamento_id: depId } : {}),
          ...(contatoNome ? { nome_contato_cache: contatoNome, contato_nome: contatoNome } : {}),
          ...(fotoPerfil ? { foto_perfil_contato_cache: fotoPerfil, foto_perfil: fotoPerfil } : {}),
          ...(mensagemFoiInseridaPeloWebhook && !fromMe
            ? {
                tem_novas_mensagens: true,
                tem_novas_mensagens_em_atendimento: temNotificacaoDiscretaEmAtendimento,
                lida: false,
              }
            : {}),
        },
        {
          modo_simples_aguardando:
            modoSimplesRecalc?.modo_simples_aguardando ?? convRow?.modo_simples_aguardando ?? null,
          atendimento_modo_simples: modoSimplesRecalc?.atendimento_modo_simples === true,
        },
        modoSimplesRecalc?.atendimento_modo_simples === true
      )
      // ultima_mensagem_preview: preview na lista lateral — direcao correta ('in'/'out') para exibir seta/ícone certo.
      // Para mensagem de contato, incluir tipo e contact_meta para o frontend exibir card em vez do vCard bruto.
      if (mensagemFoiInseridaPeloWebhook && emitPayload) {
        const preview = {
          texto: emitPayload.texto ?? '(mensagem)',
          criado_em: emitPayload.criado_em,
          direcao: emitPayload.direcao ?? (fromMe ? 'out' : 'in'),
          fromMe,
        }
        if (emitPayload.tipo === 'contact' && emitPayload.contact_meta) {
          preview.tipo = 'contact'
          preview.contact_meta = emitPayload.contact_meta
        }
        if (emitPayload.tipo === 'location' && emitPayload.location_meta) {
          preview.tipo = 'location'
          preview.location_meta = emitPayload.location_meta
        }
        convPayload.ultima_mensagem_preview = preview
      }
      // reordenar_suave: true — frontend deve animar o item para o topo em vez de refetch (evita "desce e sobe")
      convPayload.reordenar_suave = true
      const emittedConversaAtualizadaScoped = await emitirParaUsuariosQuePodemVerConversa(
        io,
        company_id,
        convIdForEmit,
        'conversa_atualizada',
        convPayload
      )
      if (!emittedConversaAtualizadaScoped) {
        io.to(`conversa_${convIdForEmit}`).emit('conversa_atualizada', convPayload)
        if (depId != null) {
          // Não emitir atualizar_conversa em reconciliação (fromMe) — evita refetch que causa bug visual
          if (mensagemFoiInseridaPeloWebhook) io.to(`departamento_${depId}`).emit('atualizar_conversa', { id: convIdForEmit })
          io.to(`departamento_${depId}`).emit('conversa_atualizada', convPayload)
        }
      }
    }

    if (pendingContactSync && io) {
      const { cliente_id: syncClienteId, chatId: syncChatId } = pendingContactSync
      const syncPhone = pendingContactSync.phone
      const syncInput = (syncChatId && String(syncChatId).endsWith('@c.us')) ? syncChatId : syncPhone
      const convId = convIdForEmit
      // Sync em background: atualiza cliente E conversa (nome/foto) quando o sync inicial falhou ou retornou vazio
      Promise.resolve().then(async () => {
        try {
          const { data: current } = await supabase.from('clientes').select('nome, pushname, foto_perfil').eq('id', syncClienteId).eq('company_id', company_id).maybeSingle()
          const { data: convRow } = await supabase.from('conversas').select('nome_contato_cache, foto_perfil_contato_cache').eq('id', convId).eq('company_id', company_id).maybeSingle()
          const synced = await syncUltraMsgContact(syncInput, company_id, { skipPersistence: true, skipCache: fromMe }).catch(() => null)
          if (!synced) return null
          const up = {}
          const telefoneTail = String(syncPhone).replace(/\D/g, '').slice(-6) || null
          const { name: bestNome } = chooseBestName(current?.nome, synced?.nome, 'syncUltramsg', { fromMe: false, company_id, telefoneTail })
          if (bestNome && bestNome !== (current?.nome || '')) up.nome = bestNome
          else if (!current?.nome || !String(current.nome).trim()) up.nome = (synced.nome && String(synced.nome).trim() && !isBadName(synced.nome)) ? String(synced.nome).trim() : syncPhone
          const pushnameVazio = !current?.pushname || !String(current.pushname).trim()
          const fotoVazia = !current?.foto_perfil || !String(current.foto_perfil).trim()
          if (pushnameVazio && synced.pushname !== undefined) up.pushname = synced.pushname
          if (fotoVazia && synced.foto_perfil) up.foto_perfil = synced.foto_perfil
          if (Object.keys(up).length > 0) {
            await supabase.from('clientes').update(up).eq('id', syncClienteId).eq('company_id', company_id)
          }
          // Atualizar conversa (nome_contato_cache, foto_perfil_contato_cache) quando vazios e sync trouxe dados
          const nomeConvVazio = !convRow?.nome_contato_cache || !String(convRow.nome_contato_cache).trim()
          const fotoConvVazia = !convRow?.foto_perfil_contato_cache || !String(convRow.foto_perfil_contato_cache).trim()
          // Priorizar name (nome salvo no celular) sobre pushname — nunca sobrescrever com pushname quando name existir
          const syncNomeValido = synced?.nome && String(synced.nome).trim() && !isBadName(synced.nome)
          const syncFotoValida = synced?.foto_perfil && String(synced.foto_perfil).trim().startsWith('http')
          const cacheConv = {}
          if (nomeConvVazio && syncNomeValido) cacheConv.nome_contato_cache = String(synced.nome).trim()
          if (fotoConvVazia && syncFotoValida) cacheConv.foto_perfil_contato_cache = String(synced.foto_perfil).trim()
          if (Object.keys(cacheConv).length > 0) {
            await supabase.from('conversas').update(cacheConv).eq('id', convId).eq('company_id', company_id)
          }
          const r = await supabase.from('clientes').select('nome, pushname, telefone, foto_perfil').eq('id', syncClienteId).single()
          const data = r?.data
          const nomeParaEmit = cacheConv.nome_contato_cache ?? convRow?.nome_contato_cache ?? getDisplayName(data) ?? null
          const fotoParaEmit = cacheConv.foto_perfil_contato_cache ?? convRow?.foto_perfil_contato_cache ?? data?.foto_perfil ?? null
          if (data && io && (nomeParaEmit || fotoParaEmit)) {
            console.log('✅ Contato sincronizado Z-API:', syncPhone?.slice(-6), nomeParaEmit || '(sem nome)')
            io.to(`empresa_${company_id}`).emit('contato_atualizado', {
              conversa_id: convId,
              contato_nome: nomeParaEmit ? String(nomeParaEmit).trim() : null,
              telefone: data.telefone || syncPhone,
              foto_perfil: fotoParaEmit ? String(fotoParaEmit).trim() : null
            })
          }
        } catch (e) {
          console.error('❌ Erro Z-API ao sincronizar contato:', syncPhone?.slice(-6), e?.message || e)
        }
      }).catch(() => {})
    }

    lastResult = { ok: true, conversa_id: convIdForEmit, mensagem_id: mensagemSalva?.id }
    }

    return res.status(200).json(lastResult)
  } catch (err) {
    console.error('Erro webhook Z-API:', err)
    return res.status(500).json({ error: 'Erro ao processar webhook' })
  }
}

/**
 * POST /webhooks/ultramsg/status — status da mensagem (entrega/leitura) para ticks ✓✓.
 * Z-API envia: status (SENT|RECEIVED|READ|READ_BY_ME|PLAYED) e ids (array de IDs).
 * Também aceita: messageId, zaapId, id (formato antigo).
 */
exports.statusZapi = async (req, res) => {
  try {
    if ((req.path || '').includes('statusht')) {
      console.log('[Z-API] alias_hit: /statusht -> handler status (ticks ✓✓)')
    }
    const body = req.body || {}
    let company_id = req.zapiContext?.company_id
    let whatsapp_instance_id = req.zapiContext?.whatsapp_instance_id ?? null
    if (company_id == null) {
      const instanceIdRaw = (body?.instanceId ?? body?.instance_id ?? body?.instance ?? '').toString().trim()
      if (instanceIdRaw) {
        const resolved = await getWhatsappInstanceByProviderInstanceId('ultramsg', instanceIdRaw)
        if (resolved?.code === 'DUPLICATE_PROVIDER_INSTANCE') {
          _logWebhookSafe({ eventType: 'MessageStatusCallback', instanceId: instanceIdRaw.slice(0, 24), companyIdResolved: 'duplicate_blocked' })
          return res.status(200).json({ ok: true, ignored: 'duplicate_provider_instance' })
        }
        if (resolved?.instance) {
          company_id = resolved.instance.company_id
          whatsapp_instance_id = resolved.instance.id ?? null
        } else {
          company_id = await getCompanyIdByInstanceId(instanceIdRaw)
        }
      } else {
        company_id = null
      }
      const instanceIdResolved = instanceIdRaw ? instanceIdRaw.slice(0, 24) + (instanceIdRaw.length > 24 ? '…' : '') : '(empty)'
      _logWebhookSafe({ eventType: 'MessageStatusCallback', instanceId: instanceIdResolved, companyIdResolved: company_id != null ? company_id : 'not_mapped' })
      if (company_id == null) return res.status(200).json({ ok: true })
    }

    // Z-API oficial usa "ids" (array); fallback para messageId, zaapId, id
    const idsRaw = body?.ids
    const messageIds = Array.isArray(idsRaw) && idsRaw.length > 0
      ? idsRaw.map((id) => (id != null ? String(id).trim() : '')).filter(Boolean)
      : []
    const singleId = body?.messageId ?? body?.zaapId ?? body?.id ?? (messageIds.length > 0 ? messageIds[0] : null)
    const idsToProcess = messageIds.length > 0 ? messageIds : (singleId ? [String(singleId).trim()] : [])

    const statusNorm = normalizeMessageAckStatus(body)

    // Debug: log toda requisição recebida em /webhooks/ultramsg/status (apenas com WHATSAPP_DEBUG=1)
    const logDebug = process.env.WHATSAPP_DEBUG === '1'
    if (logDebug) {
      console.log('[DEBUG] /webhooks/ultramsg/status recebido:', {
        ids: idsToProcess.length ? idsToProcess.slice(0, 3).map((id) => id.slice(0, 24) + (id.length > 24 ? '…' : '')) : null,
        statusBruto: body?.status ?? body?.ack ?? '(vazio)',
        ack: body?.ack,
        statusMapeado: statusNorm,
        erro: body?.error != null ? String(body.error).slice(0, 100) : null
      })
    }

    if (idsToProcess.length === 0) {
      if (logDebug) console.log('[DEBUG] /webhooks/ultramsg/status: sem messageId nem ids, ignorando.')
      return res.status(200).json({ ok: true })
    }

    if (!statusNorm) {
      if (logDebug) console.log('[DEBUG] /webhooks/ultramsg/status: status não mapeado, ignorando. raw=', body?.status ?? body?.ack ?? '(vazio)')
      return res.status(200).json({ ok: true })
    }

    // Fallback: deriva company_id da mensagem (whatsapp_id) quando instanceId ausente
    if (company_id == null && idsToProcess.length > 0) {
      const { data: msgRows } = await supabase
        .from('mensagens')
        .select('company_id')
        .eq('whatsapp_id', idsToProcess[0])
        .is('whatsapp_instance_id', null)
        .limit(2)
      if (Array.isArray(msgRows) && msgRows.length > 1) {
        logAmbiguousWhatsappId('status.company_fallback', {
          company_id: null,
          whatsapp_instance_id: null,
          whatsapp_id: idsToProcess[0],
          count: msgRows.length,
        })
        return res.status(200).json({ ok: true, ignored: 'ambiguous_status_without_instance' })
      }
      company_id = Array.isArray(msgRows) && msgRows[0]?.company_id != null ? msgRows[0].company_id : null
    }
    if (company_id == null) {
      if (body?.instanceId) console.log('[Z-API] status: instance not mapped:', String(body.instanceId).slice(0, 16) + '…')
      return res.status(200).json({ ok: true })
    }
    const io = req.app.get('io')
    let updated = 0

    for (const messageId of idsToProcess) {
      if (!messageId) continue
      const idStr = String(messageId)

      // Grupos: WhatsApp não envia read receipts confiáveis — cap em delivered
      let effectiveStatus = statusNorm
      if (statusNorm === 'read' || statusNorm === 'played') {
        const { data: msgForConv } = await selectSingleMensagemByWhatsappId(supabase, {
          company_id,
          whatsapp_id: idStr,
          whatsapp_instance_id,
          select: 'conversa_id',
          context: 'status.group_cap',
        })
        if (msgForConv?.conversa_id) {
          const { data: conv } = await supabase
            .from('conversas')
            .select('tipo, telefone')
            .eq('id', msgForConv.conversa_id)
            .eq('company_id', company_id)
            .maybeSingle()
          const isGroup = conv?.tipo === 'grupo' || (conv?.telefone && String(conv.telefone).endsWith('@g.us'))
          if (isGroup) effectiveStatus = 'delivered'
        }
      }

      // Evita que um ack atrasado (ex.: "delivered") regrida uma mensagem já em status mais avançado (ex.: "read").
      const { data: currentForRank } = await selectSingleMensagemByWhatsappId(supabase, {
        company_id,
        whatsapp_id: idStr,
        whatsapp_instance_id,
        select: 'status',
        context: 'status.rank_check',
      })
      if (currentForRank?.status && statusRank(currentForRank.status) > statusRank(effectiveStatus)) {
        effectiveStatus = currentForRank.status
      }

      const statusUpdates = { status: effectiveStatus, status_mensagem: effectiveStatus }
      const statusSelect = 'id, conversa_id, company_id, autor_usuario_id, whatsapp_instance_id, whatsapp_id'

      // 1) Atualiza por (company_id, whatsapp_id) — match exato com filtro de instância
      let { data: msg } = await updateSingleMensagemByWhatsappId(supabase, {
        company_id,
        whatsapp_id: idStr,
        whatsapp_instance_id,
        updates: statusUpdates,
        select: statusSelect,
        context: 'status.exact',
      })

      // 1b) Fallback: ACK não encontrou por whatsapp_instance_id — tenta match exato na empresa
      if (!msg) {
        const relaxed = await selectSingleMensagemByWhatsappIdRelaxed(supabase, {
          company_id,
          whatsapp_id: idStr,
          select: statusSelect,
          context: 'status.exact_relaxed',
        })
        if (relaxed.data?.id) {
          const cur = relaxed.data.status || 'pending'
          if (statusRank(cur) > statusRank(effectiveStatus)) effectiveStatus = cur
          const patched = await patchMensagemStatusById(supabase, {
            company_id,
            mensagem_id: relaxed.data.id,
            effectiveStatus,
            whatsapp_id: idStr,
            select: statusSelect,
          })
          msg = patched.data || null
        }
      }

      // 2) Fallback: Z-API às vezes trunca o ID no status callback.
      //    Tenta prefixo (primeiros 20 chars) ainda dentro do company_id (sem cross-tenant).
      if (!msg && idStr.length >= 20) {
        const prefix = idStr.slice(0, 20)
        let prefixQuery = supabase
          .from('mensagens')
          .select('id, conversa_id, company_id, autor_usuario_id, whatsapp_id, status')
          .eq('company_id', company_id)
          .ilike('whatsapp_id', `${prefix}%`)
          .order('id', { ascending: false })
          .limit(2)
        prefixQuery = applyWhatsappInstanceFilterOrLegacy(prefixQuery, whatsapp_instance_id)
        const { data: prefixRows } = await prefixQuery
        if (Array.isArray(prefixRows) && prefixRows.length > 1) {
          logAmbiguousWhatsappId('status.prefix', {
            company_id,
            whatsapp_instance_id,
            whatsapp_id: `${prefix}%`,
            count: prefixRows.length,
          })
        }
        const candidate = Array.isArray(prefixRows) && prefixRows.length === 1 ? prefixRows[0] : null
        if (candidate?.id) {
          if (candidate.status && statusRank(candidate.status) > statusRank(effectiveStatus)) {
            effectiveStatus = candidate.status
          }
          const patched = await patchMensagemStatusById(supabase, {
            company_id,
            mensagem_id: candidate.id,
            effectiveStatus,
            select: statusSelect,
          })
          msg = patched.data || null
        }
      }

      // 3) Fallback UltraMsg: message_ack pode chegar ANTES do ReceivedCallback (id formato WhatsApp).
      //    Busca mensagem out recente com whatsapp_id pendente (null ou fila numérica) e atualiza status + whatsapp_id.
      const isWhatsAppFormatId = idStr.includes('@') || idStr.includes('_')
      if (!msg && isWhatsAppFormatId && company_id) {
        const fromIso = new Date(Date.now() - 5 * 60 * 1000).toISOString()
        let recentOutQuery = supabase
          .from('mensagens')
          .select('id, conversa_id, company_id, autor_usuario_id, whatsapp_instance_id, whatsapp_id')
          .eq('company_id', company_id)
          .eq('direcao', 'out')
          .gte('criado_em', fromIso)
          .order('criado_em', { ascending: false })
          .order('id', { ascending: false })
          .limit(5)
        recentOutQuery = applyWhatsappInstanceFilterOrLegacy(recentOutQuery, whatsapp_instance_id)
        const { data: recentOutRows } = await recentOutQuery
        const pendingRows = filterRowsForFromMeReconcile(recentOutRows)
        const cand = Array.isArray(pendingRows) && pendingRows.length === 1 ? pendingRows[0] : null
        if (cand?.id) {
          const patched = await patchMensagemStatusById(supabase, {
            company_id,
            mensagem_id: cand.id,
            effectiveStatus,
            whatsapp_id: idStr,
            select: statusSelect,
          })
          msg = patched.data || null
          if (msg && logDebug) console.log('[DEBUG] status reconciliação: message_ack antes do ReceivedCallback', { mensagem_id: msg.id })
        }
      }

      // 4) Fallback UltraMsg: id numérico de fila — match exato em whatsapp_id (várias mensagens seguidas OK)
      const isUltramsgNumericId = isUltramsgNumericQueueId(idStr)
      if (!msg && isUltramsgNumericId && company_id) {
        const relaxed = await selectSingleMensagemByWhatsappIdRelaxed(supabase, {
          company_id,
          whatsapp_id: idStr,
          select: statusSelect,
          context: 'status.numeric_queue',
        })
        if (relaxed.data?.id) {
          const cur = relaxed.data.status || 'pending'
          if (statusRank(cur) > statusRank(effectiveStatus)) effectiveStatus = cur
          const patched = await patchMensagemStatusById(supabase, {
            company_id,
            mensagem_id: relaxed.data.id,
            effectiveStatus,
            select: statusSelect,
          })
          msg = patched.data || null
        }
      }

      // 4b) Fallback: ID numérico de fila — busca por provider_queue_id (linhas novas após migration M2).
      //     O fallback 4 acima cobre linhas antigas (whatsapp_id numérico); este cobre linhas novas.
      if (!msg && isUltramsgNumericId && company_id) {
        let qIdQuery = supabase
          .from('mensagens')
          .select(`${statusSelect}, status`)
          .eq('company_id', company_id)
          .eq('provider_queue_id', idStr)
          .order('id', { ascending: false })
          .limit(1)
        qIdQuery = applyWhatsappInstanceFilterOrLegacy(qIdQuery, whatsapp_instance_id)
        const { data: queueRows } = await qIdQuery
        const queueRow = Array.isArray(queueRows) ? queueRows[0] : queueRows
        if (queueRow?.id) {
          const cur = queueRow.status || 'pending'
          if (statusRank(cur) > statusRank(effectiveStatus)) effectiveStatus = cur
          const patched = await patchMensagemStatusById(supabase, {
            company_id,
            mensagem_id: queueRow.id,
            effectiveStatus,
            select: statusSelect,
          })
          msg = patched.data || null
        }
      }

      if (msg) {
        updated++
        if (io) {
          const emitStatus = canonStatusForEmit(effectiveStatus)
          const payload = {
            mensagem_id: msg.id,
            conversa_id: msg.conversa_id,
            status: emitStatus,
            status_mensagem: emitStatus,
            whatsapp_id: msg.whatsapp_id || idStr,
          }
          // Emite para empresa, conversa E usuario do autor (garante ticks ✓✓ em tempo real)
          let chain = io.to(`empresa_${msg.company_id}`).to(`conversa_${msg.conversa_id}`)
          if (msg.autor_usuario_id != null) chain = chain.to(`usuario_${msg.autor_usuario_id}`)
          chain.emit('status_mensagem', payload)
        }

        // Rollout R2 (empresa 1): ACK confirmou o envio (status final) → espelha a mídia para o R2
        // agora. ACKs só existem para mensagens outbound. No-op p/ outras empresas / tipo não-mídia.
        try {
          const { scheduleR2MirrorIfNeeded } = require('../services/mediaR2MirrorService')
          scheduleR2MirrorIfNeeded({ supabase, io, company_id: msg.company_id, mensagem_id: msg.id })
        } catch (_) { /* best-effort; nunca afeta o webhook */ }

        if (logDebug) console.log('[DEBUG] /webhooks/ultramsg/status resultado:', { status: statusNorm, mensagem_id: msg.id, conversa_id: msg.conversa_id, whatsapp_id: idStr.slice(0, 20) + '…' })
      } else {
        console.log('[ULTRAMSG] Status', statusNorm, 'para id', idStr.slice(0, 20) + '… — mensagem não encontrada no banco (ignorado)')
      }
    }

    return res.status(200).json({ ok: true })
  } catch (e) {
    if (process.env.WHATSAPP_DEBUG === '1') console.error('[DEBUG] /webhooks/ultramsg/status ERRO:', e?.message || e)
    return res.status(200).json({ ok: true })
  }
}

exports._test = {
  applyWhatsappInstanceFilterOrLegacy,
  selectSingleMensagemByWhatsappId,
  updateSingleMensagemByWhatsappId,
  looksLikeBRPhoneDigits,
  isGroupPayload,
  pickGroupChatId,
  getPayloads,
  resolveConversationKeyFromZapi,
  extractMessage,
  whatsappIdCompativelParaReconcile,
  filterRowsForFromMeReconcile,
  findFromMeOutboundMediaCandidate,
  tryReconcileFromMeByCrmReferenceId,
  preserveMediaFieldsOnWebhookFallback,
}
