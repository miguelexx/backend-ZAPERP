const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { getStatus } = require('../services/zapiIntegrationService')
const { isGroupConversation } = require('../helpers/conversaHelper')
const { normalizePhoneBR, possiblePhonesBR, phoneKeyBR } = require('../helpers/phoneHelper')
const { deduplicateConversationsByContact, sortConversationsByRecent, getCanonicalPhone, getOrCreateCliente } = require('../helpers/conversationSync')
const { chooseBestName } = require('../helpers/contactEnrichment')

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
      .select('id, nome_contato_cache, foto_perfil_contato_cache, ultima_atividade')
      .eq('company_id', company_id)
      .eq('id', cid)
      .maybeSingle()
      .then(({ data: conv }) => {
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

function emitirEventoEmpresaConversa(io, company_id, conversa_id, eventName, payload) {
  if (!io) return

  if (conversa_id) {
    io.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).emit(eventName, payload)
    return
  }
  io.to(`empresa_${company_id}`).emit(eventName, payload)
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

async function assertPermissaoConversa({ company_id, conversa_id, user_id, role, user_dep_id }) {
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
  if (r === 'admin') return { ok: true, conv }

  // supervisor: conversas sem setor visíveis para TODOS; com setor só mesmo setor
  if (r === 'supervisor') {
    if (!isGroup) {
      const convDep = conv.departamento_id ?? null
      const userDep = user_dep_id ?? null
      if (userDep == null && convDep != null) return { ok: false, status: 403, error: 'Conversa de outro setor' }
      // convDep == null: qualquer usuário pode ver conversas sem setor
      if (userDep != null && convDep != null && Number(convDep) !== Number(userDep)) return { ok: false, status: 403, error: 'Conversa de outro setor' }
    }
    return { ok: true, conv }
  }

  // atendente: pode conversar com TODOS os contatos — assumir, transferir, responder em qualquer conversa
  if (r === 'atendente') return { ok: true, conv }

  // fallback: perfis desconhecidos permitem acesso (comportamento padrão para atendimento)
  return { ok: true, conv }
}

/**
 * Verifica se o usuário pode ENVIAR mensagens na conversa.
 * Regras (otimizado para chatbot + atendimento humano):
 * - Quem ASSUMIU (atendente_id === user_id) pode enviar.
 * - Conversa em fila (atendente_id === null): qualquer usuário autenticado da empresa pode enviar
 *   — permite respostas via painel durante triagem, chatbots e fluxos automatizados antes de assumir.
 * - Conversa assumida por OUTRO usuário: bloqueia (evita conflito entre atendentes).
 */
async function assertPodeEnviarMensagem({ company_id, conversa_id, user_id }) {
  const { data: conv, error } = await supabase
    .from('conversas')
    .select('id, atendente_id')
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!conv) return { ok: false, status: 404, error: 'Conversa não encontrada' }

  if (conv.atendente_id != null && Number(conv.atendente_id) === Number(user_id)) return { ok: true }
  if (conv.atendente_id == null) return { ok: true }

  return { ok: false, status: 403, error: 'Assuma a conversa antes de enviar mensagens. Clique em "Assumir" para continuar.' }
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
 * Incrementa unread para todos os usuários da empresa quando chega mensagem de entrada (in).
 * Roda em background para não bloquear o webhook.
 *
 * Usa RPC `increment_conversa_unreads` para operação atômica com
 * INSERT ... ON CONFLICT DO UPDATE SET unread_count = unread_count + 1.
 * Isso evita a race condition de read-modify-write quando duas mensagens chegam
 * simultaneamente e o contador não seria incrementado corretamente.
 *
 * A função RPC deve existir no banco (migration 20250225000000_production_hardening.sql).
 * Fallback para o método leitura-escrita se o RPC não existir ainda.
 */
async function incrementarUnreadParaConversa(company_id, conversa_id) {
  try {
    const { data: usuarios } = await supabase
      .from('usuarios')
      .select('id')
      .eq('company_id', Number(company_id))
      .eq('ativo', true)
    if (!Array.isArray(usuarios) || usuarios.length === 0) return

    const cid = Number(company_id)
    const convId = Number(conversa_id)
    const usuarioIds = usuarios.map((u) => Number(u.id))

    // Tenta o RPC atômico primeiro
    const { error: rpcErr } = await supabase.rpc('increment_conversa_unreads', {
      p_company_id: cid,
      p_conversa_id: convId,
      p_usuario_ids: usuarioIds,
    })

    if (!rpcErr) return

    // Fallback: se o RPC não existir no banco ainda (PGRST202 = function not found),
    // usa o método leitura-escrita. Não é atômico mas funciona para volumes normais.
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

/**
 * Marca a conversa como lida para TODOS os usuários da empresa (zera notificação).
 * Usado quando a mensagem é visualizada no celular (Z-API envia read/played): a notificação
 * de mensagem nova deve sumir no sistema para todos.
 */
async function marcarConversaComoLidaParaTodos(company_id, conversa_id) {
  const cid = Number(company_id)
  const convId = Number(conversa_id)
  if (!cid || !convId) return
  try {
    await supabase
      .from('conversa_unreads')
      .update({ unread_count: 0, updated_at: new Date().toISOString() })
      .eq('company_id', cid)
      .eq('conversa_id', convId)
    await supabase
      .from('conversas')
      .update({ lida: true })
      .eq('company_id', cid)
      .eq('id', convId)
  } catch (e) {
    console.warn('marcarConversaComoLidaParaTodos:', e?.message || e)
  }
}

exports.incrementarUnreadParaConversa = incrementarUnreadParaConversa
exports.marcarConversaComoLidaParaTodos = marcarConversaComoLidaParaTodos

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
  const { error } = await supabase.from('atendimentos').insert({
    conversa_id: Number(conversa_id),
    company_id: Number(company_id),
    acao,
    de_usuario_id: de_usuario_id != null ? Number(de_usuario_id) : null,
    para_usuario_id: para_usuario_id != null ? Number(para_usuario_id) : null,
    observacao
  })
  return error
}

// =====================================================
// 3) listarConversas (com unread_count + pesquisa avançada)
// Query: tag_id, data_inicio, data_fim, status_atendimento, atendente_id, palavra
// =====================================================
exports.listarConversas = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_id: user_dep_id } = req.user
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
      incluir_todos_clientes: incluirTodosClientes
    } = req.query

    const unreadMap = await obterUnreadMap({ company_id, usuario_id: user_id })

    let conversaIdsFilter = null

    if (tag_id) {
      const { data: tagRows } = await supabase
        .from('conversa_tags')
        .select('conversa_id')
        .eq('company_id', company_id)
        .eq('tag_id', tag_id)
      const ids = (tagRows || []).map((r) => r.conversa_id)
      if (ids.length === 0) return res.json([])
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
      if (merged.length === 0) return res.json([])
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
      clientes!conversas_cliente_fk ( id, nome, pushname, telefone, foto_perfil ),
      departamentos ( id, nome ),
      mensagens ( texto, criado_em, direcao, tipo, url, nome_arquivo, whatsapp_id, status ),
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
      clientes!conversas_cliente_fk ( id, nome, pushname, telefone, foto_perfil ),
      departamentos ( id, nome ),
      mensagens ( texto, criado_em, direcao, tipo, url, nome_arquivo, whatsapp_id, status ),
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
      clientes!conversas_cliente_fk ( id, nome, pushname, telefone, foto_perfil ),
      departamentos ( id, nome ),
      mensagens ( texto, criado_em, direcao, tipo, url, nome_arquivo, whatsapp_id, status )
    `

    function buildQuery(select) {
      let q = supabase
        .from('conversas')
        .select(select)
        .eq('company_id', company_id)
      // Filtro por setor: conversas sem setor visíveis para TODOS os usuários.
      // Admin vê todas. Supervisor/atendente: com setor → seu setor + conversas sem setor + grupos;
      // sem setor → conversas sem setor + grupos.
      if (!isAdmin) {
        if (user_dep_id != null) {
          q = q.or(`departamento_id.eq.${user_dep_id},departamento_id.is.null,tipo.eq.grupo`)
        } else {
          q = q.or(`departamento_id.is.null,tipo.eq.grupo`)
        }
      } else if (filter_dep_id) {
        q = q.eq('departamento_id', Number(filter_dep_id))
      }
      if (conversaIdsFilter && conversaIdsFilter.length > 0) {
        q = q.in('id', conversaIdsFilter)
      }
      if (status_atendimento) q = q.eq('status_atendimento', status_atendimento)
      // Atendente: vê TODAS as conversas (pode assumir, transferir, responder qualquer uma)
      // Admin/supervisor: filtro opcional por atendente_id
      if (!isAtendente && atendente_id) q = q.eq('atendente_id', Number(atendente_id))
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

    let conversasFormatadas = (data || []).map((c) => {
      const raw = c.clientes
      let clientesObj = Array.isArray(raw)
        ? (raw.find((cl) => cl && Number(cl.id) === Number(c.cliente_id)) || raw[0])
        : raw
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

      // Prioridade: nome (contato do celular) > pushname (perfil WhatsApp)
      const nomeCliente = (clientesObj?.nome ?? clientesObj?.pushname ?? null) && String(clientesObj?.nome ?? clientesObj?.pushname ?? '').trim() ? String(clientesObj?.nome ?? clientesObj?.pushname ?? '').trim() : null
      const fotoCliente = clientesObj?.foto_perfil ?? null
      const isGroup = isGroupConversation(c)
      const ultimaMsg = Array.isArray(c.mensagens) && c.mensagens.length > 0 ? c.mensagens[0] : null
      // Nunca exibir LID (lid:xxx) como nome ou número — é identificador interno do WhatsApp
      const isLid = !isGroup && c.telefone && String(c.telefone).trim().toLowerCase().startsWith('lid:')
      const telefoneExibivel = isLid ? null : c.telefone
      const contatoNome = isGroup
        ? (c.nome_grupo || (c.telefone && !String(c.telefone).startsWith('lid:') ? c.telefone : null) || 'Grupo')
        : (
            // Para contatos individuais, o campo de nome **nunca** cai para o telefone.
            // Se não houver nome conhecido, deixamos null e o front decide como exibir
            // (por exemplo, usando telefone_exibivel).
            nomeCliente ||
            (c.nome_contato_cache && String(c.nome_contato_cache).trim()) ||
            null
          )
      const fotoPerfil = isGroup ? null : (fotoCliente ?? (c.foto_perfil_contato_cache && String(c.foto_perfil_contato_cache).trim()) ?? null)
      const unreadCount = unreadMap[Number(c.id)] || 0
      return {
        id: c.id,
        cliente_id: c.cliente_id,
        telefone: c.telefone,
        telefone_exibivel: telefoneExibivel,
        status_atendimento: c.status_atendimento,
        atendente_id: c.atendente_id,
        lida: unreadCount === 0,
        tem_novas_mensagens: unreadCount > 0,
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

    // Incluir todos os clientes: quem não tem conversa aparece como "Sem conversa" (clicável para abrir)
    const incluirTodos = incluirTodosClientes === '1' || incluirTodosClientes === 'true' || incluirTodosClientes === 1
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
        contato_nome: cl.nome || cl.pushname || cl.telefone || null,
        foto_perfil: cl.foto_perfil || null,
        sem_conversa: true,
        mensagens: [],
        unread_count: 0,
        tags: [],
        status_atendimento: null,
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

    return res.json(conversasFormatadas)
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

    const { mergeConversasIntoCanonico } = require('../helpers/conversationSync')

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
// 3a) Status da conexão Z-API (instância conectada?)
// GET /chats/zapi-status — status para banner "WhatsApp conectado/desconectado"
// Usa empresa_zapi por company_id (JWT). NUNCA ENV.
// Sem empresa_zapi → 200 { hasInstance:false, connected:false, configured:false }
// =====================================================
exports.zapiStatus = async (req, res) => {
  try {
    const company_id = req.user?.company_id
    if (process.env.WHATSAPP_PROVIDER !== 'zapi') {
      return res.json({ ok: true, hasInstance: false, connected: false, configured: false })
    }
    if (!company_id) {
      return res.json({ ok: true, hasInstance: false, connected: false, configured: false })
    }

    const { getEmpresaZapiConfig, getStatus } = require('../services/zapiIntegrationService')
    const configResult = await getEmpresaZapiConfig(company_id)
    if (configResult.error || !configResult.config) {
      return res.json({ ok: true, hasInstance: false, connected: false, configured: false })
    }

    const statusResult = await getStatus(company_id)
    const connected = !!statusResult?.connected
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
    console.error('zapiStatus:', err?.message || err)
    return res.json({ ok: true, hasInstance: false, connected: false, configured: false })
  }
}

// =====================================================
// 3b) Sincronizar contatos do celular (Z-API Get contacts)
// Busca TODOS os contatos do WhatsApp (paginado) e persiste em clientes.
// USA SEMPRE o provider Z-API (empresa_zapi) — independente de WHATSAPP_PROVIDER.
// =====================================================
exports.sincronizarContatosZapi = async (req, res) => {
  try {
    const { company_id } = req.user
    if (!company_id) {
      return res.status(401).json({ error: 'Não autenticado' })
    }
    const { getEmpresaZapiConfig } = require('../services/zapiIntegrationService')
    const { config, error } = await getEmpresaZapiConfig(company_id)
    if (error || !config) {
      return res.status(400).json({ error: 'Empresa sem instância Z-API configurada. Conecte o WhatsApp em Integrações.' })
    }
    const zapiProvider = require('../services/providers/zapi')
    if (!zapiProvider || !zapiProvider.getContacts) {
      return res.status(501).json({ error: 'Z-API getContacts não disponível.' })
    }

    const pageSize = 250
    const maxPages = 120
    let page = 1
    let total = 0
    let atualizados = 0
    let criados = 0

    console.log(`[Sync Contatos] Iniciando para company ${company_id} (pageSize=${pageSize})`)

    while (page <= maxPages) {
      const contacts = await zapiProvider.getContacts(page, pageSize, { companyId: company_id })
      if (!Array.isArray(contacts) || contacts.length === 0) break

      if (page === 1) {
        console.log(`[Sync Contatos] Primeira página: ${contacts.length} contatos recebidos`)
        if (contacts[0]) {
          const sample = contacts[0]
          console.log('[Sync Contatos] Exemplo estrutura:', JSON.stringify({
            keys: Object.keys(sample),
            phone: sample.phone,
            id: sample.id,
            wa_id: sample.wa_id,
            jid: typeof sample.jid === 'string' ? sample.jid.slice(0, 30) : sample.jid
          }))
        }
      }

      for (const c of contacts) {
        // Z-API pode enviar phone, id, wa_id ou jid; id/jid vêm como "5511999999999@s.whatsapp.net"
        let rawPhone = String(c.phone ?? c.wa_id ?? c.id ?? c.jid ?? '').trim()
        if (rawPhone.includes('@')) rawPhone = rawPhone.replace(/@.*$/, '').trim()
        if (!rawPhone) continue

        let phone = normalizePhoneBR(rawPhone)
        if (!phone) {
          const digits = rawPhone.replace(/\D/g, '')
          if (digits.length >= 10 && digits.length <= 13) {
            phone = digits.startsWith('55') && (digits.length === 12 || digits.length === 13)
              ? digits
              : (digits.length === 10 || digits.length === 11 ? '55' + digits : null)
          }
        }
        // Só aceita números BR válidos (55 + DDD + número)
        if (!phone || !phone.startsWith('55') || (phone.length !== 12 && phone.length !== 13)) continue
        total++

        const nome = (c.name || c.short || c.notify || c.vname || '').trim() || null
        const nomeFinal = nome || phone
        const pushname = (c.notify || '').trim() || null
        const imgUrl = (c.imgUrl || c.photo || c.profilePicture || '').trim() || null

        const phones = possiblePhonesBR(phone)

        let existenteQuery = supabase.from('clientes').select('id, nome, pushname, foto_perfil, telefone')
        if (phones.length > 0) existenteQuery = existenteQuery.in('telefone', phones)
        else existenteQuery = existenteQuery.eq('telefone', phone)
        existenteQuery = existenteQuery.eq('company_id', Number(company_id))
        const { data: existentes } = await existenteQuery.order('id', { ascending: true }).limit(10)
        const rows = Array.isArray(existentes) ? existentes : (existentes ? [existentes] : [])
        let existente = null
        if (rows.length > 0) {
          existente = rows.find(r => String(r.telefone || '') === phone) || rows[0]
        }

        // Se encontrou duplicatas (mesmo número com/sem 9), mescla no registro canônico.
        if (existente?.id && rows.length > 1) {
          const canonId = existente.id
          const dupIds = rows.map(r => r.id).filter(id => id !== canonId)
          if (dupIds.length > 0) {
            // Apontar conversas para o cliente canônico e remover duplicados (melhora lista e evita "duas pessoas iguais").
            await supabase.from('conversas').update({ cliente_id: canonId }).eq('company_id', Number(company_id)).in('cliente_id', dupIds)
            await supabase.from('clientes').delete().eq('company_id', Number(company_id)).in('id', dupIds)
          }
        }

        if (existente?.id) {
          const updates = {}
          const nomeExistente = (existente?.nome || '').trim()
          const pushExistente = (existente?.pushname || '').trim()
          const missingName = !nomeExistente || nomeExistente === (existente?.telefone || '').trim()

          // chooseBestName evita regressão: nunca substituir nome bom por pior
          if (nome && String(nome).trim()) {
            const telefoneTail = String(phone).replace(/\D/g, '').slice(-6) || null
            const { name: bestNome } = chooseBestName(nomeExistente, String(nome).trim(), 'syncZapi', { fromMe: false, company_id, telefoneTail })
            if (bestNome && bestNome !== nomeExistente) updates.nome = bestNome
          } else if (missingName) updates.nome = phone // sem nome → usa número, mas só se estava vazio

          // pushname só se veio e o banco está vazio (ou null)
          if (pushname != null && String(pushname).trim() && !pushExistente) updates.pushname = String(pushname).trim()

          // foto só se veio uma válida; não remover foto existente
          if (imgUrl != null && String(imgUrl).trim().startsWith('http')) updates.foto_perfil = String(imgUrl).trim()

          if (Object.keys(updates).length > 0) {
            let upd = await supabase.from('clientes').update(updates).eq('id', existente.id)
            if (upd.error && String(upd.error.message || '').includes('pushname')) {
              delete updates.pushname
              if (Object.keys(updates).length > 0) upd = await supabase.from('clientes').update(updates).eq('id', existente.id)
            }
            if (!upd.error) atualizados++
          }
        } else {
          const { cliente_id: cid } = await getOrCreateCliente(supabase, company_id, phone, {
            nome: nomeFinal || phone,
            nomeSource: 'syncZapi',
            pushname: pushname || undefined,
            foto_perfil: imgUrl || undefined
          })
          if (cid) criados++
        }
      }

      if (contacts.length < pageSize) break
      page++
    }

    console.log(`[Sync Contatos] Concluído: ${total} processados, ${criados} novos, ${atualizados} atualizados`)

    // Emite para outras abas/clientes da empresa atualizarem a lista
    const io = req.app?.get('io')
    if (io && company_id) {
      io.to(`empresa_${company_id}`).emit('zapi_sync_contatos', { criados, atualizados, total_contatos: total })
    }

    return res.json({
      ok: true,
      total_contatos: total,
      criados,
      atualizados
    })
  } catch (err) {
    console.error('sincronizarContatosZapi:', err)
    return res.status(500).json({ error: 'Erro ao sincronizar contatos' })
  }
}

// =====================================================
// 3c) Sincronizar fotos de perfil de todos os clientes (Z-API Get profile-picture)
// =====================================================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

exports.sincronizarFotosPerfilZapi = async (req, res) => {
  try {
    const { company_id } = req.user
    const provider = getProvider()
    if (!provider || !provider.isConfigured || (!provider.getProfilePicture && !provider.getContactMetadata)) {
      return res.status(501).json({ error: 'Sincronização de fotos disponível apenas com Z-API configurado.' })
    }

    const cid = Number(company_id)

    const statusResult = await getStatus(cid)
    if (!statusResult?.connected) {
      return res.status(503).json({
        error: 'Z-API não está conectada ao WhatsApp. Conecte o WhatsApp primeiro e tente novamente.'
      })
    }
    const limit = Math.min(3000, Math.max(1, Number(req.query.limit) || 2000))
    const delayMs = Math.min(1200, Math.max(0, Number(req.query.delay_ms) || 220))

    const forceAll = req.query.force === '1' || req.query.force === 'true'

    let q = supabase
      .from('clientes')
      .select('id, telefone, nome, pushname, foto_perfil')
      .eq('company_id', cid)
      .not('telefone', 'is', null)
      .limit(limit)
    // Sem force=1: prioriza registros incompletos; mas SEMPRE inclui quem tem foto
    // (URLs do WhatsApp CDN expiram → precisamos refrescar a URL mesmo quando existe)
    if (!forceAll) {
      q = q.or('foto_perfil.is.null,foto_perfil.eq.,nome.is.null,nome.eq.,pushname.is.null,pushname.eq.,foto_perfil.like.https://%')
    }
    const { data: clientes, error: errList } = await q

    if (errList) return res.status(500).json({ error: errList.message })
    if (!clientes || clientes.length === 0) {
      return res.json({ ok: true, total: 0, atualizados: 0, erros: 0 })
    }

    let atualizados = 0
    let erros = 0
    let semFoto = 0
    let nomeAtualizado = 0
    let fotoAtualizada = 0
    const exemplosErros = []

    for (const cl of clientes) {
      const phone = (cl.telefone || '').trim().replace(/\D/g, '')
      if (!phone) continue
      try {
        const nomeDb = String(cl.nome || '').trim()
        const pushDb = String(cl.pushname || '').trim()
        const fotoDb = String(cl.foto_perfil || '').trim()
        const missingName = !nomeDb || nomeDb === phone
        const missingFoto = !fotoDb || fotoDb.toLowerCase() === 'null' || fotoDb.toLowerCase() === 'undefined'

        const [meta, fotoUrl] = await Promise.all([
          provider.getContactMetadata ? provider.getContactMetadata(phone, { companyId: cid }) : Promise.resolve(null),
          provider.getProfilePicture ? provider.getProfilePicture(phone, { companyId: cid }) : Promise.resolve(null)
        ])

        const metaNome = String(meta?.name || meta?.short || meta?.notify || meta?.vname || '').trim()
        const metaPush = String(meta?.notify || '').trim()
        const metaImgRaw = String(meta?.imgUrl || meta?.photo || meta?.profilePicture || '').trim()
        const metaImg = metaImgRaw && metaImgRaw.startsWith('http') ? metaImgRaw : null
        const fotoFinal = (fotoUrl && String(fotoUrl).trim().startsWith('http') ? String(fotoUrl).trim() : null) || metaImg

        const updates = {}

        // nome/pushname: use chooseBestName para evitar regressão (nunca substituir nome bom por pior)
        if (missingName || metaNome) {
          const candidate = metaNome || (missingName ? phone : null)
          const { name: bestNome } = chooseBestName(
            nomeDb || null,
            candidate,
            'syncZapi',
            { fromMe: false, company_id: cid, telefoneTail: phone.slice(-6) }
          )
          if (bestNome && bestNome !== (nomeDb || '')) {
            updates.nome = bestNome
            if (bestNome !== phone) nomeAtualizado++
          } else if (missingName) {
            updates.nome = phone
          }
        }
        if (!pushDb && metaPush) {
          updates.pushname = metaPush
        }

        // Sempre atualiza foto quando Z-API retorna URL válida
        // (URLs do WhatsApp CDN expiram; sempre usar a URL mais recente)
        if (fotoFinal) {
          updates.foto_perfil = fotoFinal
          fotoAtualizada++
        } else if (missingFoto) {
          semFoto++
        }

        if (Object.keys(updates).length > 0) {
          let upd = await supabase.from('clientes').update(updates).eq('id', cl.id).eq('company_id', cid)
          if (upd.error && String(upd.error.message || '').includes('pushname')) {
            delete updates.pushname
            if (Object.keys(updates).length > 0) upd = await supabase.from('clientes').update(updates).eq('id', cl.id).eq('company_id', cid)
          }
          if (!upd.error) {
            atualizados++
            // Atualiza cache nas conversas vinculadas (nome_contato_cache, foto_perfil_contato_cache)
            const cacheUpdates = {}
            if (updates.nome) cacheUpdates.nome_contato_cache = updates.nome
            if (updates.foto_perfil) cacheUpdates.foto_perfil_contato_cache = updates.foto_perfil
            if (Object.keys(cacheUpdates).length > 0) {
              supabase.from('conversas').update(cacheUpdates).eq('cliente_id', cl.id).eq('company_id', cid).select('id').then(({ data }) => {
                // Emite via socket para atualizar UI em tempo real (empresa específica)
                const io = req.app?.get('io')
                if (io && Array.isArray(data) && data.length > 0) {
                  for (const row of data) {
                    io.to(`empresa_${cid}`).emit('conversa_atualizada', { id: row.id, ...cacheUpdates })
                    io.to(`empresa_${cid}`).emit('atualizar_conversa', { id: row.id })
                  }
                }
              }).catch(() => {})
            }
          } else {
            erros++
            if (exemplosErros.length < 10) exemplosErros.push({ id: cl.id, telefone: phone.slice(-6), erro: upd.error.message })
          }
        }
      } catch (e) {
        if (e?.code === 'ZAPI_NOT_CONNECTED') {
          console.warn('sincronizarFotosPerfilZapi: Z-API desconectou durante a sincronização')
          return res.json({
            ok: true,
            total: clientes.length,
            atualizados,
            nome_atualizado: nomeAtualizado,
            foto_atualizada: fotoAtualizada,
            sem_foto: semFoto,
            erros,
            exemplos_erros: exemplosErros,
            interrompido: 'Z-API desconectou durante a sincronização. Tente novamente quando estiver conectado.'
          })
        }
        erros++
        if (exemplosErros.length < 10) exemplosErros.push({ id: cl.id, telefone: phone.slice(-6), erro: 'exception' })
      }
      await sleep(delayMs)
    }

    return res.json({
      ok: true,
      total: clientes.length,
      atualizados,
      nome_atualizado: nomeAtualizado,
      foto_atualizada: fotoAtualizada,
      sem_foto: semFoto,
      erros,
      exemplos_erros: exemplosErros
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

// Rotas não registradas em chatRoutes; responsável = use assumir/transferir
exports.atualizarOrigem = async (req, res) => {
  return res.status(501).json({ error: 'Atualizar origem não implementado; use Supabase se precisar.' })
}

exports.atualizarResponsavel = async (req, res) => {
  return res.status(501).json({ error: 'Use POST /chats/:id/assumir ou POST /chats/:id/transferir para responsável.' })
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
        contato_nome: cliente.nome || cliente.pushname || conversaExistente.telefone,
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
      contato_nome: cliente.nome || cliente.pushname || novaConversa.telefone,
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

// =====================================================
// 6) CRIAR CONTATO (cliente + conversa)
// =====================================================
exports.criarContato = async (req, res) => {
  try {
    const io = req.app.get('io')
    const { company_id, id: usuario_id } = req.user
    const { nome, telefone } = req.body

    const telefoneCanonico = getCanonicalPhone(telefone) || String(telefone || '').trim()
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
          nome,
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
    const { company_id, id: user_id, perfil, departamento_id: user_dep_id } = req.user
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
        clientes!conversas_cliente_fk ( id, nome, pushname, telefone, observacoes, foto_perfil ),
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
    // Visibilidade: conversas sem setor visíveis para TODOS; com setor só para usuários do mesmo setor
    // Atendente: acesso total às conversas que vê na lista (seu setor + sem setor) — pode abrir para assumir/transferir
    if (!isAdmin && !isGroup) {
      const convDep = conversa.departamento_id ?? null
      const userDep = user_dep_id ?? null
      if (userDep == null && convDep != null) {
        return res.status(403).json({ error: 'Conversa pertence a um setor; usuários sem setor não podem acessá-la' })
      }
      // convDep == null: qualquer usuário pode ver conversas sem setor
      if (userDep != null && convDep != null && Number(convDep) !== Number(userDep)) {
        return res.status(403).json({ error: 'Conversa de outro setor' })
      }
    }

    // Bloqueia visão das mensagens quando a conversa está assumida por outro usuário
    // (apenas admin e supervisor podem ver; atendente que não assumiu não vê o conteúdo)
    const isSupervisor = role === 'supervisor'
    const conversaAssumidaPorOutro = conversa.atendente_id != null && Number(conversa.atendente_id) !== Number(user_id)
    const deveBloquearMensagens = !isGroup && conversaAssumidaPorOutro && !isAdmin && !isSupervisor

    // mensagens paginadas (remetente_nome/remetente_telefone para grupos; fallback se colunas não existirem)
    const selectComRemetente = 'id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo, reply_meta, remetente_nome, remetente_telefone'
    const selectBasico = 'id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo, reply_meta'
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
    // Compatibilidade: se reply_meta/remetente_* não existirem ainda no banco, refaz select sem essas colunas.
    if (errMsgs && (String(errMsgs.message || '').includes('reply_meta') || String(errMsgs.message || '').includes('remetente_nome') || String(errMsgs.message || '').includes('remetente_telefone') || String(errMsgs.message || '').includes('does not exist'))) {
      query = supabase
        .from('mensagens')
        .select(selectBasico)
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
    const clientesConv = Array.isArray(rawClientes)
      ? (rawClientes.find((cl) => cl && Number(cl.id) === Number(conversa.cliente_id)) || rawClientes[0])
      : rawClientes
    // Nunca exibir LID (lid:xxx) como nome ou número — identificador interno do WhatsApp
    const isLidConv = !isGroup && conversa.telefone && String(conversa.telefone).trim().toLowerCase().startsWith('lid:')
    // Prioridade: nome (contato do celular) > pushname (perfil WhatsApp)
    const clienteNomeBase = clientesConv?.nome ?? clientesConv?.pushname ?? null
    const clienteNome = (clienteNomeBase && String(clienteNomeBase).trim()) ? String(clienteNomeBase).trim() : null
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
    const conversaFormatada = {
      ...conversa,
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
      mensagens: (mensagens || []).reverse(),
      next_cursor: mensagens?.length ? mensagens[mensagens.length - 1].criado_em : null,
      mensagens_bloqueadas: deveBloquearMensagens || undefined
    }

    // ✅ emite SOMENTE mensagens_lidas (não dispara atualizar lista ao abrir)
    const io = req.app.get('io')
    if (io) {
      const payload = { conversa_id: Number(id), usuario_id: Number(user_id) }
      emitirParaUsuario(io, user_id, io.EVENTS?.MENSAGENS_LIDAS || 'mensagens_lidas', payload)
    }

    // Background: re-sincroniza foto e nome do contato com Z-API
    // As URLs do WhatsApp CDN expiram (tipicamente em poucas horas), por isso
    // sempre buscamos uma URL fresca ao abrir uma conversa, sem bloquear a resposta.
    if (!isGroup && clientesConv?.id && clientesConv?.telefone) {
      const cliId = Number(clientesConv.id)
      const cliPhone = String(clientesConv.telefone || '').trim()
      const cid = Number(company_id)
      if (cliPhone && !cliPhone.startsWith('lid:') && !cliPhone.includes('@g.us')) {
        setImmediate(async () => {
          try {
            const { syncContactFromZapi } = require('../services/zapiSyncContact')
            const synced = await syncContactFromZapi(cliPhone, cid)
            if (!synced) return
            const updates = {}
            if (synced.foto_perfil && String(synced.foto_perfil).startsWith('http')) {
              updates.foto_perfil = synced.foto_perfil
            }
            if (synced.pushname && String(synced.pushname).trim()) {
              updates.pushname = String(synced.pushname).trim()
            }
            if (Object.keys(updates).length === 0) return
            const { error: updErr } = await supabase
              .from('clientes')
              .update(updates)
              .eq('company_id', cid)
              .eq('id', cliId)
            if (!updErr && io && (updates.foto_perfil || updates.pushname)) {
              const { data: cli } = await supabase.from('clientes').select('nome, pushname, telefone, foto_perfil').eq('id', cliId).eq('company_id', cid).maybeSingle()
              io.to(`empresa_${cid}`).emit('contato_atualizado', {
                conversa_id: Number(id),
                contato_nome: cli?.nome || cli?.pushname || cliPhone,
                telefone: cli?.telefone || cliPhone,
                foto_perfil: cli?.foto_perfil || updates.foto_perfil
              })
            }
          } catch (_) {}
        })
      }
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
    const { company_id, id: user_id, perfil, departamento_id: user_dep_id } = req.user
    const { id: conversa_id } = req.params
    const isAdmin = perfil === 'admin'

    const { data: atual, error: errAtual } = await supabase
      .from('conversas')
      .select('id, atendente_id, departamento_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .single()

    if (errAtual) return res.status(500).json({ error: errAtual.message })
    if (!atual) return res.status(404).json({ error: 'Conversa não encontrada' })

    // Permissão por setor: conversas sem setor assumíveis por TODOS; com setor só mesmo setor
    if (!isAdmin) {
      const convDep = atual.departamento_id ?? null
      const userDep = user_dep_id ?? null
      if (userDep == null && convDep != null) {
        return res.status(403).json({ error: 'Conversa pertence a um setor; atribua-se a um setor para assumir' })
      }
      // convDep == null: qualquer usuário pode assumir conversas sem setor
      if (userDep != null && convDep != null && Number(convDep) !== Number(userDep)) {
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

    const errAt = await registrarAtendimento({
      conversa_id,
      company_id,
      acao: 'assumiu',
      de_usuario_id: user_id,
      para_usuario_id: user_id
    })
    if (errAt) return res.status(500).json({ error: errAt.message })

    const io = req.app.get('io')
    if (io) {
      // Payload completo para todos atualizarem lista (atendente_id, atendente_atribuido_em) em tempo real
      emitirConversaAtualizada(io, company_id, conversa_id, data)
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
    const { company_id, id: user_id, perfil, departamento_id: user_dep_id } = req.user
    const { id: conversa_id } = req.params

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_id })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    const { data, error } = await supabase
      .from('conversas')
      .update({ status_atendimento: 'fechada' })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })

    const errAt = await registrarAtendimento({
      conversa_id,
      company_id,
      acao: 'encerrou',
      de_usuario_id: user_id
    })
    if (errAt) return res.status(500).json({ error: errAt.message })

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.CONVERSA_ENCERRADA || 'conversa_encerrada',
        data
      )
      emitirLock(io, conversa_id, null)
      emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id) })
    }

    return res.json({ ok: true, conversa: data })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao encerrar conversa' })
  }
}

exports.reabrirChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_id: user_dep_id } = req.user
    const { id: conversa_id } = req.params

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_id })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    const { data, error } = await supabase
      .from('conversas')
      .update({ status_atendimento: 'aberta' })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })

    const errAt = await registrarAtendimento({
      conversa_id,
      company_id,
      acao: 'reabriu',
      de_usuario_id: user_id
    })
    if (errAt) return res.status(500).json({ error: errAt.message })

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.CONVERSA_REABERTA || 'conversa_reaberta',
        data
      )
      emitirLock(io, conversa_id, null)

      emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id) })
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
    const { company_id, id: user_id, perfil, departamento_id: user_dep_id } = req.user
    const { id: conversa_id } = req.params
    const { para_usuario_id, observacao } = req.body

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_id })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    if (!para_usuario_id) {
      return res.status(400).json({ error: 'para_usuario_id é obrigatório' })
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

    const errAt = await registrarAtendimento({
      conversa_id,
      company_id,
      acao: 'transferiu',
      de_usuario_id: user_id,
      para_usuario_id,
      observacao
    })
    if (errAt) return res.status(500).json({ error: errAt.message })

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.CONVERSA_TRANSFERIDA || 'conversa_transferida',
        data
      )
      emitirLock(io, conversa_id, para_usuario_id)

      emitirParaUsuario(io, para_usuario_id, io.EVENTS?.CONVERSA_ATRIBUIDA || 'conversa_atribuida', {
        conversa_id: Number(conversa_id)
      })
      emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id) })
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
    const { company_id, id: user_id, perfil, departamento_id: user_dep_id } = req.user
    const { id: conversa_id } = req.params
    const { departamento_id: novo_departamento_id, remover_setor } = req.body

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_id })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

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
      const payload = { id: Number(conversa_id), departamento_id: departamentoIdFinal, setor: remover ? null : novoDep.nome }
      emitirConversaAtualizada(io, company_id, conversa_id, payload)
      emitirLock(io, conversa_id, null)
      if (depAntigoId != null) {
        emitirDepartamento(io, depAntigoId, io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada', payload)
      }
      if (departamentoIdFinal != null) {
        emitirDepartamento(io, departamentoIdFinal, io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada', payload)
      }
      io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: Number(conversa_id) })
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
        // Enriquecer em background com dados reais da Z-API (nome, foto do WhatsApp)
        const { syncContactFromZapi } = require('../services/zapiSyncContact')
        setImmediate(() => {
          supabase.from('clientes').select('nome, pushname, foto_perfil').eq('id', novoClienteId).eq('company_id', company_id).maybeSingle()
            .then(({ data: current }) => syncContactFromZapi(conversa.telefone, company_id)
              .then((synced) => {
                if (!synced) return null
                const up = {}
                const telefoneTail = String(conversa.telefone).replace(/\D/g, '').slice(-6) || null
                const { name: bestNome } = chooseBestName(current?.nome, synced.nome, 'syncZapi', { fromMe: false, company_id, telefoneTail })
                if (bestNome && bestNome !== (current?.nome || '')) up.nome = bestNome
                if (synced.pushname !== undefined && !current?.pushname) up.pushname = synced.pushname
                if (synced.foto_perfil && !current?.foto_perfil) up.foto_perfil = synced.foto_perfil
                if (Object.keys(up).length === 0) return null
                return supabase.from('clientes').update(up).eq('id', novoClienteId).eq('company_id', company_id)
              }))
            .then(async (r) => {
              if (r && !r.error && req.app?.get('io')) {
                const io = req.app.get('io')
                const { data: cli } = await supabase.from('clientes').select('nome, pushname, telefone').eq('id', novoClienteId).eq('company_id', company_id).maybeSingle()
                const contatoNome = cli?.nome || cli?.pushname || conversa.nome_contato_cache || conversa.telefone
                io.to(`empresa_${company_id}`).emit('contato_atualizado', {
                  conversa_id: Number(conversa_id),
                  contato_nome: contatoNome,
                  telefone: cli?.telefone || conversa.telefone
                })
              }
            })
            .catch(() => {})
        })
      }
    }

    const hasLinkPayload = link && typeof link === 'object' && link.linkUrl

    // Reply (citação) — opcional. Requer coluna mensagens.reply_meta (jsonb).
    const basePayload = {
      company_id,
      conversa_id: Number(conversa_id),
      texto: String(texto).trim(),
      tipo: hasLinkPayload ? 'link' : 'texto',
      direcao: 'out',
      autor_usuario_id: Number(user_id),
      status: 'pending',
      criado_em: new Date().toISOString()
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
      // Payload normalizado: id, conversa_id, status, status_mensagem, whatsapp_id (para frontend dedupe e ticks)
      const novaMsgPayload = {
        ...msg,
        conversa_id: msg.conversa_id ?? Number(conversa_id),
        status: msg.status || 'pending',
        status_mensagem: msg.status_mensagem || msg.status || 'pending'
      }
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem',
        novaMsgPayload
      )
      // Incluir SEMPRE nome/foto no payload para evitar frontend "bugar" o nome ao enviar msg
      let contatoNome = conversa?.nome_contato_cache ? String(conversa.nome_contato_cache).trim() : null
      let fotoPerfil = conversa?.foto_perfil_contato_cache ? String(conversa.foto_perfil_contato_cache).trim() : null
      if ((!contatoNome || !fotoPerfil) && conversa?.cliente_id) {
        const { data: cli } = await supabase
          .from('clientes')
          .select('nome, pushname, foto_perfil')
          .eq('id', conversa.cliente_id)
          .eq('company_id', company_id)
          .maybeSingle()
        if (cli && !contatoNome) contatoNome = (cli.nome || cli.pushname || '').trim() || null
        if (cli?.foto_perfil && !fotoPerfil) fotoPerfil = String(cli.foto_perfil).trim()
      }
      if (!contatoNome && conversa?.telefone && !String(conversa.telefone).startsWith('lid:')) contatoNome = conversa.telefone
      // Fallback: preservar nome que já está na tela (evita contato "sumir" em LID ou sync tardio)
      if (!contatoNome && conversa?.nome_contato_cache) contatoNome = String(conversa.nome_contato_cache).trim()
      // ultima_mensagem_preview: só para preview na lista lateral — NUNCA adicionar ao array de mensagens
      // (nova_mensagem já traz a mensagem completa para o chat; incluir id aqui causaria duplicata)
      // IMPORTANTE: incluir telefone e cliente_id para frontend manter deduplicação e não fazer contato "sumir"
      const telefoneParaPayload = conversa?.telefone && !String(conversa.telefone).startsWith('lid:')
        ? String(conversa.telefone).trim()
        : null
      // Incluir telefone/nome/foto sempre que disponíveis — frontend faz merge defensivo
      const convPayload = {
        id: Number(conversa_id),
        ultima_atividade: basePayload.criado_em,
        ...(telefoneParaPayload ? { telefone: telefoneParaPayload } : {}),
        ...(conversa?.cliente_id != null ? { cliente_id: conversa.cliente_id } : {}),
        ...(contatoNome ? { nome_contato_cache: contatoNome, contato_nome: contatoNome } : {}),
        ...(fotoPerfil ? { foto_perfil_contato_cache: fotoPerfil, foto_perfil: fotoPerfil } : {}),
        ultima_mensagem_preview: { texto: basePayload.texto, criado_em: basePayload.criado_em, direcao: 'out' }
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

      const provider = getProvider()
      try {
        let result = null

        if (hasLinkPayload && provider.sendLink) {
          // Garante que o texto enviado contenha o link no final, como exige a Z-API.
          let messageToSend = String(texto).trim()
          const linkUrlStr = String(link.linkUrl || '').trim()
          if (linkUrlStr && !messageToSend.includes(linkUrlStr)) {
            messageToSend = messageToSend ? `${messageToSend} ${linkUrlStr}` : linkUrlStr
          }
          result = await provider.sendLink(telefoneParaEnvio, {
            message: messageToSend,
            image: link.image || '',
            linkUrl: linkUrlStr,
            title: String(link.title || '').trim() || linkUrlStr,
            linkDescription: String(link.linkDescription || link.description || '').trim() || messageToSend,
          }, { companyId: company_id, conversaId: conversa_id })
        } else {
          result = await provider.sendText(telefoneParaEnvio, String(texto).trim(), { companyId: company_id, conversaId: conversa_id, phoneId: phoneId || undefined, replyMessageId: replyMessageId || undefined })
        }
        const ok = typeof result === 'boolean' ? result : result?.ok === true
        const waMessageId = typeof result === 'object' && result?.messageId ? String(result.messageId).trim() : null
        const nextStatus = ok ? 'sent' : 'erro'
        await supabase
          .from('mensagens')
          .update({ status: nextStatus, ...(waMessageId ? { whatsapp_id: waMessageId } : {}) })
          .eq('company_id', company_id)
          .eq('id', msg.id)

        const io2 = req.app.get('io')
        if (io2) {
          const payload = { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: nextStatus, ...(waMessageId ? { whatsapp_id: waMessageId } : {}) }
          // Emite para empresa, conversa E usuario que enviou (garante atualização em tempo real)
          let chain = io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`)
          chain.emit('status_mensagem', payload)
        }

        if (!ok) console.warn('[WhatsApp] Falha ao entregar mensagem para', String(telefoneParaEnvio || '').slice(-8), '— verifique se a instância Z-API está conectada (escaneie o QR no painel)')
        sendResult = result
      } catch (e) {
        console.error('WhatsApp enviar:', e)
        await supabase
          .from('mensagens')
          .update({ status: 'erro' })
          .eq('company_id', company_id)
          .eq('id', msg.id)
        const io2 = req.app.get('io')
        if (io2) {
          const payload = { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro' }
          let chain = io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`)
          chain.emit('status_mensagem', payload)
        }
      }
    }

    // Não retornar mensagem completa — evita duplicação no frontend (API + socket).
    // A mensagem chega via socket nova_mensagem (única fonte de verdade para exibição).
    const sendOk = !!telefoneParaEnvio && (typeof sendResult === 'boolean' ? sendResult : sendResult?.ok === true)
    return res.json({
      ok: true,
      id: msg.id,
      conversa_id: Number(conversa_id),
      ...(sendOk ? { status: 'sent' } : { status: sendResult?.blockedBy ? 'blocked' : 'erro', ...(sendResult?.blockedBy ? { motivo: sendResult.blockedBy } : {}) })
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
      .select('id, nome, pushname, telefone')
      .eq('company_id', company_id)
      .eq('id', cliente_id)
      .maybeSingle()

    if (errCli || !cliente) {
      return res.status(404).json({ error: 'Contato não encontrado' })
    }

    const contactName =
      (cliente.pushname && String(cliente.pushname).trim()) ||
      (cliente.nome && String(cliente.nome).trim()) ||
      (cliente.telefone && String(cliente.telefone).trim()) ||
      'Contato'
    const contactPhone = String(cliente.telefone || '').replace(/\D/g, '')

    if (!contactPhone) {
      return res.status(400).json({ error: 'Contato não possui telefone válido para compartilhar' })
    }

    const provider = getProvider()
    if (!provider || !provider.sendContact) {
      return res.status(500).json({ error: 'Provider WhatsApp não suporta compartilhamento de contato' })
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
      })
      .select()
      .single()

    if (errMsg) {
      return res.status(500).json({ error: errMsg.message })
    }

    // envia contato via Z-API
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
      .update({ status: nextStatus, ...(waMessageId ? { whatsapp_id: waMessageId } : {}) })
      .eq('company_id', company_id)
      .eq('id', msg.id)

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem',
        { ...msg, status: nextStatus, whatsapp_id: waMessageId || null },
      )
      emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id) })
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error('Erro ao enviar contato:', err)
    return res.status(500).json({ error: 'Erro ao enviar contato' })
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
      .update({ status: nextStatus, ...(waMessageId ? { whatsapp_id: waMessageId } : {}) })
      .eq('company_id', company_id)
      .eq('id', msg.id)

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem',
        { ...msg, status: nextStatus, whatsapp_id: waMessageId || null },
      )
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
      .select('id, criado_em')
      .eq('company_id', company_id)
      .eq('id', cid)
      .maybeSingle()

    if (errConv || !conversa) return res.status(404).json({ error: 'Conversa não encontrada' })

    // valida que a mensagem é desta conversa/empresa
    const { data: msg, error: errMsgSel } = await supabase
      .from('mensagens')
      .select('id, conversa_id, criado_em, direcao, autor_usuario_id')
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
    const { company_id, id: user_id, perfil, departamento_id: user_dep_id } = req.user
    const isAdmin = perfil === 'admin'

    let query = supabase
      .from('conversas')
      .select('*')
      .eq('company_id', company_id)
      .eq('status_atendimento', 'aberta')
      .is('atendente_id', null)
      .order('criado_em', { ascending: true })
      .limit(1)

    // Atendente/supervisor: com setor → seu setor + conversas sem setor; sem setor → só conversas sem setor
    if (!isAdmin) {
      if (user_dep_id != null) {
        query = query.or(`departamento_id.eq.${user_dep_id},departamento_id.is.null`)
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

    const errAt = await registrarAtendimento({
      conversa_id: conversa.id,
      company_id,
      acao: 'assumiu',
      de_usuario_id: user_id,
      para_usuario_id: user_id, // ✅ corrigido
      observacao: 'Puxou da fila'
    })
    if (errAt) return res.status(500).json({ error: errAt.message })

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
function inferirTipoArquivo(file) {
  const m = String(file.mimetype || '').toLowerCase()
  const n = String(file.originalname || '').toLowerCase()
  // Figurinha (WhatsApp): geralmente WEBP
  if (m === 'image/webp' || /\.webp$/i.test(n)) return 'sticker'
  if (m.startsWith('image/')) return 'imagem'
  if (m.startsWith('audio/') || /\.(mp3|ogg|wav|m4a|webm|aac|opus)$/i.test(n)) return 'audio'
  if (m.startsWith('video/')) return 'video'
  return 'arquivo'
}

exports.enviarArquivo = async (req, res) => {
  try {
    const { id: conversa_id } = req.params
    const { company_id, id: user_id, perfil } = req.user
    const io = req.app.get('io')

    if (!req.file) {
      return res.status(400).json({ error: "Arquivo não enviado" })
    }

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id, user_id })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const file = req.file
    const tipo = inferirTipoArquivo(file)
    const pathUrl = `/uploads/${file.filename}`

    const { data: conversa } = await supabase
      .from('conversas')
      .select('id, telefone')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .single()

    const { data: msg, error } = await supabase.from("mensagens").insert({
      conversa_id: Number(conversa_id),
      texto: tipo === 'audio' ? '(áudio)' : tipo === 'sticker' ? '(figurinha)' : file.originalname,
      tipo,
      url: pathUrl,
      nome_arquivo: file.originalname,
      direcao: "out",
      autor_usuario_id: user_id,
      company_id,
    }).select().single()

    if (error) return res.status(500).json({ error: error.message })

    await supabase
      .from('conversas')
      .update({ lida: true, ultima_atividade: new Date().toISOString() })
      .eq('company_id', Number(company_id))
      .eq('id', Number(conversa_id))

    // Payload normalizado (igual enviarMensagemChat) — única fonte para exibição é o socket
    const novaMsgPayload = {
      ...msg,
      conversa_id: msg.conversa_id ?? Number(conversa_id),
      status: msg.status || 'pending',
      status_mensagem: msg.status_mensagem || msg.status || 'pending'
    }
    emitirEventoEmpresaConversa(
      io,
      company_id,
      conversa_id,
      io.EVENTS?.NOVA_MENSAGEM || "nova_mensagem",
      novaMsgPayload
    )
    emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id) })

    const baseUrl = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/$/, '')
    const fullUrl = baseUrl ? `${baseUrl}${pathUrl}` : null
    const isLocalhost = /localhost|127\.0\.0\.1/i.test(baseUrl)

    if (conversa?.telefone && fullUrl && !isLocalhost) {
      const provider = getProvider()
      const phone = conversa.telefone
      const opts = { companyId: company_id, conversaId: conversa_id }
      const promise =
        tipo === 'audio' && provider.sendAudio
          ? provider.sendAudio(phone, fullUrl, opts)
          : tipo === 'sticker' && provider.sendSticker
            ? provider.sendSticker(phone, fullUrl, { ...opts, stickerAuthor: 'ZapERP' })
          : tipo === 'imagem' && provider.sendImage
            ? provider.sendImage(phone, fullUrl, '', opts)
            : tipo === 'video' && provider.sendVideo
              ? provider.sendVideo(phone, fullUrl, '', opts)
              : provider.sendFile
                ? provider.sendFile(phone, fullUrl, file.originalname || '', opts)
                : Promise.resolve(false)
      promise
        .then(async (ok) => {
          if (!ok) {
            console.warn('WhatsApp: falha ao enviar mídia para', phone, tipo)
            await supabase.from('mensagens').update({ status: 'erro' }).eq('company_id', company_id).eq('id', msg.id)
            const io2 = req.app?.get('io')
            if (io2) {
              const payload = { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro' }
              const chain = io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`)
              chain.emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', payload)
            }
          }
        })
        .catch(async (e) => {
          console.error('WhatsApp enviar mídia:', e)
          await supabase.from('mensagens').update({ status: 'erro' }).eq('company_id', company_id).eq('id', msg.id)
          const io2 = req.app?.get('io')
          if (io2) {
            const payload = { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro' }
            const chain = io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`)
            chain.emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', payload)
          }
        })
    } else if (conversa?.telefone && (!baseUrl || isLocalhost)) {
      if (!baseUrl) console.warn('⚠️ APP_URL/BASE_URL não configurado; mídia não enviada ao WhatsApp.')
      else console.warn('⚠️ APP_URL não pode ser localhost; Z-API precisa de URL pública para baixar mídia.')
    }

    // Não retornar mensagem completa — evita duplicação (API + socket). Mensagem chega via nova_mensagem.
    return res.json({ ok: true, id: msg.id, conversa_id: Number(conversa_id) })
  } catch (err) {
    console.error('Erro ao enviar arquivo:', err)
    return res.status(500).json({ error: 'Erro ao enviar arquivo' })
  }
}
