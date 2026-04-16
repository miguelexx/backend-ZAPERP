const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { getStatus } = require('../services/ultramsgIntegrationService')
const { isGroupConversation } = require('../helpers/conversaHelper')
const { normalizePhoneBR, possiblePhonesBR, phoneKeyBR } = require('../helpers/phoneHelper')
const { deduplicateConversationsByContact, sortConversationsByRecent, sortConversationsPinThenRecent, getCanonicalPhone, getOrCreateCliente, mergeConversasIntoCanonico } = require('../helpers/conversationSync')
const { enrichConversationsWithContactData } = require('../helpers/conversaEnrichment')
const { getDisplayName } = require('../helpers/contactEnrichment')

/** UltraMsg retorna id interno (ex: 35096), não o messageId do WhatsApp. Só usar como whatsapp_id se for o ID real. */
function isRealWhatsAppId(waId) {
  return waId && (String(waId).includes('@') || String(waId).length > 20)
}

/**
 * Na listagem, conversas com status "aberta" no BD mas sem mensagem e sem atendente não são tratadas
 * como abertas nas abas (contagem / filtro). Expõe `ociosa` no JSON; o BD permanece `aberta` para constraints e fluxos internos.
 */
function statusAtendimentoParaLista(isGroup, dbStatus, exibirBadgeAberta) {
  if (isGroup) return null
  const s = dbStatus != null ? String(dbStatus) : null
  if (s === 'aberta' && !exibirBadgeAberta) return 'ociosa'
  return s
}

// =====================================================
// 1) HELPERS (TOPO DO ARQUIVO)
// =====================================================
function emitirConversaAtualizada(io, company_id, conversa_id, payload = null, opts = {}) {
  if (!io) return
  const { skipAtualizarConversa = false } = opts

  const cid = Number(conversa_id)
  let data = payload || { id: cid }

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
          io.to(`empresa_${company_id}`).to(`conversa_${cid}`).emit(eventName, enriched)
        } else {
          const eventName = io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada'
          io.to(`empresa_${company_id}`).to(`conversa_${cid}`).emit(eventName, data)
        }
        if (!skipAtualizarConversa) io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: cid })
      })
      .catch(() => {
        const eventName = io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada'
        io.to(`empresa_${company_id}`).to(`conversa_${cid}`).emit(eventName, data)
        if (!skipAtualizarConversa) io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: cid })
      })
    return
  }

  // Emite para empresa + conversa em UMA única operação (evita duplicidade
  // quando o mesmo socket está nas duas rooms).
  const eventName = io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada'
  io.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).emit(eventName, data)

  // skipAtualizarConversa: evita refetch que causa duplicata/glitch (payload já tem tudo)
  if (!skipAtualizarConversa) io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: cid })
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

function emitirEventoEmpresaConversa(io, company_id, conversa_id, eventName, payload) {
  if (!io) return

  if (conversa_id) {
    // Evita "vazamento" cross-setor (ex.: financeiro recebendo vendas).
    // Fallback para room ampla apenas se não conseguirmos resolver os destinatários.
    emitirParaUsuariosQuePodemVerConversa(io, company_id, conversa_id, eventName, payload)
      .then((emitidoFiltrado) => {
        if (!emitidoFiltrado) {
          io.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).emit(eventName, payload)
        }
      })
      .catch(() => {
        io.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).emit(eventName, payload)
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

function emitirParaUsuario(io, usuario_id, eventName, payload) {
  if (!io) return
  if (io.emitUsuario) io.emitUsuario(usuario_id, eventName, payload)
  else io.to(`usuario_${usuario_id}`).emit(eventName, payload)
}

/** Emite para a room do departamento (realtime por setor) */
function emitirDepartamento(io, departamento_id, eventName, payload) {
  if (!io || !departamento_id) return
  io.to(`departamento_${departamento_id}`).emit(eventName, payload)
}

/** Enriquece mensagens com usuario_id, usuario_nome e enviado_por_usuario (apenas direcao out) */
async function enrichMensagensComAutorUsuario(supabase, company_id, mensagens) {
  if (!Array.isArray(mensagens) || mensagens.length === 0) return mensagens
  const autorIds = [...new Set(mensagens.map((m) => m.autor_usuario_id).filter(Boolean))]
  const base = (m) => ({
    ...m,
    usuario_id: m.autor_usuario_id ?? null,
    usuario_nome: null,
    enviado_por_usuario: m.direcao === 'out' && m.autor_usuario_id != null
  })
  if (autorIds.length === 0) return mensagens.map(base)
  const { data: us } = await supabase.from('usuarios').select('id, nome').eq('company_id', company_id).in('id', autorIds)
  const usuarioMap = new Map((us || []).map((u) => [u.id, u.nome]))
  return mensagens.map((m) => ({
    ...base(m),
    usuario_nome: m.direcao === 'out' && m.autor_usuario_id ? (usuarioMap.get(m.autor_usuario_id) ?? null) : null
  }))
}

/** Retorna texto prefixado com nome do atendente para o cliente ver no WhatsApp */
function prefixarParaCliente(texto, usuarioNome) {
  if (!usuarioNome || !String(usuarioNome).trim()) return texto
  const t = String(texto || '').trim()
  return t ? `${String(usuarioNome).trim()}: ${t}` : String(usuarioNome).trim()
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
    usuario_id: msg.autor_usuario_id,
    usuario_nome: u?.nome ?? null,
    enviado_por_usuario: true,
    fromMe: true,
  }
}

async function assertPermissaoConversa({ company_id, conversa_id, user_id, role, user_dep_ids }) {
  const { data: conv, error } = await supabase
    .from('conversas')
    .select('id, atendente_id, departamento_id, tipo, telefone')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!conv) return { ok: false, status: 404, error: 'Conversa não encontrada' }

  const isGroup = isGroupConversation(conv)
  const r = String(role || '').toLowerCase()
  const isAssignedToUser = conv.atendente_id && Number(conv.atendente_id) === Number(user_id)
  const depIds = Array.isArray(user_dep_ids) ? user_dep_ids : []

  // REGRA PRINCIPAL: Se a conversa está assumida pelo usuário, SEMPRE permitir acesso total
  if (isAssignedToUser) return { ok: true, conv, reason: 'conversa_assumida_pelo_usuario' }
  if (r === 'admin') return { ok: true, conv }

  // EXCEÇÃO: usuário transferiu a conversa para outro — vê independente do setor
  const { data: transferRow } = await supabase
    .from('atendimentos')
    .select('id')
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))
    .eq('de_usuario_id', Number(user_id))
    .eq('acao', 'transferiu')
    .limit(1)
    .maybeSingle()
  if (transferRow) return { ok: true, conv, reason: 'usuario_transferiu_conversa' }

  // supervisor e atendente: conversas sem setor visíveis para TODOS; com setor só se usuário pertence
  if (r === 'supervisor' || r === 'atendente') {
    if (!isGroup) {
      const convDep = conv.departamento_id ?? null
      const userSemSetor = depIds.length === 0
      if (userSemSetor && convDep != null) return { ok: false, status: 403, error: 'Conversa de outro setor' }
      if (convDep != null && !depIds.some((id) => Number(id) === Number(convDep))) return { ok: false, status: 403, error: 'Conversa de outro setor' }
    }
    return { ok: true, conv }
  }

  return { ok: true, conv }
}

/**
 * Verifica se o usuário pode ENVIAR mensagens na conversa.
 * Regras principais:
 * - GRUPOS: Qualquer usuário pode enviar SEM assumir
 * - Se a conversa está assumida pelo usuário (atendente_id === user_id), pode enviar
 * - Conversa em fila (atendente_id === null), qualquer usuário pode enviar
 * - FLEXÍVEL: Sistema permite envio para facilitar atendimento colaborativo
 */
async function assertPodeEnviarMensagem({ company_id, conversa_id, user_id }) {
  const { data: conv, error } = await supabase
    .from('conversas')
    .select('id, atendente_id, tipo, telefone')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!conv) return { ok: false, status: 404, error: 'Conversa não encontrada' }

  // GRUPOS: qualquer usuário pode enviar sem assumir
  if (isGroupConversation(conv)) {
    return { ok: true, reason: 'grupo_sem_exigir_assumir' }
  }

  // REGRA PRINCIPAL: Se a conversa está assumida pelo usuário, SEMPRE pode enviar
  const isAssignedToUser = conv.atendente_id && Number(conv.atendente_id) === Number(user_id)
  if (isAssignedToUser) {
    return { ok: true, reason: 'conversa_assumida_pelo_usuario' }
  }

  // REGRA SECUNDÁRIA: Conversa em fila (sem atendente), qualquer usuário pode enviar
  if (!conv.atendente_id) {
    return { ok: true, reason: 'conversa_em_fila' }
  }

  // REGRA FLEXÍVEL: Permitir envio mesmo se assumida por outro (para colaboração)
  return { ok: true, reason: 'sistema_colaborativo' }
}

// =====================================================
// 2) UNREAD (TotalChat-like)
// =====================================================
async function marcarComoLidaPorUsuario({ company_id, conversa_id, usuario_id }) {
  await supabase
    .from('conversa_unreads')
    .update({
      unread_count: 0,
      updated_at: new Date().toISOString()
    })
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))
    .eq('usuario_id', Number(usuario_id))

  // mantém compatibilidade com seu campo global
  await supabase
    .from('conversas')
    .update({ lida: true })
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
}

async function obterUnreadMap({ company_id, usuario_id }) {
  const { data, error } = await supabase
    .from('conversa_unreads')
    .select('conversa_id, unread_count')
    .eq('company_id', Number(company_id))
    .eq('usuario_id', Number(usuario_id))

  if (error) return {}

  const map = {}
  for (const row of data || []) {
    map[Number(row.conversa_id)] = Number(row.unread_count || 0)
  }
  return map
}

/**
 * Retorna IDs dos usuários que podem ver a conversa (para unread/notificações).
 * Regras: admin vê tudo; conversa assumida → sempre; setor → só usuários do setor; sem setor → todos.
 * EXCEÇÃO: usuários que transferiram a conversa veem independente do setor.
 */
async function obterUsuarioIdsQuePodemVerConversa(company_id, conversa_id) {
  const { data: conv } = await supabase
    .from('conversas')
    .select('departamento_id, atendente_id, tipo')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()
  if (!conv) return []

  const isGroup = isGroupConversation(conv)
  const convDep = conv.departamento_id ?? null
  const atendenteId = conv.atendente_id ? Number(conv.atendente_id) : null

  const { data: transferiuRows } = await supabase
    .from('atendimentos')
    .select('de_usuario_id')
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))
    .eq('acao', 'transferiu')
  const transferiuIds = new Set((transferiuRows || []).map((r) => Number(r.de_usuario_id)).filter(Boolean))

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
    if (atendenteId && uid === atendenteId) { ids.push(uid); continue }
    if (transferiuIds.has(uid)) { ids.push(uid); continue }
    if (isGroup) { ids.push(uid); continue }
    const userDepIds = userDepMap.get(uid) ?? (u.departamento_id != null ? [Number(u.departamento_id)] : [])
    if (convDep == null) ids.push(uid)
    else if (userDepIds.some((d) => Number(d) === Number(convDep))) ids.push(uid)
  }
  return ids
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

exports.incrementarUnreadParaConversa = incrementarUnreadParaConversa
exports.emitirParaUsuariosQuePodemVerConversa = emitirParaUsuariosQuePodemVerConversa

// =====================================================
// AUX: registrar atendimentos
// =====================================================
async function registrarAtendimento({
  conversa_id,
  company_id,
  acao,
  de_usuario_id,
  para_usuario_id = null,
  observacao = null
}) {
  const { data, error } = await supabase
    .from('atendimentos')
    .insert({
      conversa_id: Number(conversa_id),
      company_id: Number(company_id),
      acao,
      de_usuario_id: de_usuario_id != null ? Number(de_usuario_id) : null,
      para_usuario_id: para_usuario_id != null ? Number(para_usuario_id) : null,
      observacao
    })
    .select('id')
    .single()
  if (error) return { error, atendimento: null }
  return { error: null, atendimento: data }
}

