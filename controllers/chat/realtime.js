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

/**
 * controllers/chat/realtime.js
 *
 * Emissões Socket.IO do domínio de chat + resolução de visibilidade/unread por conversa.
 * Centraliza `emitir*` e o cache de quem-pode-ver-a-conversa. NÃO faz envio ao provider.
 *
 * Invariantes: emitir só para salas mínimas (empresa/conversa/usuário/departamento);
 * isolamento por company_id em toda query; `io` sempre vem do chamador (req.app.get('io')).
 * Reexportado pela fachada chatController para consumidores externos (webhook, push, sync).
 */

// =====================================================
// 1) HELPERS (TOPO DO ARQUIVO)
// =====================================================
function emitirConversaAtualizada(io, company_id, conversa_id, payload = null, opts = {}) {
  if (!io) return
  const { skipAtualizarConversa = false } = opts

  const cid = Number(conversa_id)
  let data = payload || { id: cid }
  if (payloadAlteraVisibilidadeConversa(data)) {
    invalidateConversaVisibilityCache(company_id, cid)
  }

  // Se payload é mínimo (só id), buscar nome/foto para não sobrescrever com vazio no frontend (Bug 3)
  const keys = Object.keys(data)
  if (keys.length <= 1 && (keys.length === 0 || (keys[0] === 'id' && data.id))) {
    supabase
      .from('conversas')
      .select('id, nome_contato_cache, foto_perfil_contato_cache, ultima_atividade, status_atendimento, atendente_id, tipo')
      .eq('company_id', company_id)
      .eq('id', cid)
      .maybeSingle()
      .then(async ({ data: conv }) => {
        if (conv) {
          const enriched = { id: cid }
          if (conv.nome_contato_cache) {
            enriched.nome_contato_cache = conv.nome_contato_cache
            enriched.contato_nome = conv.nome_contato_cache
          }
          if (conv.foto_perfil_contato_cache) {
            enriched.foto_perfil_contato_cache = conv.foto_perfil_contato_cache
            enriched.foto_perfil = conv.foto_perfil_contato_cache
          }
          if (conv.ultima_atividade) enriched.ultima_atividade = conv.ultima_atividade
          const isGroup = isGroupConversation(conv)
          let statusParaUi = conv.status_atendimento
          if (!isGroup && conv.status_atendimento === 'aberta') {
            const temAtendente = conv.atendente_id != null
            let temMsg = false
            try {
              const { data: um } = await supabase
                .from('mensagens')
                .select('id')
                .eq('company_id', company_id)
                .eq('conversa_id', cid)
                .limit(1)
                .maybeSingle()
              temMsg = !!um
            } catch (_) {
              temMsg = false
            }
            const exibirBadge = temMsg || temAtendente
            statusParaUi = statusAtendimentoParaLista(false, conv.status_atendimento, exibirBadge)
          } else if (isGroup) {
            statusParaUi = null
          }
          if (statusParaUi) enriched.status_atendimento = statusParaUi
          const eventName = io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada'
          emitirEventoConversaVisivel(io, company_id, cid, eventName, enriched)
            .catch(() => io.to(`conversa_${cid}`).emit(eventName, enriched))
        } else {
          const eventName = io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada'
          emitirEventoConversaVisivel(io, company_id, cid, eventName, data)
            .catch(() => io.to(`conversa_${cid}`).emit(eventName, data))
        }
        if (!skipAtualizarConversa) {
          emitirEventoConversaVisivel(io, company_id, cid, 'atualizar_conversa', { id: cid })
            .catch(() => io.to(`conversa_${cid}`).emit('atualizar_conversa', { id: cid }))
        }
      })
      .catch(() => {
        const eventName = io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada'
        emitirEventoConversaVisivel(io, company_id, cid, eventName, data)
          .catch(() => io.to(`conversa_${cid}`).emit(eventName, data))
        if (!skipAtualizarConversa) {
          emitirEventoConversaVisivel(io, company_id, cid, 'atualizar_conversa', { id: cid })
            .catch(() => io.to(`conversa_${cid}`).emit('atualizar_conversa', { id: cid }))
        }
      })
    return
  }

  // Emite para empresa + conversa em UMA única operação (evita duplicidade
  // quando o mesmo socket está nas duas rooms).
  const eventName = io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada'
  emitirEventoConversaVisivel(io, company_id, conversa_id, eventName, data)
    .catch(() => io.to(`conversa_${conversa_id}`).emit(eventName, data))

  // skipAtualizarConversa: evita refetch que causa duplicata/glitch (payload já tem tudo)
  if (!skipAtualizarConversa) {
    emitirEventoConversaVisivel(io, company_id, cid, 'atualizar_conversa', { id: cid })
      .catch(() => io.to(`conversa_${cid}`).emit('atualizar_conversa', { id: cid }))
  }
}

