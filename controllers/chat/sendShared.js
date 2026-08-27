const supabase = require('../../config/supabase')
const _chatShared = require('./shared')
const {
  mergeConversaClienteTags,
  resolveTelefoneFromLidSiblingConversation,
  safeWhatsappInstanceMeta,
  loadWhatsappInstanceMetaMap,
  statusAtendimentoParaLista,
  applyDetalharChatMensagensCursor,
  parsePositiveInt,
  parseBooleanQuery,
  isFlagAtivo,
  isMensagemColumnFallbackError,
  parseChatListPagination,
  applyChatListCursor,
  splitChatListPage,
  parseMessageHistoryPagination,
  splitMessageHistoryPage,
  shouldIncludeClientesSemConversa,
  setChatListPaginationHeaders,
  ordenarMensagensHistoricoAsc,
  textoRevogadoApagadaParaTodos,
  aplicarApagadaParaTodosNaMensagem,
  enrichMensagensComAutorUsuario,
  assertPermissaoConversa,
  marcarComoLidaPorUsuario,
  obterUnreadMap,
  getSearchMessagesPageSize,
  getChatSearchScanLimit,
  getChatSearchIdLimit,
  getChatFilterIdLimit,
  getConversaMessagesSearchLimit,
  buscarConversaIdsPorTextoMensagens,
  isConversaAtendentesMissingTable,
  getConversaIdsParticipanteAtivo,
  usuarioParticipaAtivamenteDaConversa,
  deveIncluirGruposSemDepartamentoNoFiltroTodos,
} = _chatShared
// __CHAT_MODULE_IMPORTS__
const {
  registrarAtendimento,
  buildMensagemInternaMovimentacao,
  listarMensagensInternasMovimentacao,
  perfilPodeVerMovimentacaoInterna,
  isMensagemLegadaMovimentacaoInterna,
} = require('../../services/atendimentosRegistroService')
const { ensureConversaForCliente } = require('../../services/conversaAbrirClienteService')
const { executarAssumirConversa } = require('../../services/conversaAssumirInternoService')
const { resetAlertaSemRespostaAoAssumirReaberta } = require('../../services/atendimentoSemRespostaService')
const { getProvider } = require('../../services/providers')
const { getStatus } = require('../../services/ultramsgIntegrationService')
const { getDefaultWhatsappInstance, listWhatsappInstances, resolveWhatsappInstanceForManualAction, sanitizeWhatsappInstance } = require('../../services/whatsappInstanceService')
const { isGroupConversation, isClosedAttendanceStatus } = require('../../helpers/conversaHelper')
const {
  normalizePhoneBR,
  possiblePhonesBR,
  phoneKeyBR,
  isLidPhoneKey,
  pickRealPhoneCandidate,
} = require('../../helpers/phoneHelper')
const { deduplicateConversationsByContact, sortConversationsByRecent, sortConversationsPinThenRecent, sortConversationsBySearchRelevance, getCanonicalPhone, getCanonicalPhoneAnyIntl, getOrCreateCliente, findOrCreateConversation, mergeConversasIntoCanonico } = require('../../helpers/conversationSync')
const { enrichConversationsWithContactData } = require('../../helpers/conversaEnrichment')
const {
  resolveReabertaPorFaltaInteracao,
  enrichConversasReabertaFaltaInteracao,
  clearReabertaFaltaInteracao,
} = require('../../helpers/reabertaFaltaInteracaoHelper')
const { getDisplayName, normalizeName, isBadName } = require('../../helpers/contactEnrichment')
const { tryMarkWaitingAfterHumanOutbound } = require('../../services/absenceFinalizationService')
const {
  aplicarModoSimplesNoPayload,
  recalcularStatusPorUltimaMensagem,
  limparAguardandoAtendenteModoSimples,
  getUltimaMensagemReal,
  resolverModoSimplesAguardando,
} = require('../../services/atendimentoModoSimplesService')
const { empresaModoSimplesAtivo } = require('../../helpers/empresaModoSimplesFlag')
const {
  resolveGrupoIdsComUnreadParaUsuario,
  applyAguardandoAtendenteModoSimplesQuery,
  rowAguardandoAtendenteModoSimples,
} = require('../../helpers/modoSimplesGrupoUnread')
const { syncOldMessagesForConversation } = require('../../services/oldMessagesSyncService')
const {
  marcarAguardandoClienteManual,
  retomarEmAtendimentoManual,
} = require('../../services/conversaStatusManualService')
const {
  marcarAguardandoPagamento,
  retomarDeCobrancaFinanceira,
} = require('../../services/conversaPagamentoFinanceiroService')
const { usuarioPertenceSetorFinanceiro } = require('../../helpers/financeiroSetorHelper')
const {
  buildClienteSearchOr,
  buildTelefoneSearchOr,
  buildPhoneSearchTerms,
  chatIdentityMatchesSearch,
  escapeIlikePattern,
} = require('../../helpers/chatSearchHelper')
const {
  getGrupoDepartamentoIds,
  getGrupoIdsPorDepartamentos,
  getGrupoIdsSemDepartamento,
  usuarioPodeVerGrupo,
  pushNonGroupVisibilityParts,
  pushAllowedGroupIdsPart,
} = require('../../helpers/departamentoGruposHelper')
const {
  countConversasWithFilter,
  overridesFromListQuery,
  getChatFilterCounts,
  parseConversaIdsQuery,
  getStartOfTodayIso,
  getEndOfTodayIso,
} = require('../../services/chatListCountsService')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../../helpers/timestampApiCompat')
const { isRealWhatsAppId, isUltramsgNumericQueueId } = require('../../helpers/whatsappMessageIdHelper')
const { schedulePendingOutboundReconciliation } = require('../../services/pendingOutboundReconciliationService')
const {
  INTERNAL_NOTE_PERMISSAO,
  INTERNAL_NOTE_STATUS,
  REAL_MESSAGE_DIRECOES,
  isInternalNoteRow,
  sanitizeInternalNoteTexto,
  buildInternalNoteInsert,
} = require('../../helpers/internalNote')
const { usuarioTemPermissao } = require('../../helpers/permissoesService')