// =====================================================
// 3) listarConversas (com unread_count + pesquisa avançada)
// Query: tag_id, data_inicio, data_fim, status_atendimento, atendente_id, palavra, minha_fila
// minha_fila=1: só conversas (não grupo) em aberta (fila visível) + em_atendimento onde o responsável é o usuário logado
// =====================================================
exports.listarConversas = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const role = String(perfil || '').toLowerCase()
    const isAdmin = role === 'admin'
    const isAtendente = role === 'atendente'
    const {
      tag_id,
      data_inicio,
      data_fim,
      status_atendimento,
      atendente_id,
      palavra,
      departamento_id: filter_dep_id,
      incluir_todos_clientes: incluirTodosClientes,
      minha_fila: minhaFilaRaw,
      incluir_colaboradores_encaminhar: incluirColabEncRaw,
    } = req.query

    const incluirColaboradoresEncaminhar =
      incluirColabEncRaw === '1' ||
      incluirColabEncRaw === 'true' ||
      incluirColabEncRaw === 1 ||
      incluirColabEncRaw === true

    const minhaFilaAtiva =
      minhaFilaRaw === '1' ||
      minhaFilaRaw === 'true' ||
      minhaFilaRaw === 1 ||
      minhaFilaRaw === true

    const statusNorm =
      !minhaFilaAtiva &&
      status_atendimento != null &&
      String(status_atendimento).trim() !== ''
        ? String(status_atendimento).toLowerCase().trim()
        : null

    const unreadMap = await obterUnreadMap({ company_id, usuario_id: user_id })

    async function loadColaboradoresEncaminhar() {
      const { data, error } = await supabase
        .from('usuarios')
        .select('id, nome, email, perfil')
        .eq('company_id', company_id)
        .eq('ativo', true)
        .neq('id', user_id)
        .order('nome', { ascending: true })
      if (error) return []
      return (data || []).map((u) => ({
        usuario_id: Number(u.id),
        nome: u.nome ?? null,
        email: u.email ?? null,
        perfil: u.perfil ?? null,
      }))
    }

    // Exceção: conversas que o usuário transferiu para outro — aparecem na lista independente do setor
    let conversaIdsTransferidas = []
    if (!isAdmin) {
      const { data: transferRows } = await supabase
        .from('atendimentos')
        .select('conversa_id')
        .eq('company_id', company_id)
        .eq('de_usuario_id', user_id)
        .eq('acao', 'transferiu')
      conversaIdsTransferidas = [...new Set((transferRows || []).map((r) => Number(r.conversa_id)).filter(Boolean))]
    }

    let conversaIdsFilter = null

    if (tag_id) {
      const { data: tagRows } = await supabase
        .from('conversa_tags')
        .select('conversa_id')
        .eq('company_id', company_id)
        .eq('tag_id', tag_id)
      const ids = (tagRows || []).map((r) => r.conversa_id)
      if (ids.length === 0) {
        if (!incluirColaboradoresEncaminhar) return res.json([])
        const colaboradores_encaminhar = await loadColaboradoresEncaminhar()
        return res.json({ conversas: [], colaboradores_encaminhar })
      }
      conversaIdsFilter = ids
    }

    if (palavra && String(palavra).trim()) {
      const term = `%${String(palavra).trim()}%`
      const { data: clientesMatch } = await supabase
        .from('clientes')
        .select('id')
        .eq('company_id', company_id)
        .or(`nome.ilike.${term},pushname.ilike.${term},telefone.ilike.${term}`)
      const clienteIds = (clientesMatch || []).map((c) => c.id)
      const { data: convByCliente } = await supabase
        .from('conversas')
        .select('id')
        .eq('company_id', company_id)
        .in('cliente_id', clienteIds.length ? clienteIds : [0])
      const { data: convByTelefone } = await supabase
        .from('conversas')
        .select('id')
        .eq('company_id', company_id)
        .ilike('telefone', term)
      const { data: convByNomeGrupo } = await supabase
        .from('conversas')
        .select('id')
        .eq('company_id', company_id)
        .ilike('nome_grupo', term)
      const { data: msgMatch } = await supabase
        .from('mensagens')
        .select('conversa_id')
        .eq('company_id', company_id)
        .ilike('texto', term)
      const idsFromMsg = [...new Set((msgMatch || []).map((m) => m.conversa_id))]
      const idsFromCliente = (convByCliente || []).map((c) => c.id)
      const idsFromTel = (convByTelefone || []).map((c) => c.id)
      const idsFromGrupo = (convByNomeGrupo || []).map((c) => c.id)
      const merged = [...new Set([...idsFromCliente, ...idsFromTel, ...idsFromGrupo, ...idsFromMsg])]
      if (merged.length === 0) {
        if (!incluirColaboradoresEncaminhar) return res.json([])
        const colaboradores_encaminhar = await loadColaboradoresEncaminhar()
        return res.json({ conversas: [], colaboradores_encaminhar })
      }
      conversaIdsFilter = conversaIdsFilter ? conversaIdsFilter.filter((id) => merged.includes(id)) : merged
    }

    const selectCompleto = `
      id,
      telefone,
      cliente_id,
      status_atendimento,
      atendente_id,
      lida,
      criado_em,
      ultima_atividade,
      departamento_id,
      tipo,
      nome_grupo,
      foto_grupo,
      nome_contato_cache,
      foto_perfil_contato_cache,
      clientes!conversas_cliente_fk ( id, nome, pushname, telefone, foto_perfil, company_id ),
      atendente:usuarios!conversas_atendente_id_fkey ( id, nome, email ),
      departamentos ( id, nome ),
      mensagens ( texto, criado_em, direcao, tipo, url, nome_arquivo, whatsapp_id, status, autor_usuario_id, contact_meta, location_meta ),
      conversa_tags (
        tag_id,
        tags (
          id,
          nome,
          cor
        )
      )
    `
    const selectMinimo = `
      id,
      telefone,
      cliente_id,
      status_atendimento,
      atendente_id,
      lida,
      criado_em,
      departamento_id,
      tipo,
      nome_grupo,
      foto_grupo,
      nome_contato_cache,
      foto_perfil_contato_cache,
      clientes!conversas_cliente_fk ( id, nome, pushname, telefone, foto_perfil, company_id ),
      atendente:usuarios!conversas_atendente_id_fkey ( id, nome, email ),
      departamentos ( id, nome ),
      mensagens ( texto, criado_em, direcao, tipo, url, nome_arquivo, whatsapp_id, status, autor_usuario_id, contact_meta, location_meta ),
      conversa_tags (
        tag_id,
        tags (
          id,
          nome,
          cor
        )
      )
    `
    // Fallback mínimo mas com foto e última mensagem para não quebrar setas/fotos na UI ao atualizar
    const selectBare = `
      id,
      telefone,
      cliente_id,
      status_atendimento,
      atendente_id,
      lida,
      criado_em,
      departamento_id,
      tipo,
      nome_grupo,
      foto_grupo,
      nome_contato_cache,
      foto_perfil_contato_cache,
      clientes!conversas_cliente_fk ( id, nome, pushname, telefone, foto_perfil, company_id ),
      atendente:usuarios!conversas_atendente_id_fkey ( id, nome, email ),
      departamentos ( id, nome ),
      mensagens ( texto, criado_em, direcao, tipo, url, nome_arquivo, whatsapp_id, status, autor_usuario_id, contact_meta, location_meta )
    `

    function buildQuery(select) {
      let q = supabase
        .from('conversas')
        .select(select)
        .eq('company_id', company_id)
      // Filtro por setor: conversas sem setor visíveis para TODOS; com setor só mesmo setor.
      // EXCEÇÃO: conversas que o usuário transferiu — aparecem independente do setor.
      if (!isAdmin) {
        const depIds = Array.isArray(departamento_ids) ? departamento_ids.filter((id) => id != null && Number.isFinite(Number(id))) : []
        const parts = []
        if (depIds.length > 0) {
          depIds.forEach((d) => parts.push(`departamento_id.eq.${d}`))
        }
        parts.push('departamento_id.is.null', `tipo.eq.grupo`, `atendente_id.eq.${user_id}`)
        if (conversaIdsTransferidas.length > 0) {
          parts.push(`id.in.(${conversaIdsTransferidas.join(',')})`)
        }
        q = q.or(parts.join(','))
      } else if (filter_dep_id) {
        q = q.eq('departamento_id', Number(filter_dep_id))
      }
      if (conversaIdsFilter && conversaIdsFilter.length > 0) {
        q = q.in('id', conversaIdsFilter)
      }
      // Filtro personalizado "Minha fila": abertas (fila) + em atendimento só comigo; sem grupos; sem finalizadas
      if (minhaFilaAtiva) {
        q = q.or('tipo.is.null,tipo.neq.grupo')
        q = q.or(
          `status_atendimento.eq.aberta,and(status_atendimento.eq.em_atendimento,atendente_id.eq.${user_id})`
        )
      } else if (statusNorm) {
        // Grupos são sempre visíveis independentemente do filtro de status —
        // não têm estado de atendimento (não precisam ser assumidos nem encerrados).
        q = q.or(`tipo.eq.grupo,status_atendimento.eq.${statusNorm}`)
      }
      // Atendente: vê TODAS as conversas (pode assumir, transferir, responder qualquer uma)
      // Admin/supervisor: filtro opcional por atendente_id
      if (!minhaFilaAtiva && !isAtendente && atendente_id) q = q.eq('atendente_id', Number(atendente_id))
      if (data_inicio) q = q.gte('criado_em', new Date(data_inicio).toISOString())
      if (data_fim) {
        const end = new Date(data_fim)
        end.setHours(23, 59, 59, 999)
        q = q.lte('criado_em', end.toISOString())
      }

      // PERFORMANCE: a lista de conversas só precisa da ÚLTIMA mensagem (preview).
      // Se vier todas as mensagens embutidas, a payload explode e a UI fica lenta.
      // Supabase-js v2: use referencedTable para ordenar/limitar relação.
      q = q
        .order('criado_em', { ascending: false, referencedTable: 'mensagens' })
        .order('id', { ascending: false, referencedTable: 'mensagens' })
        .limit(1, { referencedTable: 'mensagens' })
      return q
    }

    let data = null
    let error = null

    const queryCompleto = buildQuery(selectCompleto)
      .order('ultima_atividade', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
    let result = await queryCompleto
    data = result.data
    error = result.error

    if (error) {
      const queryMinimo = buildQuery(selectMinimo)
        .order('criado_em', { ascending: false })
        .order('id', { ascending: false })
      result = await queryMinimo
      data = result.data
      error = result.error
    }

    if (error) {
      const queryBare = buildQuery(selectBare)
        .order('criado_em', { ascending: false })
        .order('id', { ascending: false })
      result = await queryBare
      data = result.data
      error = result.error
    }

    if (error) return res.status(500).json({ error: error.message })

    // Enriquece última mensagem de cada conversa com usuario_nome
    const allLastMsgs = (data || []).flatMap((c) => c.mensagens || [])
    if (allLastMsgs.length > 0) {
      const enriched = await enrichMensagensComAutorUsuario(supabase, company_id, allLastMsgs)
      let idx = 0
      for (const c of data || []) {
        if (c.mensagens && c.mensagens.length > 0) {
          c.mensagens = [enriched[idx++]]
        }
      }
    }

    // Fallback: quando conversa.cliente_id é null mas existe cliente com o mesmo telefone,
    // usamos esse cliente para exibir nome/foto na lista.
    // Usa possiblePhonesBR para matching entre formatos (5511... vs 11..., 12 vs 13 dígitos).
    const phoneToClientFallback = new Map()
    try {
      const phonesSemCliente = (data || [])
        .filter((c) => !isGroupConversation(c) && !c.cliente_id && c.telefone && !String(c.telefone).startsWith('lid:'))
        .map((c) => String(c.telefone).trim())
      const uniquePhones = Array.from(new Set(phonesSemCliente.filter(Boolean)))
      if (uniquePhones.length > 0) {
        const expandedPhones = new Set()
        for (const p of uniquePhones) {
          const variants = possiblePhonesBR(p)
          if (variants.length > 0) variants.forEach((v) => expandedPhones.add(v))
          else expandedPhones.add(p)
        }
        const { data: clientesFallback } = await supabase
          .from('clientes')
          .select('id, nome, pushname, telefone, foto_perfil')
          .eq('company_id', company_id)
          .in('telefone', Array.from(expandedPhones))
        for (const cl of clientesFallback || []) {
          if (!cl || !cl.telefone) continue
          const variants = possiblePhonesBR(cl.telefone)
          const keys = variants.length > 0 ? variants : [String(cl.telefone).trim()]
          for (const k of keys) {
            if (k) phoneToClientFallback.set(k, cl)
          }
          phoneToClientFallback.set(String(cl.telefone).trim(), cl)
        }
      }
    } catch (_) {
      // fallback silencioso — se falhar, apenas seguimos sem foto/nome extra
    }

    const cid = Number(company_id)
    let conversasFormatadas = (data || []).map((c) => {
      const raw = c.clientes
      let clientesObj = Array.isArray(raw)
        ? (raw.find((cl) => cl && Number(cl.id) === Number(c.cliente_id)) || raw[0])
        : raw
      // Isolamento multi-tenant: descarta cliente de outra empresa (evita vazamento entre companies)
      if (clientesObj && clientesObj.company_id != null && Number(clientesObj.company_id) !== cid) {
        clientesObj = null
      }
      if (!clientesObj && !isGroupConversation(c) && !c.cliente_id && c.telefone) {
        const convTel = String(c.telefone).trim()
        let fallbackCli = phoneToClientFallback.get(convTel)
        if (!fallbackCli && convTel) {
          const variants = possiblePhonesBR(convTel)
          for (const v of variants) {
            if ((fallbackCli = phoneToClientFallback.get(v))) break
          }
        }
        if (fallbackCli) clientesObj = fallbackCli
      }

      const nomeCliente = getDisplayName(clientesObj)

      const fotoCliente =
        (clientesObj?.foto_perfil && String(clientesObj.foto_perfil).trim()) ||
        null

      const isGroup = isGroupConversation(c)
      const ultimaMsg = Array.isArray(c.mensagens) && c.mensagens.length > 0 ? c.mensagens[0] : null

      const isLid = !isGroup && c.telefone && String(c.telefone).trim().toLowerCase().startsWith('lid:')
      const telefoneExibivel = isLid ? null : c.telefone

      const contatoNome = isGroup
        ? (c.nome_grupo || telefoneExibivel || 'Grupo')
        : (
            nomeCliente ||
            (c.nome_contato_cache && String(c.nome_contato_cache).trim()) ||
            telefoneExibivel ||
            'Sem nome'
          )

      const fotoPerfil = isGroup
        ? null
        : (
            fotoCliente ||
            (c.foto_perfil_contato_cache && String(c.foto_perfil_contato_cache).trim()) ||
            null
          )
      const unreadCount = unreadMap[Number(c.id)] || 0
      // Grupos não têm estado de atendimento: sem badge "aberta", sem status, sem atendente obrigatório
      const temMensagem = Array.isArray(c.mensagens) && c.mensagens.length > 0
      const exibir_badge_aberta = !isGroup && (temMensagem || (c.atendente_id != null))
      const atendRow = c.atendente && typeof c.atendente === 'object' ? c.atendente : null
      const atendenteNome =
        atendRow && atendRow.nome != null && String(atendRow.nome).trim()
          ? String(atendRow.nome).trim()
          : null
      const atendenteEmail =
        atendRow && atendRow.email != null && String(atendRow.email).trim()
          ? String(atendRow.email).trim()
          : null
      const temNovasMensagens = unreadCount > 0
      const conversaEmAtendimentoDoUsuario =
        !isGroup &&
        c.status_atendimento === 'em_atendimento' &&
        Number(c.atendente_id) === Number(user_id)
      const temNotificacaoDiscretaEmAtendimento =
        !isGroup &&
        conversaEmAtendimentoDoUsuario &&
        temNovasMensagens

      return {
        id: c.id,
        cliente_id: c.cliente_id,
        telefone: c.telefone,
        telefone_exibivel: telefoneExibivel,
        status_atendimento: statusAtendimentoParaLista(isGroup, c.status_atendimento, exibir_badge_aberta),
        exibir_badge_aberta,
        atendente_id: c.atendente_id,
        atendente_nome: atendenteNome,
        atendente_email: atendenteEmail,
        lida: unreadCount === 0,
        tem_novas_mensagens: temNovasMensagens,
        tem_novas_mensagens_em_atendimento: temNotificacaoDiscretaEmAtendimento,
        criado_em: c.criado_em,
        ultima_atividade: c.ultima_atividade,
        departamento_id: c.departamento_id,
        tipo: c.tipo,
        nome_grupo: c.nome_grupo,
        foto_grupo: isGroup ? (c.foto_grupo ?? null) : null,
        mensagens: c.mensagens,
        ultima_mensagem: ultimaMsg,
        conversa_tags: c.conversa_tags || [],
        departamentos: c.departamentos,
        is_group: isGroup,
        contato_nome: contatoNome,
        foto_perfil: fotoPerfil,
        setor: c.departamentos?.nome || null,
        tags: (c.conversa_tags || []).map((ct) => ct?.tags).filter(Boolean),
        unread_count: unreadCount
      }
    })

    // Um contato = uma conversa na lista (evita duplicata 55... vs 11...); conversas mais recentes no topo
    conversasFormatadas = deduplicateConversationsByContact(conversasFormatadas)
    conversasFormatadas = sortConversationsByRecent(conversasFormatadas)

    // Filtro "Abertas": só incluir conversas com movimentação (mensagem ou atendente assumiu)
    // Exclui: conversas sem mensagens e sem atividade — não contam como abertas
    if (statusNorm === 'aberta') {
      conversasFormatadas = conversasFormatadas.filter((c) => {
        if (c.sem_conversa) return false
        if (c.is_group) return c.ultima_mensagem != null // grupo precisa ter ao menos 1 mensagem
        return c.exibir_badge_aberta // individual: tem mensagem ou atendente assumiu
      })
    }

    // "Minha fila": alinha com abas Abertas + Em atendimento só do usuário (exclui finalizadas e assumidas por outros)
    if (minhaFilaAtiva) {
      conversasFormatadas = conversasFormatadas.filter((c) => {
        if (c.sem_conversa || c.is_group) return false
        if (c.status_atendimento === 'ociosa') return false
        if (c.status_atendimento === 'em_atendimento') {
          return Number(c.atendente_id) === Number(user_id)
        }
        if (c.status_atendimento === 'aberta') {
          const livreOuMeu = c.atendente_id == null || Number(c.atendente_id) === Number(user_id)
          return c.exibir_badge_aberta && livreOuMeu
        }
        return false
      })
    }

    // Incluir todos os clientes: quem não tem conversa aparece como "Sem conversa" (clicável para abrir)
    // Ao filtrar "Abertas", não incluir sem_conversa (não há conversa aberta)
    const incluirTodos =
      (incluirTodosClientes === '1' || incluirTodosClientes === 'true' || incluirTodosClientes === 1) &&
      statusNorm !== 'aberta' &&
      !minhaFilaAtiva
    if (incluirTodos) {
      const cid = Number(company_id)
      let clientesQuery = supabase
        .from('clientes')
        .select('id, nome, pushname, telefone, foto_perfil')
        .eq('company_id', cid)
        .order('nome', { ascending: true, nullsFirst: false })
        .limit(5000)
      const { data: todosClientes } = await clientesQuery
      const clienteIdsComConversa = new Set(
        conversasFormatadas
          .filter((c) => c.cliente_id != null)
          .map((c) => Number(c.cliente_id))
      )
      // ✅ Evita "Sem conversa" falso quando a conversa existe mas está ligada a outro cliente duplicado.
      const convPhoneKeys = new Set(
        (conversasFormatadas || [])
          .filter((c) => !c.is_group && c.telefone)
          .map((c) => phoneKeyBR(c.telefone))
          .filter(Boolean)
      )
      const semConversa = (todosClientes || []).filter((cl) => {
        if (clienteIdsComConversa.has(Number(cl.id))) return false
        const key = phoneKeyBR(cl.telefone || '')
        if (key && convPhoneKeys.has(key)) return false
        return true
      })
      const itensSemConversa = semConversa.map((cl) => ({
        id: null,
        cliente_id: cl.id,
        telefone: cl.telefone || '',
        tipo: 'cliente',
        contato_nome: getDisplayName(cl) || null,
        foto_perfil: cl.foto_perfil || null,
        sem_conversa: true,
        mensagens: [],
        unread_count: 0,
        tags: [],
        status_atendimento: null,
        exibir_badge_aberta: false,
        ultima_atividade: null,
        criado_em: null
      }))
      conversasFormatadas = [...conversasFormatadas, ...itensSemConversa]
      conversasFormatadas.sort((a, b) => {
        if (a.sem_conversa && b.sem_conversa) {
          const na = (a.contato_nome || '').toString().toLowerCase()
          const nb = (b.contato_nome || '').toString().toLowerCase()
          return na.localeCompare(nb)
        }
        if (a.sem_conversa) return 1
        if (b.sem_conversa) return -1
        const ta = a.ultima_atividade || a.criado_em || ''
        const tb = b.ultima_atividade || b.criado_em || ''
        return new Date(tb) - new Date(ta)
      })
    }

    // Preferências por usuário (silenciar / fixar / favoritar) — migration: conversa_usuario_prefs
    try {
      const idsComConversa = conversasFormatadas
        .filter((c) => c.id != null && !c.sem_conversa)
        .map((c) => Number(c.id))
        .filter((id) => Number.isFinite(id) && id > 0)
      if (idsComConversa.length > 0) {
        const { data: prefRows, error: prefErr } = await supabase
          .from('conversa_usuario_prefs')
          .select('conversa_id, silenciada, fixada, favorita, fixada_em')
          .eq('company_id', Number(company_id))
          .eq('usuario_id', Number(user_id))
          .in('conversa_id', idsComConversa)
        const missingTable =
          prefErr &&
          (String(prefErr.message || '').toLowerCase().includes('conversa_usuario_prefs') ||
            String(prefErr.message || '').includes('schema cache') ||
            String(prefErr.code || '') === '42P01')
        if (prefErr && !missingTable) {
          console.warn('[listarConversas] conversa_usuario_prefs:', prefErr.message)
        } else {
          const prefMap = new Map((prefRows || []).map((r) => [Number(r.conversa_id), r]))
          conversasFormatadas = conversasFormatadas.map((c) => {
            if (c.sem_conversa || c.id == null) {
              return {
                ...c,
                silenciada: false,
                fixada: false,
                favorita: false,
                fixada_em: null,
              }
            }
            const p = prefMap.get(Number(c.id))
            return {
              ...c,
              silenciada: !!(p && p.silenciada),
              fixada: !!(p && p.fixada),
              favorita: !!(p && p.favorita),
              fixada_em: p && p.fixada_em != null ? p.fixada_em : null,
            }
          })
          if (!prefErr) {
            conversasFormatadas = sortConversationsPinThenRecent(conversasFormatadas)
          }
        }
      }
    } catch (e) {
      console.warn('[listarConversas] prefs:', e?.message || e)
    }

    if (!incluirColaboradoresEncaminhar) {
      return res.json(conversasFormatadas)
    }
    const colaboradores_encaminhar = await loadColaboradoresEncaminhar()
    return res.json({ conversas: conversasFormatadas, colaboradores_encaminhar })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar conversas' })
  }
}

