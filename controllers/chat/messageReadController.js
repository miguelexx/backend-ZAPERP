/**
 * Leitura de mensagens: carregar antigas e buscar na conversa.
 * Extraído de controllers/chatController.js (modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { isMensagemLegadaMovimentacaoInterna } = require('../../services/atendimentosRegistroService')
const { isGroupConversation, isClosedAttendanceStatus } = require('../../helpers/conversaHelper')
const { syncOldMessagesForConversation } = require('../../services/oldMessagesSyncService')
const { escapeIlikePattern } = require('../../helpers/chatSearchHelper')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../../helpers/timestampApiCompat')
const { applyDetalharChatMensagensCursor } = require('../../services/chat/read/pagination')
const { getConversaMessagesSearchLimit } = require('../../services/chat/read/searchLimits')
const { usuarioParticipaAtivamenteDaConversa } = require('../../services/chat/access/conversationVisibilityService')
const { emitirConversaAtualizada } = require('../../services/chat/realtime/chatRealtimeGateway')
const { assertPermissaoConversa } = require('../../services/chat/access/conversationPolicy')
const { enrichMensagensComAutorUsuario } = require('../../services/chat/presentation/messageAuthorEnrichment')

exports.carregarMensagensAntigasContato = async (req, res) => {
  try {
    const { id } = req.params
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user

    const perm = await assertPermissaoConversa({
      company_id,
      conversa_id: id,
      user_id,
      role: perfil,
      user_dep_ids: departamento_ids,
    })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    if (isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Use esta acao apenas em conversas individuais.' })
    }

    const result = await syncOldMessagesForConversation(company_id, Number(id), {
      io: req.app?.get?.('io') || null,
    })
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error || 'Erro ao carregar mensagens antigas.' })

    const io = req.app?.get?.('io') || null
    if (io && ((result.messagesInserted || 0) > 0 || (result.messagesUpdated || 0) > 0)) {
      emitirConversaAtualizada(io, company_id, Number(id), { id: Number(id) })
    }

    return res.json({
      ok: true,
      conversa_id: Number(id),
      mensagens_lidas: result.messagesFetched || 0,
      mensagens_importadas: result.messagesInserted || 0,
      mensagens_atualizadas: result.messagesUpdated || 0,
      mensagens_ignoradas: result.messagesSkipped || 0,
      empty: result.empty === true,
      message: result.message || (
        ((result.messagesInserted || 0) > 0 || (result.messagesUpdated || 0) > 0)
          ? 'Mensagens antigas carregadas para este contato.'
          : 'Nenhuma mensagem antiga encontrada para este contato.'
      ),
    })
  } catch (err) {
    console.error('[carregarMensagensAntigasContato]', err)
    return res.status(500).json({ error: 'Erro ao carregar mensagens antigas deste contato' })
  }
}

exports.buscarMensagensConversa = async (req, res) => {
  try {
    const { id } = req.params
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const role = String(perfil || '').toLowerCase()
    const q = String(req.query.q || '').trim()
    const limit = getConversaMessagesSearchLimit(req.query.limit)
    const cursor = req.query.cursor || null
    const cursor_id =
      req.query.cursor_id !== undefined && req.query.cursor_id !== null && String(req.query.cursor_id).trim() !== ''
        ? req.query.cursor_id
        : null

    const perm = await assertPermissaoConversa({
      company_id,
      conversa_id: id,
      user_id,
      role: perfil,
      user_dep_ids: departamento_ids,
    })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    if (!q) {
      return res.json({
        resultados: [],
        has_more: false,
        next_cursor: null,
        next_cursor_id: null,
        q: '',
      })
    }

    const conv = perm.conv || {}
    const isGroup = isGroupConversation(conv)
    const isAdmin = role === 'admin'
    const isSupervisor = role === 'supervisor'
    const conversaAssumidaPorOutro = conv.atendente_id != null && Number(conv.atendente_id) !== Number(user_id)
    const conversaEncerradaBusca = isClosedAttendanceStatus(conv.status_atendimento)
    if (!isGroup && conversaAssumidaPorOutro && !isAdmin && !isSupervisor && !conversaEncerradaBusca) {
      const isParticipanteAtivo = await usuarioParticipaAtivamenteDaConversa(company_id, id, user_id)
      if (!isParticipanteAtivo) {
        return res.status(403).json({ error: 'Mensagens indisponíveis para conversa assumida por outro usuário' })
      }
    }

    const selectComRemetente = 'id, conversa_id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, whatsapp_instance_id, tipo, url, nome_arquivo, reply_meta, remetente_nome, remetente_telefone, contact_meta, location_meta, apagada_para_todos, apagada_em, audio_duracao_sec'
    const selectFallback = 'id, conversa_id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, whatsapp_instance_id, tipo, url, nome_arquivo'
    const term = `%${escapeIlikePattern(q)}%`

    let query = supabase
      .from('mensagens')
      .select(selectComRemetente)
      .eq('company_id', Number(company_id))
      .eq('conversa_id', Number(id))
      .ilike('texto', term)
      .order('criado_em', { ascending: false })
      .order('id', { ascending: false })

    query = applyDetalharChatMensagensCursor(query, cursor, cursor_id).limit(limit + 1)
    let { data: rows, error } = await query

    if (error && (String(error.message || '').includes('reply_meta') || String(error.message || '').includes('remetente_nome') || String(error.message || '').includes('remetente_telefone') || String(error.message || '').includes('contact_meta') || String(error.message || '').includes('location_meta') || String(error.message || '').includes('apagada_para_todos') || String(error.message || '').includes('audio_duracao_sec') || String(error.message || '').includes('does not exist'))) {
      let fallbackQuery = supabase
        .from('mensagens')
        .select(selectFallback)
        .eq('company_id', Number(company_id))
        .eq('conversa_id', Number(id))
        .ilike('texto', term)
        .order('criado_em', { ascending: false })
        .order('id', { ascending: false })
      fallbackQuery = applyDetalharChatMensagensCursor(fallbackQuery, cursor, cursor_id).limit(limit + 1)
      ;({ data: rows, error } = await fallbackQuery)
    }

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    let dbRows = Array.isArray(rows)
      ? rows.filter((m) => !isMensagemLegadaMovimentacaoInterna(m))
      : []
    const hasMoreRaw = dbRows.length > limit
    dbRows = dbRows.slice(0, limit)
    const cursorRow = dbRows.length > 0 ? dbRows[dbRows.length - 1] : null

    try {
      const { data: ocultas, error: errOcultas } = await supabase
        .from('mensagens_ocultas')
        .select('mensagem_id')
        .eq('company_id', Number(company_id))
        .eq('conversa_id', Number(id))
        .eq('usuario_id', Number(user_id))
      if (!errOcultas && Array.isArray(ocultas) && ocultas.length > 0) {
        const hidden = new Set(ocultas.map((o) => String(o.mensagem_id)))
        dbRows = dbRows.filter((m) => !hidden.has(String(m.id)))
      }
    } catch (_) {
      // Tabela opcional em bancos antigos; busca continua sem expor dados fora da conversa.
    }

    const resultados = await enrichMensagensComAutorUsuario(supabase, company_id, dbRows, user_id)

    return res.json({
      resultados,
      has_more: hasMoreRaw,
      next_cursor:
        hasMoreRaw && cursorRow
          ? normalizarTimestampSemFusoAmbiguoParaApi(cursorRow.criado_em)
          : null,
      next_cursor_id:
        hasMoreRaw && cursorRow != null && cursorRow.id != null ? cursorRow.id : null,
      q,
      limit,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao buscar mensagens da conversa' })
  }
}
