/**
 * Webhook Whapi Cloud (2º provider). Normaliza eventos Whapi para o MESMO formato interno
 * "zapi-like" consumido pelo pipeline ATIVO (webhookZapiController — nome legado) e DELEGA
 * a receberZapi / statusZapi. NÃO importa nada do webhookUltramsgController.
 *
 * Whapi envia arrays por POST: `messages` (inbound e from_me) e `statuses` (ACK).
 * Cada item é normalizado e despachado ao handler certo; respondemos UMA vez ao final.
 *
 * Fase B: texto + ACK + mídia por `link` + reação `action`.
 * Contrato Whapi CONFIRMADO via MCP health/schema + OpenAPI (2026-09-04). Ver doc 25 §3.
 */

const { normalizePhoneBR } = require('../helpers/phoneHelper')
const webhookCoreController = require('./webhookZapiController')
const supabase = require('../config/supabase')
const {
  buildEditadaDbUpdates,
  isMissingEditadaColumnError,
  buildMensagemEditadaSocketPayload,
} = require('../helpers/mensagemEditHelper')
const {
  looksLikePollOptionHash,
  resolvePollVoteLabels,
  buildPollOptionIdMap,
} = require('../helpers/pollVoteResolve')
const { emitirEventoEmpresaConversa } = require('../services/chat/realtime/chatRealtimeGateway')

/**
 * Guarda anti-histórico do Whapi.
 *
 * No (re)connect e, sobretudo, com o "webhook persistente" ligado, o Whapi RE-ENTREGA
 * mensagens antigas (backlog de atendimentos já feitos) com o timestamp ORIGINAL. Sem
 * filtro, cada uma vira uma conversa/contato novo ("Contato" sem nome) — e como o webhook
 * persistente reenvia, elas voltam a aparecer mesmo depois de apagadas no banco.
 *
 * Ignoramos qualquer item de `messages[]` (inbound ou from_me) mais velho que o teto.
 * Mensagem ao vivo do Whapi chega em segundos; só o backlog é antigo, então o corte separa
 * um do outro sem depender de um flag de "history" (que o Whapi não envia por item).
 *
 * Tunável por env `WHAPI_INBOUND_MAX_AGE_MINUTES`. DESATIVADO por padrão (`0`/ausente) para
 * não mudar o comportamento de quem não optou nem descartar mensagem em outage. Ligue com, ex.,
 * `WHAPI_INBOUND_MAX_AGE_MINUTES=10`. Resolvido em runtime (não em load) para ser testável.
 */
function getWhapiInboundMaxAgeMs() {
  const min = Number(process.env.WHAPI_INBOUND_MAX_AGE_MINUTES)
  if (!Number.isFinite(min) || min <= 0) return 0
  return min * 60 * 1000
}

/** Epoch ms da mensagem Whapi (timestamp em segundos; aceita ms se vier com 13 dígitos). */
function whapiMessageEpochMs(m) {
  const raw = Number(m?.timestamp)
  if (!Number.isFinite(raw) || raw <= 0) return null
  return raw > 1e12 ? raw : raw * 1000
}

/**
 * Máximo de idade efetivo POR CANAL, vindo da config de sincronização (metadata jsonb da instância):
 *  - sync_historico = 'off' → 2 min (só ao vivo; NÃO puxa histórico ao (re)conectar)
 *  - sync_historico = 'on'  → min(sync_historico_dias || 30, 30) dias (puxa no máx. ~1 mês)
 *  - sem config             → env global WHAPI_INBOUND_MAX_AGE_MINUTES (compatibilidade)
 */
function effectiveWhapiMaxAgeMs(ctx) {
  const mode = String(ctx?.sync_historico || '').trim().toLowerCase()
  if (mode === 'off') return 2 * 60 * 1000
  if (mode === 'on') {
    const dias = Math.min(Math.max(Number(ctx?.sync_historico_dias) || 30, 1), 30)
    return dias * 24 * 60 * 60 * 1000
  }
  return getWhapiInboundMaxAgeMs()
}

/** true se o item é backlog antigo (mais velho que o teto) e deve ser ignorado. */
function whapiInboundIsHistorical(m, nowMs, maxAgeMs = getWhapiInboundMaxAgeMs()) {
  if (!(Number(maxAgeMs) > 0)) return false
  const epochMs = whapiMessageEpochMs(m)
  if (epochMs == null) return false // sem timestamp confiável → trata como ao vivo (não descarta)
  return (nowMs - epochMs) > maxAgeMs
}

function isWhapiEditedMessage(m) {
  if (!m || typeof m !== 'object') return false
  if (m.edited === true || m.is_edited === true || m.isEdit === true) return true
  const type = String(m.type || '').toLowerCase()
  // Whapi mobile: type "edit"; ou action.type "edit" (changelog Whapi).
  if (type === 'edit') return true
  return String(m.action?.type || '').toLowerCase() === 'edit'
}

/** Id da mensagem original editada (Whapi pode mandar action.target / edit.id). */
function resolveWhapiEditTargetId(m) {
  if (!m || typeof m !== 'object') return ''
  const type = String(m.type || '').toLowerCase()
  const actionType = String(m.action?.type || '').toLowerCase()
  if (type === 'edit' || actionType === 'edit') {
    const target =
      m.action?.target
      ?? m.action?.message_id
      ?? m.edit?.id
      ?? m.edit?.message_id
      ?? m.context?.quoted_id
      ?? m.id
    if (target != null && String(target).trim()) return String(target).trim()
  }
  return String(m.id || '').trim()
}