// HTML mínimo da página "Apagar duplicatas" (botão + chamada à API)
const MERGE_DUPLICATAS_HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Apagar duplicatas</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 1rem; background: #f5f5f5; }
    .box { background: #fff; border-radius: 8px; padding: 1rem 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); max-width: 380px; }
    .box h2 { margin: 0 0 .75rem; font-size: 1rem; font-weight: 600; color: #333; }
    .box p { margin: 0 0 1rem; font-size: 0.875rem; color: #666; }
    .btn { background: #25d366; color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.875rem; cursor: pointer; }
    .btn:hover { background: #20bd5a; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .msg { margin-top: 0.75rem; font-size: 0.8125rem; }
    .msg.ok { color: #0a0; }
    .msg.err { color: #c00; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Conversas e contatos duplicados</h2>
    <p>Unifica conversas e contatos do mesmo número (evita duplicados ao enviar pelo celular).</p>
    <button type="button" class="btn" id="btn">Remover duplicatas</button>
    <div class="msg" id="msg"></div>
  </div>
  <script>
    (function() {
      var btn = document.getElementById('btn');
      var msg = document.getElementById('msg');
      function getToken() {
        try {
          return localStorage.getItem('token') || localStorage.getItem('authToken') || localStorage.getItem('jwt') || '';
        } catch (e) { return ''; }
      }
      function setMsg(text, isErr) {
        msg.textContent = text || '';
        msg.className = 'msg' + (text ? (isErr ? ' err' : ' ok') : '');
      }
      btn.addEventListener('click', function() {
        btn.disabled = true;
        setMsg('');
        var token = getToken();
        fetch(window.location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (token || '') }
        }).then(function(r) {
          return r.json().then(function(d) { return { ok: r.ok, data: d }; });
        }).then(function(_) {
          var res = _.data;
          if (_.ok) {
            var parts = [];
            if (res.clientesRemovidos) parts.push(res.clientesRemovidos + ' contato(s)');
            if (res.merged) parts.push(res.merged + ' conversa(s)');
            setMsg(res.message || (parts.length ? parts.join(', ') + ' unificados.' : 'Nenhuma duplicata encontrada.'));
          } else setMsg(res.error || 'Erro', true);
        }).catch(function(e) {
          setMsg('Erro: ' + (e.message || 'rede'), true);
        }).finally(function() {
          btn.disabled = false;
        });
      });
    })();
  </script>
</body>
</html>
`

// GET /chats/merge-duplicatas — página com botão "Apagar duplicatas" (abrir no navegador)
exports.paginaMergeDuplicatas = (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(MERGE_DUPLICATAS_HTML)
}

// =====================================================
// Merge conversas duplicadas (mesmo contato, variantes de telefone)
// Inclui reconciliação LID: mescla conversas com telefone="lid:xxx" na conversa do mesmo chat_lid.
// POST /chats/merge-duplicatas — admin only
// =====================================================
exports.mergeConversasDuplicadas = async (req, res) => {
  try {
    const { company_id } = req.user
    const cid = Number(company_id)

    let clientesRemovidos = 0

    // 1) Remover contatos duplicados (mesmo número em formatos diferentes)
    const { data: clientes, error: errCli } = await supabase
      .from('clientes')
      .select('id, telefone, nome')
      .eq('company_id', cid)
      .not('telefone', 'like', 'lid:%')

    if (!errCli && Array.isArray(clientes)) {
      const byPhoneKey = new Map()
      for (const cl of clientes) {
        const key = phoneKeyBR(cl.telefone) || String(cl.telefone || '').replace(/\D/g, '')
        if (!key) continue
        if (!byPhoneKey.has(key)) byPhoneKey.set(key, [])
        byPhoneKey.get(key).push(cl)
      }
      for (const [, list] of byPhoneKey) {
        if (list.length <= 1) continue
        list.sort((a, b) => {
          const na = (a.nome || '').trim().length
          const nb = (b.nome || '').trim().length
          if (nb !== na) return nb - na
          return (a.id || 0) - (b.id || 0)
        })
        const canonical = list[0]
        const dupIds = list.slice(1).map((c) => c.id).filter(Boolean)
        if (dupIds.length === 0) continue
        try {
          await supabase.from('conversas').update({ cliente_id: canonical.id }).eq('company_id', cid).in('cliente_id', dupIds)
          const { error: delErr } = await supabase.from('clientes').delete().eq('company_id', cid).in('id', dupIds)
          if (!delErr) clientesRemovidos += dupIds.length
        } catch (e) {
          console.warn('mergeConversasDuplicadas clientes:', e?.message || e)
        }
      }
    }

    // 2) Mesclar conversas duplicadas
    const { data: conversas, error: errList } = await supabase
      .from('conversas')
      .select('id, telefone, chat_lid, ultima_atividade, criado_em, tipo')
      .eq('company_id', cid)
      .neq('status_atendimento', 'fechada')
      .not('telefone', 'is', null)

    if (errList) return res.status(500).json({ error: errList.message })

    const individuais = (conversas || []).filter((c) => !c.tipo || String(c.tipo).toLowerCase() !== 'grupo')
    const byKey = new Map()
    for (const c of individuais) {
      const key = phoneKeyBR(c.telefone) || String(c.telefone || '').replace(/\D/g, '')
      if (!key) continue
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key).push(c)
    }

    let merged = 0
    for (const [, list] of byKey) {
      if (list.length <= 1) continue
      list.sort((a, b) => {
        const ta = new Date(a.ultima_atividade || a.criado_em || 0).getTime()
        const tb = new Date(b.ultima_atividade || b.criado_em || 0).getTime()
        if (tb !== ta) return tb - ta
        return (b.id || 0) - (a.id || 0)
      })
      const canonical = list[0]
      const otherIds = list.slice(1).map((c) => c.id).filter(Boolean)
      if (otherIds.length === 0) continue
      try {
        await mergeConversasIntoCanonico(supabase, cid, canonical.id, otherIds)
        merged += otherIds.length
      } catch (e) {
        console.warn('mergeConversasDuplicadas:', e?.message || e)
      }
    }

    // Reconcilição LID: conversas com telefone="lid:xxx" mesclar na conversa com telefone real que tenha o mesmo chat_lid
    const lidConvs = individuais.filter((c) => String(c.telefone || '').startsWith('lid:'))
    for (const lidConv of lidConvs) {
      const lidPart = lidConv.telefone ? String(lidConv.telefone).replace(/^lid:/, '').trim() : (lidConv.chat_lid || '')
      if (!lidPart) continue
      const canonPhone = individuais
        .filter((c) => c.id !== lidConv.id && !String(c.telefone || '').startsWith('lid:') && c.chat_lid === lidPart)
        .sort((a, b) => new Date(b.ultima_atividade || 0).getTime() - new Date(a.ultima_atividade || 0).getTime())[0]
      if (canonPhone) {
        try {
          await mergeConversasIntoCanonico(supabase, cid, canonPhone.id, [lidConv.id])
          merged += 1
          await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', canonPhone.id).eq('company_id', cid)
        } catch (e) {
          console.warn('mergeConversasDuplicadas LID:', e?.message || e)
        }
      }
    }

    const msgParts = []
    if (clientesRemovidos) msgParts.push(`${clientesRemovidos} contato(s) removido(s)`)
    if (merged) msgParts.push(`${merged} conversa(s) unificada(s)`)
    const message = msgParts.length ? msgParts.join('. ') + '.' : 'Nenhuma duplicata encontrada.'
    return res.json({ ok: true, merged, clientesRemovidos, message })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao mesclar duplicatas' })
  }
}

// =====================================================
// 3a) Status da conexão WhatsApp (UltraMsg)
// GET /chats/whatsapp-status — status para banner "WhatsApp conectado/desconectado"
// Usa empresa_zapi (instance_id, instance_token) por company_id. NUNCA ENV.
// Sem config → 200 { hasInstance:false, connected:false, configured:false }
// =====================================================
exports.whatsappStatus = async (req, res) => {
  try {
    const company_id = req.user?.company_id
    // Z-API removida; banner "WhatsApp desconectado" oculto por padrão. Use HIDE_WHATSAPP_DISCONNECT_BANNER=0 para exibir.
    const hideBanner = process.env.HIDE_WHATSAPP_DISCONNECT_BANNER !== '0'
    // Usa UltraMsg como único provider WhatsApp; empresa_zapi armazena instance_id/token
    if (!company_id) {
      return res.json({ ok: true, hasInstance: false, connected: hideBanner, configured: false })
    }

    const { getStatus } = require('../services/ultramsgIntegrationService')
    const { getEmpresaWhatsappConfig } = require('../services/whatsappConfigService')
    const configResult = await getEmpresaWhatsappConfig(company_id)
    if (configResult.error || !configResult.config) {
      return res.json({ ok: true, hasInstance: false, connected: hideBanner, configured: false })
    }

    const statusResult = await getStatus(company_id)
    let connected = !!statusResult?.connected
    if (hideBanner) connected = true // Oculta banner (Z-API removida; sistema usa UltraMsg)
    const smartphoneConnected = !!statusResult?.smartphoneConnected
    return res.json({
      ok: true,
      hasInstance: true,
      connected,
      smartphoneConnected,
      configured: true,
      ...(statusResult?.error && { error: statusResult.error }),
      ...(statusResult?.needsRestore && { needsRestore: true })
    })
  } catch (err) {
    console.error('whatsappStatus:', err?.message || err)
    return res.json({ ok: true, hasInstance: false, connected: false, configured: false })
  }
}

exports.zapiStatus = exports.whatsappStatus

// =====================================================
// 3b) Sincronizar contatos do celular (UltraMsg)
// Executa sync inline — compatível sem fila de jobs.
// =====================================================
exports.sincronizarContatosZapi = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

    console.log(`[SYNC-CONTATOS] Iniciando para empresa=${company_id}`)
    const { syncContacts } = require('../services/ultramsgContactsSyncService')
    const result = await syncContacts(company_id)

    if (!result.ok) {
      const msg = result.errors?.[0] || 'Empresa sem instância WhatsApp configurada. Conecte o WhatsApp em Integrações.'
      console.warn(`[SYNC-CONTATOS] empresa=${company_id} falhou: ${msg}`)
      // Retorna 200 (não erro HTTP) para que o browser não logue como "Failed to load resource"
      // O frontend detecta a falha via ok:false no body
      return res.json({ ok: false, message: msg, total_contatos: 0, criados: 0, atualizados: 0 })
    }

    console.log(`[SYNC-CONTATOS] empresa=${company_id} concluído — mode=${result.mode} fetched=${result.totalFetched} inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped}`)

    const io = req.app.get('io')
    if (io) {
      io.to(`empresa_${company_id}`).emit('zapi_sync_contatos', {
        total_contatos: result.totalFetched,
        criados: result.inserted,
        atualizados: result.updated,
        fotos_atualizadas: 0
      })
    }

    return res.json({
      ok: true,
      total_contatos: result.totalFetched,
      criados: result.inserted,
      atualizados: result.updated,
      fotos_atualizadas: 0,
      mode: result.mode
    })
  } catch (err) {
    console.error('sincronizarContatosZapi:', err)
    return res.status(500).json({ error: 'Erro ao sincronizar contatos' })
  }
}

// =====================================================
// 3b.1) Debug sync de contatos — testa passo a passo sem salvar
// GET /chats/debug-sync-contatos
// =====================================================
exports.debugSyncContatos = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

    const { getEmpresaWhatsappConfig } = require('../services/whatsappConfigService')
    const ultramsgSvc = require('../services/ultramsgIntegrationService')
    const { getProvider } = require('../services/providers')

    const diag = { company_id, steps: [] }

    // Passo 1: Verificar credenciais na tabela empresa_zapi
    const { config, error: cfgError } = await getEmpresaWhatsappConfig(company_id)
    if (cfgError || !config) {
      diag.steps.push({ step: 'credenciais', ok: false, detail: cfgError || 'sem registro em empresa_zapi com ativo=true' })
      return res.json({ ok: false, diagnostico: diag })
    }
    diag.steps.push({
      step: 'credenciais',
      ok: true,
      detail: `instance_id=${config.instance_id} token=${config.instance_token ? config.instance_token.slice(0, 6) + '...' : 'VAZIO'} ativo=${config.ativo}`
    })

    // Passo 2: Verificar status da conexão
    const status = await ultramsgSvc.getStatus(company_id)
    diag.steps.push({
      step: 'conexao',
      ok: !!status.connected,
      detail: status.error ? `erro: ${status.error}` : `connected=${status.connected} smartphoneConnected=${status.smartphoneConnected}`
    })
    if (!status.connected) {
      return res.json({ ok: false, diagnostico: diag, mensagem: 'WhatsApp não está conectado. Escaneie o QR code em Integrações.' })
    }

    // Passo 3: Tentar buscar os primeiros 10 contatos da API UltraMSG
    const provider = getProvider()
    const primeiraLeva = await provider.getContacts(1, 10, { companyId: company_id })
    diag.steps.push({
      step: 'buscar_contatos_api',
      ok: Array.isArray(primeiraLeva),
      contatos_retornados: Array.isArray(primeiraLeva) ? primeiraLeva.length : 0,
      amostra: Array.isArray(primeiraLeva)
        ? primeiraLeva.slice(0, 3).map(c => ({ name: c.name, phone: String(c.phone || c.id || '').slice(-12) }))
        : []
    })

    if (!Array.isArray(primeiraLeva) || primeiraLeva.length === 0) {
      return res.json({
        ok: false,
        diagnostico: diag,
        mensagem: 'UltraMSG retornou lista vazia. Verifique se o celular tem contatos salvos na agenda.'
      })
    }

    // Passo 4: Verificar quantos passam pelos filtros BR
    const { normalizePhoneBR } = require('../helpers/phoneHelper')
    let passam = 0, falham = 0
    for (const c of primeiraLeva) {
      const phoneRaw = String(c.phone || c.id || '').replace(/\D/g, '')
      const norm = normalizePhoneBR(phoneRaw)
      if (norm && norm.startsWith('55') && (norm.length === 12 || norm.length === 13)) passam++
      else falham++
    }
    diag.steps.push({ step: 'filtro_br', passam, falham, total: primeiraLeva.length })

    return res.json({
      ok: true,
      diagnostico: diag,
      mensagem: `Tudo OK. ${primeiraLeva.length} contatos na primeira página. Use POST /chats/sincronizar-contatos para salvar todos.`
    })
  } catch (err) {
    console.error('debugSyncContatos:', err)
    return res.status(500).json({ error: err?.message || 'Erro interno' })
  }
}

// =====================================================
// 3c) Sincronizar fotos de perfil (Z-API Get profile-picture)
// Executa sync inline — compatível sem fila de jobs.
// =====================================================
exports.sincronizarFotosPerfilZapi = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })

    const provider = getProvider()
    if (!provider?.getProfilePicture && !provider?.getContactMetadata) {
      return res.status(501).json({ error: 'Sincronização de fotos disponível apenas com WhatsApp conectado.' })
    }

    // Verifica conexão: getStatus primeiro; se não conectado, fallback em getConnectionStatus (evita 503 falso)
    let connected = false
    const statusResult = await getStatus(Number(company_id))
    if (statusResult?.connected) {
      connected = true
    } else if (provider?.getConnectionStatus) {
      const conn = await provider.getConnectionStatus({ companyId: company_id })
      connected = !!conn?.connected
    }
    if (!connected) {
      // Retorna 200 com zeros em vez de 503 — evita toast de erro "WhatsApp não conectado" (Z-API removida)
      return res.json({ total: 0, atualizados: 0 })
    }

    const { syncFotosFullProgressiva } = require('../services/syncFotosProgressivaService')
    // Botão "Sincronizar fotos": puxa TODAS as fotos de perfil (todos os clientes)
    const maxClients = Math.min(10000, Number(req.query.limit) || 10000)
    const result = await syncFotosFullProgressiva(company_id, { maxClients, onlySemFoto: false })

    return res.json({
      total: result.clientesProcessados ?? 0,
      atualizados: result.totalAtualizados ?? 0
    })
  } catch (err) {
    console.error('sincronizarFotosPerfilZapi:', err)
    return res.status(500).json({ error: 'Erro ao sincronizar fotos' })
  }
}

// =====================================================
// 4) CRIAR GRUPO
// =====================================================
exports.criarGrupo = async (req, res) => {
  try {
    const io = req.app.get('io')
    const { company_id, id: usuario_id } = req.user
    const { nome } = req.body

    const { data, error } = await supabase
      .from('conversas')
      .insert({
        company_id,
        tipo: 'grupo',
        nome_grupo: nome,
        telefone: `grupo_${Date.now()}`,
        status_atendimento: 'aberta',
        usuario_id
      })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })

    emitirEventoEmpresaConversa(io, company_id, data.id, 'nova_conversa', data)

    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar grupo' })
  }
}
// =====================================================
// 5) CRIAR COMUNIDADE
// =====================================================
exports.criarComunidade = async (req, res) => {
  try {
    const io = req.app.get('io')
    const { company_id, id: usuario_id } = req.user
    const { nome } = req.body

    const { data, error } = await supabase
      .from('conversas')
      .insert({
        company_id,
        tipo: 'comunidade',
        nome_grupo: nome,
        telefone: `comunidade_${Date.now()}`,
        status_atendimento: 'aberta',
        usuario_id
      })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })

    emitirEventoEmpresaConversa(io, company_id, data.id, 'nova_conversa', data)

    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar comunidade' })
  }
}
exports.atualizarObservacao = async (req, res) => {
  try {
    const { id } = req.params;
    const { observacao } = req.body;
    const { company_id, id: user_id, perfil } = req.user;

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id: Number(id), user_id })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error });

    // busca cliente ligado à conversa
    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('cliente_id')
      .eq('id', Number(id))
      .eq('company_id', company_id)
      .single();

    if (errConv) return res.status(500).json({ error: errConv.message });
    if (!conversa?.cliente_id) {
      return res.status(404).json({ error: 'Cliente não encontrado para esta conversa' });
    }

    const { error: errCli } = await supabase
      .from('clientes')
      .update({ observacoes: observacao ?? null })
      .eq('id', Number(conversa.cliente_id))
      .eq('company_id', company_id);

    if (errCli) return res.status(500).json({ error: errCli.message });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao atualizar observação:', err);
    return res.status(500).json({ error: 'Erro ao atualizar observação' });
  }
};

// =====================================================
// Preferências da lista (silenciar / fixar / favoritar) — PATCH /chats/:id/prefs
// =====================================================
exports.patchConversaPrefs = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids } = req.user
    const conversa_id = Number(req.params.id)
    if (!Number.isFinite(conversa_id) || conversa_id <= 0) {
      return res.status(400).json({ error: 'ID da conversa inválido' })
    }
    const perm = await assertPermissaoConversa({
      company_id,
      conversa_id,
      user_id,
      role: perfil,
      user_dep_ids: departamento_ids,
    })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    const body = req.body && typeof req.body === 'object' ? req.body : {}
    if (
      body.silenciada === undefined &&
      body.fixada === undefined &&
      body.favorita === undefined
    ) {
      return res.status(400).json({ error: 'Envie silenciada, fixada e/ou favorita (boolean).' })
    }

    const { data: existing } = await supabase
      .from('conversa_usuario_prefs')
      .select('silenciada, fixada, favorita, fixada_em')
      .eq('company_id', Number(company_id))
      .eq('usuario_id', Number(user_id))
      .eq('conversa_id', conversa_id)
      .maybeSingle()

    let silenciada = !!(existing && existing.silenciada)
    let favorita = !!(existing && existing.favorita)
    let fixada = !!(existing && existing.fixada)
    let fixada_em = existing && existing.fixada_em != null ? existing.fixada_em : null
    if (body.silenciada !== undefined) silenciada = !!body.silenciada
    if (body.favorita !== undefined) favorita = !!body.favorita
    if (body.fixada !== undefined) {
      fixada = !!body.fixada
      fixada_em = fixada ? new Date().toISOString() : null
    }

    const row = {
      company_id: Number(company_id),
      usuario_id: Number(user_id),
      conversa_id,
      silenciada,
      fixada,
      favorita,
      fixada_em,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('conversa_usuario_prefs')
      .upsert(row, { onConflict: 'company_id,usuario_id,conversa_id' })
      .select('conversa_id, silenciada, fixada, favorita, fixada_em')
      .single()

    if (error) {
      if (String(error.message || '').includes('conversa_usuario_prefs') || String(error.code || '') === '42P01') {
        return res.status(503).json({ error: 'Aplique a migration conversa_usuario_prefs no Supabase e tente novamente.' })
      }
      return res.status(500).json({ error: error.message })
    }

    const io = req.app.get('io')
    if (io) {
      emitirParaUsuario(io, user_id, 'conversa_prefs_atualizada', {
        conversa_id,
        silenciada: !!data?.silenciada,
        fixada: !!data?.fixada,
        favorita: !!data?.favorita,
        fixada_em: data?.fixada_em ?? null,
      })
    }

    return res.json({
      ok: true,
      conversa_id,
      silenciada: !!data?.silenciada,
      fixada: !!data?.fixada,
      favorita: !!data?.favorita,
      fixada_em: data?.fixada_em ?? null,
    })
  } catch (err) {
    console.error('[patchConversaPrefs]', err)
    return res.status(500).json({ error: 'Erro ao salvar preferências da conversa' })
  }
}

// =====================================================
// Limpar mensagens da conversa (mantém a conversa) — POST /chats/:id/limpar-mensagens
// =====================================================
exports.limparMensagensConversa = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids } = req.user
    const conversa_id = Number(req.params.id)
    if (!Number.isFinite(conversa_id) || conversa_id <= 0) {
      return res.status(400).json({ error: 'ID da conversa inválido' })
    }
    const perm = await assertPermissaoConversa({
      company_id,
      conversa_id,
      user_id,
      role: perfil,
      user_dep_ids: departamento_ids,
    })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    const { error: errMsg } = await supabase
      .from('mensagens')
      .delete()
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
    if (errMsg) return res.status(500).json({ error: errMsg.message })

    try {
      await supabase.from('mensagens_ocultas').delete().eq('company_id', company_id).eq('conversa_id', conversa_id)
    } catch (_) { /* tabela opcional */ }

    const now = new Date().toISOString()
    await supabase
      .from('conversas')
      .update({ ultima_atividade: now, lida: true })
      .eq('company_id', company_id)
      .eq('id', conversa_id)

    await marcarComoLidaPorUsuario({ company_id, conversa_id, usuario_id: user_id })

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(io, company_id, conversa_id, 'mensagens_conversa_limpas', {
        conversa_id,
        ultima_mensagem: null,
      })
      emitirConversaAtualizada(io, company_id, conversa_id, {
        id: conversa_id,
        ultima_atividade: now,
        ultima_mensagem_preview: null,
        tem_novas_mensagens: false,
        lida: true,
      })
    }

    return res.json({ ok: true, conversa_id, ultima_atividade: now })
  } catch (err) {
    console.error('[limparMensagensConversa]', err)
    return res.status(500).json({ error: 'Erro ao limpar mensagens da conversa' })
  }
}

// =====================================================
// Apagar conversa e dependências — DELETE /chats/:id
// =====================================================
exports.apagarConversa = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids } = req.user
    const conversa_id = Number(req.params.id)
    if (!Number.isFinite(conversa_id) || conversa_id <= 0) {
      return res.status(400).json({ error: 'ID da conversa inválido' })
    }
    const perm = await assertPermissaoConversa({
      company_id,
      conversa_id,
      user_id,
      role: perfil,
      user_dep_ids: departamento_ids,
    })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    const { data: conv, error: errC } = await supabase
      .from('conversas')
      .select('id, tipo, cliente_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()
    if (errC) return res.status(500).json({ error: errC.message })
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' })
    if (isGroupConversation(conv)) {
      return res.status(400).json({ error: 'Exclusão de conversa de grupo não suportada neste endpoint.' })
    }

    const cid = company_id
    const convId = conversa_id
    const clienteId = conv?.cliente_id ? Number(conv.cliente_id) : null

    // Garantia operacional: apagar conversa nunca deve apagar o contato.
    // Guardamos o estado do contato antes da exclusão para validar depois.
    let contatoExistiaAntes = false
    if (clienteId) {
      const { data: contatoAntes } = await supabase
        .from('clientes')
        .select('id')
        .eq('company_id', cid)
        .eq('id', clienteId)
        .maybeSingle()
      contatoExistiaAntes = !!contatoAntes?.id
    }

    const { data: atendRows } = await supabase
      .from('atendimentos')
      .select('id')
      .eq('company_id', cid)
      .eq('conversa_id', convId)
    const atendIds = (atendRows || []).map((r) => r.id).filter(Boolean)
    if (atendIds.length > 0) {
      await supabase.from('avaliacoes_atendimento').delete().in('atendimento_id', atendIds)
    }
    await supabase.from('avaliacoes_atendimento').delete().eq('conversa_id', convId).eq('company_id', cid)

    await supabase.from('mensagens_ocultas').delete().eq('company_id', cid).eq('conversa_id', convId)
    await supabase.from('conversa_unreads').delete().eq('company_id', cid).eq('conversa_id', convId)
    await supabase.from('atendimentos').delete().eq('company_id', cid).eq('conversa_id', convId)
    await supabase.from('historico_atendimentos').delete().eq('conversa_id', convId)
    await supabase.from('conversa_tags').delete().eq('company_id', cid).eq('conversa_id', convId)
    await supabase.from('bot_logs').delete().eq('company_id', cid).eq('conversa_id', convId)
    await supabase.from('mensagens').delete().eq('company_id', cid).eq('conversa_id', convId)

    await supabase.from('conversas').update({ cliente_id: null }).eq('company_id', cid).eq('id', convId)

    const { error: errDel } = await supabase.from('conversas').delete().eq('company_id', cid).eq('id', convId)
    if (errDel) return res.status(500).json({ error: errDel.message })

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(io, cid, convId, 'conversa_apagada', { id: convId })
      io.to(`empresa_${cid}`).emit('atualizar_conversa', { id: convId, removida: true })
    }

    let contatoPreservado = true
    if (clienteId && contatoExistiaAntes) {
      const { data: contatoDepois } = await supabase
        .from('clientes')
        .select('id')
        .eq('company_id', cid)
        .eq('id', clienteId)
        .maybeSingle()
      contatoPreservado = !!contatoDepois?.id
      if (!contatoPreservado) {
        console.error('[apagarConversa] CONTATO REMOVIDO INDEVIDAMENTE', {
          company_id: cid,
          conversa_id: convId,
          cliente_id: clienteId,
        })
      }
    }

    return res.json({
      ok: true,
      id: convId,
      contato_preservado: contatoPreservado,
      cliente_id_preservado: clienteId,
    })
  } catch (err) {
    console.error('[apagarConversa]', err)
    return res.status(500).json({ error: 'Erro ao apagar conversa' })
  }
}

// =====================================================
// 5b) ABRIR CONVERSA POR CLIENTE (lista de clientes → chat list)
// =====================================================
exports.abrirConversaCliente = async (req, res) => {
  try {
    const io = req.app.get('io')
    const { company_id, id: usuario_id } = req.user
    const { cliente_id } = req.body

    if (!cliente_id) {
      return res.status(400).json({ error: 'cliente_id é obrigatório' })
    }

    const cid = Number(company_id)
    let clienteQuery = supabase
      .from('clientes')
      .select('id, nome, pushname, telefone, foto_perfil')
      .eq('id', Number(cliente_id))
      .eq('company_id', cid)
    const { data: cliente, error: errCli } = await clienteQuery.maybeSingle()

    if (errCli || !cliente) {
      return res.status(404).json({ error: 'Cliente não encontrado' })
    }

    const telefone = cliente.telefone || ''
    if (!telefone) {
      return res.status(400).json({ error: 'Cliente sem telefone cadastrado' })
    }

    // ✅ Profissional: encontra conversa existente pelo TELEFONE também
    // (evita bug quando há clientes duplicados por variação/empresa=1 null vs 1)
    const convPhones = possiblePhonesBR(telefone)
    let qConv = supabase
      .from('conversas')
      .select('id, telefone, cliente_id, status_atendimento, nome_grupo, tipo')
      .eq('company_id', company_id)
      .neq('status_atendimento', 'fechada')
      .order('id', { ascending: false })
      .limit(5)
    if (convPhones.length > 0) qConv = qConv.in('telefone', convPhones)
    else qConv = qConv.eq('telefone', telefone)
    const { data: convRows } = await qConv
    const convList = Array.isArray(convRows) ? convRows : (convRows ? [convRows] : [])
    const conversaExistente =
      convList.find((c) => c && Number(c.cliente_id) === Number(cliente.id)) ||
      convList[0] ||
      null

    // Se achou conversa mas está apontando para outro cliente_id (duplicata), unifica para este cliente
    if (conversaExistente?.id && conversaExistente.cliente_id && Number(conversaExistente.cliente_id) !== Number(cliente.id)) {
      await supabase
        .from('conversas')
        .update({ cliente_id: cliente.id })
        .eq('company_id', company_id)
        .eq('id', conversaExistente.id)
    }

    if (conversaExistente) {
      const payload = {
        id: conversaExistente.id,
        cliente_id: cliente.id,
        telefone: conversaExistente.telefone,
        tipo: 'cliente',
        contato_nome: getDisplayName(cliente) || conversaExistente.telefone,
        foto_perfil: cliente.foto_perfil || null,
        unread_count: 0,
        tags: []
      }
      return res.json({ conversa: payload, criada: false })
    }

    const telefoneCanonico = getCanonicalPhone(telefone) || telefone
    const { data: novaConversa, error: errConv } = await supabase
      .from('conversas')
      .insert({
        cliente_id: cliente.id,
        telefone: telefoneCanonico,
        company_id,
        status_atendimento: 'aberta',
        usuario_id,
        tipo: 'cliente',
        ultima_atividade: new Date().toISOString()
      })
      .select('id, telefone, cliente_id, status_atendimento, tipo')
      .single()

    if (errConv) return res.status(500).json({ error: errConv.message })

    const payload = {
      id: novaConversa.id,
      cliente_id: cliente.id,
      telefone: novaConversa.telefone,
      tipo: 'cliente',
      contato_nome: getDisplayName(cliente) || novaConversa.telefone,
      foto_perfil: cliente.foto_perfil || null,
      unread_count: 0,
      tags: []
    }

    if (io) {
      emitirEventoEmpresaConversa(io, company_id, novaConversa.id, 'nova_conversa', payload)
    }

    return res.json({ conversa: payload, criada: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao abrir conversa' })
  }
}

// Resposta 400 padronizada — frontend pode exibir formato ao usuário (novo contato manual)
function erroTelefoneNovoContato (codigo, extra = {}) {
  const base = {
    error: codigo === 'TELEFONE_OBRIGATORIO' ? 'Telefone obrigatório' : 'Telefone inválido',
    codigo,
    detalhe:
      codigo === 'TELEFONE_OBRIGATORIO'
        ? 'Informe o número do contato para continuar.'
        : 'Informe um número brasileiro válido: DDD + número (10 ou 11 dígitos), com ou sem o código do país 55 (12 ou 13 dígitos no total). Espaços, parênteses e hífens podem ser usados e serão ignorados.',
    formato_esperado:
      'Somente números do Brasil. Celular com 9 após o DDD: ex. (11) 98765-4321 → armazenado como 5511987654321. Fixo sem o 9: ex. (11) 3456-7890.',
    exemplos: ['34999999999', '(34) 99999-9999', '+55 34 99999-9999', '5534999999999'],
    ...extra
  }
  return base
}

// =====================================================
// 6) CRIAR CONTATO (cliente + conversa)
// =====================================================
exports.criarContato = async (req, res) => {
  try {
    const io = req.app.get('io')
    const { company_id, id: usuario_id } = req.user
    const { nome, telefone } = req.body

    const telefoneRaw = telefone != null ? String(telefone).trim() : ''
    if (!telefoneRaw) {
      return res.status(400).json(erroTelefoneNovoContato('TELEFONE_OBRIGATORIO'))
    }

    const telefoneCanonico = getCanonicalPhone(telefone)
    const bloqueadoManual =
      !telefoneCanonico ||
      telefoneCanonico.startsWith('lid:') ||
      telefoneCanonico.endsWith('@g.us')
    if (bloqueadoManual) {
      return res.status(400).json(
        erroTelefoneNovoContato('TELEFONE_INVALIDO', {
          detalhe:
            'Não foi possível interpretar um telefone brasileiro. Verifique DDD e quantidade de dígitos. Grupos e identificadores internos (LID) não podem ser cadastrados por este formulário.'
        })
      )
    }

    const nomeTrim = nome != null ? String(nome).trim() : ''
    const phonesBusca = possiblePhonesBR(telefoneCanonico)
    let cliente

    // =================================================
    // 1️⃣ TENTA BUSCAR CLIENTE EXISTENTE (por variantes do número)
    // =================================================
    let qCli = supabase.from('clientes').select('*').eq('company_id', company_id)
    if (phonesBusca.length > 0) qCli = qCli.in('telefone', phonesBusca)
    else qCli = qCli.eq('telefone', telefoneCanonico)
    const { data: existenteList } = await qCli.order('id', { ascending: true }).limit(1)
    const existenteRow = Array.isArray(existenteList) && existenteList.length > 0 ? existenteList[0] : null

    if (existenteRow) {
      cliente = existenteRow
    } else {
      const { data, error } = await supabase
        .from('clientes')
        .insert({
          nome: nomeTrim || null,
          telefone: telefoneCanonico,
          company_id
        })
        .select()
        .single()

      if (error) return res.status(500).json({ error: error.message })

      cliente = data
    }

    // =================================================
    // 2️⃣ CRIA CONVERSA (telefone canônico = uma conversa por contato)
    // =================================================
    let conversa = null
    let errConv = null
    const insConv = await supabase
      .from('conversas')
      .insert({
        cliente_id: cliente.id,
        telefone: telefoneCanonico,
        company_id,
        status_atendimento: 'aberta',
        usuario_id,
        tipo: 'cliente'
      })
      .select()
      .single()
    conversa = insConv.data
    errConv = insConv.error

    if (errConv && (String(errConv.code || '') === '23505' || String(errConv.message || '').includes('unique'))) {
      const { data: existenteConv } = await supabase
        .from('conversas')
        .select('*')
        .eq('company_id', company_id)
        .neq('status_atendimento', 'fechada')
        .in('telefone', phonesBusca.length > 0 ? phonesBusca : [telefoneCanonico])
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (existenteConv) {
        conversa = existenteConv
        errConv = null
      }
    }
    if (errConv) return res.status(500).json({ error: errConv.message })

    // realtime
    emitirEventoEmpresaConversa(io, company_id, conversa.id, 'nova_conversa', conversa)

    return res.json(conversa)

  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar contato' })
  }
}



// =====================================================
// 4) detalharChat (paginação + marcar como lida)
// IMPORTANTÍSSIMO: não disparar atualizar lista ao abrir (evita loop)
// =====================================================
exports.detalharChat = async (req, res) => {
  try {
    const { id } = req.params
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const role = String(perfil || '').toLowerCase()
    const isAdmin = role === 'admin'

    const limit = Math.min(Number(req.query.limit || 50), 200)
    const cursor = req.query.cursor || null

    // conversa (com cliente, atendente, departamento/setor; tipo, nome_grupo, fotos; nome_contato_cache para header quando cliente ainda não tem nome)
    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select(`
        id,
        telefone,
        status_atendimento,
        atendente_id,
        lida,
        criado_em,
        departamento_id,
        tipo,
        nome_grupo,
        foto_grupo,
        nome_contato_cache,
        foto_perfil_contato_cache,
        cliente_id,
        clientes!conversas_cliente_fk ( id, nome, pushname, telefone, observacoes, foto_perfil, company_id ),
        usuarios!conversas_atendente_fk ( id, nome ),
        departamentos ( id, nome ),
        conversa_tags (
          tag_id,
          tags (
            id,
            nome,
            cor
          )
        )
      `)
      .eq('id', Number(id))
      .eq('company_id', Number(company_id))
      .single()

    if (errConv) return res.status(500).json({ error: errConv.message })
    if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada' })

    const isGroup = isGroupConversation(conversa)
    const isAssignedToUser = conversa.atendente_id && Number(conversa.atendente_id) === Number(user_id)

    // REGRA PRINCIPAL: Se a conversa está assumida pelo usuário, SEMPRE permitir acesso total
    let podeAcessar = isAssignedToUser
    if (!podeAcessar && !isAdmin && !isGroup) {
      const convDep = conversa.departamento_id ?? null
      const depIds = Array.isArray(departamento_ids) ? departamento_ids : []
      const pertenceAoSetor = convDep == null || depIds.some((d) => Number(d) === Number(convDep))
      if (!pertenceAoSetor) {
        const { data: transferRow } = await supabase
          .from('atendimentos')
          .select('id')
          .eq('company_id', Number(company_id))
          .eq('conversa_id', Number(id))
          .eq('de_usuario_id', Number(user_id))
          .eq('acao', 'transferiu')
          .limit(1)
          .maybeSingle()
        if (!transferRow) {
          return res.status(403).json({ error: 'Conversa de outro setor' })
        }
      }
    }

    // Bloqueia visão das mensagens quando a conversa está assumida por outro usuário
    // (apenas admin e supervisor podem ver; atendente que não assumiu não vê o conteúdo)
    const isSupervisor = role === 'supervisor'
    const conversaAssumidaPorOutro = conversa.atendente_id != null && Number(conversa.atendente_id) !== Number(user_id)
    const deveBloquearMensagens = !isGroup && conversaAssumidaPorOutro && !isAdmin && !isSupervisor

    // mensagens paginadas (remetente_nome/remetente_telefone para grupos; fallback se colunas não existirem)
    const selectComRemetente = 'id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo, reply_meta, remetente_nome, remetente_telefone, contact_meta, location_meta'
    const selectBasico = 'id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo, reply_meta, contact_meta, location_meta'
    let mensagens = []
    let errMsgs = null
    let query

    if (!deveBloquearMensagens) {
      query = supabase
        .from('mensagens')
        .select(selectComRemetente)
        .eq('company_id', Number(company_id))
        .eq('conversa_id', Number(id))
        .order('criado_em', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)

      if (cursor) {
        query = query.lt('criado_em', cursor)
      }

      const result = await query
      mensagens = result.data
      errMsgs = result.error
    }
    // Compatibilidade: se reply_meta/remetente_*/contact_meta/location_meta não existirem ainda no banco, refaz select sem essas colunas.
    const selectFallback = 'id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo'
    if (errMsgs && (String(errMsgs.message || '').includes('reply_meta') || String(errMsgs.message || '').includes('remetente_nome') || String(errMsgs.message || '').includes('remetente_telefone') || String(errMsgs.message || '').includes('contact_meta') || String(errMsgs.message || '').includes('location_meta') || String(errMsgs.message || '').includes('does not exist'))) {
      query = supabase
        .from('mensagens')
        .select(selectFallback)
        .eq('company_id', Number(company_id))
        .eq('conversa_id', Number(id))
        .order('criado_em', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)
      if (cursor) query = query.lt('criado_em', cursor)
      const result = await query
      mensagens = result.data
      errMsgs = result.error
    }
    if (errMsgs) return res.status(500).json({ error: errMsgs.message })

    // ✅ "Apagar pra mim": filtra mensagens ocultas para este usuário (se a tabela existir)
    try {
      const { data: ocultas, error: errOcultas } = await supabase
        .from('mensagens_ocultas')
        .select('mensagem_id')
        .eq('company_id', Number(company_id))
        .eq('conversa_id', Number(id))
        .eq('usuario_id', Number(user_id))
      if (errOcultas) {
        const msg = String(errOcultas.message || '')
        // compat: tabela pode não existir ainda (banco desatualizado)
        if (!msg.includes('mensagens_ocultas') && !msg.includes('does not exist')) {
          console.warn('detalharChat: erro ao ler mensagens_ocultas:', errOcultas.message)
        }
      } else if (Array.isArray(ocultas) && ocultas.length > 0) {
        const hidden = new Set(ocultas.map((o) => String(o.mensagem_id)))
        mensagens = (Array.isArray(mensagens) ? mensagens : []).filter((m) => !hidden.has(String(m.id)))
      }
    } catch (_) {
      // ignore
    }

    // marca como lida (unread=0 + compatibilidade lida=true)
    await marcarComoLidaPorUsuario({ company_id, conversa_id: id, usuario_id: user_id })

    const rawClientes = conversa.clientes
    let clientesConv = Array.isArray(rawClientes)
      ? (rawClientes.find((cl) => cl && Number(cl.id) === Number(conversa.cliente_id)) || rawClientes[0])
      : rawClientes
    // Isolamento multi-tenant: descarta cliente de outra empresa
    if (clientesConv && clientesConv.company_id != null && Number(clientesConv.company_id) !== Number(company_id)) {
      clientesConv = null
    }
    // Nunca exibir LID (lid:xxx) como nome ou número — identificador interno do WhatsApp
    const isLidConv = !isGroup && conversa.telefone && String(conversa.telefone).trim().toLowerCase().startsWith('lid:')
    const clienteNome = getDisplayName(clientesConv)
    const nomeCache = (conversa.nome_contato_cache && String(conversa.nome_contato_cache).trim()) ? String(conversa.nome_contato_cache).trim() : null
    const nomeUnico = isGroup
      ? (conversa.nome_grupo ?? conversa.telefone ?? 'Grupo')
      : (isLidConv ? 'Contato' : (clienteNome || nomeCache || null))
    const clienteTelefoneExibivel = isGroup
      ? conversa.telefone
      : (isLidConv ? null : (conversa.telefone ?? clientesConv?.telefone ?? null))
    const telefoneExibivel = isLidConv ? null : (conversa.telefone ?? clientesConv?.telefone ?? null)
    const fotoCache = (conversa.foto_perfil_contato_cache && String(conversa.foto_perfil_contato_cache).trim()) ? String(conversa.foto_perfil_contato_cache).trim() : null
    const fotoUnica = isGroup ? (conversa.foto_grupo ?? null) : (clientesConv?.foto_perfil ?? fotoCache ?? null)
    // Badge "Aberta": só exibir quando há movimentação (mensagem ou atendente assumiu) — mesma regra da lista
    const temMensagem = Array.isArray(mensagens) && mensagens.length > 0
    const exibirBadgeAberta = !isGroup && (temMensagem || conversa.atendente_id != null)
    // No detalhe da conversa, preserva status real do BD para liberar ações do cabeçalho
    // (assumir/transferir/encerrar) mesmo sem movimentação.
    const statusDetalhe = isGroup ? null : conversa.status_atendimento
    const conversaFormatada = {
      ...conversa,
      status_atendimento: statusDetalhe,
      status_atendimento_lista: statusAtendimentoParaLista(isGroup, conversa.status_atendimento, exibirBadgeAberta),
      exibir_badge_aberta: exibirBadgeAberta,
      clientes: clientesConv,
      is_group: isGroup,
      nome_grupo: conversa.nome_grupo ?? null,
      contato_nome: nomeUnico,
      cliente_nome: nomeUnico,
      cliente_telefone: clienteTelefoneExibivel,
      telefone_exibivel: telefoneExibivel,
      observacao: isGroup ? null : (clientesConv?.observacoes ?? null),
      foto_perfil: fotoUnica,
      foto_grupo: isGroup ? (conversa.foto_grupo ?? null) : null,
      atendente_nome: conversa.usuarios?.nome ?? null,
      setor: conversa.departamentos?.nome ?? null,
      tags: (conversa.conversa_tags || []).map((ct) => ct.tags).filter(Boolean),
      mensagens: await enrichMensagensComAutorUsuario(supabase, company_id, (mensagens || []).reverse()),
      next_cursor: mensagens?.length ? mensagens[mensagens.length - 1].criado_em : null,
      mensagens_bloqueadas: deveBloquearMensagens || undefined
    }

    // ✅ emite SOMENTE mensagens_lidas (não dispara atualizar lista ao abrir)
    const io = req.app.get('io')
    if (io) {
      const payload = { conversa_id: Number(id), usuario_id: Number(user_id) }
      emitirParaUsuario(io, user_id, io.EVENTS?.MENSAGENS_LIDAS || 'mensagens_lidas', payload)
    }

    // Background: re-sincroniza foto e nome do contato/grupo com provider (UltraMsg/Z-API)
    if (io) {
      setImmediate(() => {
        if (isGroup) {
          const { syncConversationGroupOnJoin } = require('../services/ultramsgGroupsSyncService')
          syncConversationGroupOnJoin(supabase, Number(id), Number(company_id), io, { skipIfRecent: true }).catch(() => {})
        } else {
          const { syncConversationContactOnJoin } = require('../services/ultramsgSyncContact')
          syncConversationContactOnJoin(supabase, Number(id), Number(company_id), io, { skipIfRecent: true }).catch(() => {})
        }
      })
    }

    return res.json(conversaFormatada)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao detalhar conversa' })
  }
}

// =====================================================
// 5) assumirChat (lock real)
// =====================================================
exports.assumirChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params
    const isAdmin = perfil === 'admin'

    const { data: atual, error: errAtual } = await supabase
      .from('conversas')
      .select('id, atendente_id, departamento_id, tipo, telefone')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .single()

    if (errAtual) return res.status(500).json({ error: errAtual.message })
    if (!atual) return res.status(404).json({ error: 'Conversa não encontrada' })

    if (isGroupConversation(atual)) {
      return res.status(400).json({ error: 'Grupos são apenas visuais. Não é possível assumir conversa de grupo.' })
    }

    // Permissão por setor: conversas sem setor assumíveis por TODOS; com setor só se usuário pertence
    if (!isAdmin) {
      const convDep = atual.departamento_id ?? null
      const depIds = Array.isArray(departamento_ids) ? departamento_ids : []
      if (depIds.length === 0 && convDep != null) {
        return res.status(403).json({ error: 'Conversa pertence a um setor; atribua-se a um setor para assumir' })
      }
      if (convDep != null && !depIds.some((d) => Number(d) === Number(convDep))) {
        return res.status(403).json({ error: 'Conversa de outro setor' })
      }
    }

    if (atual.atendente_id && Number(atual.atendente_id) !== Number(user_id)) {
      return res.status(409).json({ error: 'Conversa já está em atendimento por outro usuário' })
    }

    // Limite de chats simultâneos por atendente
    const { data: emp } = await supabase.from('empresas').select('limite_chats_por_atendente').eq('id', company_id).single()
    const limite = Number(emp?.limite_chats_por_atendente ?? 0)
    if (limite > 0) {
      const { count } = await supabase
        .from('conversas')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', company_id)
        .eq('atendente_id', user_id)
        .eq('status_atendimento', 'em_atendimento')
      if (count >= limite) {
        return res.status(409).json({ error: `Limite de ${limite} conversas simultâneas atingido. Encerre uma antes de assumir outra.` })
      }
    }

    const { data, error } = await supabase
      .from('conversas')
      .update({
        atendente_id: user_id,
        status_atendimento: 'em_atendimento',
        lida: true,
        atendente_atribuido_em: new Date().toISOString()
      })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })

    const resultAt = await registrarAtendimento({
      conversa_id,
      company_id,
      acao: 'assumiu',
      de_usuario_id: user_id,
      para_usuario_id: user_id
    })
    if (resultAt.error) return res.status(500).json({ error: resultAt.error.message })

    const io = req.app.get('io')
    if (io) {
      // Payload completo para todos atualizarem lista (atendente_id, atendente_atribuido_em) em tempo real
      // Evita refetch agressivo no frontend (mantém usuário nas últimas mensagens).
      emitirConversaAtualizada(io, company_id, conversa_id, { ...data, exibir_badge_aberta: true }, { skipAtualizarConversa: true })
      emitirSincronizacaoListaConversas(io, company_id, conversa_id)
      emitirLock(io, conversa_id, user_id)
    }

    return res.json({ ok: true, conversa: data })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao assumir conversa' })
  }
}

// =====================================================
// encerrar / reabrir (padronizado)
// =====================================================
exports.encerrarChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_ids: departamento_ids })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })
    if (perm.conv && isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Grupos são apenas visuais. Não é possível encerrar conversa de grupo.' })
    }

    const { data, error } = await supabase
      .from('conversas')
      .update({ status_atendimento: 'fechada' })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })

    const { resetOpcaoInvalidaLimitForConversa } = require('../services/chatbotTriageService')
    await resetOpcaoInvalidaLimitForConversa(supabase, company_id, conversa_id)

    const resultAt = await registrarAtendimento({
      conversa_id,
      company_id,
      acao: 'encerrou',
      de_usuario_id: user_id
    })
    if (resultAt.error) return res.status(500).json({ error: resultAt.error.message })

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.CONVERSA_ENCERRADA || 'conversa_encerrada',
        {
          ...data,
          lista_realtime: { minha_fila: true, motivo: 'encerrada' }
        }
      )
      emitirLock(io, conversa_id, null)
      // Evita reposicionamento para mensagens antigas após encerrar.
      emitirConversaAtualizada(io, company_id, conversa_id, { ...data }, { skipAtualizarConversa: true })
      emitirSincronizacaoListaConversas(io, company_id, conversa_id)
    }

    // Enviar mensagem de finalização se configurado no chatbot de triagem
    const atendimentoEncerrou = resultAt.atendimento
    if (atendimentoEncerrou?.id) {
      try {
        const { getChatbotConfig, buildMensagemFinalizacao } = require('../services/chatbotTriageService')
        const config = await getChatbotConfig(company_id)
        if (config?.enviarMensagemFinalizacao && config?.mensagemFinalizacao) {
          const { data: usu } = await supabase.from('usuarios').select('nome').eq('id', user_id).maybeSingle()
          const msg = buildMensagemFinalizacao(config.mensagemFinalizacao, {
            protocolo: atendimentoEncerrou.id,
            nome_atendente: usu?.nome || ''
          })
          if (msg) {
            let telefoneParaEnvio = data.telefone || ''
            const isGroup = String(data?.tipo || '').toLowerCase() === 'grupo' || String(data?.telefone || '').includes('@g.us')
            if (!isGroup && telefoneParaEnvio && !String(telefoneParaEnvio).trim().toLowerCase().startsWith('lid:')) {
              const { getProvider } = require('../services/providers')
              const provider = getProvider()
              if (provider?.sendText) {
                const resultSend = await provider.sendText(telefoneParaEnvio, msg, { companyId: company_id, conversaId: conversa_id })
                const statusMsg = resultSend?.ok ? 'sent' : 'erro'
                const { data: msgInsert, error: errInsert } = await supabase
                  .from('mensagens')
                  .insert({
                    conversa_id: Number(conversa_id),
                    texto: msg,
                    direcao: 'out',
                    company_id,
                    status: statusMsg,
                    autor_usuario_id: user_id
                  })
                  .select()
                  .single()
                if (!errInsert && msgInsert && req.app?.get('io')) {
                  const io2 = req.app.get('io')
                  const payload = await enrichMensagemComAutorUsuario(supabase, company_id, msgInsert)
                  emitirEventoEmpresaConversa(io2, company_id, conversa_id, io2.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', payload)
                  emitirConversaAtualizada(io2, company_id, conversa_id, { ...data }, { skipAtualizarConversa: true })
                  emitirSincronizacaoListaConversas(io2, company_id, conversa_id)
                }
              }
            }
          }
        }
      } catch (eFinal) {
        console.warn('[encerrarChat] mensagem finalização:', eFinal?.message || eFinal)
      }
    }

    return res.json({ ok: true, conversa: data })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao encerrar conversa' })
  }
}

exports.reabrirChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_ids: departamento_ids })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })
    if (perm.conv && isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Grupos são apenas visuais. Não é possível reabrir conversa de grupo.' })
    }

    // Conversa aberta = sem responsável, apenas setor (volta para a fila)
    const { data, error } = await supabase
      .from('conversas')
      .update({ status_atendimento: 'aberta', atendente_id: null })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })

    const resultAt = await registrarAtendimento({
      conversa_id,
      company_id,
      acao: 'reabriu',
      de_usuario_id: user_id
    })
    if (resultAt.error) return res.status(500).json({ error: resultAt.error.message })

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.CONVERSA_REABERTA || 'conversa_reaberta',
        {
          ...data,
          lista_realtime: { minha_fila: true, motivo: 'reaberta' }
        }
      )
      emitirLock(io, conversa_id, null)
      // Evita reposicionamento indevido ao reabrir.
      emitirConversaAtualizada(io, company_id, conversa_id, { ...data }, { skipAtualizarConversa: true })
      emitirSincronizacaoListaConversas(io, company_id, conversa_id)
    }

    return res.json({ ok: true, conversa: data })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao reabrir conversa' })
  }
}

// =====================================================
// transferir (padronizado)
// =====================================================
exports.transferirChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params
    const { para_usuario_id, observacao } = req.body

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_ids: departamento_ids })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })
    if (perm.conv && isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Grupos são apenas visuais. Não é possível transferir conversa de grupo.' })
    }

    if (!para_usuario_id) {
      return res.status(400).json({ error: 'para_usuario_id é obrigatório' })
    }

    // Validar se o usuário de destino existe e está ativo na mesma empresa
    const { data: targetUser, error: userError } = await supabase
      .from('usuarios')
      .select('id, nome, ativo, departamento_id')
      .eq('company_id', company_id)
      .eq('id', para_usuario_id)
      .eq('ativo', true)
      .maybeSingle()

    if (userError) {
      return res.status(500).json({ error: 'Erro ao validar usuário de destino' })
    }

    if (!targetUser) {
      return res.status(400).json({ error: 'Usuário de destino não encontrado ou inativo' })
    }

    const { data, error } = await supabase
      .from('conversas')
      .update({
        atendente_id: para_usuario_id,
        status_atendimento: 'em_atendimento',
        atendente_atribuido_em: new Date().toISOString()
      })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })

    const resultAt = await registrarAtendimento({
      conversa_id,
      company_id,
      acao: 'transferiu',
      de_usuario_id: user_id,
      para_usuario_id,
      observacao
    })
    if (resultAt.error) return res.status(500).json({ error: resultAt.error.message })

    const io = req.app.get('io')
    if (io) {
      // Buscar nome de quem transferiu (notificação rica + texto sugerido)
      const { data: fromUser } = await supabase
        .from('usuarios')
        .select('nome')
        .eq('id', user_id)
        .maybeSingle()

      const fromNome = (fromUser?.nome && String(fromUser.nome).trim()) || 'Um colega'
      const nomeCliente =
        (data?.nome_contato_cache && String(data.nome_contato_cache).trim()) ||
        (data?.contato_nome && String(data.contato_nome).trim()) ||
        null
      const ts = new Date().toISOString()

      // Broadcast empresa + room da conversa: sincroniza lista/UI. O som/toast “de transferência”
      // deve usar só `conversa_atribuida` na room `usuario_${destino}` (emitirParaUsuario).
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.CONVERSA_TRANSFERIDA || 'conversa_transferida',
        {
          ...data,
          company_id: Number(company_id),
          lista_realtime: { minha_fila: true, motivo: 'transferencia', novo_atendente_id: Number(para_usuario_id) },
          /** Quem deve tratar alerta sonoro/toast específico é este usuário (via evento privado). */
          notificacao_rica_usuario_id: Number(para_usuario_id),
          /** Front: em `conversa_transferida` não repetir som de nova msg para o destinatário. */
          suprimir_som_nova_mensagem_para_usuario_id: Number(para_usuario_id)
        }
      )

      // Lock para o novo atendente
      emitirLock(io, conversa_id, para_usuario_id)

      // Destinatário exclusivo (room usuario_*): aqui vai o contrato completo para som/título distintos
      const corpoLinha = nomeCliente
        ? `${fromNome} encaminhou «${nomeCliente}» pra você — é sua vez de brilhar ✨`
        : `${fromNome} te passou um atendimento. Bora responder com estilo 🚀`

      emitirParaUsuario(io, para_usuario_id, io.EVENTS?.CONVERSA_ATRIBUIDA || 'conversa_atribuida', {
        conversa_id: Number(conversa_id),
        company_id: Number(company_id),
        motivo: 'transferencia_recebida',
        transferido_por: user_id,
        transferido_por_nome: fromNome,
        observacao: observacao || null,
        timestamp: ts,
        cliente_preview: nomeCliente
          ? { nome: nomeCliente, telefone: data?.telefone ?? null }
          : { nome: null, telefone: data?.telefone ?? null },
        /** Front: incluir na “Minha fila” (em atendimento com você) sem esperar polling */
        lista_realtime: { minha_fila: true, motivo: 'recebeu_transferencia' },
        /** Contrato estável para o front mapear áudio / vibra / Notification API */
        ui: {
          variant: 'handoff',
          soundId: 'atendimento-transferido',
          titulo: '🎯 Passaram o bastão pra você!',
          corpo: corpoLinha,
          vibratePatternMs: [100, 60, 140, 60, 180],
          priority: 'high',
          tag: `handoff-${company_id}-${conversa_id}-${Date.now()}`
        }
      })
      
      // Notificar o usuário que transferiu
      emitirParaUsuario(io, user_id, 'conversa_transferida_sucesso', {
        conversa_id: Number(conversa_id),
        para_usuario_id: para_usuario_id,
        para_usuario_nome: targetUser.nome,
        timestamp: new Date().toISOString(),
        /** Front: refetch ou patch “Minha fila” — conversa deixa de ser “minha” após transferir */
        lista_realtime: {
          minha_fila: true,
          motivo: 'transferiu_para_outro',
          novo_atendente_id: Number(para_usuario_id)
        }
      })
      
      // Linha completa da conversa (setor, nome, status, atendente) para botões e filtros em tempo real
      emitirConversaAtualizada(io, company_id, conversa_id, {
        ...data,
        company_id: Number(company_id)
      })
    }

    return res.json({ ok: true, conversa: data })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao transferir conversa' })
  }
}

// =====================================================
// transferirSetor — altera departamento da conversa e registra no histórico
// =====================================================
exports.transferirSetor = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params
    const { departamento_id: novo_departamento_id, remover_setor } = req.body

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_ids: departamento_ids })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })
    if (perm.conv && isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Grupos são apenas visuais. Não é possível alterar setor de conversa de grupo.' })
    }

    const remover = remover_setor === true || (req.body.hasOwnProperty('departamento_id') && novo_departamento_id == null)

    if (!remover && (novo_departamento_id == null || novo_departamento_id === '')) {
      return res.status(400).json({ error: 'departamento_id é obrigatório. Use remover_setor: true para remover o setor.' })
    }

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, departamento_id, departamentos(nome)')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .single()

    if (errConv || !conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    const depAntigoId = conversa.departamento_id ?? null
    const depAntigoNome = conversa.departamentos?.nome ?? 'Sem setor'

    let novoDep = null
    let departamentoIdFinal = null

    if (remover) {
      if (depAntigoId == null) {
        return res.status(400).json({ error: 'Conversa já está sem setor' })
      }
      departamentoIdFinal = null
    } else {
      if (Number(depAntigoId) === Number(novo_departamento_id)) {
        return res.status(400).json({ error: 'Conversa já está neste setor' })
      }
      const { data: dep } = await supabase
        .from('departamentos')
        .select('id, nome')
        .eq('company_id', company_id)
        .eq('id', novo_departamento_id)
        .single()
      if (!dep) return res.status(400).json({ error: 'Setor de destino inválido' })
      novoDep = dep
      departamentoIdFinal = Number(novo_departamento_id)
    }

    const { data: atualizada, error: errUpd } = await supabase
      .from('conversas')
      .update({
        departamento_id: departamentoIdFinal,
        atendente_id: null,
        status_atendimento: 'aberta'
      })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .select()
      .single()

    if (errUpd) return res.status(500).json({ error: errUpd.message })

    const observacaoTexto = remover ? `${depAntigoNome} → Sem setor` : `${depAntigoNome} → ${novoDep.nome}`
    await supabase.from('historico_atendimentos').insert({
      conversa_id: Number(conversa_id),
      usuario_id: user_id,
      acao: 'transferiu_setor',
      observacao: observacaoTexto
    })

    const io = req.app.get('io')
    if (io) {
      const payload = {
        ...atualizada,
        departamento_id: departamentoIdFinal,
        setor: remover ? null : novoDep?.nome ?? null,
        lista_realtime: { minha_fila: true, motivo: 'transferiu_setor' }
      }
      emitirConversaAtualizada(io, company_id, conversa_id, payload)
      emitirLock(io, conversa_id, null)
      if (depAntigoId != null) {
        emitirDepartamento(io, depAntigoId, io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada', payload)
      }
      if (departamentoIdFinal != null) {
        emitirDepartamento(io, departamentoIdFinal, io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada', payload)
      }
      // `emitirConversaAtualizada` já emite `atualizar_conversa` na empresa (skip padrão false).
    }

    return res.json({
      ok: true,
      conversa: atualizada,
      setor: remover ? null : novoDep.nome,
      observacao: observacaoTexto
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao transferir setor' })
  }
}

// =====================================================
// enviarMensagemChat (corrigido + padronizado)
// =====================================================
exports.enviarMensagemChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const { id: conversa_id } = req.params
    const { texto, reply_meta, link } = req.body

    if (!texto || !String(texto).trim()) {
      return res.status(400).json({ error: 'texto é obrigatório' })
    }

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id, user_id })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, tipo, nome_contato_cache, foto_perfil_contato_cache, chat_lid')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .single()

    if (errConv || !conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    // Resolver telefone real quando conversa tem apenas LID (lid:xxx) — Z-API não envia para LID
    let telefoneParaEnvio = conversa.telefone || ''
    if (telefoneParaEnvio && String(telefoneParaEnvio).trim().toLowerCase().startsWith('lid:')) {
      if (conversa.cliente_id) {
        const { data: cli } = await supabase.from('clientes').select('telefone').eq('id', conversa.cliente_id).eq('company_id', company_id).maybeSingle()
        if (cli?.telefone && !String(cli.telefone).startsWith('lid:')) telefoneParaEnvio = cli.telefone
      }
      if (telefoneParaEnvio.startsWith('lid:') && conversa.chat_lid) {
        const { data: outra } = await supabase
          .from('conversas')
          .select('telefone')
          .eq('company_id', company_id)
          .eq('chat_lid', conversa.chat_lid)
          .not('telefone', 'like', 'lid:%')
          .limit(1)
          .maybeSingle()
        if (outra?.telefone) telefoneParaEnvio = outra.telefone
      }
      if (telefoneParaEnvio.startsWith('lid:')) {
        return res.status(400).json({ error: 'Número do contato indisponível (conversa por LID). Aguarde o contato enviar uma mensagem ou sincronize os contatos.' })
      }
    }

    // Garantir que o contato (número + nome) esteja salvo em clientes antes de enviar
    const isGroup = String(conversa?.tipo || '').toLowerCase() === 'grupo' || String(conversa?.telefone || '').includes('@g.us')
    if (!isGroup && conversa?.telefone && !conversa?.cliente_id) {
      const nomeCache = conversa?.nome_contato_cache ? String(conversa.nome_contato_cache).trim() : null
      const fotoCache = conversa?.foto_perfil_contato_cache ? String(conversa.foto_perfil_contato_cache).trim() : null
      const { cliente_id: novoClienteId } = await getOrCreateCliente(supabase, company_id, conversa.telefone, {
        nome: nomeCache || undefined,
        nomeSource: 'chatName',
        foto_perfil: fotoCache || undefined
      })
      if (novoClienteId) {
        await supabase.from('conversas').update({ cliente_id: novoClienteId }).eq('id', conversa_id).eq('company_id', company_id)
        conversa.cliente_id = novoClienteId
        // Enriquecer em background com dados reais da UltraMsg (nome, foto do WhatsApp)
        const { syncUltraMsgContact } = require('../services/ultramsgSyncContact')
        setImmediate(async () => {
          try {
            const synced = await syncUltraMsgContact(conversa.telefone, company_id)
            if (synced && req.app?.get('io')) {
              const io = req.app.get('io')
              const { data: cli } = await supabase.from('clientes').select('nome, pushname, telefone, foto_perfil').eq('id', novoClienteId).eq('company_id', company_id).maybeSingle()
              const { data: conv } = await supabase.from('conversas').select('nome_contato_cache, foto_perfil_contato_cache').eq('id', conversa_id).eq('company_id', company_id).maybeSingle()
              const contatoNome = getDisplayName(cli) || conv?.nome_contato_cache || synced.nome || conversa.telefone
              const fotoPerfil = conv?.foto_perfil_contato_cache || cli?.foto_perfil || synced.foto_perfil
              io.to(`empresa_${company_id}`).emit('contato_atualizado', {
                conversa_id: Number(conversa_id),
                contato_nome: contatoNome,
                telefone: cli?.telefone || conversa.telefone,
                foto_perfil: fotoPerfil
              })
            }
          } catch (_) {}
        })
      }
    }

    const hasLinkPayload = link && typeof link === 'object' && link.linkUrl

    // Reply (citação) — opcional. Requer coluna mensagens.reply_meta (jsonb).
    const timestamp = new Date().toISOString()
    const basePayload = {
      company_id,
      conversa_id: Number(conversa_id),
      texto: String(texto).trim(),
      tipo: hasLinkPayload ? 'link' : 'texto',
      direcao: 'out',
      autor_usuario_id: Number(user_id),
      status: 'pending',
      criado_em: timestamp
    }
    const payloadWithReply =
      reply_meta && typeof reply_meta === 'object'
        ? {
            ...basePayload,
            reply_meta: {
              name: String(reply_meta.name || '').slice(0, 80),
              snippet: String(reply_meta.snippet || '').slice(0, 180),
              ts: Number(reply_meta.ts || Date.now()),
              replyToId: reply_meta.replyToId != null ? String(reply_meta.replyToId) : undefined
            }
          }
        : basePayload

    let { data: msg, error: errMsg } = await supabase
      .from('mensagens')
      .insert(payloadWithReply)
      .select()
      .single()

    // Compatibilidade: se a coluna reply_meta não existir ainda, tenta sem ela
    if (errMsg && (String(errMsg.message || '').includes('reply_meta') || String(errMsg.message || '').includes('does not exist'))) {
      ;({ data: msg, error: errMsg } = await supabase
        .from('mensagens')
        .insert(basePayload)
        .select()
        .single())
    }

    if (errMsg) return res.status(500).json({ error: errMsg.message })

    // compatibilidade: marca como lida e atualiza ordem na lista
    await supabase
      .from('conversas')
      .update({ lida: true, ultima_atividade: new Date().toISOString() })
      .eq('company_id', Number(company_id))
      .eq('id', Number(conversa_id))

    // CRM: atualiza último contato do cliente (apenas conversas individuais)
    try {
      const isGroup = String(conversa?.tipo || '').toLowerCase() === 'grupo' || String(conversa?.telefone || '').includes('@g.us')
      if (!isGroup && conversa?.cliente_id != null) {
        await supabase
          .from('clientes')
          .update({ ultimo_contato: basePayload.criado_em, atualizado_em: new Date().toISOString() })
          .eq('company_id', Number(company_id))
          .eq('id', Number(conversa.cliente_id))
      }
    } catch (_) {}

    const io = req.app.get('io')
    if (io) {
      const basePayload = { ...msg, id: msg.id, conversa_id: msg.conversa_id ?? Number(conversa_id), status: 'sending', status_mensagem: 'sending', direcao: 'out' }
      const novaMsgPayload = await enrichMensagemComAutorUsuario(supabase, company_id, basePayload)
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem',
        novaMsgPayload
      )
      // Atualizar sidebar (preview) sem disparar refetch que causa duplicação
      let contatoNome = conversa?.nome_contato_cache ? String(conversa.nome_contato_cache).trim() : null
      let fotoPerfil = conversa?.foto_perfil_contato_cache ? String(conversa.foto_perfil_contato_cache).trim() : null
      if (!fotoPerfil && conversa?.cliente_id) {
        try {
          const { data: cli } = await supabase.from('clientes').select('foto_perfil').eq('id', conversa.cliente_id).eq('company_id', company_id).maybeSingle()
          if (cli?.foto_perfil) fotoPerfil = String(cli.foto_perfil).trim()
        } catch (_) {}
      }
      const telefoneParaPayload = conversa?.telefone && !String(conversa.telefone).startsWith('lid:') ? String(conversa.telefone).trim() : null
      const convPayload = {
        id: Number(conversa_id),
        ultima_atividade: basePayload.criado_em,
        exibir_badge_aberta: true,
        ...(telefoneParaPayload ? { telefone: telefoneParaPayload } : {}),
        ...(conversa?.cliente_id != null ? { cliente_id: conversa.cliente_id } : {}),
        ...(contatoNome ? { nome_contato_cache: contatoNome, contato_nome: contatoNome } : {}),
        ...(fotoPerfil ? { foto_perfil_contato_cache: fotoPerfil, foto_perfil: fotoPerfil } : {}),
        ultima_mensagem_preview: { texto: basePayload.texto, criado_em: basePayload.criado_em, direcao: 'out', fromMe: true, usuario_id: novaMsgPayload.usuario_id, usuario_nome: novaMsgPayload.usuario_nome },
        reordenar_suave: true // Frontend: animar item para o topo em vez de refetch (evita "desce e sobe")
      }
      emitirConversaAtualizada(io, company_id, conversa_id, convPayload, { skipAtualizarConversa: true })
    }

    // Envio para WhatsApp via provider (meta ou zapi, conforme WHATSAPP_PROVIDER)
    let sendResult = null
    if (!telefoneParaEnvio) {
      console.warn(`[WhatsApp] Conversa ${conversa_id} sem telefone (company ${company_id}) — mensagem salva, mas não enviada ao WhatsApp`)
    }
    if (telefoneParaEnvio) {
      let phoneId = null
      try {
        const { data: ew } = await supabase
          .from('empresas_whatsapp')
          .select('phone_number_id')
          .eq('company_id', company_id)
          .maybeSingle()
        if (ew?.phone_number_id) phoneId = String(ew.phone_number_id)
      } catch (_) {}

      // Resolve o whatsapp_id real da mensagem citada para enviar reply nativo ao WhatsApp
      let replyMessageId = null
      if (reply_meta?.replyToId != null) {
        const rid = String(reply_meta.replyToId).trim()
        // Se parece um ID numérico do banco (inteiro curto), busca o whatsapp_id real
        if (/^\d{1,15}$/.test(rid)) {
          try {
            const { data: refMsg } = await supabase
              .from('mensagens')
              .select('whatsapp_id')
              .eq('company_id', company_id)
              .eq('conversa_id', Number(conversa_id))
              .eq('id', Number(rid))
              .maybeSingle()
            replyMessageId = refMsg?.whatsapp_id || null
          } catch (_) {}
        } else {
          // Já é um whatsapp_id (ID longo do WhatsApp)
          replyMessageId = rid
        }
      }

      const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, user_id)
      const provider = getProvider()
      try {
        let result = null

        if (hasLinkPayload && provider.sendLink) {
          let messageToSend = String(texto).trim()
          const linkUrlStr = String(link.linkUrl || '').trim()
          if (linkUrlStr && !messageToSend.includes(linkUrlStr)) {
            messageToSend = messageToSend ? `${messageToSend} ${linkUrlStr}` : linkUrlStr
          }
          messageToSend = prefixarParaCliente(messageToSend, usuarioNome)
          result = await provider.sendLink(telefoneParaEnvio, {
            message: messageToSend,
            image: link.image || '',
            linkUrl: linkUrlStr,
            title: String(link.title || '').trim() || linkUrlStr,
            linkDescription: String(link.linkDescription || link.description || '').trim() || messageToSend,
          }, { companyId: company_id, conversaId: conversa_id })
        } else {
          const textoParaCliente = prefixarParaCliente(String(texto).trim(), usuarioNome)
          result = await provider.sendText(telefoneParaEnvio, textoParaCliente, { companyId: company_id, conversaId: conversa_id, phoneId: phoneId || undefined, replyMessageId: replyMessageId || undefined })
        }
        const ok = typeof result === 'boolean' ? result : result?.ok === true
        const waMessageId = typeof result === 'object' && result?.messageId ? String(result.messageId).trim() : null
        const nextStatus = ok ? 'sent' : 'erro'
        await supabase
          .from('mensagens')
          .update({ status: nextStatus, ...(isRealWhatsAppId(waMessageId) ? { whatsapp_id: waMessageId } : {}) })
          .eq('company_id', company_id)
          .eq('id', msg.id)

        const io2 = req.app.get('io')
        if (io2) {
          const payload = { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: nextStatus, status_mensagem: nextStatus, ...(waMessageId ? { whatsapp_id: waMessageId } : {}) }
          // Emite para empresa, conversa E usuario que enviou (garante ticks ✓✓ em tempo real)
          let chain = io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`)
          chain.emit('status_mensagem', payload)
        }

        if (!ok) {
          const errMsg = result?.error || result?.blockedBy
          if (errMsg) {
            console.warn('[WhatsApp] Falha ao entregar:', String(telefoneParaEnvio || '').slice(-8), '—', errMsg, '| mensagem_id:', msg.id)
          } else {
            console.warn('[WhatsApp] Falha ao entregar mensagem para', String(telefoneParaEnvio || '').slice(-8), '— verifique se a instância está conectada (escaneie o QR no painel) | mensagem_id:', msg.id)
          }
        }
        sendResult = result
      } catch (e) {
        console.error('WhatsApp enviar:', e)
        sendResult = { ok: false, error: e?.message || 'Erro ao enviar mensagem' }
        await supabase
          .from('mensagens')
          .update({ status: 'erro' })
          .eq('company_id', company_id)
          .eq('id', msg.id)
        const io2 = req.app.get('io')
        if (io2) {
          const payload = { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro', status_mensagem: 'erro' }
          let chain = io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`)
          chain.emit('status_mensagem', payload)
        }
      }
    }

    // Não retornar mensagem completa — evita duplicação no frontend (API + socket).
    // A mensagem chega via socket nova_mensagem (única fonte de verdade para exibição).
    const sendOk = !!telefoneParaEnvio && (typeof sendResult === 'boolean' ? sendResult : sendResult?.ok === true)
    const motivoErro = sendResult?.error || sendResult?.blockedBy
    return res.json({
      ok: true,
      id: msg.id,
      conversa_id: Number(conversa_id),
      ...(sendOk ? { status: 'sent' } : {
        status: sendResult?.blockedBy ? 'blocked' : 'erro',
        ...(motivoErro ? { motivo: motivoErro } : {})
      })
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao enviar mensagem' })
  }
}

// =====================================================
// Reações em mensagens (Z-API send-reaction / send-remove-reaction)
// =====================================================

exports.enviarReacaoMensagem = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const { id: conversa_id, mensagem_id } = req.params
    const { reaction } = req.body || {}

    if (!reaction || !String(reaction).trim()) {
      return res.status(400).json({ error: 'reaction é obrigatório' })
    }

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id, user_id })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    // busca conversa + mensagem para garantir que pertencem à empresa
    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, company_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()

    if (errConv || !conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    const { data: msg, error: errMsg } = await supabase
      .from('mensagens')
      .select('id, whatsapp_id, company_id, conversa_id')
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .eq('id', mensagem_id)
      .maybeSingle()

    if (errMsg || !msg) {
      return res.status(404).json({ error: 'Mensagem não encontrada' })
    }

    if (!msg.whatsapp_id) {
      return res.status(400).json({ error: 'Mensagem ainda não possui whatsapp_id para reagir' })
    }

    const provider = getProvider()
    if (!provider || !provider.sendReaction) {
      return res.status(500).json({ error: 'Provider WhatsApp não suporta reações' })
    }

    const ok = await provider.sendReaction(conversa.telefone, msg.whatsapp_id, String(reaction).trim(), { companyId: company_id })
    if (!ok) {
      return res.status(502).json({ error: 'Falha ao enviar reação para o WhatsApp' })
    }

    // Reação será espelhada depois via webhook Z-API (type=reaction), então não gravamos mensagem aqui.
    return res.json({ ok: true })
  } catch (err) {
    console.error('Erro ao enviar reação:', err)
    return res.status(500).json({ error: 'Erro ao enviar reação' })
  }
}

exports.removerReacaoMensagem = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const { id: conversa_id, mensagem_id } = req.params

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id, user_id })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, company_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()

    if (errConv || !conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    const { data: msg, error: errMsg } = await supabase
      .from('mensagens')
      .select('id, whatsapp_id, company_id, conversa_id')
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .eq('id', mensagem_id)
      .maybeSingle()

    if (errMsg || !msg) {
      return res.status(404).json({ error: 'Mensagem não encontrada' })
    }

    if (!msg.whatsapp_id) {
      return res.status(400).json({ error: 'Mensagem ainda não possui whatsapp_id para remover reação' })
    }

    const provider = getProvider()
    if (!provider || !provider.removeReaction) {
      return res.status(500).json({ error: 'Provider WhatsApp não suporta remoção de reação' })
    }

    const ok = await provider.removeReaction(conversa.telefone, msg.whatsapp_id, { companyId: company_id })
    if (!ok) {
      return res.status(502).json({ error: 'Falha ao remover reação no WhatsApp' })
    }

    // Remoção de reação também será refletida via webhook da Z-API.
    return res.json({ ok: true })
  } catch (err) {
    console.error('Erro ao remover reação:', err)
    return res.status(500).json({ error: 'Erro ao remover reação' })
  }
}

// =====================================================
// Compartilhar contato existente pelo WhatsApp (Z-API /send-contact)
// =====================================================

exports.enviarContatoWhatsapp = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const { id: conversa_id } = req.params
    const { cliente_id, messageId } = req.body || {}

    if (!cliente_id) {
      return res.status(400).json({ error: 'cliente_id é obrigatório' })
    }

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id, user_id })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, company_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()

    if (errConv || !conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    const { data: cliente, error: errCli } = await supabase
      .from('clientes')
      .select('id, nome, pushname, telefone, foto_perfil')
      .eq('company_id', company_id)
      .eq('id', cliente_id)
      .maybeSingle()

    if (errCli || !cliente) {
      return res.status(404).json({ error: 'Contato não encontrado' })
    }

    const contactName = getDisplayName(cliente) || 'Contato'
    const contactPhone = String(cliente.telefone || '').replace(/\D/g, '')
    const contactPhoneNorm = contactPhone.startsWith('55') ? contactPhone : `55${contactPhone}`
    const fotoPerfil = (cliente.foto_perfil && String(cliente.foto_perfil).trim().startsWith('http')) ? String(cliente.foto_perfil).trim() : null

    if (!contactPhone) {
      return res.status(400).json({ error: 'Contato não possui telefone válido para compartilhar' })
    }

    const provider = getProvider()
    if (!provider || !provider.sendContact) {
      return res.status(500).json({ error: 'Provider WhatsApp não suporta compartilhamento de contato' })
    }

    // contact_meta para o frontend exibir cartão de contato (nome, telefone, foto)
    const contact_meta = {
      nome: contactName,
      telefone: contactPhoneNorm,
      ...(fotoPerfil ? { foto_perfil: fotoPerfil } : {})
    }

    // cria registro local de mensagem do tipo "contact" (direção out)
    const criadoEm = new Date().toISOString()
    const { data: msg, error: errMsg } = await supabase
      .from('mensagens')
      .insert({
        company_id,
        conversa_id: Number(conversa_id),
        texto: contactName,
        direcao: 'out',
        tipo: 'contact',
        status: 'pending',
        autor_usuario_id: Number(user_id),
        criado_em: criadoEm,
        contact_meta,
      })
      .select()
      .single()

    if (errMsg) {
      return res.status(500).json({ error: errMsg.message })
    }

    const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, user_id)
    if (usuarioNome) {
      await provider.sendText(conversa.telefone, prefixarParaCliente('Segue contato abaixo:', usuarioNome), { companyId: company_id, conversaId: conversa_id })
    }
    const result = await provider.sendContact(conversa.telefone, contactName, contactPhone, {
      companyId: company_id,
      conversaId: conversa_id,
      messageId: messageId || undefined,
    })
    const ok = typeof result === 'boolean' ? result : result?.ok === true
    const waMessageId =
      typeof result === 'object' && result?.messageId ? String(result.messageId).trim() : null

    const nextStatus = ok ? 'sent' : 'erro'
    await supabase
      .from('mensagens')
      .update({ status: nextStatus, ...(isRealWhatsAppId(waMessageId) ? { whatsapp_id: waMessageId } : {}) })
      .eq('company_id', company_id)
      .eq('id', msg.id)

    const io = req.app.get('io')
    if (io) {
      const payload = await enrichMensagemComAutorUsuario(supabase, company_id, { ...msg, status: nextStatus, whatsapp_id: waMessageId || null })
      emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', payload)
      emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id) })
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error('Erro ao enviar contato:', err)
    return res.status(500).json({ error: 'Erro ao enviar contato' })
  }
}

// =====================================================
// enviarLocalizacao — envia localização via UltraMsg (contrato WhatsApp)
// =====================================================

exports.enviarLocalizacao = async (req, res) => {
  try {
    const { company_id, id: user_id } = req.user
    const { id: conversa_id } = req.params
    const body = req.body || {}
    const addressRaw = body.address ?? body.endereco ?? ''
    const nomeRaw = body.nome ?? body.name ?? body.placeName ?? ''
    const lat = body.lat ?? body.latitude
    const lng = body.lng ?? body.longitude

    const latitude = Number(lat)
    const longitude = Number(lng)
    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ error: 'lat e lng (ou latitude e longitude) são obrigatórios e devem ser números válidos' })
    }

    const nomePlace = String(nomeRaw || '').trim().slice(0, 200) || null
    const endereco = String(addressRaw || '').trim().slice(0, 500) || null

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id, user_id })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, tipo, nome_contato_cache, foto_perfil_contato_cache, chat_lid')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()

    if (errConv || !conversa) return res.status(404).json({ error: 'Conversa não encontrada' })

    let telefoneParaEnvio = conversa.telefone || ''
    if (telefoneParaEnvio && String(telefoneParaEnvio).trim().toLowerCase().startsWith('lid:')) {
      if (conversa.cliente_id) {
        const { data: cli } = await supabase.from('clientes').select('telefone').eq('id', conversa.cliente_id).eq('company_id', company_id).maybeSingle()
        if (cli?.telefone && !String(cli.telefone).startsWith('lid:')) telefoneParaEnvio = cli.telefone
      }
      if (telefoneParaEnvio.startsWith('lid:') && conversa.chat_lid) {
        const { data: outra } = await supabase
          .from('conversas')
          .select('telefone')
          .eq('company_id', company_id)
          .eq('chat_lid', conversa.chat_lid)
          .not('telefone', 'like', 'lid:%')
          .limit(1)
          .maybeSingle()
        if (outra?.telefone) telefoneParaEnvio = outra.telefone
      }
      if (telefoneParaEnvio.startsWith('lid:')) {
        return res.status(400).json({ error: 'Número do contato indisponível (conversa por LID). Aguarde o contato enviar uma mensagem ou sincronize os contatos.' })
      }
    }

    const location_meta = {
      latitude,
      longitude,
      ...(nomePlace ? { nome: nomePlace } : {}),
      ...(endereco ? { endereco } : {})
    }

    const provider = getProvider()
    if (!provider || !provider.sendLocation) {
      return res.status(500).json({ error: 'Provider WhatsApp não suporta envio de localização' })
    }

    const textoDisplay = [nomePlace, endereco].filter(Boolean).join(' • ') || '(localização)'
    const locationUrl = `https://www.google.com/maps?q=${latitude},${longitude}`
    const criadoEm = new Date().toISOString()

    const insertRow = {
      company_id,
      conversa_id: Number(conversa_id),
      texto: textoDisplay.slice(0, 2000),
      direcao: 'out',
      tipo: 'location',
      status: 'pending',
      url: locationUrl,
      nome_arquivo: 'localização',
      autor_usuario_id: Number(user_id),
      criado_em: criadoEm,
      location_meta
    }

    let { data: msg, error: errMsg } = await supabase
      .from('mensagens')
      .insert(insertRow)
      .select()
      .single()

    if (errMsg && (String(errMsg.message || '').includes('location_meta') || String(errMsg.message || '').includes('does not exist'))) {
      delete insertRow.location_meta
      ;({ data: msg, error: errMsg } = await supabase.from('mensagens').insert(insertRow).select().single())
    }

    if (errMsg) return res.status(500).json({ error: errMsg.message })

    await supabase
      .from('conversas')
      .update({ lida: true, ultima_atividade: new Date().toISOString() })
      .eq('company_id', Number(company_id))
      .eq('id', Number(conversa_id))

    try {
      const isGroup = String(conversa?.tipo || '').toLowerCase() === 'grupo' || String(conversa?.telefone || '').includes('@g.us')
      if (!isGroup && conversa?.cliente_id != null) {
        await supabase
          .from('clientes')
          .update({ ultimo_contato: criadoEm, atualizado_em: new Date().toISOString() })
          .eq('company_id', Number(company_id))
          .eq('id', Number(conversa.cliente_id))
      }
    } catch (_) {}

    const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, user_id)
    const baseAddress = [nomePlace, endereco].filter(Boolean).join('\n') || `${latitude},${longitude}`
    const addressParaCliente = usuarioNome ? `${usuarioNome} — ${String(baseAddress).slice(0, 280)}` : String(baseAddress).slice(0, 300)

    let result = { ok: false, messageId: null }
    if (telefoneParaEnvio) {
      result = await provider.sendLocation(telefoneParaEnvio, { address: addressParaCliente, lat: latitude, lng: longitude }, {
        companyId: company_id,
        conversaId: conversa_id
      })
    } else {
      console.warn(`[WhatsApp] Conversa ${conversa_id} sem telefone — localização salva, não enviada ao WhatsApp`)
    }

    const ok = result?.ok === true
    const waMessageId = result?.messageId ? String(result.messageId).trim() : null
    const nextStatus = ok ? 'sent' : 'erro'

    await supabase
      .from('mensagens')
      .update({ status: nextStatus, ...(isRealWhatsAppId(waMessageId) ? { whatsapp_id: waMessageId } : {}) })
      .eq('company_id', company_id)
      .eq('id', msg.id)

    const io = req.app.get('io')
    if (io) {
      const payload = await enrichMensagemComAutorUsuario(supabase, company_id, { ...msg, status: nextStatus, whatsapp_id: waMessageId || null, location_meta: msg.location_meta || location_meta })
      emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', payload)
      const convPayload = {
        id: Number(conversa_id),
        ultima_mensagem_preview: {
          texto: msg.texto,
          criado_em: msg.criado_em,
          direcao: 'out',
          tipo: 'location',
          location_meta: msg.location_meta || location_meta,
          url: locationUrl
        },
        reordenar_suave: true
      }
      emitirConversaAtualizada(io, company_id, conversa_id, convPayload, { skipAtualizarConversa: true })
    }

    const sendOk = !!telefoneParaEnvio && ok

    return res.json({
      ok: true,
      id: msg.id,
      conversa_id: Number(conversa_id),
      location_meta: msg.location_meta || location_meta,
      ...(sendOk ? { status: 'sent' } : { status: telefoneParaEnvio ? 'erro' : 'pending' })
    })
  } catch (err) {
    console.error('Erro ao enviar localização:', err)
    return res.status(500).json({ error: 'Erro ao enviar localização' })
  }
}

// =====================================================
// Registro de ligações via WhatsApp (Z-API /send-call)
// =====================================================

exports.enviarLigacaoWhatsapp = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const { id: conversa_id } = req.params
    const { callDuration } = req.body || {}

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id, user_id })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, company_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()

    if (errConv || !conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    const dur = Number(callDuration)
    const safeDur = Number.isFinite(dur) ? Math.max(1, Math.min(15, dur)) : 5

    const criadoEm = new Date().toISOString()
    const texto = `Ligação via WhatsApp (${safeDur}s)`

    const { data: msg, error: errMsg } = await supabase
      .from('mensagens')
      .insert({
        company_id,
        conversa_id: Number(conversa_id),
        texto,
        tipo: 'call',
        direcao: 'out',
        status: 'pending',
        autor_usuario_id: Number(user_id),
        criado_em: criadoEm,
      })
      .select()
      .single()

    if (errMsg) {
      return res.status(500).json({ error: errMsg.message })
    }

    const provider = getProvider()
    if (!provider || !provider.sendCall) {
      return res.status(500).json({ error: 'Provider WhatsApp não suporta ligações' })
    }

    const result = await provider.sendCall(conversa.telefone, safeDur, { companyId: company_id, conversaId: conversa_id })
    const ok = typeof result === 'boolean' ? result : result?.ok === true
    const waMessageId =
      typeof result === 'object' && result?.messageId ? String(result.messageId).trim() : null

    const nextStatus = ok ? 'sent' : 'erro'
    await supabase
      .from('mensagens')
      .update({ status: nextStatus, ...(isRealWhatsAppId(waMessageId) ? { whatsapp_id: waMessageId } : {}) })
      .eq('company_id', company_id)
      .eq('id', msg.id)

    const io = req.app.get('io')
    if (io) {
      const payload = await enrichMensagemComAutorUsuario(supabase, company_id, { ...msg, status: nextStatus, whatsapp_id: waMessageId || null })
      emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', payload)
      emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id) })
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error('Erro ao registrar ligação:', err)
    return res.status(500).json({ error: 'Erro ao registrar ligação' })
  }
}