const { emitirConversaAtualizada, emitirMovimentacaoInternaAtendimento, emitirRealtimeAposAssumir } = require('./realtime')

/**
 * controllers/chat/sendShared.js
 *
 * Helpers de SUPORTE a envio de mensagens (texto e mídia), compartilhados entre
 * sendMessageController e sendMediaController. Inclui o estado de idempotência
 * (`_clientTempIdDeduplicationMap` e `_sendMemo`) que DEVE ser único no processo.
 *
 * Invariantes: idempotência por client_temp_id/referenceId; nunca retry cego;
 * status unidirecional; isolamento por company_id; permissão de envio via
 * assertPodeEnviarMensagem. Emissão de socket delegada a ./realtime.
 */

/**
 * Deduplicação in-memory para double-send de texto.
 * Chave: `${company_id}:${conversa_id}:${client_temp_id}` → { id, status, ts }
 * TTL: 30s. Limpo a cada 5 min para evitar memory leak.
 */
const _clientTempIdDeduplicationMap = new Map()

// Memoização de indisponibilidade de coluna/dedupe no banco (bancos desatualizados).
// Objeto (não `let` solto) para poder ser COMPARTILHADO por referência entre os módulos
// de envio (texto e mídia) sem perder o estado — preserva a idempotência por client_temp_id.
const _sendMemo = { dbDedupeUnavailable: false, audioColumnUnavailable: false }

/**
 * Duração em segundos a partir do FormData do upload de áudio/voice.
 * Usa o MENOR entre elapsed e duration: elapsed (relógio de parede) é confiável;
 * duration vem do <audio> lendo o WebM cru e pode ser inflado no container sem Duration.
 */
function parseAudioDuracaoSecFromBody(body) {
  if (!body || typeof body !== 'object') return null
  const fromMs = (raw) => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.max(1, Math.min(600, Math.round(n / 1000)))
  }
  const fromSec = (raw) => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.max(1, Math.min(600, Math.round(n)))
  }
  const elapsed = fromMs(body.audio_elapsed_ms)
  const duration = fromMs(body.audio_duration_ms)
  if (elapsed && duration) return Math.min(elapsed, duration)
  return (
    elapsed ||
    duration ||
    fromSec(body.audio_duracao_sec) ||
    fromSec(body.audio_duration_sec) ||
    null
  )
}