function extractWhapiEditedTexto(m) {
  if (!m || typeof m !== 'object') return ''
  const type = String(m.type ?? 'text').toLowerCase()
  const typed = m[type]
  const editObj = (m.edit && typeof m.edit === 'object') ? m.edit : null
  const actionObj = (m.action && typeof m.action === 'object') ? m.action : null
  return String(
    (m.text && (m.text.body ?? m.text))
    || (editObj && (editObj.body ?? editObj.text ?? editObj.caption))
    || (actionObj && ((actionObj.body ?? actionObj.text ?? actionObj.caption)
      || (actionObj.text && (actionObj.text.body ?? actionObj.text))))
    || m.body
    || m.caption
    || (typed && typeof typed === 'object' ? (typed.caption ?? typed.body ?? typed.text) : '')
    || ''
  ).trim()
}

async function applyWhapiEditedMessage(ctxSrc, m, io) {
  const id = resolveWhapiEditTargetId(m)
  if (!id || ctxSrc?.company_id == null) return false
  const texto = extractWhapiEditedTexto(m)
  // Sem texto novo não atualiza (evita apagar bolha com webhook incompleto).
  if (!texto) return false
  const updates = buildEditadaDbUpdates(texto)
  const runUpdate = async (payload, select, { withInstance } = { withInstance: true }) => {
    let query = supabase
      .from('mensagens')
      .update(payload)
      .eq('company_id', ctxSrc.company_id)
      .eq('whatsapp_id', id)
    if (withInstance && ctxSrc.whatsapp_instance_id) {
      query = query.eq('whatsapp_instance_id', ctxSrc.whatsapp_instance_id)
    }
    return query.select(select).maybeSingle()
  }
  let { data, error } = await runUpdate(updates, 'id, conversa_id, texto, tipo, editada_em', { withInstance: true })
  if (error && isMissingEditadaColumnError(error)) {
    ;({ data, error } = await runUpdate({ texto }, 'id, conversa_id, texto, tipo', { withInstance: true }))
  }
  // Fallback: linha legada sem whatsapp_instance_id / divergência de instância
  if ((!data?.id || error) && ctxSrc.whatsapp_instance_id) {
    ;({ data, error } = await runUpdate(updates, 'id, conversa_id, texto, tipo, editada_em', { withInstance: false }))
    if (error && isMissingEditadaColumnError(error)) {
      ;({ data, error } = await runUpdate({ texto }, 'id, conversa_id, texto, tipo', { withInstance: false }))
    }
  }
  if (error || !data?.id) return false
  if (io) {
    let ultima_mensagem = null
    try {
      const { data: ultima } = await supabase
        .from('mensagens')
        .select('id, texto, tipo, criado_em, direcao')
        .eq('company_id', ctxSrc.company_id)
        .eq('conversa_id', data.conversa_id)
        .order('criado_em', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (ultima && String(ultima.id) === String(data.id)) {
        ultima_mensagem = {
          id: ultima.id,
          texto,
          tipo: data.tipo || ultima.tipo,
          criado_em: ultima.criado_em,
          direcao: ultima.direcao,
          editada: true,
          editado: true,
        }
      }
    } catch (_) {}
    emitirEventoEmpresaConversa(
      io,
      ctxSrc.company_id,
      data.conversa_id,
      io.EVENTS?.MENSAGEM_EDITADA || 'mensagem_editada',
      buildMensagemEditadaSocketPayload({
        id: data.id,
        conversa_id: data.conversa_id,
        company_id: ctxSrc.company_id,
        texto,
        editada_em: data.editada_em || updates.editada_em,
        tipo: data.tipo || null,
        ultima_mensagem,
      })
    )
  }
  return true
}

/** Extrai dígitos de um JID (5534999@s.whatsapp.net → 5534999; 120363@g.us → 120363).
 * @lid NÃO é telefone — devolve vazio para o caller usar a chave lid:… */
function isLidJid(jid) {
  const s = String(jid || '').trim().toLowerCase()
  return s.endsWith('@lid') || s.endsWith('@broadcast')
}

function jidToDigits(jid) {
  if (!jid || typeof jid !== 'string') return ''
  if (isLidJid(jid)) return ''
  return String(jid).replace(/@[^@]+$/, '').replace(/\D/g, '')
}

function isGroupJid(v) {
  return typeof v === 'string' && v.trim().toLowerCase().endsWith('@g.us')
}

/** Whapi ack/status → status interno (mesma escala do UltraMSG).
 * CONFIRMADO docs: status string failed|pending|sent|delivered|read|played|deleted
 * e `code` numérico (exemplo oficial code 4 = read). */
function mapWhapiAckToStatus(ack, code) {
  const n = code == null || code === '' ? NaN : Number(code)
  if (Number.isFinite(n)) {
    if (n === 0) return 'erro'
    if (n === 1) return 'pending'
    if (n === 2) return 'sent'
    if (n === 3) return 'delivered'
    if (n === 4) return 'read'
    if (n === 5) return 'played'
    if (n === 6) return 'erro'
  }
  const s = String(ack ?? '').toLowerCase()
  if (s === 'failed' || s === 'error' || s === 'deleted') return 'erro'
  if (s === 'sent' || s === 'server' || s === '1') return 'sent'
  if (s === 'delivered' || s === 'received' || s === 'device' || s === '2') return 'delivered'
  if (s === 'read' || s === 'seen' || s === '3') return 'read'
  if (s === 'played' || s === '4') return 'played'
  if (s === 'pending' || s === '0') return 'pending'
  return s || 'pending'
}

/** URL de mídia de um sub-objeto Whapi ({ link } | string). */
function mediaLink(obj) {
  if (!obj) return null
  if (typeof obj === 'string') return obj.trim().startsWith('http') ? obj.trim() : null
  if (typeof obj === 'object') {
    const v = obj.link ?? obj.url ?? obj.file
    return typeof v === 'string' && v.trim().startsWith('http') ? v.trim() : null
  }
  return null
}

/**
 * Converte um item de `messages[]` do Whapi para o formato interno esperado por receberZapi.
 * @param {object} m item de messages[]
 * @param {object} ctx { channelId, connectedPhone }
 */
/**
 * Extrai a resposta de uma mensagem interativa inbound (toque em botão / item de lista).
 * Whapi entrega em `m.reply` (buttons_reply|list_reply) ou `m.interactive` (button_reply|list_reply).
 * Retorna { id, title, description } ou null. CONFIRMAR shape exato em homologação live (doc 25).
 */
function extractInteractiveReply(m) {
  if (!m || typeof m !== 'object') return null
  const src = m.reply || m.interactive || null
  if (!src || typeof src !== 'object') return null
  const r = src.buttons_reply || src.button_reply || src.list_reply || src.selected_button || src
  const id = r?.id ?? r?.selected_id ?? r?.selectedRowId ?? src.id ?? null
  const title = r?.title ?? r?.selected_display_text ?? r?.text ?? null
  const description = r?.description ?? null
  if (id == null && title == null) return null
  return {
    id: id != null ? String(id) : null,
    title: title != null ? String(title) : null,
    description: description != null ? String(description) : null,
  }
}

/**
 * Extrai o voto de uma enquete inbound. Whapi (INFERÊNCIA — confirmar live): `m.action`
 * (type 'vote') com `votes`/`selected_options` e `target` = id da mensagem da enquete.
 * As opções podem vir como texto (ideal) ou hash/índice. Retorna { target, options: string[] }.
 */
function extractPollVote(m) {
  if (!m || typeof m !== 'object') return { target: null, options: [] }
  const a = m.action || m.poll || m
  const target = a.target ?? a.poll_id ?? a.message_id ?? m.context?.quoted_id ?? null
  let raw = a.votes ?? a.selected_options ?? a.options ?? m.votes ?? []
  if (!Array.isArray(raw)) raw = raw != null ? [raw] : []
  const options = raw
    .map((v) => {
      if (v == null) return ''
      if (typeof v === 'string') return v.trim()
      if (typeof v === 'object') {
        // Whapi manda { id: '<sha256-base64>' } — o id É o voto a resolver.
        return String(v.name ?? v.title ?? v.text ?? v.option ?? v.id ?? '').trim()
      }
      return String(v).trim()
    })
    .filter(Boolean)
  return { target: target != null ? String(target) : null, options }
}

/** Metadados da mensagem de enquete (type=poll). */
function extractPollMessage(m) {
  if (!m || typeof m !== 'object') return null
  const p = (m.poll && typeof m.poll === 'object') ? m.poll : m
  const title = String(p.title ?? p.name ?? m.title ?? '').trim()
  let raw = p.options ?? m.options ?? []
  if (!Array.isArray(raw)) raw = []
  const options = [...new Set(raw.map((v) => {
    if (v == null) return ''
    if (typeof v === 'string') return v.trim()
    if (typeof v === 'object') return String(v.name ?? v.title ?? v.text ?? '').trim()
    return String(v).trim()
  }).filter(Boolean))].slice(0, 12)
  if (!title && !options.length) return null
  const count = p.count === 0 || p.count === '0' ? 0 : 1
  return { title: title || 'Enquete', options, count }
}

function pollPreviewText(poll) {
  if (!poll) return ''
  const lines = [`📊 ${poll.title || 'Enquete'}`]
  for (const opt of poll.options || []) lines.push(`• ${opt}`)
  return lines.join('\n')
}

/**
 * Busca a enquete original no banco e resolve hashes de voto → texto da opção.
 * Atualiza reply_meta.poll (last_vote + results) e emite patch em tempo real.
 */
async function enrichNormalizedPollVote(normalized, ctxSrc, io) {
  if (!normalized?.pollVoteTarget || ctxSrc?.company_id == null) return normalized
  const target = String(normalized.pollVoteTarget).trim()
  if (!target) return normalized

  async function findPollRow() {
    let query = supabase
      .from('mensagens')
      .select('id, conversa_id, texto, tipo, reply_meta, whatsapp_id')
      .eq('company_id', ctxSrc.company_id)
      .eq('whatsapp_id', target)
      .eq('tipo', 'poll')
    if (ctxSrc.whatsapp_instance_id) {
      query = query.eq('whatsapp_instance_id', ctxSrc.whatsapp_instance_id)
    }
    const { data } = await query.maybeSingle()
    if (data) return data

    // Sem filtro de instância (legado / divergência null vs id)
    const { data: loose } = await supabase
      .from('mensagens')
      .select('id, conversa_id, texto, tipo, reply_meta, whatsapp_id')
      .eq('company_id', ctxSrc.company_id)
      .eq('whatsapp_id', target)
      .eq('tipo', 'poll')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (loose) return loose

    // Fallback: última enquete da conversa (quando o target não bate o whatsapp_id gravado)
    const conversaId = normalized.conversa_id || normalized.chatId || null
    if (conversaId) {
      const { data: byConv } = await supabase
        .from('mensagens')
        .select('id, conversa_id, texto, tipo, reply_meta, whatsapp_id')
        .eq('company_id', ctxSrc.company_id)
        .eq('conversa_id', Number(conversaId))
        .eq('tipo', 'poll')
        .order('criado_em', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (byConv) return byConv
    }
    return null
  }

  const pollRow = await findPollRow()
  if (!pollRow) {
    // Nunca persistir hash cru
    const rawVotes = Array.isArray(normalized.pollVoteOptions) ? normalized.pollVoteOptions : []
    if (rawVotes.some((v) => looksLikePollOptionHash(v))) {
      normalized.body = '(voto na enquete)'
      normalized.texto = normalized.body
      normalized.message = normalized.body
    }
    return normalized
  }

  const pollMeta = (pollRow.reply_meta && typeof pollRow.reply_meta === 'object' && pollRow.reply_meta.poll)
    ? { ...pollRow.reply_meta.poll }
    : {}
  let options = Array.isArray(pollMeta.options) ? pollMeta.options : []
  // Enquete antiga/sem reply_meta: recupera opções do preview "📊 Título\n• A\n• B"
  if (!options.length && pollRow.texto) {
    const lines = String(pollRow.texto).split('\n').map((l) => l.trim()).filter(Boolean)
    options = lines
      .filter((l) => l.startsWith('•') || l.startsWith('-'))
      .map((l) => l.replace(/^[•\-]\s*/, '').trim())
      .filter(Boolean)
  }
  const optionIds = Array.isArray(pollMeta.option_ids) && pollMeta.option_ids.length
    ? pollMeta.option_ids
    : buildPollOptionIdMap(options)
  const resultsForMap = Array.isArray(pollMeta.results) && pollMeta.results.length
    ? pollMeta.results
    : optionIds

  const rawVotes = Array.isArray(normalized.pollVoteOptions) ? normalized.pollVoteOptions : []
  // Tenta results/option_ids e, se vazio, as opções em texto puro
  let labels = resolvePollVoteLabels(rawVotes, resultsForMap.length ? resultsForMap : options)
  if (!labels.length && options.length) {
    labels = resolvePollVoteLabels(rawVotes, options)
  }
  const resolved = labels.length
    ? labels
    : rawVotes.filter((v) => v && !looksLikePollOptionHash(v))

  if (resolved.length) {
    normalized.pollVoteOptions = resolved
    normalized.body = resolved.join(', ')
    normalized.texto = normalized.body
    normalized.message = normalized.body
    if (normalized.text && typeof normalized.text === 'object') {
      normalized.text = { ...normalized.text, message: normalized.body }
    }
  } else if (rawVotes.some((v) => looksLikePollOptionHash(v))) {
    normalized.body = '(voto na enquete)'
    normalized.texto = normalized.body
    normalized.message = normalized.body
  }

  const nextPoll = {
    ...pollMeta,
    options: options.length ? options : pollMeta.options,
    option_ids: optionIds,
    last_vote: {
      options: resolved.length ? resolved : (rawVotes.filter((v) => !looksLikePollOptionHash(v))),
      at: new Date().toISOString(),
      voter_whatsapp_id: normalized.id || null,
    },
  }
  if (!nextPoll.last_vote.options.length && resolved.length) {
    nextPoll.last_vote.options = resolved
  }
  const nextReplyMeta = {
    ...(pollRow.reply_meta && typeof pollRow.reply_meta === 'object' ? pollRow.reply_meta : {}),
    poll: nextPoll,
  }

  try {
    const { data: updated } = await supabase
      .from('mensagens')
      .update({ reply_meta: nextReplyMeta })
      .eq('company_id', ctxSrc.company_id)
      .eq('id', pollRow.id)
      .select('id, conversa_id, tipo, reply_meta, texto')
      .maybeSingle()

    if (updated && io) {
      emitirEventoEmpresaConversa(
        io,
        ctxSrc.company_id,
        updated.conversa_id,
        io.EVENTS?.MENSAGEM_EDITADA || 'mensagem_editada',
        {
          id: Number(updated.id),
          conversa_id: Number(updated.conversa_id),
          company_id: Number(ctxSrc.company_id),
          texto: updated.texto,
          conteudo: updated.texto,
          tipo: updated.tipo || 'poll',
          reply_meta: updated.reply_meta || nextReplyMeta,
          editada: false,
          editado: false,
          poll_vote: true,
        }
      )
    }
  } catch (e) {
    console.warn('[WHAPI] falha ao atualizar reply_meta da enquete:', e?.message || e)
  }

  return normalized
}

/**
 * messages.patch (messages_updates): atualiza contagem/resultados da enquete e
 * resolve o voto do trigger quando vier com hashes.
 */
async function applyWhapiPollMessageUpdate(ctxSrc, update, io) {
  if (!update || typeof update !== 'object' || ctxSrc?.company_id == null) return null
  const after = update.after_update || update.after || null
  if (!after || String(after.type || '').toLowerCase() !== 'poll') return null
  const pollId = String(update.id || after.id || '').trim()
  if (!pollId) return null

  const poll = after.poll && typeof after.poll === 'object' ? after.poll : null
  if (!poll) return null

  const title = String(poll.title || '').trim()
  const options = Array.isArray(poll.options)
    ? poll.options.map((o) => String(o ?? '').trim()).filter(Boolean)
    : []
  const results = Array.isArray(poll.results)
    ? poll.results.map((r) => ({
      name: String(r?.name ?? '').trim(),
      id: r?.id != null ? String(r.id) : undefined,
      count: Number(r?.count) || 0,
      voters: Array.isArray(r?.voters) ? r.voters : [],
    })).filter((r) => r.name || r.id)
    : []

  let query = supabase
    .from('mensagens')
    .select('id, conversa_id, texto, tipo, reply_meta')
    .eq('company_id', ctxSrc.company_id)
    .eq('whatsapp_id', pollId)
  if (ctxSrc.whatsapp_instance_id) {
    query = query.eq('whatsapp_instance_id', ctxSrc.whatsapp_instance_id)
  }
  const { data: pollRow } = await query.maybeSingle()
  if (!pollRow) return null

  const prev = (pollRow.reply_meta && typeof pollRow.reply_meta === 'object' && pollRow.reply_meta.poll)
    ? pollRow.reply_meta.poll
    : {}

  const trigger = update.trigger || null
  const triggerVote = (trigger && String(trigger.action?.type || '').toLowerCase() === 'vote')
    ? extractPollVote(trigger)
    : null
  let lastVoteOptions = null
  if (triggerVote?.options?.length) {
    lastVoteOptions = resolvePollVoteLabels(triggerVote.options, results.length ? results : (prev.options || options))
    if (!lastVoteOptions.length) lastVoteOptions = triggerVote.options.filter((v) => !looksLikePollOptionHash(v))
  }

  const nextPoll = {
    ...prev,
    title: title || prev.title,
    options: options.length ? options : prev.options,
    option_ids: buildPollOptionIdMap(options.length ? options : prev.options),
    count: poll.vote_limit === 0 || poll.count === 0 ? 0 : (prev.count ?? 1),
    total: poll.total != null ? Number(poll.total) : prev.total,
    results,
    ...(lastVoteOptions?.length
      ? { last_vote: { options: lastVoteOptions, at: new Date().toISOString() } }
      : {}),
  }
  const nextReplyMeta = {
    ...(pollRow.reply_meta && typeof pollRow.reply_meta === 'object' ? pollRow.reply_meta : {}),
    poll: nextPoll,
  }

  const { data: updated } = await supabase
    .from('mensagens')
    .update({ reply_meta: nextReplyMeta })
    .eq('company_id', ctxSrc.company_id)
    .eq('id', pollRow.id)
    .select('id, conversa_id, tipo, reply_meta, texto')
    .maybeSingle()

  if (updated && io) {
    emitirEventoEmpresaConversa(
      io,
      ctxSrc.company_id,
      updated.conversa_id,
      io.EVENTS?.MENSAGEM_EDITADA || 'mensagem_editada',
      {
        id: Number(updated.id),
        conversa_id: Number(updated.conversa_id),
        company_id: Number(ctxSrc.company_id),
        texto: updated.texto,
        conteudo: updated.texto,
        tipo: updated.tipo || 'poll',
        reply_meta: updated.reply_meta || nextReplyMeta,
        editada: false,
        editado: false,
        poll_vote: true,
      }
    )
  }

  return { pollRow: updated, lastVoteOptions, trigger }
}

function normalizeWhapiMessageToInternal(m, ctx = {}) {
  if (!m || typeof m !== 'object') return null
  const channelId = ctx.channelId
  const fromMe = Boolean(m.from_me ?? m.fromMe)
  const chatJid = String(m.chat_id ?? m.chatId ?? m.chat?.id ?? '').trim()
  const fromJid = String(m.from ?? '').trim()
  const isGroup = isGroupJid(chatJid) || isGroupJid(fromJid)
  const type = String(m.type ?? 'text').toLowerCase()
  const actionType = String(m.action?.type || '').toLowerCase()
  const isReaction = type === 'reaction' || (type === 'action' && actionType === 'reaction')
  // Voto em enquete: type 'action' + action.type 'vote' (ou type poll_vote/vote).
  // Vira inbound de texto (opção escolhida) p/ a URA tratar como resposta. CONFIRMAR shape live (doc 25 §29).
  const isPollVote = (type === 'action' && actionType === 'vote') || type === 'poll_vote' || type === 'vote'
  const isEdit = Boolean(
    m.edited || m.is_edited || m.isEdit
    || type === 'edit'
    || actionType === 'edit'
  )
  // Outros `action` (ex. media_notify) não são mensagem de atendimento — edit/vote/reaction passam.
  if (type === 'action' && !isReaction && !isPollVote && !isEdit) return null
  if (type === 'deleted' || type === 'revoke' || type === 'revoked' || m.deleted === true) return null

  let phone = ''
  let remoteJid = ''
  let participantPhone = ''
  if (isGroup) {
    remoteJid = isGroupJid(chatJid) ? chatJid : (isGroupJid(fromJid) ? fromJid : chatJid)
    phone = remoteJid
    const fromCandidate = [m.from, m.author, m.participant]
      .map((v) => String(v || '').trim())
      .find((s) => s && !isGroupJid(s))
    participantPhone = jidToDigits(fromCandidate || '')
  } else {
    remoteJid = chatJid || fromJid
    const digits = jidToDigits(remoteJid) || jidToDigits(chatJid) || jidToDigits(fromJid)
    if (digits) {
      phone = normalizePhoneBR(digits) || digits
    } else {
      const lidJid = [chatJid, fromJid, remoteJid].find(isLidJid) || ''
      // Preserva o JID @lid para o pipeline (resolveConversationKeyFromZapi → lid:…).
      phone = lidJid || remoteJid
    }
  }

  const messageId = resolveWhapiEditTargetId(m) || ((m.id && String(m.id).trim()) ? String(m.id).trim() : null)

  // Resposta interativa (toque em botão/lista): o título vira o texto do inbound para a URA
  // tratar como uma resposta digitada; o id fica disponível p/ casamento exato futuro.
  const interactiveReply = (type === 'reply' || type === 'interactive')
    ? extractInteractiveReply(m)
    : null
  const pollVote = isPollVote ? extractPollVote(m) : null
  const pollMsg = (type === 'poll' && !isPollVote) ? extractPollMessage(m) : null

  // Voto: nunca colocar hash SHA-256 no body — enrich resolve para o texto da opção.
  // Até lá usamos placeholder (evita bolha com "a4ayc/80/…=" no chat).
  const pollVotePreview = pollVote
    ? (pollVote.options.some((o) => !looksLikePollOptionHash(o))
      ? pollVote.options.filter((o) => !looksLikePollOptionHash(o)).join(', ')
      : '') || '(voto na enquete)'
    : null

  // Texto: { text: { body } }; link_preview; resposta interativa; voto de enquete; caption em mídia.
  // Edição: prioriza extractWhapiEditedTexto (type=edit / action.edit / edited:true).
  const textBody = String(
    (isEdit && extractWhapiEditedTexto(m))
    || (m.text && (m.text.body ?? m.text))
    || (type === 'link_preview' && (m.link_preview?.body || m.link_preview?.title))
    || (interactiveReply && (interactiveReply.title || interactiveReply.id))
    || pollVotePreview
    || (pollMsg && pollPreviewText(pollMsg))
    || m.body
    || m.caption
    || m[type]?.caption
    || ''
  )

  // Mídia por tipo (Fase B faz o download; aqui já mapeamos a URL para não perder o link).
  // GIF (`type: gif`) e vídeo-recado circular (`type: short`, PTV) são MP4 no Whapi: sem este
  // mapeamento chegavam como "(mídia)" sem arquivo. Entram no pipeline como vídeo.
  const isVideoLike = type === 'video' || type === 'gif' || type === 'short'
  const imageUrl = type === 'image' ? mediaLink(m.image) : null
  const audioUrl = (type === 'audio' || type === 'voice' || type === 'ptt') ? mediaLink(m.audio ?? m.voice) : null
  const videoUrl = isVideoLike ? mediaLink(m[type] ?? m.video) : null
  const documentUrl = (type === 'document' || type === 'file') ? mediaLink(m.document ?? m.file) : null
  const stickerUrl = type === 'sticker' ? mediaLink(m.sticker) : null
  const captionText = m[type]?.caption ?? m.caption ?? null
  const fileName = m.document?.file_name ?? m.document?.filename ?? m.file?.filename ?? null

  // Reação: emoji + alvo.
  const reactionPayload = isReaction
    ? {
        value: m.action?.emoji ?? m.reaction?.emoji ?? m.emoji ?? '',
        emoji: m.action?.emoji ?? m.reaction?.emoji ?? m.emoji ?? '',
        time: m.timestamp ?? null,
        messageId: m.action?.target ?? m.reaction?.message_id ?? m.reaction?.target ?? m.context?.quoted_id ?? null,
      }
    : null

  // Citação / reply.
  const quotedId = m.context?.quoted_id ?? m.context?.quotedId ?? m.quoted_id ?? null
  const quotedMsg = m.context?.quoted_content ?? m.quotedMsg ?? (quotedId ? { id: quotedId } : null)

  // Localização.
  const locSrc = (type === 'location' && m.location)
    || (type === 'live_location' && (m.live_location || m.location))
    || null
  const loc = (locSrc && typeof locSrc === 'object') ? locSrc : null
  const locationPayload = loc ? {
    latitude: Number(loc.latitude ?? loc.lat) || 0,
    longitude: Number(loc.longitude ?? loc.lng) || 0,
    address: String(loc.address ?? loc.caption ?? '').trim(),
    name: String(loc.name ?? '').trim(),
  } : undefined

  const contactPayload = (type === 'contact' && m.contact && typeof m.contact === 'object')
    ? {
        displayName: m.contact.name || null,
        formattedName: m.contact.name || null,
        vCard: m.contact.vcard || m.contact.vCard || null,
      }
    : undefined

  const senderNameRaw = fromMe ? null : (m.from_name ?? m.notify ?? m.pushname ?? null)
  const senderName = senderNameRaw ? String(senderNameRaw).trim() : null

  const connectedPhone = ctx.connectedPhone
    ? (normalizePhoneBR(String(ctx.connectedPhone).replace(/\D/g, '')) || String(ctx.connectedPhone).replace(/\D/g, ''))
    : undefined

  // type interno: ptt→audio; reaction; senão o tipo Whapi (text vira 'chat' p/ compat com o pipeline).
  const internalType = isReaction ? 'reaction'
    : (type === 'ptt' || type === 'voice') ? 'audio'
    : (type === 'text' || type === 'link_preview' || type === 'edit' || isEdit) ? 'chat'
    : (type === 'reply' || type === 'interactive') ? 'chat'
    : isPollVote ? 'chat'
    : (type === 'poll') ? 'poll'
    : (type === 'live_location') ? 'location'
    : (type === 'gif' || type === 'short') ? 'video'
    : type

  return {
    instanceId: channelId,
    instance_id: channelId,
    event_type: 'message_received',
    fromMe,
    phone,
    remoteJid,
    isGroup,
    messageId,
    zaapId: messageId,
    id: messageId,
    body: textBody,
    message: textBody,
    text: { message: textBody },
    type: internalType,
    participantPhone: participantPhone || undefined,
    participant: participantPhone ? `${participantPhone}@c.us` : undefined,
    key: {
      remoteJid: remoteJid || phone,
      fromMe,
      id: messageId,
      participant: isGroup && fromJid ? fromJid : undefined,
    },
    chatId: remoteJid,
    chat: { id: remoteJid, remoteJid },
    timestamp: m.timestamp ? Number(m.timestamp) * 1000 : Date.now(),
    t: m.timestamp,
    ack: 'pending',
    status: 'RECEIVED',
    imageUrl: imageUrl || null,
    audioUrl: audioUrl || null,
    videoUrl: videoUrl || null,
    documentUrl: documentUrl || null,
    stickerUrl: stickerUrl || null,
    fileName: fileName || undefined,
    caption: captionText || undefined,
    interactiveReplyId: interactiveReply?.id || undefined,
    interactiveReplyTitle: interactiveReply?.title || undefined,
    pollVoteTarget: pollVote?.target || undefined,
    pollVoteOptions: pollVote?.options?.length ? pollVote.options : undefined,
    pollMeta: pollMsg || undefined,
    senderName,
    name: senderName,
    notifyName: senderName,
    pushName: senderName,
    connectedPhone,
    ownerPhone: connectedPhone,
    quotedMsg: quotedMsg || undefined,
    referenceMessageId: quotedId || undefined,
    ...(locationPayload ? { location: locationPayload } : {}),
    ...(reactionPayload ? { reaction: reactionPayload } : {}),
    ...(contactPayload ? { contact: contactPayload } : {}),
    isEdit,
  }
}

/** Converte um item de `statuses[]` do Whapi para o formato interno de ACK (statusZapi). */
function normalizeWhapiStatusToInternal(s, ctx = {}) {
  if (!s || typeof s !== 'object') return null
  const msgId = s.id ?? s.message_id ?? s.messageId ?? null
  if (!msgId) return null
  const ids = [String(msgId).trim()]
  return {
    instanceId: ctx.channelId,
    instance_id: ctx.channelId,
    type: 'MessageStatusCallback',
    messageId: msgId,
    zaapId: msgId,
    id: msgId,
    ids,
    ack: s.status ?? s.ack ?? 'pending',
    status: mapWhapiAckToStatus(s.status ?? s.ack, s.code),
    // Whapi não tem referenceId no envio; reconciliação por whatsapp_id (doc 25 §4).
    referenceId: null,
  }
}

/** res "capturado": registra status/body sem tocar o socket real (permite despachar item a item). */
function makeCaptureRes() {
  const captured = { statusCode: 200, body: null }
  const res = {
    statusCode: 200,
    status(code) { captured.statusCode = code; this.statusCode = code; return this },
    json(obj) { captured.body = obj; return this },
    send(obj) { captured.body = obj; return this },
    end() { return this },
    set() { return this },
    setHeader() { return this },
    get() { return undefined },
  }
  return { res, captured }
}

/** Despacha 1 payload normalizado ao handler do pipeline, capturando o status HTTP resultante. */
async function dispatchOne(handler, req, normalizedBody) {
  req.body = normalizedBody
  const { res: captureRes, captured } = makeCaptureRes()
  try {
    await handler(req, captureRes)
  } catch (e) {
    console.error('[WEBHOOK_WHAPI] handler lançou:', e?.message || e)
    return 500
  }
  return captured.statusCode || 200
}

/** Extrai arrays de eventos do corpo Whapi (tolerante a formatos). */
function extractEvents(body) {
  const messages = Array.isArray(body?.messages) ? body.messages
    : (body?.message ? [body.message] : [])
  const statuses = Array.isArray(body?.statuses) ? body.statuses
    : (body?.status && typeof body.status === 'object' ? [body.status] : [])
  const presences = Array.isArray(body?.presences) ? body.presences
    : (body?.presence && typeof body.presence === 'object' ? [body.presence] : [])
  const messagesUpdates = Array.isArray(body?.messages_updates) ? body.messages_updates
    : (body?.message_update ? [body.message_update] : [])
  return { messages, statuses, presences, messagesUpdates }
}

/**
 * Normaliza um item de `presences[]` do Whapi → payload de socket para o header da conversa.
 * Não toca o pipeline de mensagens; presença é efêmera (não persiste). Emite `presenca_contato`.
 */
function normalizeWhapiPresence(p, ctx = {}) {
  if (!p || typeof p !== 'object') return null
  const entry = p.contact_id ?? p.chat_id ?? p.id ?? p.entry_id ?? null
  if (!entry) return null
  const lastSeenRaw = p.last_seen ?? p.lastSeen
  const lastSeen = Number.isFinite(Number(lastSeenRaw)) ? Number(lastSeenRaw) : null
  return {
    channel_id: ctx.channelId,
    chat_id: String(entry),
    telefone: jidToDigits(String(entry)) || null,
    status: p.status ?? p.presence ?? null,
    last_seen: lastSeen,
  }
}

async function handleWebhookWhapi(req, res) {
  try {
    const body = req.body
    if (!body || typeof body !== 'object') {
      req.webhookLogData = { status: 'ignored', error: 'payload_invalido' }
      return res.status(200).json({ ok: true })
    }
    const ctxSrc = req.webhookContext || req.zapiContext
    if (!ctxSrc || ctxSrc.company_id == null) {
      return res.status(200).json({ ok: true })
    }
    const ctx = {
      channelId: ctxSrc.provider_instance_id || ctxSrc.instanceId,
      connectedPhone: ctxSrc.connected_phone || ctxSrc.telefone_conectado || null,
    }

    const { messages, statuses, presences, messagesUpdates } = extractEvents(body)
    req.webhookLogData = {
      status: 'processed',
      company_id: ctxSrc.company_id,
      instance_id: ctx.channelId,
      event_type: 'whapi',
      counts: {
        messages: messages.length,
        statuses: statuses.length,
        presences: presences.length,
        messages_updates: messagesUpdates.length,
      },
    }

    let anyServerError = false
    let skippedHistorical = 0
    const nowMs = Date.now()
    const whapiMaxAgeMs = effectiveWhapiMaxAgeMs(ctxSrc) // teto de idade por canal (config de sync)
    const io = req.app?.get?.('io')

    for (const upd of messagesUpdates) {
      try {
        await applyWhapiPollMessageUpdate(ctxSrc, upd, io)
        const trigger = upd?.trigger
        if (trigger && isWhapiEditedMessage(trigger)) {
          await applyWhapiEditedMessage(ctxSrc, trigger, io)
        }
        // messages.patch com after_update editado (texto/legenda do cliente)
        const after = upd?.after_update || upd?.after || null
        if (after && isWhapiEditedMessage(after)) {
          await applyWhapiEditedMessage(ctxSrc, after, io)
        } else if (after && (upd?.before_update || upd?.before) && String(after.type || '').toLowerCase() !== 'poll') {
          // Diff de texto/caption sem flag edited explícita — trata como edição se o id existir.
          const before = upd.before_update || upd.before
          const afterText = extractWhapiEditedTexto(after)
          const beforeText = extractWhapiEditedTexto(before)
          if (afterText && afterText !== beforeText && after.id) {
            await applyWhapiEditedMessage(ctxSrc, { ...after, edited: true }, io)
          }
        }
      } catch (e) {
        console.warn('[WHAPI] messages_updates falhou:', e?.message || e)
      }
    }

    for (const m of messages) {
      // Guarda anti-histórico: no (re)connect / webhook persistente o Whapi reentrega backlog
      // antigo com o timestamp original. Descartamos antes de criar conversa/contato/mensagem.
      if (whapiInboundIsHistorical(m, nowMs, whapiMaxAgeMs)) {
        skippedHistorical++
        continue
      }
      if (isWhapiEditedMessage(m)) {
        const applied = await applyWhapiEditedMessage(ctxSrc, m, io)
        if (applied) continue
      }
      let normalized = normalizeWhapiMessageToInternal(m, ctx)
      if (!normalized) continue
      if (normalized.pollVoteTarget) {
        try {
          normalized = await enrichNormalizedPollVote(normalized, ctxSrc, io)
        } catch (e) {
          console.warn('[WHAPI] enrich poll vote falhou:', e?.message || e)
        }
      }
      normalized.type = 'ReceivedCallback'
      normalized.instanceId = ctx.channelId
      normalized.instance_id = ctx.channelId
      const code = await dispatchOne(webhookCoreController.receberZapi, req, normalized)
      if (Number(code) >= 500) anyServerError = true
    }

    if (skippedHistorical > 0 && req.webhookLogData?.counts) {
      req.webhookLogData.counts.skipped_historical = skippedHistorical
    }

    for (const s of statuses) {
      const normalized = normalizeWhapiStatusToInternal(s, ctx)
      if (!normalized) continue
      await dispatchOne(webhookCoreController.statusZapi, req, normalized)
    }

    if (presences.length && io) {
      for (const p of presences) {
        const payload = normalizeWhapiPresence(p, ctx)
        if (!payload) continue
        try {
          io.to(`empresa_${ctxSrc.company_id}`).emit('presenca_contato', { ...payload, company_id: ctxSrc.company_id })
        } catch (e) {
          console.warn('[WEBHOOK_WHAPI] emit presenca_contato falhou:', e?.message || e)
        }
      }
    }

    // Erro interno persistente no inbound → 500 para o provider reentregar (idempotência protege duplicata).
    if (anyServerError) return res.status(500).json({ ok: false, error: 'inbound_processing_error' })
    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('[handleWebhookWhapi]', e?.message || e)
    req.webhookLogData = { status: 'error', error_message: e?.message || String(e) }
    return res.status(200).json({ ok: true })
  }
}

exports.healthWhapi = (req, res) => res.status(200).json({ ok: true, provider: 'whapi' })

exports.testarWhapi = (req, res) => {
  const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
  return res.status(200).json({
    ok: true,
    provider: 'whapi',
    message: 'Configure o webhook do canal no painel Whapi (Settings → Webhooks) apontando para esta URL com header X-Webhook-Token',
    webhook_url: `${base}/webhooks/whapi`,
  })
}

exports.handleWebhookWhapi = handleWebhookWhapi
exports._test = {
  normalizeWhapiMessageToInternal,
  normalizeWhapiStatusToInternal,
  mapWhapiAckToStatus,
  extractEvents,
  jidToDigits,
  isLidJid,
  isWhapiEditedMessage,
  resolveWhapiEditTargetId,
  extractWhapiEditedTexto,
  extractInteractiveReply,
  extractPollVote,
  normalizeWhapiPresence,
  resolvePollVoteLabels,
  enrichNormalizedPollVote,
  whapiMessageEpochMs,
  whapiInboundIsHistorical,
  getWhapiInboundMaxAgeMs,
}