// =====================================================
// excluirMensagem — remove do sistema (DB) + realtime
// =====================================================
exports.excluirMensagem = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const { id: conversa_id, mensagem_id } = req.params
    const scope = String(req.query?.scope || req.query?.for || '').toLowerCase().trim() || 'all'

    const cid = Number(conversa_id)
    const mid = Number(mensagem_id)
    if (!cid || !mid) return res.status(400).json({ error: 'Parâmetros inválidos' })

    // garante que a conversa pertence à empresa
    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, criado_em, telefone')
      .eq('company_id', company_id)
      .eq('id', cid)
      .maybeSingle()

    if (errConv || !conversa) return res.status(404).json({ error: 'Conversa não encontrada' })

    // valida que a mensagem é desta conversa/empresa
    const { data: msg, error: errMsgSel } = await supabase
      .from('mensagens')
      .select('id, conversa_id, criado_em, direcao, autor_usuario_id, whatsapp_id')
      .eq('company_id', company_id)
      .eq('conversa_id', cid)
      .eq('id', mid)
      .maybeSingle()

    if (errMsgSel) return res.status(500).json({ error: errMsgSel.message })
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' })

    // =====================================================
    // Apagar "pra mim" (persistente): oculta para este usuário
    // =====================================================
    if (scope === 'me' || scope === 'mim' || scope === 'self') {
      const { error: errHide } = await supabase
        .from('mensagens_ocultas')
        .insert({
          company_id: Number(company_id),
          conversa_id: cid,
          mensagem_id: mid,
          usuario_id: Number(user_id)
        })

      if (errHide) {
        const msg = String(errHide.message || '')
        if (msg.includes('mensagens_ocultas') || msg.includes('does not exist')) {
          return res.status(400).json({ error: 'Banco desatualizado: rode o supabase/RUN_IN_SUPABASE.sql (tabela mensagens_ocultas).' })
        }
        // se já existe (unique), considera ok
        if (String(errHide.code || '') !== '23505') {
          return res.status(500).json({ error: errHide.message })
        }
      }

      const io = req.app.get('io')
      if (io) {
        // emite só para o usuário (não impacta outros atendentes)
        emitirParaUsuario(io, user_id, 'mensagem_oculta', { conversa_id: cid, mensagem_id: mid })
      }

      return res.json({ ok: true, scope: 'me', conversa_id: cid, mensagem_id: mid })
    }

    // =====================================================
    // Apagar "para todos" — permitido somente para mensagens enviadas pelo próprio usuário
    // (admin pode apagar qualquer mensagem do sistema)
    // =====================================================
    if (String(perfil || '') !== 'admin') {
      const isOut = String(msg?.direcao || '').toLowerCase() === 'out'
      if (!isOut) {
        return res.status(403).json({ error: 'Você só pode apagar para todos mensagens enviadas por você.' })
      }
      if (msg?.autor_usuario_id == null || Number(msg.autor_usuario_id) !== Number(user_id)) {
        return res.status(403).json({ error: 'Você só pode apagar para todos mensagens enviadas por você.' })
      }
    }

    // Apagar no WhatsApp (UltraMsg) se houver whatsapp_id e provider suportar
    const provider = getProvider()
    if (provider?.deleteMessage && msg?.whatsapp_id && conversa?.telefone) {
      try {
        await provider.deleteMessage(conversa.telefone, msg.whatsapp_id, { companyId: company_id })
      } catch (e) {
        console.warn('[excluirMensagem] deleteMessage no WhatsApp:', e?.message || e)
      }
    }

    const { error: errDel } = await supabase
      .from('mensagens')
      .delete()
      .eq('company_id', company_id)
      .eq('conversa_id', cid)
      .eq('id', mid)

    if (errDel) return res.status(500).json({ error: errDel.message })

    // recalcula última mensagem (para o preview da lista)
    const { data: lastMsg, error: errLast } = await supabase
      .from('mensagens')
      .select('id, conversa_id, texto, direcao, tipo, url, nome_arquivo, criado_em, status, status_mensagem, whatsapp_id')
      .eq('company_id', company_id)
      .eq('conversa_id', cid)
      .order('criado_em', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)

    if (errLast) console.warn('Excluir mensagem: erro ao buscar última mensagem:', errLast.message)
    const ultima = Array.isArray(lastMsg) && lastMsg.length > 0 ? lastMsg[0] : null

    // atualiza ultima_atividade para manter ordenação coerente
    const ultimaAtividade = ultima?.criado_em || conversa?.criado_em || new Date().toISOString()
    await supabase
      .from('conversas')
      .update({ ultima_atividade: ultimaAtividade })
      .eq('company_id', company_id)
      .eq('id', cid)

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(
        io,
        company_id,
        cid,
        io.EVENTS?.MENSAGEM_EXCLUIDA || 'mensagem_excluida',
        {
          conversa_id: cid,
          mensagem_id: mid,
          ultima_mensagem: ultima
        }
      )
      emitirConversaAtualizada(io, company_id, cid, { id: cid })
    }

    return res.json({ ok: true, conversa_id: cid, mensagem_id: mid, ultima_mensagem: ultima })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao excluir mensagem' })
  }
}

