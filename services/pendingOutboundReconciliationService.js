/**
 * Reconcilia mensagens outbound pending/sending e revalida `sent` da Whapi.
 *
 * Cenário: UltraMSG aceita o envio (ok=true) mas retorna ID de fila interno ou
 * o webhook message_create/message_ack demora/falha. Este serviço consulta a API
 * UltraMSG (GET /messages por referenceId ou id) e corrige status no banco.
 */

const supabase = require('../config/supabase')
const { getProvider } = require('./providers')
const { resolveConversationProvider } = require('./chat/identity/conversationAddressService')
const {
  isRealWhatsAppId,
  extractUltraMsgMessageId,
  isUltramsgNumericQueueId,
  buildCrmReferenceId,
} = require('../helpers/whatsappMessageIdHelper')
const { formatTextoWhatsappComNomeAtendente } = require('../helpers/mensagemAtendenteNomeHelper')
const { captionWhatsappParaMidia } = require('../helpers/midiaMensagemHelper')
const { isInternalNoteRow } = require('../helpers/internalNote')
const { STATUS_RANK, statusRank, canonStatusForEmit } = require('../helpers/messageStatusHelper')
const { despachoEmAndamento } = require('./chat/outbound/outboundDispatchRegistry')
const { isTransientOutboundFailure } = require('./chat/outbound/outboundFailureClassifier')
const { parseTimestampSemFusoComoUtc } = require('../helpers/timestampApiCompat')

const deferredTimers = new Map()
const companyProviderCache = new Map()
const COMPANY_CACHE_TTL_MS = 60_000