function normalizeClientTempId(value) {
  const normalized = value != null ? String(value).trim().slice(0, 64) : ''
  return normalized || null
}

function clientTempIdDedupeKey(company_id, conversa_id, clientTempId) {
  return `${company_id}:${conversa_id}:${clientTempId}`
}

function isMissingMensagemColumnError(error, columnName) {
  const text = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(' ').toLowerCase()
  return text.includes(String(columnName).toLowerCase())
}

function isGenericMissingColumnError(error) {
  const text = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(' ').toLowerCase()
  return text.includes('does not exist') || text.includes('schema cache') || text.includes('could not find')
}

function isClientTempIdUniqueViolation(error) {
  const text = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(' ').toLowerCase()
  return String(error?.code || '') === '23505' && (
    text.includes('client_temp_id') ||
    text.includes('idx_mensagens_client_temp_id_unique')
  )
}

function buildClientTempIdDedupResponse(row, conversa_id, clientTempId) {
  if (!row?.id) return null
  return {
    ok: true,
    id: row.id,
    conversa_id: Number(row.conversa_id ?? conversa_id),
    client_temp_id: clientTempId,
    status: row.status || row.status_mensagem || 'pending',
    ...(row.whatsapp_id ? { whatsapp_id: row.whatsapp_id } : {}),
    deduplicated: true,
  }
}

async function findMensagemByClientTempId(company_id, conversa_id, clientTempId, select = 'id, conversa_id, status, status_mensagem, whatsapp_id, client_temp_id') {
  if (!clientTempId || _sendMemo.dbDedupeUnavailable) return null
  try {
    const { data, error } = await supabase
      .from('mensagens')
      .select(select)
      .eq('company_id', company_id)
      .eq('conversa_id', Number(conversa_id))
      .eq('client_temp_id', clientTempId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      if (isMissingMensagemColumnError(error, 'client_temp_id') || isGenericMissingColumnError(error)) {
        _sendMemo.dbDedupeUnavailable = true
        return null
      }
      console.warn('[client_temp_id] falha ao consultar dedupe persistente:', error?.message || error)
      return null
    }
    return data || null
  } catch (error) {
    if (isMissingMensagemColumnError(error, 'client_temp_id') || isGenericMissingColumnError(error)) {
      _sendMemo.dbDedupeUnavailable = true
      return null
    }
    console.warn('[client_temp_id] excecao ao consultar dedupe persistente:', error?.message || error)
    return null
  }
}

function normalizeLinkPayload(link) {
  if (!link || typeof link !== 'object') return null
  const linkUrl = String(link.linkUrl ?? link.url ?? '').trim()
  if (!linkUrl) return null
  return {
    ...link,
    linkUrl,
    title: String(link.title || '').trim(),
    image: link.image || '',
    linkDescription: String(link.linkDescription || link.description || '').trim(),
  }
}

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

function aplicarAguardandoClienteNoPayload(payload, waitingResult, modoSimplesOpt) {
  if (!payload || !waitingResult?.marked) {
    return aplicarModoSimplesNoPayload(payload, modoSimplesOpt, modoSimplesOpt?.atendimento_modo_simples)
  }
  payload.status_atendimento = 'em_atendimento'
  payload.status_atendimento_real = 'em_atendimento'
  payload.aguardando_cliente_desde = waitingResult.aguardando_cliente_desde || new Date().toISOString()
  payload.exibir_badge_aberta = false
  payload.tem_novas_mensagens_em_atendimento = false
  return aplicarModoSimplesNoPayload(payload, modoSimplesOpt, modoSimplesOpt?.atendimento_modo_simples)
}