// =====================================================
// listarAtendimentos — atendimentos + historico (transferiu_setor) com nomes
// =====================================================
exports.listarAtendimentos = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id: conversa_id } = req.params
    const cid = Number(conversa_id)

    // 🔒 Tenant estrito: não permitir consultar conversa de outra empresa
    const { data: conv, error: errConvCheck } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .eq('id', cid)
      .maybeSingle()
    if (errConvCheck) return res.status(500).json({ error: errConvCheck.message })
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' })

    const { data: rows, error } = await supabase
      .from('atendimentos')
      .select('id, conversa_id, acao, observacao, criado_em, de_usuario_id, para_usuario_id')
      .eq('company_id', company_id)
      .eq('conversa_id', cid)
      .order('criado_em', { ascending: true })

    if (error) return res.status(500).json({ error: error.message })

    const { data: histRows } = await supabase
      .from('historico_atendimentos')
      .select('id, conversa_id, usuario_id, acao, observacao, criado_em')
      .eq('conversa_id', cid)
      .order('criado_em', { ascending: true })

    const list = rows || []
    const histList = histRows || []
    const userIds = new Set()
    list.forEach((a) => {
      if (a.de_usuario_id) userIds.add(a.de_usuario_id)
      if (a.para_usuario_id) userIds.add(a.para_usuario_id)
    })
    histList.forEach((h) => { if (h.usuario_id) userIds.add(h.usuario_id) })
    const idList = [...userIds]
    let userMap = {}
    if (idList.length > 0) {
      const { data: usuarios } = await supabase
        .from('usuarios')
        .select('id, nome')
        .eq('company_id', company_id)
        .in('id', idList)
      usuarios?.forEach((u) => { userMap[u.id] = u.nome || '' })
    }

    const atend = list.map((a) => ({
      ...a,
      tipo: 'atendimento',
      usuario_nome: userMap[a.de_usuario_id] ?? null,
      para_usuario_nome: userMap[a.para_usuario_id] ?? null,
    }))
    const hist = histList.map((h) => ({
      id: h.id,
      conversa_id: h.conversa_id,
      acao: h.acao,
      observacao: h.observacao ?? null,
      criado_em: h.criado_em,
      tipo: 'historico',
      usuario_nome: userMap[h.usuario_id] ?? null,
      para_usuario_nome: null,
    }))
    const merged = [...atend, ...hist].sort(
      (a, b) => new Date(a.criado_em) - new Date(b.criado_em)
    )
    return res.json(merged)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar atendimentos' })
  }
}