function parsePositiveIntEnv(name, fallback, { min = 1, max = 10_080 } = {}) {
  const n = Number(process.env[name])
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function isEnabled() {
  const raw = String(process.env.PENDING_OUTBOUND_RECONCILE_ENABLED ?? 'true').trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(raw)
}

function getGraceMs() {
  return parsePositiveIntEnv('PENDING_OUTBOUND_RECONCILE_GRACE_MINUTES', 3, { min: 1, max: 120 }) * 60_000
}

function getFailAfterMs() {
  return parsePositiveIntEnv('PENDING_OUTBOUND_RECONCILE_FAIL_AFTER_MINUTES', 60, { min: 5, max: 1440 }) * 60_000
}

/** Reenvio automatico de mensagens que o provedor nunca aceitou. */
function isResendEnabled() {
  const raw = String(process.env.PENDING_OUTBOUND_RESEND_ENABLED ?? 'true').trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(raw)
}

/** Janela em que ainda vale reenviar. Depois dela a mensagem vira falha definitiva. */
function getResendWindowMs() {
  return parsePositiveIntEnv('PENDING_OUTBOUND_RESEND_WINDOW_MINUTES', 30, { min: 5, max: 240 }) * 60_000
}

/** Faixa "recente" da varredura: cobre a janela de reenvio e a de falha, com folga. */
function getRecentWindowMs() {
  return Math.max(getFailAfterMs(), getResendWindowMs()) + 30 * 60_000
}

/** Cursor (por empresa+status) do rodízio sobre o acúmulo antigo de pendentes. */
const _acumuloCursor = new Map()

/**
 * Whapi aceitou (há id) mas nunca confirmou: depois deste prazo a linha vira erro em vez de
 * ficar no relógio por dias. Um ACK tardio ainda recupera a linha (sent vence erro).
 */
function getWhapiUnackedFailMs() {
  return parsePositiveIntEnv('PENDING_OUTBOUND_WHAPI_UNACKED_FAIL_MINUTES', 120, { min: 15, max: 10_080 }) * 60_000
}

function getBatchLimit() {
  return parsePositiveIntEnv('PENDING_OUTBOUND_RECONCILE_BATCH_LIMIT', 50, { min: 1, max: 200 })
}

function getLookbackMs() {
  return parsePositiveIntEnv('PENDING_OUTBOUND_RECONCILE_LOOKBACK_HOURS', 168, { min: 1, max: 336 }) * 60 * 60 * 1000
}

function messageAgeMs(row) {
  // criado_em é `timestamp without time zone` (UTC) e chega sem "Z": Date.parse puro o leria no
  // fuso do servidor, deslocando carência/janelas em horas fora de UTC.
  const ts = parseTimestampSemFusoComoUtc(row?.criado_em)
  return Number.isFinite(ts) ? Date.now() - ts : 0
}

function providerRowStatus(row) {
  return String(row?.status ?? '').trim().toLowerCase()
}

function providerRowAck(row) {
  return String(row?.ack ?? '').trim().toLowerCase()
}

function providerRowIndicatesSuccess(row) {
  const status = providerRowStatus(row)
  const ack = providerRowAck(row)
  if (['sent', 'server', 'device', 'read', 'played', 'delivered'].includes(status)) return true
  if (['sent', 'server', 'device', 'read', 'played', 'delivered'].includes(ack)) return true
  if (/^[1-4]$/.test(ack)) return true
  return false
}

function providerRowIndicatesFailure(row) {
  const status = providerRowStatus(row)
  return ['unsent', 'invalid', 'expired', 'failed', 'error', 'erro'].includes(status)
}

function providerRowInQueue(row) {
  return providerRowStatus(row) === 'queue'
}

function providerRowIndicatesPending(row) {
  const status = providerRowStatus(row)
  const ack = providerRowAck(row)
  return status === 'pending' || ack === 'pending' || ack === '0'
}

function mapProviderAckToStatus(row) {
  const ack = providerRowAck(row)
  const status = providerRowStatus(row)
  if (/^\d+$/.test(ack)) {
    const n = Number(ack)
    if (n <= 0) return 'pending'
    if (n === 1) return 'sent'
    if (n === 2) return 'delivered'
    if (n === 3) return 'read'
    if (n >= 4) return 'played'
  }
  if (['read', 'played', 'seen'].includes(ack)) return ack === 'played' ? 'played' : 'read'
  if (['delivered', 'device', 'received'].includes(ack)) return 'delivered'
  if (['sent', 'server'].includes(ack)) return 'sent'
  if (['pending', 'queue'].includes(ack)) return 'pending'
  if (['read', 'played', 'seen'].includes(status)) return status === 'played' ? 'played' : 'read'
  if (['delivered', 'device', 'received'].includes(status)) return 'delivered'
  if (['sent', 'server'].includes(status)) return 'sent'
  if (['pending', 'queue'].includes(status)) return 'pending'
  if (providerRowIndicatesSuccess(row)) return 'sent'
  return 'sent'
}

function buildProviderOpts(row) {
  return {
    companyId: row.company_id,
    whatsappInstanceId: row.whatsapp_instance_id || undefined,
  }
}

async function fetchProviderMessages(opts, filters = {}) {
  const instanceProvider = await resolveConversationProvider(opts.companyId, opts.whatsappInstanceId)
  const provider = getProvider({ provider: instanceProvider })
  if (!provider?.getMessages) return { ok: false, data: [], error: 'provider_indisponivel' }
  try {
    return await provider.getMessages({
      ...opts,
      page: 1,
      limit: Math.min(10, Number(filters.limit) || 5),
      sort: 'desc',
      status: filters.status || 'all',
      ...(filters.referenceId ? { referenceId: filters.referenceId } : {}),
      ...(filters.id ? { id: filters.id } : {}),
    })
  } catch (e) {
    return { ok: false, data: [], error: e?.message || String(e) }
  }
}

function emitStatusUpdate(io, row, payload) {
  if (!io || !row) return
  const eventPayload = {
    mensagem_id: row.id,
    conversa_id: row.conversa_id,
    status: payload.status,
    status_mensagem: payload.status_mensagem || payload.status,
    ...(payload.whatsapp_id ? { whatsapp_id: payload.whatsapp_id } : {}),
  }
  let chain = io.to(`empresa_${row.company_id}`).to(`conversa_${row.conversa_id}`)
  if (row.autor_usuario_id != null) chain = chain.to(`usuario_${row.autor_usuario_id}`)
  chain.emit('status_mensagem', eventPayload)
}

/**
 * `row` é a leitura feita no início do ciclo; entre ela e a gravação há uma consulta ao
 * provedor (e, na varredura, até 50 mensagens em sequência). Um ACK do webhook que chegue nesse
 * intervalo (ex.: `read`) seria sobrescrito pelo status mais antigo que a consulta devolveu
 * (ex.: `delivered`) — o tique regrediria no banco. Relê o status logo antes de gravar e nunca
 * rebaixa: progresso só sobe; a reversão sent→pending e o erro não se aplicam sobre mensagem
 * que já consta como entregue/lida. Leitura falhou → segue como antes (não bloqueia).
 */
async function statusJaMaisAvancado(row, updates) {
  if (updates?.status == null) return false
  let atual = null
  try {
    const { data } = await supabase
      .from('mensagens')
      .select('status, status_mensagem')
      .eq('company_id', row.company_id)
      .eq('id', row.id)
      .maybeSingle()
    atual = data || null
  } catch (_) {
    return false
  }
  if (!atual) return false
  const ranks = [atual.status, atual.status_mensagem]
    .filter((v) => v != null && String(v).trim() !== '')
    .map((v) => statusRank(v))
  if (!ranks.length) return false
  const rankAtual = Math.max(...ranks)
  const proximo = canonStatusForEmit(updates.status)
  if (proximo === 'erro') return rankAtual >= STATUS_RANK.delivered
  if (proximo === 'pending') return rankAtual > STATUS_RANK.sent
  return rankAtual > statusRank(proximo)
}

async function patchMessage(row, updates, io) {
  if (await statusJaMaisAvancado(row, updates)) {
    return { ok: true, action: 'keep_status_mais_avancado', mensagem_id: row.id }
  }
  const { data, error } = await supabase
    .from('mensagens')
    .update(updates)
    .eq('company_id', row.company_id)
    .eq('id', row.id)
    .select('id, company_id, conversa_id, autor_usuario_id, status, status_mensagem, whatsapp_id')
    .maybeSingle()

  if (error || !data) {
    return { ok: false, action: 'patch_failed', error: error?.message || 'update_failed' }
  }

  emitStatusUpdate(io, data, updates)

  // Rollout R2 (empresa 1): quando a reconciliação confirma o envio (status final), espelha a
  // mídia para o Cloudflare R2 na hora. No-op para texto / outras empresas / R2 desligado.
  if (['sent', 'delivered', 'read', 'played'].includes(String(updates.status || '').toLowerCase())) {
    try {
      const { scheduleR2MirrorIfNeeded } = require('./mediaR2MirrorService')
      scheduleR2MirrorIfNeeded({ supabase, io, company_id: row.company_id, mensagem_id: row.id })
    } catch (_) { /* best-effort */ }
  }

  return { ok: true, action: 'patched', status: updates.status, mensagem_id: data.id }
}

async function resolveFromProviderRow(row, providerRow, io) {
  if (!providerRow) return { ok: true, action: 'noop' }

  if (providerRowIndicatesFailure(providerRow)) {
    return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
  }

  // A Whapi pode ter retornado apenas o ID no POST e o ZapERP legado ter
  // promovido a linha para `sent`. Se o GET do proprio ID ainda informa
  // `pending`, revertemos somente o estado local; nunca reenviamos a mensagem.
  if (providerRowIndicatesPending(providerRow)) {
    const currentStatus = String(row.status_mensagem || row.status || '').toLowerCase()
    if (currentStatus === 'sent') {
      return patchMessage(row, { status: 'pending', status_mensagem: 'sending' }, io)
    }
    return { ok: true, action: 'keep_provider_pending' }
  }

  if (providerRowInQueue(providerRow)) {
    return { ok: true, action: 'keep_queue' }
  }

  if (providerRowIndicatesSuccess(providerRow)) {
    const waId = extractUltraMsgMessageId(providerRow)
    const nextStatus = mapProviderAckToStatus(providerRow)
    const updates = {
      status: nextStatus,
      status_mensagem: nextStatus,
    }
    // whatsapp_id só recebe ID real do WhatsApp; queue ID numérico vai para provider_queue_id.
    if (isRealWhatsAppId(waId)) updates.whatsapp_id = String(waId).trim()
    else if (isUltramsgNumericQueueId(waId) && !row.provider_queue_id) updates.provider_queue_id = String(waId).trim()
    const sameStatus = String(row.status || '').toLowerCase() === nextStatus &&
      String(row.status_mensagem || row.status || '').toLowerCase() === nextStatus
    const sameId = !updates.whatsapp_id || String(row.whatsapp_id || '').trim() === updates.whatsapp_id
    if (sameStatus && sameId && !updates.provider_queue_id) {
      return { ok: true, action: 'confirmed_unchanged', status: nextStatus, mensagem_id: row.id }
    }
    return patchMessage(row, updates, io)
  }

  return { ok: true, action: 'noop' }
}

async function queryProviderForMessage(row) {
  const opts = buildProviderOpts(row)
  const instanceProvider = await resolveConversationProvider(opts.companyId, opts.whatsappInstanceId)
  const isWhapi = String(instanceProvider || '').trim().toLowerCase() === 'whapi'
  const idCandidates = [...new Set([
    row.whatsapp_id != null ? String(row.whatsapp_id).trim() : '',
    row.provider_queue_id != null ? String(row.provider_queue_id).trim() : '',
  ].filter(Boolean))]

  // Whapi nao tem referenceId e ignora o filtro de status: um GET /messages/{id}
  // basta. Repetir a consulta 6x no 404 so estressa rate-limit e nao muda o resultado.
  if (isWhapi) {
    if (!idCandidates.length) return { source: null, row: null, list: [], consultaOk: true }
    let consultaOk = false
    for (const idCandidate of idCandidates) {
      const result = await fetchProviderMessages(opts, { id: idCandidate, limit: 1 })
      if (result.ok) consultaOk = true
      if (result.ok && Array.isArray(result.data) && result.data.length > 0) {
        return { source: 'id:whapi', row: result.data[0], list: result.data, consultaOk: true }
      }
    }
    return { source: null, row: null, list: [], consultaOk }
  }

  const referenceId = buildCrmReferenceId(row.id)
  // consultaOk distingue "provedor respondeu e nao tem a mensagem" de "nao consegui perguntar".
  // Sem essa distincao um reenvio automatico duplicaria mensagem ja entregue quando a API falha.
  let consultaOk = false

  if (referenceId) {
    for (const status of ['all', 'sent', 'queue', 'unsent', 'invalid', 'expired']) {
      const result = await fetchProviderMessages(opts, { referenceId, status, limit: 3 })
      if (result.ok) consultaOk = true
      if (result.ok && Array.isArray(result.data) && result.data.length > 0) {
        return { source: `referenceId:${status}`, row: result.data[0], list: result.data, consultaOk: true }
      }
    }
  }

  // Busca por ID: usa whatsapp_id (linhas antigas com queue id) ou provider_queue_id (linhas novas).
  // O parâmetro `id` da UltraMsg espera o ID interno numérico deles — exatamente o queue id.
  for (const idCandidate of idCandidates) {
    for (const status of ['all', 'sent', 'queue', 'unsent', 'invalid', 'expired']) {
      const result = await fetchProviderMessages(opts, { id: idCandidate, status, limit: 3 })
      if (result.ok) consultaOk = true
      if (result.ok && Array.isArray(result.data) && result.data.length > 0) {
        return { source: `id:${status}`, row: result.data[0], list: result.data, consultaOk: true }
      }
    }
  }

  return { source: null, row: null, list: [], consultaOk }
}

/**
 * Provedor comprovadamente nunca aceitou a mensagem.
 * Qualquer id de fila ou WhatsApp id significa que o UltraMSG a recebeu: reenviar duplicaria no cliente.
 */
function provedorNuncaAceitou(row) {
  if (isRealWhatsAppId(row?.whatsapp_id)) return false
  if (String(row?.provider_queue_id || '').trim()) return false
  if (isUltramsgNumericQueueId(String(row?.whatsapp_id || '').trim())) return false
  return true
}

/** URL publica da midia persistida; null quando o backend nao esta acessivel de fora. */
function urlPublicaDeMidia(row) {
  const raw = String(row?.url || '').trim()
  if (!raw) return null
  // Mídia no Cloudflare R2: devolve URL assinada DIRETA (o provedor baixa sem redirect e sem
  // depender do arquivo local, que pode já ter sido purgado). Cobre o reenvio de mídia da empresa 1.
  if (String(row?.storage_backend || '').toLowerCase() === 'r2' && row?.storage_key) {
    try {
      const { presignGetUrl } = require('./storage/r2Client')
      const { getPresignExpiresSeconds } = require('../config/r2')
      return presignGetUrl(row.storage_key, Math.max(3600, getPresignExpiresSeconds()))
    } catch (_) { /* cai para o comportamento antigo abaixo */ }
  }
  if (/^https?:\/\//i.test(raw)) return raw
  const baseUrl = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/$/, '')
  if (!baseUrl || /localhost|127\.0\.0\.1/i.test(baseUrl)) return null
  return `${baseUrl}${raw.startsWith('/') ? raw : `/${raw}`}`
}

async function nomeAtendenteParaEnvio(company_id, autor_usuario_id) {
  if (!autor_usuario_id) return null
  const { data } = await supabase
    .from('usuarios')
    .select('nome, mostrar_nome_ao_cliente')
    .eq('company_id', company_id)
    .eq('id', autor_usuario_id)
    .maybeSingle()
  if (data?.mostrar_nome_ao_cliente === false) return null
  return (data?.nome && String(data.nome).trim()) || null
}

/** Legenda original do atendente a partir do texto persistido (inverte placeholders de midia). */
function captionUsuarioDeMidia(row) {
  const texto = String(row?.texto || '').trim()
  if (!texto) return ''
  const placeholders = new Set(['(áudio)', '(áudio de voz)', '(figurinha)', '(imagem)', '(vídeo)', '(arquivo)'])
  if (placeholders.has(texto.toLowerCase())) return ''
  if (texto === String(row?.nome_arquivo || '').trim()) return ''
  return texto
}

const TIPOS_MIDIA_REENVIAVEIS = new Set([
  'voice', 'audio', 'sticker', 'imagem', 'video', 'vídeo', 'arquivo', 'documento', 'document', 'file',
])

async function despacharReenvioAoProvedor(row, telefone, usuarioNome) {
  const instanceProvider = await resolveConversationProvider(row.company_id, row.whatsapp_instance_id)
  const provider = getProvider({ provider: instanceProvider })
  const tipo = String(row?.tipo || '').toLowerCase().trim()
  const opts = {
    companyId: row.company_id,
    conversaId: row.conversa_id,
    whatsappInstanceId: row.whatsapp_instance_id || undefined,
    referenceId: buildCrmReferenceId(row.id),
    sendOrigin: 'reconciliacao_reenvio_automatico',
    returnDetails: true,
  }

  const isTexto = !tipo || ['texto', 'text', 'chat', 'link'].includes(tipo)
  if (isTexto) {
    const texto = String(row?.texto || '').trim()
    if (!texto) return { skip: 'sem_texto' }
    if (!provider?.sendText) return { skip: 'provider_sem_sendtext' }
    return {
      result: await provider.sendText(telefone, formatTextoWhatsappComNomeAtendente(texto, usuarioNome), opts),
    }
  }

  // Só tipos de MÍDIA têm reenvio automático. Localização guarda o link do mapa em `url`,
  // e contato/enquete/produto/Pix/interativa não são arquivos: sem esta lista, a linha caía no
  // sendFile do fim da função e o cliente recebia o link do mapa como um "documento".
  if (!TIPOS_MIDIA_REENVIAVEIS.has(tipo)) return { skip: 'tipo_sem_reenvio_automatico' }

  const mediaUrl = urlPublicaDeMidia(row)
  if (!mediaUrl) return { skip: 'midia_sem_url_publica' }
  const caption = captionWhatsappParaMidia({
    tipo,
    captionUsuarioTrim: captionUsuarioDeMidia(row),
    usuarioNome,
  })

  if (tipo === 'voice' && provider?.sendVoice) return { result: await provider.sendVoice(telefone, mediaUrl, opts) }
  if (tipo === 'audio' && provider?.sendAudio) return { result: await provider.sendAudio(telefone, mediaUrl, opts) }
  if (tipo === 'sticker' && provider?.sendSticker) {
    return { result: await provider.sendSticker(telefone, mediaUrl, { ...opts, stickerAuthor: 'ZapERP' }) }
  }
  if (tipo === 'imagem' && provider?.sendImage) {
    return { result: await provider.sendImage(telefone, mediaUrl, caption, opts) }
  }
  if ((tipo === 'video' || tipo === 'vídeo') && provider?.sendVideo) {
    return { result: await provider.sendVideo(telefone, mediaUrl, caption, opts) }
  }
  if (provider?.sendFile) {
    return {
      result: await provider.sendFile(telefone, mediaUrl, row?.nome_arquivo || 'arquivo', { ...opts, caption }),
    }
  }
  return { skip: 'provider_sem_envio_midia' }
}

/** Tipos que o reenvio de TEXTO cobre (mesma lista do despacho). */
function isTipoTextoReenviavel(tipo) {
  const t = String(tipo || '').toLowerCase().trim()
  return !t || ['texto', 'text', 'chat', 'link'].includes(t)
}

/** Liga/desliga a confirmacao+reenvio Whapi pelo historico do chat (default ligado). */
function whapiHistoryResendEnabled() {
  const raw = String(process.env.WHAPI_HISTORY_RESEND_ENABLED ?? 'true').trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(raw)
}

/** Normaliza texto para comparacao exata (CRLF/espacos multiplos nao podem quebrar o match). */
function normalizarTextoParaComparacao(s) {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
}

/**
 * Confirmacao de AUSENCIA/PRESENCA na Whapi pelo historico do chat (GET /messages/list/{ChatID}).
 * A Whapi nao tem idempotencia nem referenceId no envio (confirmado no MCP/OpenAPI): para uma
 * linha SEM nenhum id, o historico do chat e a unica fonte capaz de dizer se o texto saiu —
 * o equivalente funcional da consulta por referenceId da UltraMSG.
 *
 * Match EXATO apenas (texto puro ou com o prefixo do atendente reconstruido): um endsWith
 * frouxo poderia "curar" apontando para OUTRA mensagem nossa e esconder uma perda real.
 */
async function consultarHistoricoWhapiPorTexto({ row, provider, telefone, usuarioNome }) {
  if (!provider?.getChatMessages) return { consultaOk: false }
  const cacheKey = `${row.company_id}:${row.whatsapp_instance_id || 'default'}:${telefone}`
  let res
  // timeFrom ativa as variantes de chat id (com/sem o 9º dígito). Sem ele a consulta usava
  // só a forma com o 9 forçado: para contato cujo JID real tem 12 dígitos a lista voltava
  // vazia, a ausência era "confirmada" e uma mensagem já entregue era reenviada.
  const criadoRef = parseTimestampSemFusoComoUtc(row.criado_em)
  const timeFrom = Number.isFinite(criadoRef) ? Math.floor((criadoRef - 2 * 60_000) / 1000) : null
  const cached = _historicoWhapiCache.get(cacheKey)
  // O cache só serve se a consulta guardada começou NO MESMO ponto ou antes do que esta linha
  // precisa; uma consulta feita para uma mensagem mais nova não enxerga a mais antiga.
  const cacheCobre = cached && (timeFrom == null ? cached.timeFrom == null : (cached.timeFrom == null || cached.timeFrom <= timeFrom))
  if (cached && cacheCobre && Date.now() - cached.ts < HISTORICO_CACHE_TTL_MS) {
    res = cached.res
  } else {
    try {
      res = await provider.getChatMessages(telefone, 30, null, {
        companyId: row.company_id,
        whatsappInstanceId: row.whatsapp_instance_id || undefined,
        returnDetails: true,
        ...(timeFrom != null ? { timeFrom } : {}),
      })
    } catch (_) {
      return { consultaOk: false }
    }
    if (res?.ok === true && Array.isArray(res.data)) {
      if (_historicoWhapiCache.size > 200) _historicoWhapiCache.clear()
      _historicoWhapiCache.set(cacheKey, { ts: Date.now(), res, timeFrom })
    }
  }
  if (res?.ok !== true || !Array.isArray(res.data)) return { consultaOk: false }

  const textoPuro = normalizarTextoParaComparacao(row.texto)
  if (!textoPuro) return { consultaOk: true, encontrado: false }
  const alvos = new Set([textoPuro])
  try {
    const comNome = normalizarTextoParaComparacao(
      formatTextoWhatsappComNomeAtendente(String(row.texto || '').trim(), usuarioNome)
    )
    if (comNome) alvos.add(comNome)
  } catch (_) { /* sem nome: compara so o texto puro */ }
  // Encaminhamento: o texto que foi ao WhatsApp é "[Encaminhado] / <texto> / — <Nome>" (em
  // linhas separadas), diferente do que fica gravado na linha. Sem estes alvos a mensagem
  // encaminhada entregue nunca casava com o histórico, a ausência era "confirmada" e ela era
  // reenviada em duplicidade.
  try {
    const bruto = String(row.texto || '').trim()
    const semPrefixo = bruto.replace(/^\[Encaminhado\]\s*/i, '').trim()
    const nome = String(usuarioNome || '').trim()
    const NL = String.fromCharCode(10)
    for (const corpo of [
      ['[Encaminhado]', semPrefixo].join(NL),
      ['[Encaminhado]', semPrefixo, `— ${nome}`].join(NL),
    ]) {
      const alvo = normalizarTextoParaComparacao(corpo)
      if (alvo) alvos.add(alvo)
    }
  } catch (_) { /* alvos extras são best-effort */ }

  const criadoMs = parseTimestampSemFusoComoUtc(row.criado_em)
  const desdeSeg = Number.isFinite(criadoMs) ? Math.floor((criadoMs - 2 * 60_000) / 1000) : 0

  // RAJADA COM TEXTOS IDÊNTICOS ("ok" duas vezes no mesmo minuto): o histórico pode conter
  // a cópia do IRMÃO que foi entregue — curar esta linha com aquele id gravaria um
  // whatsapp_id já reivindicado (UNIQUE) e marcaria sent uma mensagem que o cliente nunca
  // recebeu. Coleta TODOS os matches da janela e só cura com um id ainda livre; se todas as
  // cópias pertencem a outras linhas, é ausência real → o chamador segue para o reenvio
  // seguro (com releitura da linha antes).
  const candidatosComId = []
  let candidatoSemId = null
  for (const m of res.data) {
    const fromMe = m?.from_me === true || m?.fromMe === true
    if (!fromMe) continue
    const tsRaw = Number(m?.timestamp) || 0
    const tsSeg = tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : tsRaw
    if (desdeSeg && tsSeg && tsSeg < desdeSeg) continue
    const corpo = normalizarTextoParaComparacao(m?.body ?? m?.text?.body ?? '')
    if (!corpo || !alvos.has(corpo)) continue
    const idItem = String(m?.id || '').trim()
    if (idItem) candidatosComId.push(m)
    else if (!candidatoSemId) candidatoSemId = m
  }

  if (candidatosComId.length) {
    let reivindicados = new Set()
    try {
      const ids = candidatosComId.map((m) => String(m.id).trim())
      const { data: donos } = await supabase
        .from('mensagens')
        .select('id, whatsapp_id')
        .eq('company_id', row.company_id)
        .in('whatsapp_id', ids)
      reivindicados = new Set(
        (donos || [])
          .filter((d) => Number(d.id) !== Number(row.id))
          .map((d) => String(d.whatsapp_id || '').trim())
      )
    } catch (_) {
      // Consulta de reivindicação falhou: NÃO curar às cegas (poderia roubar o id do irmão);
      // devolve inconclusivo e o fluxo conservador mantém pending até o próximo ciclo.
      return { consultaOk: false }
    }
    const livre = candidatosComId.find((m) => !reivindicados.has(String(m.id).trim()))
    if (livre) return { consultaOk: true, encontrado: true, mensagem: livre }
    if (candidatosComId.length && !candidatoSemId) {
      // Todas as cópias do texto já pertencem a outras linhas: ESTA mensagem não chegou.
      return { consultaOk: true, encontrado: false }
    }
  }

  if (candidatoSemId) return { consultaOk: true, encontrado: true, mensagem: candidatoSemId }
  return { consultaOk: true, encontrado: false }
}

/**
 * Lock em processo por mensagem durante o REENVIO: o timer diferido (90s pós-envio) e o
 * sweep (5min) podem processar a MESMA linha em paralelo — ambos confirmavam a ausência,
 * ambos passavam na releitura (janela = duração do sendText) e o cliente recebia em dobro.
 * PM2 roda 1 instância (fork), então o Set cobre o processo inteiro.
 */
const _reenviosEmAndamento = new Set()

/** Cache curto do histórico Whapi por chat: N textos pendentes da MESMA conversa num ciclo
 * (rajada durante outage) viravam N GETs idênticos — 1 basta. */
const _historicoWhapiCache = new Map()
const HISTORICO_CACHE_TTL_MS = 45_000

/** Releitura minima da linha antes de reenviar: o eco from_me pode ter chegado na corrida. */
async function rowAindaSemAceiteNoBanco(row) {
  const { data, error } = await supabase
    .from('mensagens')
    .select('id, status, status_mensagem, whatsapp_id, provider_queue_id')
    .eq('company_id', row.company_id)
    .eq('id', row.id)
    .maybeSingle()
  if (error || !data) return false
  const st = String(data.status_mensagem || data.status || '').toLowerCase()
  if (!['pending', 'sending'].includes(st)) return false
  return provedorNuncaAceitou(data)
}

/**
 * Reenvia mensagem que o provedor nunca aceitou. Chamado somente apos confirmar,
 * consultando a API, que o UltraMSG nao tem registro dela.
 */
async function reenviarMensagemNaoAceita(row, io, { aguardarAck = false } = {}) {
  const lockKey = `${row.company_id}:${row.id}`
  if (_reenviosEmAndamento.has(lockKey)) {
    return { ok: true, action: 'keep_reenvio_em_andamento' }
  }
  _reenviosEmAndamento.add(lockKey)
  try {
    return await _reenviarMensagemNaoAceitaInterno(row, io, { aguardarAck })
  } finally {
    _reenviosEmAndamento.delete(lockKey)
  }
}

async function _reenviarMensagemNaoAceitaInterno(row, io, { aguardarAck = false } = {}) {
  const { data: conversa } = await supabase
    .from('conversas')
    .select('id, telefone')
    .eq('company_id', row.company_id)
    .eq('id', row.conversa_id)
    .maybeSingle()

  const telefone = String(conversa?.telefone || '').trim()
  if (!telefone || telefone.toLowerCase().startsWith('lid:')) {
    return { ok: true, action: 'skip_reenvio_sem_telefone' }
  }

  const usuarioNome = await nomeAtendenteParaEnvio(row.company_id, row.autor_usuario_id)

  let despacho
  try {
    despacho = await despacharReenvioAoProvedor(row, telefone, usuarioNome)
  } catch (e) {
    console.warn('[pendingOutboundReconciliation] reenvio falhou no transporte', {
      mensagem_id: row.id,
      company_id: row.company_id,
      error: e?.message || e,
    })
    return { ok: true, action: 'reenvio_erro_transporte' }
  }

  if (despacho?.skip) return { ok: true, action: `skip_reenvio_${despacho.skip}` }

  const result = despacho.result
  const ok = typeof result === 'boolean' ? result : result?.ok === true
  const waMessageId =
    typeof result === 'object' && result?.messageId ? String(result.messageId).trim() : null
  const hasValidId = isRealWhatsAppId(waMessageId)
  const hasQueueId = !!waMessageId && isUltramsgNumericQueueId(waMessageId)

  console.log(`[pendingOutboundReconciliation] reenvio automatico ${ok ? 'aceito' : 'recusado'}`, {
    mensagem_id: row.id,
    company_id: row.company_id,
    conversa_id: row.conversa_id,
    tipo: row.tipo || 'texto',
    idade_min: Math.round(messageAgeMs(row) / 60_000),
    provider_message_id: waMessageId || null,
    ...(ok ? {} : { erro: String((typeof result === 'object' && (result?.error || result?.blockedBy)) || '').slice(0, 200) }),
  })

  if (!ok) {
    // Falha TRANSITÓRIA do reenvio (timeout/rede/429/5xx): o provedor pode ter aceitado. Marcar
    // erro tirava a linha da varredura e liberava o reenvio manual — duplicata no cliente. Fica
    // pending: o próximo ciclo confere de novo no provedor antes de decidir.
    const transitoria = isTransientOutboundFailure({
      httpStatus: typeof result === 'object' ? result?.httpStatus : null,
      transportError: typeof result === 'object' && result?.transportError === true,
    })
    if (transitoria) return { ok: true, action: 'keep_reenvio_falha_transitoria' }
    return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
  }

  // Whapi (aguardarAck): o message.id do POST NÃO prova envio — guarda o id para o ACK/GET
  // reconciliar, mas a linha permanece pending/sending até confirmação (contrato do doc 25).
  const confirmaEnvio = hasValidId && !aguardarAck
  const updates = {
    status: confirmaEnvio ? 'sent' : 'pending',
    status_mensagem: confirmaEnvio ? 'sent' : 'sending',
    ...(hasValidId ? { whatsapp_id: waMessageId } : {}),
    ...(hasQueueId ? { provider_queue_id: waMessageId } : {}),
  }
  const patched = await patchMessage(row, updates, io)
  return { ...patched, action: patched.ok ? 'reenviada' : patched.action }
}

async function reconcilePendingOutboundMessage(row, { io = null, force = false } = {}) {
  if (!row?.id || !row?.company_id) return { ok: false, action: 'invalid_row' }

  const ageMs = messageAgeMs(row)
  if (!force && ageMs < getGraceMs()) {
    return { ok: true, action: 'skip_grace' }
  }
  // Conferência forçada (diferida, ~90s) pode CONFIRMAR status dentro da carência, mas nunca
  // REENVIAR: a ausência no provedor tão cedo pode ser só indexação atrasada. O reenvio segue
  // exclusivo da varredura, depois da carência — mesmo momento de sempre.
  const dentroDaCarencia = ageMs < getGraceMs()

  const currentStatus = String(row.status_mensagem || row.status || '').toLowerCase()
  if (!['pending', 'sending', 'sent'].includes(currentStatus)) {
    return { ok: true, action: 'skip_not_pending' }
  }

  // O primeiro despacho desta mídia ainda está rodando (upload + envio podem passar da
  // carência): não consultar nem reenviar agora, senão o cliente recebe em dobro.
  if (despachoEmAndamento(row.id)) {
    return { ok: true, action: 'keep_despacho_em_andamento' }
  }

  const instanceProvider = await resolveConversationProvider(row.company_id, row.whatsapp_instance_id)
  const isWhapi = String(instanceProvider || '').trim().toLowerCase() === 'whapi'
  if (currentStatus === 'sent' && !isWhapi) {
    return { ok: true, action: 'skip_sent_non_whapi' }
  }
  if (currentStatus === 'sent' && !isRealWhatsAppId(row.whatsapp_id)) {
    return { ok: true, action: 'skip_sent_without_id' }
  }
  // UltraMSG preserva o comportamento historico. Na Whapi, o ID do POST nao
  // prova envio: sempre consultamos GET /messages/{id} ou aguardamos webhook ACK.
  if (!isWhapi && isRealWhatsAppId(row.whatsapp_id)) {
    return patchMessage(row, { status: 'sent', status_mensagem: 'sent' }, io)
  }

  const provider = getProvider({ provider: instanceProvider })
  if (!provider?.getMessages) {
    return { ok: false, action: 'provider_indisponivel' }
  }

  const cacheKey = `${row.company_id}:${row.whatsapp_instance_id || 'default'}`
  const cached = companyProviderCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < COMPANY_CACHE_TTL_MS) {
    if (!cached.configured) {
      if (ageMs >= getFailAfterMs()) {
        return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
      }
      return { ok: true, action: 'skip_sem_instancia' }
    }
  } else if (provider.getConnectionStatus) {
    try {
      const conn = await provider.getConnectionStatus(buildProviderOpts(row))
      const configured = conn?.configured !== false
      companyProviderCache.set(cacheKey, { ts: Date.now(), configured, connected: conn?.connected === true })
      if (!configured) {
        if (ageMs >= getFailAfterMs()) {
          return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
        }
        return { ok: true, action: 'skip_sem_instancia' }
      }
    } catch (_) {
      companyProviderCache.set(cacheKey, { ts: Date.now(), configured: true, connected: null })
    }
  }

  const providerHit = await queryProviderForMessage(row)
  if (providerHit?.row) {
    const resolved = await resolveFromProviderRow(row, providerHit.row, io)
    // Whapi aceitou, mas horas depois o próprio provedor ainda informa "pending": a mensagem
    // não saiu. Sem este desfecho a bolha ficava no relógio por dias e o atendente nunca
    // sabia; um ACK tardio ainda recupera a linha.
    if (
      resolved.action === 'keep_provider_pending' && isWhapi &&
      currentStatus !== 'sent' && ageMs >= getWhapiUnackedFailMs()
    ) {
      console.warn('[pendingOutboundReconciliation] whapi segue pending no provedor após o prazo — marcando erro', {
        mensagem_id: row.id, company_id: row.company_id, idade_min: Math.round(ageMs / 60_000),
      })
      return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
    }
    if (resolved.action !== 'noop') return resolved
  }

  // Provedor respondeu que nao tem registro da mensagem e nunca a aceitou: o envio se perdeu.
  // Reenviar aqui e seguro justamente porque a ausencia foi confirmada, nao presumida.
  const provedorSemRegistro = providerHit?.consultaOk === true && !providerHit?.row
  // Whapi: 404/ausencia pode ser consistencia eventual, retencao da API ou ID
  // ainda nao indexado. Nunca reenviar nem promover para sent sem ACK explicito.
  if (isWhapi && provedorSemRegistro) {
    // TEXTO humano SEM nenhum id (POST falhou/timeout): a Whapi nao tem referenceId, mas o
    // HISTORICO do chat confirma presenca/ausencia. Presenca → cura (adota id, marca sent).
    // Ausencia CONFIRMADA dentro da janela → reenvio automatico pelo caminho ja existente
    // (reenviarMensagemNaoAceita), com releitura da linha antes (eco pode chegar na corrida).
    // Consulta falhada/inconclusiva → mantem o comportamento conservador abaixo.
    if (
      provedorNuncaAceitou(row) &&
      currentStatus !== 'sent' &&
      row.autor_usuario_id != null &&
      isTipoTextoReenviavel(row.tipo) &&
      whapiHistoryResendEnabled() &&
      isResendEnabled()
    ) {
      const { data: convReenvio } = await supabase
        .from('conversas')
        .select('id, telefone')
        .eq('company_id', row.company_id)
        .eq('id', row.conversa_id)
        .maybeSingle()
      const telefoneReenvio = String(convReenvio?.telefone || '').trim()
      if (telefoneReenvio && !telefoneReenvio.toLowerCase().startsWith('lid:')) {
        const provider = getProvider({ provider: instanceProvider })
        const usuarioNome = await nomeAtendenteParaEnvio(row.company_id, row.autor_usuario_id)
        const hist = await consultarHistoricoWhapiPorTexto({
          row, provider, telefone: telefoneReenvio, usuarioNome,
        })
        if (hist.consultaOk && hist.encontrado) {
          const waId = String(hist.mensagem?.id || '').trim()
          console.log('[pendingOutboundReconciliation] whapi: texto encontrado no historico do chat — curando sem reenviar', {
            mensagem_id: row.id,
            company_id: row.company_id,
            conversa_id: row.conversa_id,
            whatsapp_id_tail: waId.slice(-12) || null,
          })
          const patched = await patchMessage(row, {
            status: 'sent',
            status_mensagem: 'sent',
            ...(isRealWhatsAppId(waId) ? { whatsapp_id: waId } : {}),
          }, io)
          return { ...patched, action: patched.ok ? 'whapi_curada_pelo_historico' : patched.action }
        }
        if (hist.consultaOk && !hist.encontrado && !dentroDaCarencia && ageMs <= getResendWindowMs()) {
          // Ausencia confirmada pelo provedor + releitura fresca da linha = reenvio seguro.
          if (await rowAindaSemAceiteNoBanco(row)) {
            const r = await reenviarMensagemNaoAceita(row, io, { aguardarAck: true })
            return {
              ...r,
              action: r.action === 'reenviada' ? 'whapi_reenviada_apos_confirmacao_historico' : r.action,
            }
          }
          return { ok: true, action: 'keep_whapi_eco_na_corrida' }
        }
        // consulta falhou ou fora da janela de reenvio → segue o fluxo conservador abaixo
      }
    }
    // Linha SEM nenhum id do provedor (POST falhou/exceção de transporte): não há o que
    // consultar nem indexar — a única salvação seria o eco from_me do webhook, que já teria
    // chegado. Após a janela de falha, vira erro em vez de relógio eterno (espelha o
    // comportamento UltraMSG "sem registro no provedor → falha definitiva"). Nunca reenvia.
    if (provedorNuncaAceitou(row) && currentStatus !== 'sent' && ageMs >= getFailAfterMs()) {
      console.warn('[pendingOutboundReconciliation] whapi sem id e sem eco após janela de falha — marcando erro', {
        mensagem_id: row.id,
        company_id: row.company_id,
        conversa_id: row.conversa_id,
        idade_min: Math.round(ageMs / 60_000),
      })
      return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
    }
    // Há id do provedor, mas ele não tem mais registro e nenhum ACK chegou no prazo.
    if (!provedorNuncaAceitou(row) && currentStatus !== 'sent' && ageMs >= getWhapiUnackedFailMs()) {
      console.warn('[pendingOutboundReconciliation] whapi com id sem registro nem ACK após o prazo — marcando erro', {
        mensagem_id: row.id, company_id: row.company_id, idade_min: Math.round(ageMs / 60_000),
      })
      return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
    }
    return { ok: true, action: currentStatus === 'sent' ? 'keep_whapi_sent_unconfirmed' : 'keep_whapi_unconfirmed' }
  }
  if (provedorSemRegistro && provedorNuncaAceitou(row) && !dentroDaCarencia) {
    // Chatbot / automações (sem autor humano): o envio original NÃO usa referenceId crm-{id}
    // (insert depois do sendText). A consulta UltraMSG por referenceId sempre falha →
    // reenviar duplicaria menu/confirmação no WhatsApp do cliente (~5 min depois).
    if (row.autor_usuario_id == null) {
      console.log('[pendingOutboundReconciliation] skip reenvio automacao/chatbot — marca sent para nao duplicar no cliente', {
        mensagem_id: row.id,
        company_id: row.company_id,
        conversa_id: row.conversa_id,
        idade_min: Math.round(ageMs / 60_000),
        textoPreview: String(row.texto || '').slice(0, 60),
      })
      return patchMessage(row, { status: 'sent', status_mensagem: 'sent' }, io)
    }
    if (isResendEnabled() && ageMs <= getResendWindowMs()) {
      return await reenviarMensagemNaoAceita(row, io)
    }
    if (ageMs > getResendWindowMs()) {
      // Fora da janela de reenvio e sem registro no provedor: falha definitiva, nao relogio eterno.
      return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
    }
  }

  if (ageMs < getFailAfterMs()) {
    return { ok: true, action: 'keep_waiting' }
  }

  // Após fail threshold: só marca erro se o provedor confirmar falha explícita.
  if (providerHit?.list?.some((item) => providerRowIndicatesFailure(item))) {
    return patchMessage(row, { status: 'erro', status_mensagem: 'failed' }, io)
  }

  if (providerHit?.list?.some((item) => providerRowInQueue(item))) {
    return { ok: true, action: 'keep_queue_after_fail_window' }
  }

  // Sem confirmação do provedor: mantém pending (não inventar erro).
  return { ok: true, action: 'keep_unknown' }
}