async function emitirParaUsuariosQuePodemVerConversa(io, company_id, conversa_id, eventName, payload) {
  if (!io || !conversa_id) return false
  const usuarioIds = await obterUsuarioIdsQuePodemVerConversa(company_id, conversa_id)
  if (!Array.isArray(usuarioIds) || usuarioIds.length === 0) return false
  const idsUnicos = [...new Set(usuarioIds.map(Number).filter((id) => Number.isFinite(id) && id > 0))]
  if (idsUnicos.length === 0) return false
  idsUnicos.forEach((uid) => io.to(`usuario_${uid}`).emit(eventName, payload))
  return true
}

async function emitirEventoConversaVisivel(io, company_id, conversa_id, eventName, payload) {
  if (!io || !conversa_id) return false
  const usuarioIds = await obterUsuarioIdsQuePodemVerConversa(company_id, conversa_id)
  const idsUnicos = [...new Set((usuarioIds || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))]
  let target = io.to(`conversa_${Number(conversa_id)}`)
  idsUnicos.forEach((uid) => {
    target = target.to(`usuario_${uid}`)
  })
  target.emit(eventName, payload)
  return idsUnicos.length > 0
}

function emitirEventoEmpresaConversa(io, company_id, conversa_id, eventName, payload) {
  if (!io) return

  if (conversa_id) {
    if (payloadAlteraVisibilidadeConversa(payload)) {
      invalidateConversaVisibilityCache(company_id, conversa_id)
    }
    const { scheduleInboundWebPush } = require('../../services/webPushDispatchService')
    // Evita "vazamento" cross-setor (ex.: financeiro recebendo vendas).
    // Fallback para room ampla apenas se não conseguirmos resolver os destinatários.
    emitirEventoConversaVisivel(io, company_id, conversa_id, eventName, payload)
      .then(() => {
        scheduleInboundWebPush(company_id, conversa_id, eventName, payload)
      })
      .catch(() => {
        io.to(`conversa_${conversa_id}`).emit(eventName, payload)
        scheduleInboundWebPush(company_id, conversa_id, eventName, payload)
      })
    return
  }
  io.to(`empresa_${company_id}`).emit(eventName, payload)
}

/** Quando `emitirConversaAtualizada` usa skipAtualizarConversa (evita flicker), ainda força sync da lista lateral / “Minha fila”. */
function emitirSincronizacaoListaConversas(io, company_id, conversa_id) {
  if (!io || company_id == null || conversa_id == null) return
  const ev = io.EVENTS?.ATUALIZAR_CONVERSA || 'atualizar_conversa'
  io.to(`empresa_${Number(company_id)}`).emit(ev, { id: Number(conversa_id) })
}

// =====================================================
// ⭐ LOCK REALTIME (SEMANA 3)
// =====================================================
function emitirLock(io, conversa_id, usuario_id = null) {
  if (!io) return;

  io.emitConversa(
    conversa_id,
    io.EVENTS?.CONVERSA_LOCK || "conversa_lock",
    {
      conversa_id: Number(conversa_id),
      locked_by: usuario_id ? Number(usuario_id) : null
    }
  );
}

function emitirRealtimeAposAssumir(io, company_id, conversa_id, user_id, conversaRow) {
  if (!io) return
  emitirConversaAtualizada(io, company_id, conversa_id, { ...conversaRow, exibir_badge_aberta: true }, { skipAtualizarConversa: true })
  emitirSincronizacaoListaConversas(io, company_id, conversa_id)
  emitirLock(io, conversa_id, user_id)
}

function emitirParaUsuario(io, usuario_id, eventName, payload) {
  if (!io) return
  if (io.emitUsuario) io.emitUsuario(usuario_id, eventName, payload)
  else io.to(`usuario_${usuario_id}`).emit(eventName, payload)
}

async function emitirMovimentacaoInternaAtendimento(io, {
  company_id,
  conversa,
  atendimento,
}) {
  if (!io || !atendimento || !['assumiu', 'transferiu'].includes(String(atendimento.acao || '').toLowerCase())) return

  try {
    const idsParaNome = [
      atendimento.de_usuario_id,
      atendimento.para_usuario_id,
    ].map(Number).filter((id) => Number.isFinite(id) && id > 0)

    const userMap = {}
    if (idsParaNome.length > 0) {
      const { data: nomes } = await supabase
        .from('usuarios')
        .select('id, nome')
        .eq('company_id', Number(company_id))
        .in('id', [...new Set(idsParaNome)])
      ;(nomes || []).forEach((u) => { userMap[Number(u.id)] = u.nome || '' })
    }

    const payload = buildMensagemInternaMovimentacao(atendimento, userMap)
    if (!payload) return

    const { data: candidatos, error } = await supabase
      .from('usuarios')
      .select('id, perfil')
      .eq('company_id', Number(company_id))
      .eq('ativo', true)
      .in('perfil', ['admin', 'administrador'])

    if (error) {
      console.warn('[movimentacaoInterna] usuarios:', error?.message || error)
      return
    }

    const recipients = new Set()
    for (const usuario of candidatos || []) {
      if (perfilPodeVerMovimentacaoInterna(usuario?.perfil)) {
        recipients.add(Number(usuario.id))
      }
    }

    recipients.forEach((usuarioId) => {
      if (Number.isFinite(usuarioId) && usuarioId > 0) {
        emitirParaUsuario(io, usuarioId, io.EVENTS?.MENSAGEM_INTERNA_ATENDIMENTO || 'mensagem_interna_atendimento', payload)
      }
    })
  } catch (err) {
    console.warn('[movimentacaoInterna] emitir:', err?.message || err)
  }
}