// =====================================================
// 6) puxarChatFila (lock + filtrar por setor)
// =====================================================
exports.puxarChatFila = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const isAdmin = perfil === 'admin'

    // Só entra na fila quem tem ao menos uma mensagem (movimentação real), alinhado à aba "Abertas"
    let query = supabase
      .from('conversas')
      .select('*, mensagens!inner(id)')
      .eq('company_id', company_id)
      .eq('status_atendimento', 'aberta')
      .is('atendente_id', null)
      .or('tipo.is.null,tipo.neq.grupo') // Grupos são apenas visuais — não entram na fila
      .order('criado_em', { ascending: true })
      .limit(1)

    // Atendente/supervisor: com setor → seu setor + conversas sem setor; sem setor → só conversas sem setor
    if (!isAdmin) {
      const depIds = Array.isArray(departamento_ids) ? departamento_ids.filter((id) => id != null && Number.isFinite(Number(id))) : []
      if (depIds.length > 0) {
        const depOr = depIds.map((d) => `departamento_id.eq.${d}`).join(',')
        query = query.or(`${depOr},departamento_id.is.null`)
      } else {
        query = query.is('departamento_id', null)
      }
    }

    const { data: conversa, error } = await query.maybeSingle()

    if (error) return res.status(500).json({ error: error.message })

    if (!conversa) {
      return res.status(404).json({ error: 'Nenhuma conversa na fila' })
    }

    // Limite de chats simultâneos por atendente
    const { data: emp } = await supabase.from('empresas').select('limite_chats_por_atendente').eq('id', company_id).single()
    const limite = Number(emp?.limite_chats_por_atendente ?? 0)
    if (limite > 0) {
      const { count } = await supabase
        .from('conversas')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', company_id)
        .eq('atendente_id', user_id)
        .eq('status_atendimento', 'em_atendimento')
      if (count >= limite) {
        return res.status(409).json({ error: `Limite de ${limite} conversas simultâneas atingido. Encerre uma antes de puxar outra.` })
      }
    }

    const { data: atualizada, error: errUpdate } = await supabase
      .from('conversas')
      .update({
        atendente_id: user_id,
        status_atendimento: 'em_atendimento',
        lida: true,
        atendente_atribuido_em: new Date().toISOString()
      })
      .eq('company_id', company_id)
      .eq('id', conversa.id)
      .is('atendente_id', null) // LOCK REAL
      .select()
      .maybeSingle()

    if (errUpdate) return res.status(500).json({ error: errUpdate.message })

    if (!atualizada) {
      return res.status(409).json({ error: 'Outra pessoa puxou essa conversa antes de você' })
    }

    const resultAt = await registrarAtendimento({
      conversa_id: conversa.id,
      company_id,
      acao: 'assumiu',
      de_usuario_id: user_id,
      para_usuario_id: user_id, // ✅ corrigido
      observacao: 'Puxou da fila'
    })
    if (resultAt.error) return res.status(500).json({ error: resultAt.error.message })

    const io = req.app.get('io')
    if (io) {
      emitirConversaAtualizada(io, company_id, conversa.id, { id: Number(conversa.id) })
      emitirLock(io, conversa.id, user_id)

    }

    return res.json({ conversa_id: conversa.id })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao puxar conversa da fila' })
  }
}