async function recalcularEMesclarModoSimples({
  company_id,
  conversa_id,
  mensagemNova,
  io,
  payloadBase = null,
}) {
  const result = await recalcularStatusPorUltimaMensagem({
    company_id,
    conversa_id,
    mensagemNova,
    io,
    emitirEvento: async (socket, cid, convId, recalc) => {
      if (!recalc.changed || !socket) return
      const base =
        payloadBase && typeof payloadBase === 'object'
          ? { ...payloadBase }
          : { id: convId, ultima_atividade: new Date().toISOString() }
      const eventPayload = aplicarModoSimplesNoPayload(base, recalc.conversa, true)
      emitirConversaAtualizada(socket, cid, convId, eventPayload, { skipAtualizarConversa: true })
    },
  })
  return result
}

/** Texto ao WhatsApp com *nome* na primeira linha (respeita getUsuarioParaEnvioCliente). CRM grava sem prefixo. */
function textoParaEnvioWhatsapp(texto, usuarioNome) {
  return formatTextoWhatsappComNomeAtendente(texto, usuarioNome)
}

function prefixarParaCliente(texto, usuarioNome) {
  return formatTextoWhatsappComNomeAtendente(texto, usuarioNome)
}

/** Busca nome e preferência do usuário para exibir ao cliente no WhatsApp. Retorna { nome, mostrar } */
async function getUsuarioParaEnvioCliente(supabase, company_id, user_id) {
  if (!user_id) return { nome: null, mostrar: false }
  const { data, error } = await supabase.from('usuarios').select('nome, mostrar_nome_ao_cliente').eq('company_id', company_id).eq('id', user_id).maybeSingle()
  if (error) return { nome: null, mostrar: true }
  const mostrar = data?.mostrar_nome_ao_cliente !== false
  const nome = (data?.nome && String(data.nome).trim()) || null
  return { nome: mostrar ? nome : null, mostrar }
}

/** Enriquece uma mensagem única com usuario_nome (para evento nova_mensagem) */
async function enrichMensagemComAutorUsuario(supabase, company_id, msg) {
  const isOut = msg?.direcao === 'out'
  if (!msg || !isOut || !msg.autor_usuario_id) {
    return {
      ...msg,
      criado_em: normalizarTimestampSemFusoAmbiguoParaApi(msg?.criado_em),
      usuario_id: msg?.autor_usuario_id ?? null,
      usuario_nome: null,
      enviado_por_usuario: !!(isOut && msg?.autor_usuario_id),
      // fromMe: mensagens enviadas pelo CRM (direcao 'out') são sempre fromMe=true para fins de notificação.
      // O frontend NÃO deve exibir notificação/som para estas mensagens.
      fromMe: isOut,
    }
  }
  const { data: u } = await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).eq('id', msg.autor_usuario_id).maybeSingle()
  return {
    ...msg,
    criado_em: normalizarTimestampSemFusoAmbiguoParaApi(msg?.criado_em),
    usuario_id: msg.autor_usuario_id,
    usuario_nome: u?.nome ?? null,
    enviado_por_usuario: true,
    fromMe: true,
    apagada_para_todos: msg?.apagada_para_todos === true,
  }
}

/**
 * Verifica se o usuário pode ENVIAR mensagens na conversa.
 * - Grupos: qualquer usuário pode enviar sem assumir.
 * - Demais conversas: só quem assumiu (atendente_id === user_id), inclusive admin.
 * - Quando habilitado pelo caller, conversa sem atendente pode ser assumida
 *   automaticamente no primeiro envio manual, respeitando setor/perfil/limite.
 */
function podeAssumirConversaPorPerfil(role) {
  const r = String(role || '').toLowerCase()
  return r === 'admin' || r === 'supervisor' || r === 'atendente'
}