/** Emite para a room do departamento (realtime por setor) */
function emitirDepartamento(io, departamento_id, eventName, payload) {
  if (!io || !departamento_id) return
  io.to(`departamento_${departamento_id}`).emit(eventName, payload)
}

/**
 * Retorna IDs dos usuários que podem ver a conversa (para unread/notificações).
 * Regras: admin vê tudo; conversa assumida → sempre; setor → só usuários do setor; sem setor → todos.
 * EXCEÇÃO: usuários que transferiram a conversa veem independente do setor.
 */
const conversaVisibilityCache = new Map()

const CONVERSA_VISIBILITY_CACHE_TTL_MS = 15_000

function conversaVisibilityCacheKey(company_id, conversa_id) {
  return `${Number(company_id)}:${Number(conversa_id)}`
}

function invalidateConversaVisibilityCache(company_id, conversa_id) {
  if (company_id == null || conversa_id == null) return
  conversaVisibilityCache.delete(conversaVisibilityCacheKey(company_id, conversa_id))
}

async function getConversaParticipanteIdsAtivos(company_id, conversa_id) {
  if (company_id == null || conversa_id == null) return []
  const { data, error } = await supabase
    .from('conversa_atendentes')
    .select('usuario_id')
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))
    .eq('ativo', true)
  if (error) {
    if (isConversaAtendentesMissingTable(error)) return []
    throw error
  }
  return [...new Set((data || []).map((row) => Number(row.usuario_id)).filter((n) => Number.isFinite(n) && n > 0))]
}

function payloadAlteraVisibilidadeConversa(payload) {
  if (!payload || typeof payload !== 'object') return false
  return (
    Object.prototype.hasOwnProperty.call(payload, 'departamento_id') ||
    Object.prototype.hasOwnProperty.call(payload, 'atendente_id') ||
    Object.prototype.hasOwnProperty.call(payload, 'tipo') ||
    Object.prototype.hasOwnProperty.call(payload, 'departamento_grupos')
  )
}

async function carregarUsuarioIdsQuePodemVerConversaSemCache(company_id, conversa_id) {
  const { data: conv } = await supabase
    .from('conversas')
    .select('departamento_id, atendente_id, tipo, telefone')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()
  if (!conv) return []

  const isGroup = isGroupConversation(conv)
  const convDep = conv.departamento_id ?? null
  const atendenteId = conv.atendente_id ? Number(conv.atendente_id) : null
  const grupoDepIds = isGroup ? await getGrupoDepartamentoIds(company_id, conversa_id) : []
  const grupoDepSet = new Set(grupoDepIds.map(Number))

  const { data: transferiuRows } = await supabase
    .from('atendimentos')
    .select('de_usuario_id')
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))
    .eq('acao', 'transferiu')
  const transferiuIds = new Set((transferiuRows || []).map((r) => Number(r.de_usuario_id)).filter(Boolean))
  const participanteIds = new Set(await getConversaParticipanteIdsAtivos(company_id, conversa_id))

  const { data: usuarios } = await supabase
    .from('usuarios')
    .select('id, perfil, departamento_id')
    .eq('company_id', Number(company_id))
    .eq('ativo', true)
  if (!Array.isArray(usuarios) || usuarios.length === 0) return []

  let userDepMap = new Map()
  const { data: udRows } = await supabase
    .from('usuario_departamentos')
    .select('usuario_id, departamento_id')
    .eq('company_id', Number(company_id))
  if (Array.isArray(udRows)) {
    udRows.forEach((r) => {
      const uid = Number(r.usuario_id)
      if (!userDepMap.has(uid)) userDepMap.set(uid, [])
      userDepMap.get(uid).push(Number(r.departamento_id))
    })
  }

  const ids = []
  for (const u of usuarios) {
    const uid = Number(u.id)
    const isAdmin = String(u.perfil || '').toLowerCase() === 'admin'
    if (isAdmin) { ids.push(uid); continue }
    const userDepIds = userDepMap.get(uid) ?? (u.departamento_id != null ? [Number(u.departamento_id)] : [])
    if (isGroup) {
      if (grupoDepSet.size === 0 || userDepIds.some((d) => grupoDepSet.has(Number(d)))) ids.push(uid)
      continue
    }
    if (atendenteId && uid === atendenteId) { ids.push(uid); continue }
    if (participanteIds.has(uid)) { ids.push(uid); continue }
    if (transferiuIds.has(uid)) { ids.push(uid); continue }
    if (convDep == null) ids.push(uid)
    else if (userDepIds.some((d) => Number(d) === Number(convDep))) ids.push(uid)
  }
  return ids
}