async function fetchPendingOutboundRows({ companyId = null, limit = null, mensagemId = null } = {}) {
  const batch = limit || getBatchLimit()
  const oldestIso = new Date(Date.now() - getLookbackMs()).toISOString()
  const graceIso = new Date(Date.now() - getGraceMs()).toISOString()

  const BASE_COLS = 'id, company_id, conversa_id, whatsapp_instance_id, whatsapp_id, provider_queue_id, status, status_mensagem, direcao, criado_em, autor_usuario_id, tipo, texto, url, nome_arquivo'
  // storage_* só existem após a migration de R2; sem elas, refazemos a consulta sem as colunas.
  const buildQuery = (cols, statuses, whatsappInstanceIds = null, faixa = {}) => {
    let q = supabase
      .from('mensagens')
      .select(cols)
      .eq('direcao', 'out')
      .in('status', statuses)
      .gte('criado_em', faixa.desdeIso || oldestIso)
    // A carência só vale para a VARREDURA. A conferência diferida (mensagemId) roda ~90s após
    // o envio justamente para conferir cedo; com este filtro ela não achava a própria linha
    // (idade < carência de 3 min) e virava no-op — sem ACK, o tique só andava na varredura
    // (3 a 8 min). O reenvio continua protegido pela carência em reconcilePendingOutboundMessage.
    if (mensagemId == null) q = q.lte('criado_em', faixa.ateIso || graceIso)
    if (faixa.aposId != null) q = q.gt('id', faixa.aposId)
    q = q
      .order(faixa.porId ? 'id' : 'criado_em', { ascending: true })
      .limit(faixa.limite || batch)
    if (companyId != null) q = q.eq('company_id', Number(companyId))
    if (mensagemId != null) q = q.eq('id', Number(mensagemId))
    if (Array.isArray(whatsappInstanceIds) && whatsappInstanceIds.length) {
      q = q.in('whatsapp_instance_id', whatsappInstanceIds)
    }
    return q
  }

  function isMissingStorageColumn(err) {
    const t = [err?.message, err?.details, err?.hint, err?.code].filter(Boolean).join(' ').toLowerCase()
    return t.includes('storage_backend') || t.includes('storage_key') ||
      t.includes('does not exist') || t.includes('42703') || t.includes('pgrst204') || t.includes('schema cache')
  }

  const runQuery = async (statuses, whatsappInstanceIds = null, faixa = {}) => {
    let result = await buildQuery(`${BASE_COLS}, storage_backend, storage_key`, statuses, whatsappInstanceIds, faixa)
    if (result.error && isMissingStorageColumn(result.error)) {
      result = await buildQuery(BASE_COLS, statuses, whatsappInstanceIds, faixa)
    }
    return result
  }

  // VARREDURA EM DUAS FAIXAS. Antes era uma consulta só, "as N mais antigas primeiro": bastavam
  // N linhas travadas (sem desfecho por dias) para ocupar o lote inteiro em TODO ciclo, e as
  // mensagens novas — as únicas que ainda podem ser reenviadas ou confirmadas — nunca eram
  // alcançadas, em nenhuma empresa. Agora:
  //  1) faixa RECENTE (dentro da janela em que reenvio/falha ainda se decidem) tem lote próprio;
  //  2) o ACÚMULO antigo roda em rodízio por id (cursor em memória), meio lote por ciclo, e
  //     recomeça do início ao chegar no fim — nenhuma linha fica para sempre sem ser visitada.
  // A conferência por mensagemId segue como consulta única.
  const buscarLote = async (statuses, whatsappInstanceIds = null) => {
    if (mensagemId != null) return runQuery(statuses, whatsappInstanceIds)
    const corteRecenteIso = new Date(Date.now() - getRecentWindowMs()).toISOString()
    const recentes = await runQuery(statuses, whatsappInstanceIds, { desdeIso: corteRecenteIso })
    if (recentes.error) return recentes
    const limiteAcumulo = Math.max(5, Math.ceil(batch / 2))
    const chaveCursor = `${companyId ?? 'todas'}:${statuses.join(',')}`
    const antigas = await runQuery(statuses, whatsappInstanceIds, {
      ateIso: corteRecenteIso,
      aposId: _acumuloCursor.get(chaveCursor) ?? null,
      porId: true,
      limite: limiteAcumulo,
    })
    if (antigas.error) return antigas
    const listaAntigas = antigas.data || []
    if (listaAntigas.length < limiteAcumulo) _acumuloCursor.delete(chaveCursor)
    else _acumuloCursor.set(chaveCursor, listaAntigas[listaAntigas.length - 1].id)
    const vistos = new Set()
    const data = [...(recentes.data || []), ...listaAntigas].filter((r) => {
      if (vistos.has(r.id)) return false
      vistos.add(r.id)
      return true
    })
    return { data, error: null }
  }

  let whapiInstancesQuery = supabase
    .from('whatsapp_instances')
    .select('id')
    .eq('provider', 'whapi')
  if (companyId != null) whapiInstancesQuery = whapiInstancesQuery.eq('company_id', Number(companyId))
  const { data: whapiInstances, error: whapiInstancesError } = await whapiInstancesQuery
  const whapiInstanceIds = whapiInstancesError
    ? []
    : (whapiInstances || []).map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0)

  // Lotes independentes evitam que o volume de `sent` ocupe as vagas das
  // mensagens realmente pendentes. A filtragem por provider ocorre no reconcile.
  const pendingResult = await buscarLote(['pending', 'sending'])
  if (pendingResult.error) return { ok: false, rows: [], error: pendingResult.error.message }
  const sentResult = whapiInstanceIds.length
    ? await buscarLote(['sent'], whapiInstanceIds)
    : { data: [], error: null }
  if (sentResult.error) return { ok: false, rows: [], error: sentResult.error.message }

  const rows = [...(pendingResult.data || []), ...(sentResult.data || [])].filter((row) => {
    if (isInternalNoteRow(row)) return false
    const st = String(row.status_mensagem || row.status || '').toLowerCase()
    return ['pending', 'sending', 'sent'].includes(st)
  })
  return { ok: true, rows }
}

