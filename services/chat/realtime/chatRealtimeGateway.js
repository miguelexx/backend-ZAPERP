/**
 * Gateway de realtime (Socket.IO) do chat: emissão de eventos de conversa para as rooms corretas
 * (empresa, conversa, usuário, departamento), respeitando visibilidade por setor e agendando web push.
 *
 * Extraído de controllers/chatController.js (Fase 2/3 da modularização) sem alteração de comportamento.
 * Direção de dependência: realtime → visibilidade (permitida). Este módulo NÃO decide regra de negócio;
 * apenas publica o resultado. Recebe sempre `io` explicitamente (sem estado de socket global aqui).
 */

const supabase = require('../../../config/supabase')
const { isGroupConversation } = require('../../../helpers/conversaHelper')
const {
  buildMensagemInternaMovimentacao,
  perfilPodeVerMovimentacaoInterna,
} = require('../../atendimentosRegistroService')
const { statusAtendimentoParaLista } = require('../presentation/chatDto')
const {
  payloadAlteraVisibilidadeConversa,
  invalidateConversaVisibilityCache,
  obterUsuarioIdsQuePodemVerConversa,
} = require('../access/conversationVisibilityService')
const {
  setorRealtimeMudou,
  emitirMudancaSetorRealtime: emitirMudancaSetorRealtimeBase,
} = require('./setorVisibilidadeRealtime')

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

/**
 * PURA: as salas que recebem um evento escopado a uma conversa.
 *
 * A sala da CONVERSA entra junto com as dos usuários. A lista de quem pode ver vem de um cache de
 * 15s (CONVERSA_VISIBILITY_CACHE_TTL_MS); enquanto o emit ia SÓ para `usuario_*`, o atendente que
 * estava com a conversa ABERTA podia não receber a mensagem dela — bastava a lista estar vencida
 * ou ter sido montada antes de uma mudança de atribuição/setor. O card se curava sozinho (qualquer
 * refetch da lista traz o preview da API); a thread não tem nada equivalente e ficava mentindo:
 * card anunciando uma mensagem que a conversa não mostrava (caso real de 21/10/2026).
 *
 * Não amplia visibilidade: só entra em `conversa_${id}` quem passou por
 * `canUserJoinConversationRoom` no `join_conversa` (socket/conversationRooms.js) — o mesmo
 * raciocínio que `emitirEventoConversaVisivel` já aplicava.
 */
function buildRoomsConversaEUsuarios(conversa_id, usuarioIds) {
  const cid = Number(conversa_id)
  const rooms = Number.isFinite(cid) && cid > 0 ? [`conversa_${cid}`] : []
  for (const uid of usuarioIds || []) {
    const n = Number(uid)
    if (Number.isFinite(n) && n > 0) rooms.push(`usuario_${n}`)
  }
  return rooms
}

async function emitirParaUsuariosQuePodemVerConversa(io, company_id, conversa_id, eventName, payload) {
  if (!io || !conversa_id) return false
  const usuarioIds = await obterUsuarioIdsQuePodemVerConversa(company_id, conversa_id)
  if (!Array.isArray(usuarioIds) || usuarioIds.length === 0) return false
  const idsUnicos = [...new Set(usuarioIds.map(Number).filter((id) => Number.isFinite(id) && id > 0))]
  if (idsUnicos.length === 0) return false
  // A sala da CONVERSA entra junto com as dos usuários.
  //
  // A lista de quem pode ver vem de um cache de 15s (CONVERSA_VISIBILITY_CACHE_TTL_MS). Enquanto
  // este emit ia SÓ para `usuario_*`, o atendente que estava com a conversa ABERTA podia não
  // receber a mensagem da conversa que estava olhando — bastava a lista estar vencida ou ter sido
  // montada antes de uma mudança de atribuição/setor. O card se curava sozinho (qualquer refetch
  // da lista traz o preview da API), a thread não: ficava com a última bolha antiga, com o card
  // anunciando uma mensagem que a conversa não mostrava.
  //
  // Não amplia visibilidade: só entra em `conversa_${id}` quem passou por
  // `canUserJoinConversationRoom` no `join_conversa` (socket/conversationRooms.js). É o mesmo
  // raciocínio que `emitirEventoConversaVisivel`, logo abaixo, já aplicava.
  // Emit único com todas as rooms: 1 serialização do payload em vez de N (caminho de TODO
  // nova_mensagem inbound). Socket.IO deduplica sockets que estejam em mais de uma sala.
  io.to(buildRoomsConversaEUsuarios(conversa_id, idsUnicos)).emit(eventName, payload)
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
    const { scheduleInboundWebPush } = require('../../webPushDispatchService')
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

// ⭐ LOCK REALTIME (SEMANA 3)
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
  const status = String(conversaRow?.status_atendimento || '').toLowerCase()
  const exibirBadgeAberta = !(status === 'em_atendimento' || status === 'aguardando_cliente')
  emitirConversaAtualizada(io, company_id, conversa_id, { ...conversaRow, exibir_badge_aberta: exibirBadgeAberta }, { skipAtualizarConversa: true })
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
 * Quem perdeu o setor precisa receber `conversa_atualizada` na room da empresa.
 * Invalida o cache de visibilidade antes do emit.
 */
function emitirMudancaSetorRealtime(io, company_id, conversa_id, opts = {}) {
  if (setorRealtimeMudou(opts.departamentoIdAnterior, opts.departamento_id)) {
    invalidateConversaVisibilityCache(company_id, conversa_id)
  }
  return emitirMudancaSetorRealtimeBase(io, company_id, conversa_id, opts)
}

module.exports = {
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
  emitirMudancaSetorRealtime,
  setorRealtimeMudou,
  _test: { buildRoomsConversaEUsuarios },
}