async function obterUsuarioIdsQuePodemVerConversa(company_id, conversa_id) {
  const key = conversaVisibilityCacheKey(company_id, conversa_id)
  const now = Date.now()
  const cached = conversaVisibilityCache.get(key)

  if (cached?.ids && cached.expiresAt > now) return [...cached.ids]
  if (cached?.promise) return [...(await cached.promise)]

  const promise = carregarUsuarioIdsQuePodemVerConversaSemCache(company_id, conversa_id)
  conversaVisibilityCache.set(key, {
    promise,
    expiresAt: now + CONVERSA_VISIBILITY_CACHE_TTL_MS,
  })

  try {
    const ids = await promise
    const safeIds = Array.isArray(ids) ? ids : []
    conversaVisibilityCache.set(key, {
      ids: safeIds,
      expiresAt: Date.now() + CONVERSA_VISIBILITY_CACHE_TTL_MS,
    })
    return [...safeIds]
  } catch (err) {
    conversaVisibilityCache.delete(key)
    throw err
  }
}

/**
 * Incrementa unread apenas para usuários que podem ver a conversa (por setor).
 * Quando o cliente escolhe um setor, só usuários daquele setor recebem notificação.
 *
 * Usa RPC `increment_conversa_unreads` para operação atômica com
 * INSERT ... ON CONFLICT DO UPDATE SET unread_count = unread_count + 1.
 *
 * A função RPC deve existir no banco (migration 20250225000000_production_hardening.sql).
 * Fallback para o método leitura-escrita se o RPC não existir ainda.
 */
async function incrementarUnreadParaConversa(company_id, conversa_id) {
  try {
    const usuarioIds = await obterUsuarioIdsQuePodemVerConversa(company_id, conversa_id)
    if (usuarioIds.length === 0) return

    const cid = Number(company_id)
    const convId = Number(conversa_id)

    const { error: rpcErr } = await supabase.rpc('increment_conversa_unreads', {
      p_company_id: cid,
      p_conversa_id: convId,
      p_usuario_ids: usuarioIds,
    })

    if (!rpcErr) return

    const isNotFound = String(rpcErr.code || '').includes('PGRST202') ||
      String(rpcErr.message || '').includes('function') ||
      String(rpcErr.message || '').includes('not exist')

    if (!isNotFound) {
      console.warn('incrementarUnreadParaConversa rpc error:', rpcErr?.message || rpcErr)
    }

    const now = new Date().toISOString()
    const { data: existentes } = await supabase
      .from('conversa_unreads')
      .select('id, usuario_id, unread_count')
      .eq('company_id', cid)
      .eq('conversa_id', convId)
    const byUser = new Map((existentes || []).map((r) => [Number(r.usuario_id), r]))

    for (const uid of usuarioIds) {
      const row = byUser.get(uid)
      if (row) {
        await supabase
          .from('conversa_unreads')
          .update({ unread_count: Number(row.unread_count || 0) + 1, updated_at: now })
          .eq('id', row.id)
      } else {
        await supabase.from('conversa_unreads').insert({
          company_id: cid, conversa_id: convId, usuario_id: uid, unread_count: 1
        })
      }
    }
  } catch (e) {
    console.warn('incrementarUnreadParaConversa:', e?.message || e)
  }
}

module.exports = {
  conversaVisibilityCache,
  CONVERSA_VISIBILITY_CACHE_TTL_MS,
  conversaVisibilityCacheKey,
  invalidateConversaVisibilityCache,
  getConversaParticipanteIdsAtivos,
  payloadAlteraVisibilidadeConversa,
  carregarUsuarioIdsQuePodemVerConversaSemCache,
  obterUsuarioIdsQuePodemVerConversa,
  incrementarUnreadParaConversa,
  emitirConversaAtualizada,
  emitirParaUsuariosQuePodemVerConversa,
  emitirEventoConversaVisivel,
  emitirEventoEmpresaConversa,
  emitirSincronizacaoListaConversas,
  emitirLock,
  emitirRealtimeAposAssumir,
  emitirParaUsuario,
  emitirMovimentacaoInternaAtendimento,
  emitirDepartamento,
}