// =====================================================
// TAGS (padronizado)
// =====================================================
exports.adicionarTagConversa = async (req, res) => {
  try {
    const { id } = req.params
    const { tag_id } = req.body
    const { company_id } = req.user

    if (!tag_id) return res.status(400).json({ error: 'tag_id é obrigatório' })

    const { data: existente } = await supabase
      .from('conversa_tags')
      .select('id')
      .eq('conversa_id', id)
      .eq('tag_id', tag_id)
      .eq('company_id', company_id)
      .maybeSingle()

    if (existente) return res.status(409).json({ error: 'Tag já vinculada' })

    const { data, error } = await supabase
      .from('conversa_tags')
      .insert([{ conversa_id: id, tag_id, company_id }])
      .select(`
        id,
        tags (
          id,
          nome,
          cor
        )
      `)
      .single()

    if (error) return res.status(500).json({ error: error.message })

    const io = req.app.get('io')
    if (io) {
      const payload = { conversa_id: Number(id), tag: data.tags }

      emitirEventoEmpresaConversa(
        io,
        company_id,
        id,
        io.EVENTS?.TAG_ADICIONADA || 'tag_adicionada',
        payload
      )
      emitirConversaAtualizada(io, company_id, id, { id: Number(id) })
    }

    return res.json({ success: true, tag: data.tags })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao adicionar tag' })
  }
}

