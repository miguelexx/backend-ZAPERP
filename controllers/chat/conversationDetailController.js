/**
 * Detalhe da conversa: histórico paginado, ocultas, movimentações internas e marcação de leitura.
 * Extraído de controllers/chatController.js (modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { listarMensagensInternasMovimentacao, perfilPodeVerMovimentacaoInterna, isMensagemLegadaMovimentacaoInterna } = require('../../services/atendimentosRegistroService')
const { isGroupConversation, isClosedAttendanceStatus } = require('../../helpers/conversaHelper')
const { isLidPhoneKey, pickRealPhoneCandidate } = require('../../helpers/phoneHelper')
const { resolveReabertaPorFaltaInteracao, enrichConversasReabertaFaltaInteracao } = require('../../helpers/reabertaFaltaInteracaoHelper')
const { getDisplayName } = require('../../helpers/contactEnrichment')
const { aplicarModoSimplesNoPayload } = require('../../services/atendimentoModoSimplesService')
const { empresaModoSimplesAtivo } = require('../../helpers/empresaModoSimplesFlag')
const { usuarioPodeVerGrupo } = require('../../helpers/departamentoGruposHelper')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../../helpers/timestampApiCompat')
const { parseMessageHistoryPagination, splitMessageHistoryPage, applyDetalharChatMensagensCursor } = require('../../services/chat/read/pagination')
const { mergeConversaClienteTags, statusAtendimentoParaLista, safeWhatsappInstanceMeta } = require('../../services/chat/presentation/chatDto')
const { resolveTelefoneFromLidSiblingConversation } = require('../../services/chat/identity/conversationAddressService')
const { usuarioParticipaAtivamenteDaConversa } = require('../../services/chat/access/conversationVisibilityService')
const { emitirParaUsuario } = require('../../services/chat/realtime/chatRealtimeGateway')
const { assertPermissaoConversa } = require('../../services/chat/access/conversationPolicy')
const { enrichMensagensComAutorUsuario } = require('../../services/chat/presentation/messageAuthorEnrichment')
const { marcarComoLidaPorUsuario } = require('../../services/chat/unread/conversationUnreadService')
const { loadWhatsappInstanceMetaMap } = require('../../services/chat/read/conversationLookups')

/** Ordena histórico ascendente por criado_em, com desempate por atendimento_id/id. */
function ordenarMensagensHistoricoAsc(a, b) {
  const ta = new Date(a?.criado_em || 0).getTime()
  const tb = new Date(b?.criado_em || 0).getTime()
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
  const ida = Number(a?.atendimento_id ?? a?.id)
  const idb = Number(b?.atendimento_id ?? b?.id)
  if (Number.isFinite(ida) && Number.isFinite(idb) && ida !== idb) return ida - idb
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
}