async function runPendingOutboundReconciliation({ io = null, companyId = null, mensagemId = null, force = false } = {}) {
  if (!isEnabled()) return { ok: true, skipped: true, reason: 'disabled' }

  const { ok, rows, error } = await fetchPendingOutboundRows({ companyId, mensagemId })
  if (!ok) return { ok: false, error }

  const summary = {
    ok: true,
    scanned: rows.length,
    patched: 0,
    kept: 0,
    skipped: 0,
    failed: 0,
    actions: {},
  }

  for (const row of rows) {
    try {
      const result = await reconcilePendingOutboundMessage(row, { io, force: force || mensagemId != null })
      const action = result.action || (result.ok ? 'ok' : 'failed')
      summary.actions[action] = (summary.actions[action] || 0) + 1
      if (result.action === 'patched') summary.patched += 1
      else if (String(action).startsWith('keep') || action === 'skip_grace' || action === 'skip_not_pending') summary.kept += 1
      else if (action === 'skip_sem_instancia' || action === 'noop') summary.skipped += 1
      else if (!result.ok) summary.failed += 1
    } catch (e) {
      summary.failed += 1
      summary.actions.error = (summary.actions.error || 0) + 1
      console.warn('[pendingOutboundReconciliation] erro em mensagem', {
        mensagem_id: row.id,
        company_id: row.company_id,
        error: e?.message || e,
      })
    }
  }

  if (summary.patched > 0) {
    console.log('[pendingOutboundReconciliation] ciclo concluído', summary)
  }

  return summary
}

