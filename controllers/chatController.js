const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')
const { isGroupConversation } = require('../helpers/conversaHelper')
const { normalizePhoneBR, possiblePhonesBR, phoneKeyBR } = require('../helpers/phoneHelper')
const { deduplicateConversationsByContact, sortConversationsByRecent, getCanonicalPhone } = require('../helpers/conversationSync')

// =====================================================
// 1) HELPERS (TOPO DO ARQUIVO)
// =====================================================
function emitirConversaAtualizada(io, company_id, conversa_id, payload = null) {
  if (!io) return

  const data = payload || { id: Number(conversa_id) }

  // Emite para empresa + conversa em UMA única operação (evita duplicidade
  // quando o mesmo socket está nas duas rooms).
  const eventName = io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada'
  io.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).emit(eventName, data)

  // compatibilidade com seu front atual
  io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: Number(conversa_id) })
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

  // supervisor: pode gerenciar conversas do seu setor (grupos: permitido)
  if (r === 'supervisor') {
    if (!isGroup && user_dep_id != null && conv.departamento_id != null && Number(conv.departamento_id) !== Number(user_dep_id)) {
      return { ok: false, status: 403, error: 'Conversa de outro setor' }
    }
    return { ok: true, conv }
  }

  // atendente: só gerencia conversa atribuída a ele (grupos: permitido)
  if (r === 'atendente') {
    if (!isGroup && (conv.atendente_id == null || Number(conv.atendente_id) !== Number(user_id))) {
      return { ok: false, status: 403, error: 'Conversa não atribuída a este atendente' }
    }
    return { ok: true, conv }
  }

  // fallback: perfis desconhecidos são tratados como atendente (seguro)
  if (!isGroup && (conv.atendente_id == null || Number(conv.atendente_id) !== Number(user_id))) {
    return { ok: false, status: 403, error: 'Conversa não atribuída a este atendente' }
  }
  return { ok: true, conv }
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
        .or(`nome.ilike.${term},telefone.ilike.${term}`)
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
      clientes!conversas_cliente_fk ( id, nome, pushname, telefone, foto_perfil ),
      departamentos ( id, nome ),
      mensagens ( texto, criado_em, direcao, tipo, url, nome_arquivo, whatsapp_id, status )
    `

    function buildQuery(select) {
      let q = supabase
        .from('conversas')
        .select(select)
        .eq('company_id', company_id)
      if (!isAdmin && user_dep_id != null) {
        q = q.or(`departamento_id.eq.${user_dep_id},tipo.eq.grupo,departamento_id.is.null`)
      } else if (filter_dep_id) {
        q = q.eq('departamento_id', Number(filter_dep_id))
      }
      if (conversaIdsFilter && conversaIdsFilter.length > 0) {
        q = q.in('id', conversaIdsFilter)
      }
      if (status_atendimento) q = q.eq('status_atendimento', status_atendimento)
      // Atendente: só pode ver suas conversas (padrão CRM SaaS). Admin/supervisor podem filtrar por atendente_id.
      if (isAtendente) q = q.eq('atendente_id', Number(user_id))
      else if (atendente_id) q = q.eq('atendente_id', Number(atendente_id))
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

    let conversasFormatadas = (data || []).map((c) => {
      const raw = c.clientes
      const clientesObj = Array.isArray(raw)
        ? (raw.find((cl) => cl && Number(cl.id) === Number(c.cliente_id)) || raw[0])
        : raw
      const nomeCliente = (clientesObj?.pushname ?? clientesObj?.nome ?? null) && String(clientesObj?.pushname ?? clientesObj?.nome ?? '').trim() ? String(clientesObj?.pushname ?? clientesObj?.nome ?? '').trim() : null
      const fotoCliente = clientesObj?.foto_perfil ?? null
      const isGroup = isGroupConversation(c)
      const ultimaMsg = Array.isArray(c.mensagens) && c.mensagens.length > 0 ? c.mensagens[0] : null
      // Contatos não salvos (sem nome): sempre exibir o número no lugar do nome
      const contatoNome = isGroup
        ? (c.nome_grupo || c.telefone || 'Grupo')
        : (nomeCliente || c.telefone || null)
      return {
        id: c.id,
        cliente_id: c.cliente_id,
        telefone: c.telefone,
        status_atendimento: c.status_atendimento,
        atendente_id: c.atendente_id,
        lida: c.lida,
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
        foto_perfil: isGroup ? null : (fotoCliente ?? null),
        setor: c.departamentos?.nome || null,
        tags: (c.conversa_tags || []).map((ct) => ct?.tags).filter(Boolean),
        unread_count: unreadMap[Number(c.id)] || 0
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
        contato_nome: cl.pushname || cl.nome || cl.telefone || null,
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
    .box { background: #fff; border-radius: 8px; padding: 1rem 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); max-width: 320px; }
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
    <h2>Conversas duplicadas</h2>
    <p>Unifica conversas do mesmo contato (mesmo número em formatos diferentes).</p>
    <button type="button" class="btn" id="btn">Apagar duplicatas</button>
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
          if (_.ok) setMsg(res.message || (res.merged ? res.merged + ' unificada(s).' : 'Nenhuma duplicata.'));
          else setMsg(res.error || 'Erro', true);
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
// POST /chats/merge-duplicatas — admin only
// =====================================================
exports.mergeConversasDuplicadas = async (req, res) => {
  try {
    const { company_id } = req.user
    const cid = Number(company_id)

    const { data: conversas, error: errList } = await supabase
      .from('conversas')
      .select('id, telefone, ultima_atividade, criado_em, tipo')
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
        await supabase.from('mensagens').update({ conversa_id: canonical.id }).in('conversa_id', otherIds)
        await supabase.from('conversa_tags').update({ conversa_id: canonical.id }).in('conversa_id', otherIds)
        await supabase.from('atendimentos').update({ conversa_id: canonical.id }).in('conversa_id', otherIds)
        await supabase.from('historico_atendimentos').update({ conversa_id: canonical.id }).in('conversa_id', otherIds)
        await supabase.from('conversa_unreads').update({ conversa_id: canonical.id }).in('conversa_id', otherIds)
        const del = await supabase.from('conversas').delete().in('id', otherIds).eq('company_id', cid)
        if (del.error) {
          await supabase.from('conversas').update({ status_atendimento: 'fechada', lida: true }).in('id', otherIds).eq('company_id', cid)
        }
        merged += otherIds.length
      } catch (e) {
        console.warn('mergeConversasDuplicadas:', e?.message || e)
      }
    }

    return res.json({ ok: true, merged, message: merged ? `${merged} conversa(s) duplicada(s) unificada(s).` : 'Nenhuma duplicata encontrada.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao mesclar duplicatas' })
  }
}

// =====================================================
// 3b) Sincronizar contatos do celular (Z-API Get contacts)
// =====================================================
exports.sincronizarContatosZapi = async (req, res) => {
  try {
    const { company_id } = req.user
    const provider = getProvider()
    if (!provider || !provider.getContacts || !provider.isConfigured) {
      return res.status(501).json({ error: 'Sincronização de contatos disponível apenas com Z-API configurado.' })
    }

    const pageSize = 100
    let page = 1
    let total = 0
    let atualizados = 0
    let criados = 0

    while (true) {
      const contacts = await provider.getContacts(page, pageSize)
      if (!Array.isArray(contacts) || contacts.length === 0) break

      for (const c of contacts) {
        const rawPhone = String(c.phone || '').trim()
        const phone = normalizePhoneBR(rawPhone) || rawPhone.replace(/\D/g, '').trim()
        if (!phone) continue
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

          // ✅ NÃO degradar nome: só atualiza se veio nome do WhatsApp, ou se o banco está vazio
          if (nome && String(nome).trim()) updates.nome = String(nome).trim()
          else if (missingName) updates.nome = phone // sem nome → usa número, mas só se estava vazio

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
          let ins = await supabase.from('clientes').insert({
            company_id: Number(company_id),
            telefone: phone,
            nome: nomeFinal || null,
            pushname: pushname || undefined,
            ...(imgUrl ? { foto_perfil: imgUrl } : {})
          })
          if (ins.error && String(ins.error.message || '').includes('pushname')) {
            ins = await supabase.from('clientes').insert({
              company_id,
              telefone: phone,
              nome: nomeFinal || null,
              ...(imgUrl ? { foto_perfil: imgUrl } : {})
            })
          }
          if (!ins.error) {
            criados++
          } else if (String(ins.error.code || '') === '23505') {
            let q = supabase.from('clientes').select('id, telefone')
            if (phones.length > 0) q = q.in('telefone', phones)
            else q = q.eq('telefone', phone)
            q = q.eq('company_id', Number(company_id))
            const found = await q.order('id', { ascending: true }).limit(1)
            const jaExiste = Array.isArray(found.data) && found.data.length > 0 ? found.data[0] : null
            if (jaExiste?.id) {
              const upd = await supabase
                .from('clientes')
                .update({ nome: nomeFinal || phone, ...(imgUrl ? { foto_perfil: imgUrl } : {}) })
                .eq('id', jaExiste.id)
              if (!upd.error) atualizados++
            }
          }
        }
      }

      if (contacts.length < pageSize) break
      page++
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
    const limit = Math.min(3000, Math.max(1, Number(req.query.limit) || 2000))
    const delayMs = Math.min(1200, Math.max(0, Number(req.query.delay_ms) || 220))

    let q = supabase
      .from('clientes')
      .select('id, telefone, nome, pushname, foto_perfil')
      .eq('company_id', cid)
      .not('telefone', 'is', null)
      .limit(limit)
    // prioriza registros potencialmente incompletos
    q = q.or('foto_perfil.is.null,foto_perfil.eq.,nome.is.null,nome.eq.,pushname.is.null,pushname.eq.')
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
          provider.getContactMetadata ? provider.getContactMetadata(phone) : Promise.resolve(null),
          provider.getProfilePicture ? provider.getProfilePicture(phone) : Promise.resolve(null)
        ])

        const metaNome = String(meta?.name || meta?.short || meta?.notify || meta?.vname || '').trim()
        const metaPush = String(meta?.notify || '').trim()
        const metaImgRaw = String(meta?.imgUrl || meta?.photo || meta?.profilePicture || '').trim()
        const metaImg = metaImgRaw && metaImgRaw.startsWith('http') ? metaImgRaw : null
        const fotoFinal = (fotoUrl && String(fotoUrl).trim().startsWith('http') ? String(fotoUrl).trim() : null) || metaImg

        const updates = {}

        // nome/pushname: preencher quando faltando (ou quando só tem número)
        if (missingName) {
          updates.nome = metaNome || phone
          if (metaNome) nomeAtualizado++
        }
        if (!pushDb && metaPush) {
          updates.pushname = metaPush
        }

        // foto: preencher quando faltando
        if (missingFoto) {
          if (fotoFinal) {
            updates.foto_perfil = fotoFinal
            fotoAtualizada++
          } else {
            semFoto++
          }
        }

        if (Object.keys(updates).length > 0) {
          let upd = await supabase.from('clientes').update(updates).eq('id', cl.id)
          if (upd.error && String(upd.error.message || '').includes('pushname')) {
            delete updates.pushname
            if (Object.keys(updates).length > 0) upd = await supabase.from('clientes').update(updates).eq('id', cl.id)
          }
          if (!upd.error) atualizados++
          else {
            erros++
            if (exemplosErros.length < 10) exemplosErros.push({ id: cl.id, telefone: phone.slice(-6), erro: upd.error.message })
          }
        }
      } catch (_) {
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
    const { company_id } = req.user;

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
        contato_nome: cliente.pushname || cliente.nome || conversaExistente.telefone,
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
      contato_nome: cliente.pushname || cliente.nome || novaConversa.telefone,
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
    const isAtendente = role === 'atendente'

    const limit = Math.min(Number(req.query.limit || 50), 200)
    const cursor = req.query.cursor || null

    // conversa (com cliente, atendente, departamento/setor; tipo, nome_grupo, fotos)
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
    // Visibilidade: não-admin vê seu setor; grupos são visíveis a todos
    if (!isAdmin && !isGroup) {
      const convDep = conversa.departamento_id ?? null
      const userDep = user_dep_id ?? null
      if (userDep == null && convDep != null) {
        return res.status(403).json({ error: 'Conversa de outro setor' })
      }
      if (userDep != null && Number(convDep) !== Number(userDep)) {
        return res.status(403).json({ error: 'Conversa de outro setor' })
      }
    }

    // Atendente: acesso somente às próprias conversas (quando já atribuídas)
    if (isAtendente && !isGroup) {
      if (conversa.atendente_id == null || Number(conversa.atendente_id) !== Number(user_id)) {
        return res.status(403).json({ error: 'Conversa não atribuída a este atendente' })
      }
    }

    // mensagens paginadas (remetente_nome/remetente_telefone para grupos; fallback se colunas não existirem)
    const selectComRemetente = 'id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo, reply_meta, remetente_nome, remetente_telefone'
    const selectBasico = 'id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo, reply_meta'
    let query = supabase
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

    let { data: mensagens, error: errMsgs } = await query
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
    const nomeUnico = isGroup
      ? (conversa.nome_grupo ?? conversa.telefone ?? 'Grupo')
      : (clientesConv?.pushname ?? clientesConv?.nome ?? conversa.telefone ?? null)
    const fotoUnica = isGroup ? (conversa.foto_grupo ?? null) : (clientesConv?.foto_perfil ?? null)
    const conversaFormatada = {
      ...conversa,
      clientes: clientesConv,
      is_group: isGroup,
      nome_grupo: conversa.nome_grupo ?? null,
      contato_nome: nomeUnico,
      cliente_nome: nomeUnico,
      cliente_telefone: isGroup ? conversa.telefone : (conversa.telefone ?? clientesConv?.telefone ?? null),
      observacao: isGroup ? null : (clientesConv?.observacoes ?? null),
      foto_perfil: fotoUnica,
      foto_grupo: isGroup ? (conversa.foto_grupo ?? null) : null,
      atendente_nome: conversa.usuarios?.nome ?? null,
      setor: conversa.departamentos?.nome ?? null,
      tags: (conversa.conversa_tags || []).map((ct) => ct.tags).filter(Boolean),
      mensagens: (mensagens || []).reverse(),
      next_cursor: mensagens?.length ? mensagens[mensagens.length - 1].criado_em : null
    }

    // ✅ emite SOMENTE mensagens_lidas (não dispara atualizar lista ao abrir)
    const io = req.app.get('io')
    if (io) {
      const payload = { conversa_id: Number(id), usuario_id: Number(user_id) }
      emitirParaUsuario(io, user_id, io.EVENTS?.MENSAGENS_LIDAS || 'mensagens_lidas', payload)
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

    // Permissão por setor: não-admin só assume conversas do seu departamento
    if (!isAdmin) {
      const convDep = atual.departamento_id ?? null
      const userDep = user_dep_id ?? null
      if (userDep != null && Number(convDep) !== Number(userDep)) {
        return res.status(403).json({ error: 'Conversa de outro setor' })
      }
      if (userDep == null && convDep != null) {
        return res.status(403).json({ error: 'Conversa pertence a um setor; atribua-se a um setor para assumir' })
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
    const { departamento_id: novo_departamento_id } = req.body

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_id })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    if (novo_departamento_id == null || novo_departamento_id === '') {
      return res.status(400).json({ error: 'departamento_id é obrigatório' })
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
    if (Number(depAntigoId) === Number(novo_departamento_id)) {
      return res.status(400).json({ error: 'Conversa já está neste setor' })
    }

    const { data: novoDep } = await supabase
      .from('departamentos')
      .select('id, nome')
      .eq('company_id', company_id)
      .eq('id', novo_departamento_id)
      .single()

    if (!novoDep) {
      return res.status(400).json({ error: 'Setor de destino inválido' })
    }

    const { data: atualizada, error: errUpd } = await supabase
      .from('conversas')
      .update({
        departamento_id: Number(novo_departamento_id),
        atendente_id: null,
        status_atendimento: 'aberta'
      })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .select()
      .single()

    if (errUpd) return res.status(500).json({ error: errUpd.message })

    const observacaoTexto = `${depAntigoNome} → ${novoDep.nome}`
    await supabase.from('historico_atendimentos').insert({
      conversa_id: Number(conversa_id),
      usuario_id: user_id,
      acao: 'transferiu_setor',
      observacao: observacaoTexto
    })

    const io = req.app.get('io')
    if (io) {
      const payload = { id: Number(conversa_id), departamento_id: Number(novo_departamento_id), setor: novoDep.nome }
      emitirConversaAtualizada(io, company_id, conversa_id, payload)
      emitirLock(io, conversa_id, null)
      if (depAntigoId != null) {
        emitirDepartamento(io, depAntigoId, io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada', payload)
      }
      emitirDepartamento(io, Number(novo_departamento_id), io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada', payload)
      io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: Number(conversa_id) })
    }

    return res.json({
      ok: true,
      conversa: atualizada,
      setor: novoDep.nome,
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
    const { company_id, id: user_id } = req.user
    const { id: conversa_id } = req.params
    const { texto, reply_meta } = req.body

    if (!texto || !String(texto).trim()) {
      return res.status(400).json({ error: 'texto é obrigatório' })
    }

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, tipo')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .single()

    if (errConv || !conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    // Reply (citação) — opcional. Requer coluna mensagens.reply_meta (jsonb).
    const basePayload = {
      company_id,
      conversa_id: Number(conversa_id),
      texto: String(texto).trim(),
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
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem',
        msg
      )
      emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id) })
    }

    // Envio para WhatsApp via provider (meta ou zapi, conforme WHATSAPP_PROVIDER)
    if (conversa?.telefone) {
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
        const result = await provider.sendText(conversa.telefone, String(texto).trim(), { phoneId: phoneId || undefined, replyMessageId: replyMessageId || undefined })
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
          io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).emit('status_mensagem', payload)
        }

        if (!ok) console.warn('WhatsApp: falha ao enviar mensagem para', conversa.telefone)
      } catch (e) {
        console.error('WhatsApp enviar:', e)
        await supabase
          .from('mensagens')
          .update({ status: 'erro' })
          .eq('company_id', company_id)
          .eq('id', msg.id)
        const io2 = req.app.get('io')
        if (io2) {
          io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).emit('status_mensagem', { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro' })
        }
      }
    }

    return res.json({
      ok: true,
      mensagem: {
        ...msg,
        conversa_id: Number(conversa_id)
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao enviar mensagem' })
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

    // Atendente só puxa conversas do seu setor
    if (!isAdmin && user_dep_id != null) {
      query = query.eq('departamento_id', user_dep_id)
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
    const { company_id, id: user_id } = req.user
    const io = req.app.get('io')

    if (!req.file) {
      return res.status(400).json({ error: "Arquivo não enviado" })
    }

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

    emitirEventoEmpresaConversa(
      io,
      company_id,
      conversa_id,
      io.EVENTS?.NOVA_MENSAGEM || "nova_mensagem",
      msg
    )
    emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id) })

    const baseUrl = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/$/, '')
    const fullUrl = baseUrl ? `${baseUrl}${pathUrl}` : null
    const isLocalhost = /localhost|127\.0\.0\.1/i.test(baseUrl)

    if (conversa?.telefone && fullUrl && !isLocalhost) {
      const provider = getProvider()
      const phone = conversa.telefone
      const promise =
        tipo === 'audio' && provider.sendAudio
          ? provider.sendAudio(phone, fullUrl)
          : tipo === 'sticker' && provider.sendSticker
            ? provider.sendSticker(phone, fullUrl, { stickerAuthor: 'ZapERP' })
          : tipo === 'imagem' && provider.sendImage
            ? provider.sendImage(phone, fullUrl, '')
            : tipo === 'video' && provider.sendVideo
              ? provider.sendVideo(phone, fullUrl, '')
              : provider.sendFile
                ? provider.sendFile(phone, fullUrl, file.originalname || '')
                : Promise.resolve(false)
      promise
        .then((ok) => {
          if (!ok) console.warn('WhatsApp: falha ao enviar mídia para', phone, tipo)
        })
        .catch((e) => console.error('WhatsApp enviar mídia:', e))
    } else if (conversa?.telefone && (!baseUrl || isLocalhost)) {
      if (!baseUrl) console.warn('⚠️ APP_URL/BASE_URL não configurado; mídia não enviada ao WhatsApp.')
      else console.warn('⚠️ APP_URL não pode ser localhost; Z-API precisa de URL pública para baixar mídia.')
    }

    return res.json(msg)
  } catch (err) {
    console.error('Erro ao enviar arquivo:', err)
    return res.status(500).json({ error: 'Erro ao enviar arquivo' })
  }
}