async function assertPodeEnviarMensagem({
  company_id,
  conversa_id,
  user_id,
  role = null,
  user_dep_ids = [],
  autoAssumirUra = false,
  autoAssumirAoEnviar = false,
  io = null,
}) {
  const { data: conv, error } = await supabase
    .from('conversas')
    .select('id, atendente_id, departamento_id, tipo, telefone, status_atendimento, whatsapp_instance_id')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!conv) return { ok: false, status: 404, error: 'Conversa não encontrada' }

  if (isGroupConversation(conv)) {
    const podeVerGrupo = await usuarioPodeVerGrupo({
      company_id,
      conversa_id,
      role,
      departamento_ids: user_dep_ids,
    })
    if (!podeVerGrupo) {
      return { ok: false, status: 403, error: 'Grupo nao vinculado ao seu setor' }
    }
    return { ok: true, reason: 'grupo_sem_exigir_assumir' }
  }

  if (isClosedAttendanceStatus(conv.status_atendimento)) {
    return {
      ok: false,
      status: 409,
      error: 'Reabra a conversa antes de enviar mensagens.',
    }
  }

  const isAssignedToUser = conv.atendente_id && Number(conv.atendente_id) === Number(user_id)
  if (isAssignedToUser) {
    return { ok: true, reason: 'conversa_assumida_pelo_usuario' }
  }

  if (conv.atendente_id && await usuarioParticipaAtivamenteDaConversa(company_id, conversa_id, user_id)) {
    return { ok: true, reason: 'usuario_participante_conversa' }
  }

  if (!conv.atendente_id) {
    const modoSimplesAtivo = await empresaModoSimplesAtivo(company_id)
    if (modoSimplesAtivo) {
      const permVer = await assertPermissaoConversa({
        company_id,
        conversa_id,
        user_id,
        role,
        user_dep_ids,
      })
      if (permVer.ok) {
        return { ok: true, reason: 'modo_simples_sem_assumir', conversa: permVer.conv, modo_simples: true }
      }
      return { ok: false, status: permVer.status || 403, error: permVer.error || 'Sem permissão para esta conversa' }
    }
    const deveAutoAssumir = autoAssumirAoEnviar || autoAssumirUra
    if (deveAutoAssumir) {
      if (!podeAssumirConversaPorPerfil(role)) {
        return { ok: false, status: 403, error: 'Seu perfil não permite assumir conversas' }
      }
      const result = await executarAssumirConversa({
        company_id,
        conversa_id,
        user_id,
        perfil: role,
        departamento_ids: user_dep_ids,
        observacao: 'Conversa assumida automaticamente no primeiro envio manual.'
      })
      if (!result.ok) return { ok: false, status: result.status, error: result.error }

      if (io) {
        emitirRealtimeAposAssumir(io, company_id, conversa_id, user_id, result.conversa)
        if (result.atendimento) {
          await emitirMovimentacaoInternaAtendimento(io, {
            company_id,
            conversa: result.conversa,
            atendimento: result.atendimento,
          })
        }
      }

      return {
        ok: true,
        reason: result.already_assigned ? 'auto_assumida_ja_estava_com_usuario' : 'auto_assumida_envio_manual',
        conversa: result.conversa,
      }
    }
    return { ok: false, status: 403, error: 'Assuma a conversa antes de enviar mensagens' }
  }

  return {
    ok: false,
    status: 403,
    error: 'Esta conversa está com outro atendente. Assuma a conversa para enviar mensagens.',
  }
}

// Limpeza periódica do dedup in-memory (TTL 30s; varre a cada 5min). unref: não segura o processo.
setInterval(() => {
  const cutoff = Date.now() - 30_000
  for (const [key, val] of _clientTempIdDeduplicationMap.entries()) {
    if (val.ts < cutoff) _clientTempIdDeduplicationMap.delete(key)
  }
}, 5 * 60 * 1000).unref()

module.exports = {
  _clientTempIdDeduplicationMap,
  _sendMemo,
  parseAudioDuracaoSecFromBody,
  normalizeClientTempId,
  clientTempIdDedupeKey,
  isMissingMensagemColumnError,
  isGenericMissingColumnError,
  isClientTempIdUniqueViolation,
  buildClientTempIdDedupResponse,
  findMensagemByClientTempId,
  normalizeLinkPayload,
  resolveConversationWhatsappInstance,
  resolveUltraMsgReplyMessageId,
  aplicarAguardandoClienteNoPayload,
  recalcularEMesclarModoSimples,
  textoParaEnvioWhatsapp,
  prefixarParaCliente,
  getUsuarioParaEnvioCliente,
  enrichMensagemComAutorUsuario,
  podeAssumirConversaPorPerfil,
  assertPodeEnviarMensagem,
}