function schedulePendingOutboundReconciliation({ companyId, mensagemId, io = null, delayMs = null } = {}) {
  if (!isEnabled()) return
  const cid = Number(companyId)
  const mid = Number(mensagemId)
  if (!Number.isFinite(cid) || !Number.isFinite(mid) || mid <= 0) return

  const key = `${cid}:${mid}`
  if (deferredTimers.has(key)) return

  const delay = Number.isFinite(Number(delayMs))
    ? Math.max(15_000, Math.min(300_000, Number(delayMs)))
    : parsePositiveIntEnv('PENDING_OUTBOUND_RECONCILE_DEFER_MS', 90_000, { min: 15_000, max: 300_000 })

  const timer = setTimeout(() => {
    deferredTimers.delete(key)
    runPendingOutboundReconciliation({ io, companyId: cid, mensagemId: mid, force: false }).catch((e) => {
      console.warn('[pendingOutboundReconciliation] deferred falhou', {
        company_id: cid,
        mensagem_id: mid,
        error: e?.message || e,
      })
    })
  }, delay)

  if (typeof timer.unref === 'function') timer.unref()
  deferredTimers.set(key, timer)
}

module.exports = {
  runPendingOutboundReconciliation,
  reconcilePendingOutboundMessage,
  schedulePendingOutboundReconciliation,
  _test: {
    providerRowIndicatesSuccess,
    providerRowIndicatesFailure,
    providerRowIndicatesPending,
    providerRowInQueue,
    mapProviderAckToStatus,
    buildCrmReferenceId,
    getGraceMs,
    getFailAfterMs,
    getResendWindowMs,
    provedorNuncaAceitou,
    urlPublicaDeMidia,
    captionUsuarioDeMidia,
    isTipoTextoReenviavel,
    normalizarTextoParaComparacao,
    consultarHistoricoWhapiPorTexto,
    whapiHistoryResendEnabled,
  },
}