exports.removerTagConversa = async (req, res) => {
  try {
    const { id, tag_id } = req.params
    const { company_id } = req.user

    const { error } = await supabase
      .from('conversa_tags')
      .delete()
      .eq('conversa_id', id)
      .eq('tag_id', tag_id)
      .eq('company_id', company_id)

    if (error) return res.status(500).json({ error: error.message })

    const io = req.app.get('io')
    if (io) {
      const payload = { conversa_id: Number(id), tag_id: Number(tag_id) }

      emitirEventoEmpresaConversa(
        io,
        company_id,
        id,
        io.EVENTS?.TAG_REMOVIDA || 'tag_removida',
        payload
      )
      emitirConversaAtualizada(io, company_id, id, { id: Number(id) })
    }

    return res.json({ success: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao remover tag' })
  }
}
/** MIME base sem parâmetros (ex.: codecs) */
function mimeBase(file) {
  const m = String(file?.mimetype || '').toLowerCase().trim()
  return m.split(';')[0].trim()
}

/**
 * Permite forçar envio como figurinha (endpoint /messages/sticker) quando o front envia
 * PNG/JPEG recortado na área "Criar" — sem depender só de .webp no nome/MIME.
 */
function aplicarTipoForcadoSticker(file, tipoInferido) {
  const forced = String(file?.__tipoForcado || '').toLowerCase().trim()
  if (forced !== 'sticker') return tipoInferido
  const base = mimeBase(file)
  const n = String(file?.originalname || '').toLowerCase()
  const stickerish =
    ['image/webp', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif'].includes(base) ||
    /\.(webp|png|jpe?g|gif)$/i.test(n)
  return stickerish ? 'sticker' : tipoInferido
}

function inferirTipoArquivo(file) {
  const m = String(file.mimetype || '').toLowerCase()
  const n = String(file.originalname || '').toLowerCase()
  // Figurinha (WhatsApp): geralmente WEBP
  if (m === 'image/webp' || /\.webp$/i.test(n)) return 'sticker'
  if (m.startsWith('image/')) return 'imagem'
  
  // Voice note (PTT): formatos tipicamente opus/ogg/webm.
  // Áudios comuns (mp3/m4a/wav/aac) devem ir como "audio".
  if (
    m === 'audio/opus' ||
    m === 'audio/ogg' ||
    m === 'audio/webm' ||
    /\.opus$/i.test(n) ||
    /\.ogg$/i.test(n) ||
    /\.webm$/i.test(n)
  ) {
    return 'voice'
  }
  
  // Para outros formatos de áudio, verifica se parece ser uma gravação (voice note)
  // Arquivos pequenos (< 5MB) e com nomes típicos de gravação são tratados como voice
  if (m.startsWith('audio/') || /\.(mp3|ogg|wav|m4a|aac)$/i.test(n)) {
    return 'audio'
  }
  
  if (m.startsWith('video/')) return 'video'
  return 'arquivo'
}

function getAudioFileExtension(file) {
  const byOriginal = String(file?.originalname || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/i)
  if (byOriginal?.[1]) return byOriginal[1].toLowerCase()
  const byStored = String(file?.filename || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/i)
  if (byStored?.[1]) return byStored[1].toLowerCase()
  return ''
}

async function convertAudioWithFfmpeg(inputPath, outputPath, profile = 'audio_mp3') {
  const { spawn } = require('child_process')
  return new Promise((resolve, reject) => {
    let ffmpegPath
    try {
      ffmpegPath = require('ffmpeg-static')
    } catch {
      ffmpegPath = null
    }
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static não disponível'))
      return
    }
    let args
    // Voice (PTT): alinhado ao padrão usado por integrações WhatsApp estáveis (Evolution/Baileys):
    // 48 kHz, mono, Opus ~48k, sem metadados — evita áudio que toca no Web mas falha no iPhone.
    if (profile === 'voice_ogg_opus') {
      args = [
        '-y',
        '-i', inputPath,
        '-vn',
        '-ac', '1',
        '-ar', '48000',
        '-c:a', 'libopus',
        '-b:a', '48k',
        '-avoid_negative_ts', 'make_zero',
        '-write_xing', '0',
        '-compression_level', '10',
        '-application', 'voip',
        '-fflags', '+bitexact',
        '-flags', '+bitexact',
        '-id3v2_version', '0',
        '-map_metadata', '-1',
        '-map_chapters', '-1',
        '-write_bext', '0',
        outputPath,
      ]
    } else {
      args = [
        '-y',
        '-i', inputPath,
        '-vn',
        '-ac', '1',
        '-ar', '44100',
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        '-write_xing', '0',
        '-id3v2_version', '0',
        '-map_metadata', '-1',
        '-map_chapters', '-1',
        outputPath,
      ]
    }
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += String(d || '') })
    proc.on('error', (err) => reject(err))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exit=${code} ${stderr.slice(-240)}`.trim()))
    })
  })
}

async function normalizeAudioForUltraMsg(file, tipo) {
  if (!file || !file.path || (tipo !== 'audio' && tipo !== 'voice')) return { file, converted: false, error: null }
  const ext = getAudioFileExtension(file)
  const isVoice = tipo === 'voice'
  const isAudio = tipo === 'audio'
  const allowedAudioExt = ['mp3', 'ogg', 'aac']
  // Para voice, sempre transcodificar para OGG/Opus.
  // Isso elimina variações de codec/container que tocam no desktop mas falham no mobile.
  if (isAudio && allowedAudioExt.includes(ext)) {
    return { file, converted: false, error: null }
  }

  const path = require('path')
  const fs = require('fs')
  const dir = path.dirname(file.path)
  const currentStoredName = String(file.filename || path.basename(file.path))
  const baseStoredName = currentStoredName.replace(/\.[a-z0-9]{2,5}$/i, '')
  const originalName = String(file.originalname || currentStoredName)
  // Voice: ogg/opus | Audio: mp3 (mais compatível no endpoint /messages/audio).
  const targetExt = isVoice ? 'ogg' : 'mp3'
  const targetStoredName = `${baseStoredName}.${targetExt}`
  const targetPath = path.join(dir, targetStoredName)
  const targetOriginalName = originalName.replace(/\.[a-z0-9]{2,5}$/i, `.${targetExt}`)
  const ffmpegProfile = isVoice ? 'voice_ogg_opus' : 'audio_mp3'

  await convertAudioWithFfmpeg(file.path, targetPath, ffmpegProfile)
  fs.unlink(file.path, () => {})

  return {
    converted: true,
    error: null,
    file: {
      ...file,
      path: targetPath,
      filename: targetStoredName,
      originalname: targetOriginalName,
      mimetype: isVoice ? 'audio/ogg' : 'audio/mpeg',
    }
  }
}

exports.enviarArquivo = async (req, res) => {
  try {
    const { id: conversa_id } = req.params
    const { company_id, id: user_id, perfil } = req.user
    const io = req.app.get('io')

    if (!req.file) {
      const hint = 'Envie multipart/form-data com campo "file" ou "audio"'
      return res.status(400).json({ error: "Arquivo não enviado. " + hint })
    }

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id, user_id })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    let file = req.file
    const tipoBody = String(req.body?.tipo || req.query?.tipo || '').toLowerCase().trim()
    if (tipoBody === 'sticker') file.__tipoForcado = 'sticker'
    const tipo = aplicarTipoForcadoSticker(file, inferirTipoArquivo(file))
    if (tipo === 'audio' || tipo === 'voice') {
      try {
        const normalized = await normalizeAudioForUltraMsg(file, tipo)
        if (normalized?.converted && normalized?.file) {
          const beforeName = req.file?.originalname || file.originalname
          file = normalized.file
          req.file = file
          console.log('[ULTRAMSG][AUDIO] Áudio convertido para formato compatível antes do envio:', {
            tipo,
            from: beforeName,
            to: file.originalname,
            mime: file.mimetype,
          })
        } else if (normalized?.error) {
          console.warn('[ULTRAMSG][AUDIO] Conversão/normalização indisponível:', normalized.error)
        }
      } catch (e) {
        console.warn('[ULTRAMSG][AUDIO] Falha ao converter WAV para MP3:', e?.message || e)
      }
    }
    const pathUrl = `/uploads/${file.filename}`

    const { data: conversa } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, tipo, chat_lid')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .single()

    if (!conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    // Resolver telefone real quando conversa tem apenas LID (lid:xxx) — UltraMsg não envia para LID
    let telefoneParaEnvio = conversa.telefone || ''
    if (telefoneParaEnvio && String(telefoneParaEnvio).trim().toLowerCase().startsWith('lid:')) {
      if (conversa.cliente_id) {
        const { data: cli } = await supabase.from('clientes').select('telefone').eq('id', conversa.cliente_id).eq('company_id', company_id).maybeSingle()
        if (cli?.telefone && !String(cli.telefone).startsWith('lid:')) telefoneParaEnvio = cli.telefone
      }
      if (telefoneParaEnvio.startsWith('lid:') && conversa.chat_lid) {
        const { data: outra } = await supabase
          .from('conversas')
          .select('telefone')
          .eq('company_id', company_id)
          .eq('chat_lid', conversa.chat_lid)
          .not('telefone', 'like', 'lid:%')
          .limit(1)
          .maybeSingle()
        if (outra?.telefone) telefoneParaEnvio = outra.telefone
      }
      if (telefoneParaEnvio.startsWith('lid:')) {
        return res.status(400).json({ error: 'Número do contato indisponível (conversa por LID). Aguarde o contato enviar uma mensagem ou sincronize os contatos.' })
      }
    }

    const { data: msg, error } = await supabase.from("mensagens").insert({
      conversa_id: Number(conversa_id),
      texto: tipo === 'audio' ? '(áudio)' : tipo === 'voice' ? '(áudio de voz)' : tipo === 'sticker' ? '(figurinha)' : file.originalname,
      tipo,
      url: pathUrl,
      nome_arquivo: file.originalname,
      direcao: "out",
      autor_usuario_id: user_id,
      company_id,
    }).select().single()

    if (error) return res.status(500).json({ error: error.message })

    // Atualizar conversa com timestamp correto
    const timestampAtividade = new Date().toISOString()
    await supabase
      .from('conversas')
      .update({ lida: true, ultima_atividade: timestampAtividade })
      .eq('company_id', Number(company_id))
      .eq('id', Number(conversa_id))

    // Emitir eventos para o frontend
    if (io) {
      const basePayload = { ...msg, conversa_id: msg.conversa_id ?? Number(conversa_id), status: msg.status || 'pending', status_mensagem: msg.status_mensagem || msg.status || 'pending', direcao: 'out' }
      const novaMsgPayload = await enrichMensagemComAutorUsuario(supabase, company_id, basePayload)
      emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', novaMsgPayload)
      
      const convPayload = { id: Number(conversa_id), ultima_atividade: timestampAtividade }
      
      // Adicionar preview da última mensagem baseado no tipo
      if (msg.tipo === 'contact' && msg.contact_meta) {
        convPayload.ultima_mensagem_preview = { texto: msg.texto, criado_em: msg.criado_em, direcao: 'out', tipo: 'contact', contact_meta: msg.contact_meta }
      } else if (msg.tipo === 'location' && (msg.location_meta || msg.url)) {
        convPayload.ultima_mensagem_preview = {
          texto: msg.texto,
          criado_em: msg.criado_em,
          direcao: 'out',
          tipo: 'location',
          ...(msg.location_meta ? { location_meta: msg.location_meta } : {}),
          ...(msg.url ? { url: msg.url } : {})
        }
      } else {
        // Para outros tipos de mídia
        convPayload.ultima_mensagem_preview = {
          texto: msg.texto,
          criado_em: msg.criado_em,
          direcao: 'out',
          tipo: msg.tipo,
          ...(msg.url ? { url: msg.url } : {}),
          ...(msg.nome_arquivo ? { nome_arquivo: msg.nome_arquivo } : {})
        }
      }
      
      emitirConversaAtualizada(io, company_id, conversa_id, convPayload)
    }

    const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, user_id)
    const captionCliente = usuarioNome ? `— ${usuarioNome}` : ''
    const baseUrl = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/$/, '')
    const fullUrl = baseUrl ? `${baseUrl}${pathUrl}` : null
    const isLocalhost = /localhost|127\.0\.0\.1/i.test(baseUrl)
    // Para áudio/voice, prioriza sempre CDN da UltraMsg:
    // evita problemas de disponibilidade/headers em URLs próprias do backend
    // e melhora a reprodução no WhatsApp mobile e desktop.
    const forceUploadMedia = (tipo === 'audio' || tipo === 'voice')

    const sendMediaWithUrl = (mediaUrl) => {
      const provider = getProvider()
      const phone = telefoneParaEnvio
      const isAudioTipo = tipo === 'voice' || tipo === 'audio'
      const opts = {
        companyId: company_id,
        conversaId: conversa_id,
        ...(isAudioTipo ? { returnDetails: true, audioMeta: { originalName: file.originalname, mimeType: file.mimetype } } : {}),
      }
      const promise =
        tipo === 'voice' && provider.sendVoice
          ? provider.sendVoice(phone, mediaUrl, opts)
          : tipo === 'audio' && provider.sendAudio
          ? provider.sendAudio(phone, mediaUrl, opts)
          : tipo === 'sticker' && provider.sendSticker
            ? provider.sendSticker(phone, mediaUrl, { ...opts, stickerAuthor: 'ZapERP' })
            : tipo === 'imagem' && provider.sendImage
              ? provider.sendImage(phone, mediaUrl, captionCliente, opts)
              : tipo === 'video' && provider.sendVideo
                ? provider.sendVideo(phone, mediaUrl, captionCliente, opts)
                : provider.sendFile
                  ? provider.sendFile(phone, mediaUrl, file.originalname || '', { ...opts, caption: captionCliente })
                  : Promise.resolve(false)
      promise
        .then(async (result) => {
          const normalizedResult = typeof result === 'boolean'
            ? { ok: result, error: null, messageId: null }
            : (result || { ok: false, error: 'resultado_provider_vazio', messageId: null })
          const ok = normalizedResult.ok === true
          const waMessageId = normalizedResult?.messageId ? String(normalizedResult.messageId).trim() : null
          const nextStatus = ok ? 'sent' : 'erro'
          
          if (!ok) {
            console.warn('WhatsApp: falha ao enviar mídia', {
              phone: String(phone || '').slice(-12),
              tipo,
              mediaUrl: String(mediaUrl || '').slice(0, 180),
              erro: normalizedResult?.error || 'sem detalhes',
            })
          } else {
            console.log('✅ WhatsApp mídia enviada:', phone?.slice(-12), tipo, waMessageId ? `(${waMessageId})` : '')
          }
          
          await supabase
            .from('mensagens')
            .update({ 
              status: nextStatus,
              ...(isRealWhatsAppId(waMessageId) ? { whatsapp_id: waMessageId } : {})
            })
            .eq('company_id', company_id)
            .eq('id', msg.id)
            
          const io2 = req.app?.get('io')
          if (io2) {
            const payload = { 
              mensagem_id: msg.id, 
              conversa_id: Number(conversa_id), 
              status: nextStatus, 
              status_mensagem: nextStatus,
              ...(waMessageId ? { whatsapp_id: waMessageId } : {})
            }
            io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`).emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', payload)
          }
        })
        .catch(async (e) => {
          console.error('WhatsApp enviar mídia (erro de rede/provider):', e?.message || e)
          await supabase.from('mensagens').update({ status: 'erro' }).eq('company_id', company_id).eq('id', msg.id)
          const io2 = req.app?.get('io')
          if (io2) {
            const payload = { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro', status_mensagem: 'erro' }
            io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`).emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', payload)
          }
        })
    }

    if (telefoneParaEnvio) {
      if (fullUrl && !isLocalhost && !forceUploadMedia) {
        setImmediate(() => sendMediaWithUrl(fullUrl))
      } else if ((!baseUrl || isLocalhost || forceUploadMedia) && file.path) {
        const provider = getProvider()
        if (provider?.uploadMedia) {
          setImmediate(async () => {
            try {
              const result = await provider.uploadMedia(file.path, file.originalname || 'file', { companyId: company_id })
              if (result?.ok && result?.url) {
                console.log('[ULTRAMSG] Upload bem-sucedido, enviando mídia via CDN:', result.url.slice(0, 50) + '...')
                sendMediaWithUrl(result.url)
              } else {
                console.warn('[ULTRAMSG] Upload de mídia falhou:', {
                  ok: result?.ok,
                  error: result?.error,
                  filename: file.originalname,
                  tipo,
                  forceUploadMedia
                })
                // Fallback seguro: se temos URL pública do backend, tenta enviar direto sem upload.
                if (fullUrl && !isLocalhost) {
                  console.warn('[ULTRAMSG] Tentando fallback com URL pública do backend após falha no upload.')
                  sendMediaWithUrl(fullUrl)
                } else {
                  console.warn('⚠️ UltraMsg uploadMedia falhou; mídia não enviada.', result?.error || '')
                  await supabase.from('mensagens').update({ status: 'erro' }).eq('company_id', company_id).eq('id', msg.id)
                  const io2 = req.app?.get('io')
                  if (io2) {
                    io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`).emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro', status_mensagem: 'erro' })
                  }
                }
              }
            } catch (e) {
              console.error('WhatsApp uploadMedia:', e)
              await supabase.from('mensagens').update({ status: 'erro' }).eq('company_id', company_id).eq('id', msg.id)
              const io2 = req.app?.get('io')
              if (io2) {
                io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`).emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro', status_mensagem: 'erro' })
              }
            }
          })
        } else if (!baseUrl && !forceUploadMedia) {
          console.warn('⚠️ APP_URL/BASE_URL não configurado; mídia não enviada ao WhatsApp.')
        } else {
          console.warn('⚠️ APP_URL é localhost e provider sem uploadMedia; mídia não enviada ao WhatsApp.')
        }
      } else if (!baseUrl) {
        console.warn('⚠️ APP_URL/BASE_URL não configurado; mídia não enviada ao WhatsApp.')
      }
    }

    // Não retornar mensagem completa — evita duplicação (API + socket). Mensagem chega via nova_mensagem.
    return res.json({ ok: true, id: msg.id, conversa_id: Number(conversa_id) })
  } catch (err) {
    console.error('Erro ao enviar arquivo:', err)
    return res.status(500).json({ error: 'Erro ao enviar arquivo' })
  }
}

const MAX_ENC_AMINHAR_LOTE = 30

/**
 * Normaliza `mensagem_id` ou `mensagem_ids` do body para uma lista ordenada de IDs (sem duplicados).
 * @param {Record<string, unknown>} body
 * @returns {number[]}
 */
function collectOrderedMessageIds(body) {
  const raw =
    Array.isArray(body?.mensagem_ids) && body.mensagem_ids.length > 0
      ? body.mensagem_ids
      : body?.mensagem_id != null && body?.mensagem_id !== ''
        ? [body.mensagem_id]
        : []
  const seen = new Set()
  const ordered = []
  for (const x of raw) {
    const n = Number(x)
    if (!Number.isFinite(n) || n <= 0) continue
    if (seen.has(n)) continue
    seen.add(n)
    ordered.push(n)
  }
  return ordered
}

/**
 * Encaminha uma mensagem já carregada para a conversa de destino (persistência + WhatsApp + socket).
 * @returns {Promise<{ ok: true, mensagem: object, enviado_whatsapp: boolean } | { ok: false, status: number, error: string }>}
 */
async function encaminharUmaMensagemParaConversa(ctx) {
  const {
    io,
    supabase,
    company_id,
    user_id,
    conversa_id,
    telefoneParaEnvio,
    provider,
    usuarioNome,
    mensagemOriginal,
    tipo_encaminhamento,
    timestamp,
  } = ctx

  const fail = (status, error) => ({ ok: false, status, error })
  const prefixoEncaminhado = '[Encaminhado]'

  let novaMensagem = null
  let resultadoEnvio = false

  const tipoOriginal = String(mensagemOriginal.tipo || '').toLowerCase()
  const temUrl = !!(mensagemOriginal.url)

  if (tipo_encaminhamento === 'texto' || (!temUrl && tipoOriginal === 'texto')) {
    const textoOriginal = mensagemOriginal.texto && !mensagemOriginal.texto.startsWith('[Encaminhado]')
      ? mensagemOriginal.texto
      : (mensagemOriginal.texto || '(mídia)')

    const textoParaWhatsApp = usuarioNome
      ? `${prefixoEncaminhado}\n${textoOriginal}\n— ${usuarioNome}`
      : `${prefixoEncaminhado}\n${textoOriginal}`

    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: textoOriginal,
      tipo: 'texto',
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio && provider.sendText) {
      resultadoEnvio = await provider.sendText(telefoneParaEnvio, textoParaWhatsApp, {
        companyId: company_id,
        conversaId: conversa_id,
      })
    }
  } else if (temUrl && (tipoOriginal === 'imagem' || tipoOriginal === 'video' || tipoOriginal === 'audio' || tipoOriginal === 'voice' || tipoOriginal === 'arquivo' || tipoOriginal === 'sticker')) {
    const baseUrl = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/$/, '')
    const mediaUrl = mensagemOriginal.url.startsWith('http')
      ? mensagemOriginal.url
      : baseUrl ? `${baseUrl}${mensagemOriginal.url}` : null

    if (!mediaUrl) {
      return fail(400, 'URL da mídia não pode ser resolvida para encaminhamento')
    }

    const captionEncaminhado = usuarioNome ? `${prefixoEncaminhado} — ${usuarioNome}` : prefixoEncaminhado

    const textoPlaceholderPorTipo = {
      imagem: '(imagem)',
      video: '(vídeo)',
      audio: '(áudio)',
      voice: '(áudio de voz)',
      sticker: '(figurinha)',
      arquivo: mensagemOriginal.nome_arquivo || '(arquivo)',
    }
    const textoParaBanco = textoPlaceholderPorTipo[tipoOriginal] || mensagemOriginal.nome_arquivo || `(${tipoOriginal})`

    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: textoParaBanco,
      tipo: tipoOriginal,
      url: mensagemOriginal.url,
      nome_arquivo: mensagemOriginal.nome_arquivo,
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio) {
      const opts = { companyId: company_id, conversaId: conversa_id }

      switch (tipoOriginal) {
        case 'imagem':
          if (provider.sendImage) {
            resultadoEnvio = await provider.sendImage(telefoneParaEnvio, mediaUrl, captionEncaminhado, opts)
          }
          break
        case 'video':
          if (provider.sendVideo) {
            resultadoEnvio = await provider.sendVideo(telefoneParaEnvio, mediaUrl, captionEncaminhado, opts)
          }
          break
        case 'audio':
          if (provider.sendAudio) {
            resultadoEnvio = await provider.sendAudio(telefoneParaEnvio, mediaUrl, opts)
          }
          break
        case 'voice':
          if (provider.sendVoice) {
            resultadoEnvio = await provider.sendVoice(telefoneParaEnvio, mediaUrl, opts)
          } else if (provider.sendAudio) {
            resultadoEnvio = await provider.sendAudio(telefoneParaEnvio, mediaUrl, opts)
          }
          break
        case 'sticker':
          if (provider.sendSticker) {
            resultadoEnvio = await provider.sendSticker(telefoneParaEnvio, mediaUrl, opts)
          }
          break
        default:
          if (provider.sendFile) {
            resultadoEnvio = await provider.sendFile(telefoneParaEnvio, mediaUrl, mensagemOriginal.nome_arquivo || 'arquivo', { ...opts, caption: captionEncaminhado })
          }
      }
    }
  } else if (tipoOriginal === 'contact') {
    let contactMeta = mensagemOriginal.contact_meta
    if (!contactMeta || typeof contactMeta !== 'object') {
      contactMeta = null
    }

    const contactName = contactMeta?.nome || contactMeta?.name || mensagemOriginal.texto || 'Contato'
    const contactPhoneRaw = String(contactMeta?.telefone || contactMeta?.phone || '').replace(/\D/g, '')
    const contactPhone = contactPhoneRaw || null

    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: contactName,
      tipo: 'contact',
      contact_meta: contactMeta || { nome: contactName },
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio && provider.sendContact && contactPhone) {
      resultadoEnvio = await provider.sendContact(
        telefoneParaEnvio,
        contactName,
        contactPhone,
        { companyId: company_id, conversaId: conversa_id },
      )
    } else if (telefoneParaEnvio && provider.sendText && !contactPhone) {
      const textoContato = `${prefixoEncaminhado}\n${contactName}`
      resultadoEnvio = await provider.sendText(telefoneParaEnvio, textoContato, {
        companyId: company_id,
        conversaId: conversa_id,
      })
    }
  } else if (tipoOriginal === 'location' && mensagemOriginal.location_meta) {
    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: `${prefixoEncaminhado}\n${mensagemOriginal.texto}`,
      tipo: 'location',
      url: mensagemOriginal.url,
      location_meta: mensagemOriginal.location_meta,
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio && provider.sendLocation && mensagemOriginal.location_meta) {
      const { latitude, longitude, nome, endereco } = mensagemOriginal.location_meta
      const addressParaCliente = usuarioNome
        ? `${usuarioNome} — ${[nome, endereco].filter(Boolean).join('\n') || `${latitude},${longitude}`}`
        : [nome, endereco].filter(Boolean).join('\n') || `${latitude},${longitude}`

      resultadoEnvio = await provider.sendLocation(telefoneParaEnvio, {
        address: addressParaCliente,
        lat: latitude,
        lng: longitude,
      }, {
        companyId: company_id,
        conversaId: conversa_id,
      })
    }
  } else {
    const textoFallback = mensagemOriginal.texto || '(mídia não suportada para encaminhamento)'
    const textoEncaminhado = `${prefixoEncaminhado}\n${textoFallback}`
    const textoComUsuario = usuarioNome ? `${textoEncaminhado}\n— ${usuarioNome}` : textoEncaminhado

    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: textoEncaminhado,
      tipo: 'texto',
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio && provider.sendText) {
      resultadoEnvio = await provider.sendText(telefoneParaEnvio, textoComUsuario, {
        companyId: company_id,
        conversaId: conversa_id,
      })
    }
  }

  const ok = resultadoEnvio === true || resultadoEnvio?.ok === true
  const waMessageId = (typeof resultadoEnvio === 'object' && resultadoEnvio?.messageId)
    ? String(resultadoEnvio.messageId).trim() : null
  const nextStatus = ok ? 'sent' : 'erro'

  await supabase
    .from('mensagens')
    .update({
      status: nextStatus,
      ...(isRealWhatsAppId(waMessageId) ? { whatsapp_id: waMessageId } : {}),
    })
    .eq('company_id', company_id)
    .eq('id', novaMensagem.id)

  await supabase
    .from('conversas')
    .update({ lida: true, ultima_atividade: timestamp })
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))

  if (io) {
    const msgParaEmissao = {
      ...novaMensagem,
      status: nextStatus,
      whatsapp_id: waMessageId || null,
      encaminhado: true,
    }
    const payload = await enrichMensagemComAutorUsuario(supabase, company_id, msgParaEmissao)
    emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', payload)

    const convPayload = { id: Number(conversa_id) }
    emitirConversaAtualizada(io, company_id, conversa_id, convPayload)
  }

  return {
    ok: true,
    mensagem: {
      ...novaMensagem,
      status: nextStatus,
      whatsapp_id: waMessageId || null,
      encaminhado: true,
    },
    enviado_whatsapp: ok,
  }
}

/**
 * Encaminha uma ou várias mensagens (texto ou mídia) para outra conversa.
 * Body: `mensagem_id` (único, compatível) ou `mensagem_ids` (array, ordem preservada).
 */
exports.encaminharMensagem = async (req, res) => {
  try {
    const { id: conversa_id } = req.params
    const { company_id, id: user_id } = req.user
    const { tipo_encaminhamento = 'auto' } = req.body

    const orderedIds = collectOrderedMessageIds(req.body)
    if (!orderedIds.length) {
      return res.status(400).json({ error: 'mensagem_id ou mensagem_ids é obrigatório' })
    }
    if (orderedIds.length > MAX_ENC_AMINHAR_LOTE) {
      return res.status(400).json({ error: `No máximo ${MAX_ENC_AMINHAR_LOTE} mensagens por encaminhamento` })
    }

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id, user_id })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const { data: mensagensRows, error: errMsg } = await supabase
      .from('mensagens')
      .select('id, texto, tipo, url, nome_arquivo, contact_meta, location_meta, conversa_id')
      .eq('company_id', company_id)
      .in('id', orderedIds)

    if (errMsg) {
      return res.status(500).json({ error: errMsg.message })
    }

    const byId = new Map((mensagensRows || []).map((m) => [Number(m.id), m]))
    const missing = orderedIds.filter((id) => !byId.has(id))
    if (missing.length) {
      return res.status(404).json({ error: `Mensagem(ns) não encontrada(s): ${missing.join(', ')}` })
    }

    // Buscar conversa de destino
    const { data: conversa } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, tipo, chat_lid')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .single()

    if (!conversa) {
      return res.status(404).json({ error: 'Conversa de destino não encontrada' })
    }

    // Resolver telefone real quando conversa tem apenas LID
    let telefoneParaEnvio = conversa.telefone || ''
    if (telefoneParaEnvio && String(telefoneParaEnvio).trim().toLowerCase().startsWith('lid:')) {
      if (conversa.cliente_id) {
        const { data: cli } = await supabase.from('clientes').select('telefone').eq('id', conversa.cliente_id).eq('company_id', company_id).maybeSingle()
        if (cli?.telefone && !String(cli.telefone).startsWith('lid:')) telefoneParaEnvio = cli.telefone
      }
      if (telefoneParaEnvio.startsWith('lid:') && conversa.chat_lid) {
        const { data: outra } = await supabase
          .from('conversas')
          .select('telefone')
          .eq('company_id', company_id)
          .eq('chat_lid', conversa.chat_lid)
          .not('telefone', 'like', 'lid:%')
          .limit(1)
          .maybeSingle()
        if (outra?.telefone) telefoneParaEnvio = outra.telefone
      }
      if (telefoneParaEnvio.startsWith('lid:')) {
        return res.status(400).json({ error: 'Número do contato indisponível (conversa por LID). Aguarde o contato enviar uma mensagem ou sincronize os contatos.' })
      }
    }

    const provider = getProvider()
    if (!provider) {
      return res.status(500).json({ error: 'Provider WhatsApp não configurado' })
    }

    const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, user_id)

    const io = req.app.get('io')
    const resultados = []
    for (let i = 0; i < orderedIds.length; i++) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 400))
      }
      const r = await encaminharUmaMensagemParaConversa({
        io,
        supabase,
        company_id,
        user_id,
        conversa_id,
        telefoneParaEnvio,
        provider,
        usuarioNome,
        mensagemOriginal: byId.get(orderedIds[i]),
        tipo_encaminhamento,
        timestamp: new Date(Date.now() + i * 50).toISOString(),
      })
      if (!r.ok) {
        resultados.push({ mensagem_id: orderedIds[i], ok: false, error: r.error, status: r.status })
        continue
      }
      resultados.push({
        mensagem_id: orderedIds[i],
        ok: true,
        mensagem: r.mensagem,
        enviado_whatsapp: r.enviado_whatsapp,
      })
    }

    if (orderedIds.length === 1) {
      const s0 = resultados[0]
      if (!s0.ok) {
        return res.status(s0.status || 500).json({ error: s0.error })
      }
      return res.json({
        success: true,
        mensagem: s0.mensagem,
        enviado_whatsapp: s0.enviado_whatsapp,
      })
    }

    return res.json({
      success: resultados.every((x) => x.ok),
      encaminhamentos: resultados,
      total: resultados.length,
    })

  } catch (error) {
    console.error('Erro ao encaminhar mensagem:', error)
    return res.status(500).json({ error: 'Erro ao encaminhar mensagem' })
  }
}