exports.detalharChat = async (req, res) => {
  try {
    const { id } = req.params
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const role = String(perfil || '').toLowerCase()
    const isAdmin = role === 'admin'

    const messageHistoryPagination = parseMessageHistoryPagination(req.query)
    const { limit, cursor, cursor_id } = messageHistoryPagination
    const messageHistoryFetchLimit = Math.min(300, Math.max(limit + 1, limit + 75))

    // conversa (com cliente, atendente, departamento/setor; tipo, nome_grupo, fotos; nome_contato_cache para header quando cliente ainda não tem nome)
    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select(`
        id,
        whatsapp_instance_id,
        telefone,
        status_atendimento,
        atendente_id,
        aguardando_cliente_desde,
        modo_simples_aguardando,
        ultima_atividade,
        finalizacao_motivo,
        finalizada_automaticamente,
        finalizada_automaticamente_em,
        lida,
        criado_em,
        departamento_id,
        tipo,
        nome_grupo,
        foto_grupo,
        nome_contato_cache,
        foto_perfil_contato_cache,
        cliente_id,
        clientes!conversas_cliente_fk ( id, nome, pushname, telefone, observacoes, foto_perfil, company_id, cliente_tags ( tag_id, tags ( id, nome, cor ) ) ),
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
    const detalheModoSimplesAtivo = await empresaModoSimplesAtivo(company_id).catch(() => false)

    // REGRA PRINCIPAL: Se a conversa está assumida pelo usuário, SEMPRE permitir acesso total
    let podeAcessar = !isGroup && isAssignedToUser
    const conversaEncerrada = isClosedAttendanceStatus(conversa.status_atendimento)
    if (!podeAcessar && !isAdmin && isGroup) {
      podeAcessar = await usuarioPodeVerGrupo({
        company_id,
        conversa_id: Number(id),
        role,
        departamento_ids,
      })
      if (!podeAcessar) {
        return res.status(403).json({ error: 'Grupo nao vinculado ao seu setor' })
      }
    }
    if (!podeAcessar && !isAdmin && !isGroup && !conversaEncerrada) {
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

    // Bloqueia visão das mensagens quando a conversa está assumida por outro usuário.
    // Exceções: admin, supervisor, conversa encerrada, participante ativo (alinha com assertPermissaoConversa/envio).
    const isSupervisor = role === 'supervisor'
    const conversaAssumidaPorOutro = conversa.atendente_id != null && Number(conversa.atendente_id) !== Number(user_id)
    let isParticipanteAtivo = false
    if (!isGroup && !conversaEncerrada && conversaAssumidaPorOutro && !isAdmin && !isSupervisor) {
      isParticipanteAtivo = await usuarioParticipaAtivamenteDaConversa(company_id, id, user_id)
    }
    const deveBloquearMensagens =
      !isGroup &&
      !conversaEncerrada &&
      conversaAssumidaPorOutro &&
      !isAdmin &&
      !isSupervisor &&
      !isParticipanteAtivo

    // mensagens paginadas (remetente_nome/remetente_telefone para grupos; fallback se colunas não existirem)
    // `client_temp_id` é obrigatório aqui: sem ele, a linha trazida por este GET (refresh de
    // consistência pós-envio, "carregar mais" e F5) não correlaciona com a bolha otimista pendente
    // no frontend (matchesClientTempCorrelation). Para mídia (PDF/documento/imagem/vídeo/áudio) o
    // fallback por conteúdo é fraco — o eco costuma chegar sem tamanho/last_modified e com URL
    // /uploads vs blob: — então a mídia duplicava (uma bolha pendente + uma entregue). O
    // `selectFallback` abaixo já cobre bancos sem a coluna via "does not exist".
    const selectComRemetente = 'id, conversa_id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, whatsapp_instance_id, tipo, url, nome_arquivo, reply_meta, remetente_nome, remetente_telefone, contact_meta, location_meta, apagada_para_todos, apagada_em, audio_duracao_sec, client_temp_id'
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
        .limit(messageHistoryFetchLimit)

      query = applyDetalharChatMensagensCursor(query, cursor, cursor_id)

      const result = await query
      mensagens = result.data
      errMsgs = result.error
    }
    // Compatibilidade: se reply_meta/remetente_*/contact_meta/location_meta não existirem ainda no banco, refaz select sem essas colunas.
    const selectFallback = 'id, conversa_id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, whatsapp_instance_id, tipo, url, nome_arquivo'
    if (errMsgs && (String(errMsgs.message || '').includes('reply_meta') || String(errMsgs.message || '').includes('remetente_nome') || String(errMsgs.message || '').includes('remetente_telefone') || String(errMsgs.message || '').includes('contact_meta') || String(errMsgs.message || '').includes('location_meta') || String(errMsgs.message || '').includes('apagada_para_todos') || String(errMsgs.message || '').includes('audio_duracao_sec') || String(errMsgs.message || '').includes('client_temp_id') || String(errMsgs.message || '').includes('does not exist'))) {
      query = supabase
        .from('mensagens')
        .select(selectFallback)
        .eq('company_id', Number(company_id))
        .eq('conversa_id', Number(id))
        .order('criado_em', { ascending: false })
        .order('id', { ascending: false })
        .limit(messageHistoryFetchLimit)
      query = applyDetalharChatMensagensCursor(query, cursor, cursor_id)
      const result = await query
      mensagens = result.data
      errMsgs = result.error
    }
    if (errMsgs) return res.status(500).json({ error: errMsgs.message })
    if (Array.isArray(mensagens) && mensagens.length > 0) {
      mensagens = mensagens.filter((m) => !isMensagemLegadaMovimentacaoInterna(m))
    }

    const messageHistoryPage = splitMessageHistoryPage(mensagens, limit)
    mensagens = messageHistoryPage.rows
    const oldestDbRow = messageHistoryPage.cursor_row
    const hasMoreFromDb = messageHistoryPage.has_more

    // ✅ "Apagar pra mim" + marcar como lida em paralelo (reduz latência percebida ao abrir o chat)
    try {
      const ocultasQuery = supabase
        .from('mensagens_ocultas')
        .select('mensagem_id')
        .eq('company_id', Number(company_id))
        .eq('conversa_id', Number(id))
        .eq('usuario_id', Number(user_id))

      const [, { data: ocultas, error: errOcultas }] = await Promise.all([
        detalheModoSimplesAtivo
          ? Promise.resolve()
          : marcarComoLidaPorUsuario({ company_id, conversa_id: id, usuario_id: user_id }).catch((e) => {
              console.warn('detalharChat: marcarComoLidaPorUsuario', e?.message || e)
            }),
        ocultasQuery,
      ])

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

    const rawClientes = conversa.clientes
    let clientesConv = Array.isArray(rawClientes)
      ? (rawClientes.find((cl) => cl && Number(cl.id) === Number(conversa.cliente_id)) || rawClientes[0])
      : rawClientes
    // Isolamento multi-tenant: descarta cliente de outra empresa
    if (clientesConv && clientesConv.company_id != null && Number(clientesConv.company_id) !== Number(company_id)) {
      clientesConv = null
    }
    // Nunca exibir LID (lid:xxx) como nome ou número — identificador interno do WhatsApp.
    // Se a conversa ainda é lid: mas há telefone real no cliente (ou irmã), exibir esse número.
    const isLidConv = !isGroup && isLidPhoneKey(conversa.telefone)
    const clienteNome = getDisplayName(clientesConv)
    const nomeCache = (conversa.nome_contato_cache && String(conversa.nome_contato_cache).trim()) ? String(conversa.nome_contato_cache).trim() : null
    let telefoneExibivel = null
    if (isGroup) {
      telefoneExibivel = conversa.telefone || null
    } else if (isLidConv) {
      telefoneExibivel = pickRealPhoneCandidate(clientesConv?.telefone) || null
      if (!telefoneExibivel && conversa.chat_lid) {
        try {
          const siblingPhone = await resolveTelefoneFromLidSiblingConversation(
            company_id,
            conversa,
            conversa.whatsapp_instance_id
          )
          telefoneExibivel = pickRealPhoneCandidate(siblingPhone)
        } catch (siblingErr) {
          console.warn('[detalharChat] telefone irma LID:', siblingErr?.message || siblingErr)
        }
      }
    } else {
      const rawTel = String(conversa.telefone || '').trim()
      telefoneExibivel = rawTel || pickRealPhoneCandidate(clientesConv?.telefone) || null
    }
    const nomeUnico = isGroup
      ? (conversa.nome_grupo ?? conversa.telefone ?? 'Grupo')
      : (clienteNome || nomeCache || (isLidConv && !telefoneExibivel ? 'Contato' : null))
    const clienteTelefoneExibivel = isGroup
      ? conversa.telefone
      : (telefoneExibivel || pickRealPhoneCandidate(clientesConv?.telefone) || null)
    const fotoCache = (conversa.foto_perfil_contato_cache && String(conversa.foto_perfil_contato_cache).trim()) ? String(conversa.foto_perfil_contato_cache).trim() : null
    const fotoUnica = isGroup ? (conversa.foto_grupo ?? null) : (clientesConv?.foto_perfil ?? fotoCache ?? null)
    // Badge "Aberta": só exibir quando há movimentação (mensagem ou atendente assumiu) — mesma regra da lista
    const temMensagem = Array.isArray(mensagens) && mensagens.length > 0
    const dbStatusAtend = String(conversa.status_atendimento || '')
    const exibirBadgeAberta =
      !isGroup &&
      (temMensagem || conversa.atendente_id != null) &&
      dbStatusAtend !== 'mensagem_disparada'
    const semMensagens = !temMensagem
    // Empty state: UI deve oferecer Assumir (POST /chats/:id/assumir) mesmo sem badge "aberta" / sem mensagens
    const exibirCtaAssumirSemMensagens =
      !detalheModoSimplesAtivo &&
      !isGroup &&
      semMensagens &&
      dbStatusAtend !== 'fechada' &&
      !isAssignedToUser &&
      !(conversa.atendente_id != null && Number(conversa.atendente_id) !== Number(user_id))
    // No detalhe da conversa, expõe status "de lista" para não promover conversa ociosa para "aberta"
    // ao apenas abrir o chat sem mensagens. O status real do BD segue em `status_atendimento_real`.
    const statusDetalheReal = isGroup ? null : conversa.status_atendimento
    const statusDetalheLista = statusAtendimentoParaLista(isGroup, conversa.status_atendimento, exibirBadgeAberta)
    let mensagensFormatadas = (mensagens || []).reverse()
    if (perfilPodeVerMovimentacaoInterna(perfil)) {
      const movimentosQuery = {
        company_id,
        conversa_id: id,
      }
      const pageRows = Array.isArray(mensagens) ? mensagens.filter((m) => m?.criado_em) : []
      if (pageRows.length > 0) {
        const newestMessageRow = pageRows[0]
        const oldestMessageRow = pageRows[pageRows.length - 1]
        movimentosQuery.from_criado_em = oldestMessageRow.criado_em
        if (cursor) movimentosQuery.to_criado_em = newestMessageRow.criado_em
        movimentosQuery.limit = Math.max(100, limit)
      } else if (!cursor) {
        movimentosQuery.limit = 20
      } else {
        movimentosQuery.limit = 0
      }

      const movimentosInternos = movimentosQuery.limit === 0
        ? []
        : await listarMensagensInternasMovimentacao(movimentosQuery)
      if (movimentosInternos.length > 0) {
        mensagensFormatadas = [...mensagensFormatadas, ...movimentosInternos].sort(ordenarMensagensHistoricoAsc)
      }
    }
    // whatsappInstanceMetaMap e enrichMensagens são independentes entre si — executam em paralelo
    const [whatsappInstanceMetaMap, enrichedMensagens] = await Promise.all([
      loadWhatsappInstanceMetaMap(company_id, [conversa.whatsapp_instance_id]),
      enrichMensagensComAutorUsuario(supabase, company_id, mensagensFormatadas, user_id).catch((enrichErr) => {
        console.warn('[detalharChat] enriquecer mensagens:', enrichErr?.message || enrichErr)
        return mensagensFormatadas
      }),
    ])
    mensagensFormatadas = enrichedMensagens
    const whatsappInstanceMeta = safeWhatsappInstanceMeta(whatsappInstanceMetaMap.get(Number(conversa.whatsapp_instance_id)))

    const conversaFormatada = aplicarModoSimplesNoPayload(
      {
        ...conversa,
        whatsapp_instance_id: conversa.whatsapp_instance_id ?? null,
        ...whatsappInstanceMeta,
        status_atendimento: statusDetalheLista,
        status_atendimento_real: statusDetalheReal,
        status_atendimento_lista: statusDetalheLista,
        exibir_badge_aberta: exibirBadgeAberta,
        sem_mensagens: semMensagens,
        exibir_cta_assumir_sem_mensagens: exibirCtaAssumirSemMensagens,
        reaberta_falta_interacao_em: null,
        reaberta_por_falta_interacao: resolveReabertaPorFaltaInteracao(conversa),
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
        tags: mergeConversaClienteTags(conversa),
        mensagens: mensagensFormatadas,
        next_cursor:
          hasMoreFromDb && oldestDbRow
            ? normalizarTimestampSemFusoAmbiguoParaApi(oldestDbRow.criado_em)
            : null,
        next_cursor_id:
          hasMoreFromDb && oldestDbRow != null && oldestDbRow.id != null ? oldestDbRow.id : null,
        mensagens_bloqueadas: deveBloquearMensagens || undefined,
      },
      conversa,
      detalheModoSimplesAtivo
    )

    try {
      await enrichConversasReabertaFaltaInteracao(company_id, [conversaFormatada])
    } catch (reabertaErr) {
      console.warn('[detalharChat] enriquecer reaberta falta interacao:', reabertaErr?.message || reabertaErr)
    }

    // ✅ emite SOMENTE mensagens_lidas (não dispara atualizar lista ao abrir)
    const io = req.app.get('io')
    if (io && !detalheModoSimplesAtivo) {
      const payload = { conversa_id: Number(id), usuario_id: Number(user_id) }
      emitirParaUsuario(io, user_id, io.EVENTS?.MENSAGENS_LIDAS || 'mensagens_lidas', payload)
    }

    // Background: re-sincroniza foto e nome do contato/grupo com provider (UltraMsg/Z-API)
    if (io) {
      setImmediate(() => {
        if (isGroup) {
          const { syncConversationGroupOnJoin } = require('../../services/ultramsgGroupsSyncService')
          syncConversationGroupOnJoin(supabase, Number(id), Number(company_id), io, { skipIfRecent: true }).catch(() => {})
        } else {
          const { syncConversationContactOnJoin } = require('../../services/ultramsgSyncContact')
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
