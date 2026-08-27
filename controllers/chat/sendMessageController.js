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
const {
  _reenviosEmAndamento,
  _STATUS_REENVIO_PERMITIDO,
  _STATUS_JA_RESOLVIDO,
  statusReenvioNormalizado,
  avaliarElegibilidadeReenvio,
  resolverTelefoneEnvioDaConversa,
  captionUsuarioDeMidiaPersistida,
  aplicarResultadoReenvio,
  prepararReenvio,
} = require('./resendService')
const {
  IMAGE_FILE_EXTENSIONS,
  VIDEO_FILE_EXTENSIONS,
  ULTRAMSG_VIDEO_FILE_EXTENSIONS,
  ULTRAMSG_VIDEO_MAX_BYTES,
  ULTRAMSG_VIDEO_TARGET_BYTES,
  AUDIO_FILE_EXTENSIONS,
  DOCUMENT_FILE_EXTENSIONS,
  MAX_ARQUIVOS_LOTE_ENVIO,
  MAX_MEDIA_CAPTION_CHARS,
  MAX_ENC_AMINHAR_LOTE,
  mimeBase,
  extBaseArquivo,
  isForcedVoiceAudioish,
  aplicarTipoForcadoSticker,
  inferirTipoArquivo,
  getAudioFileExtension,
  resolveFfmpegPath,
  convertAudioWithFfmpeg,
  probeAudioDurationSec,
  normalizeAudioForUltraMsg,
  shouldAbortAudioAfterNormalize,
  shouldNormalizeVideoForUltraMsg,
  shouldForceProviderUploadForMedia,
  buildVideoTranscodeProfile,
  probeVideoDurationSec,
  convertVideoToUltraMsgMp4,
  normalizeVideoForUltraMsg,
  shouldNormalizeImageForWhatsapp,
  convertImageToWhatsappJpeg,
  normalizeImageForWhatsapp,
  dedupeMulterFiles,
  enviarArquivoProcessarUm,
  collectOrderedMessageIds,
  normalizeForwardTipo,
  getForwardMediaUrlCandidate,
  safeDecodeURIComponent,
  resolveLocalUploadPathFromMediaUrl,
  downloadR2MediaToTemp,
  resolveForwardMediaForProvider,
  encaminharUmaMensagemParaConversa,
} = require('./mediaProcessing')
const {
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
} = require('./sendShared')
const {
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
} = require('./realtime')
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
 * controllers/chat/sendMessageController.js — Envio não-mídia: texto, PIX (config+envio), localização, contato e ligação. Idempotência via sendShared; emissão via realtime.
 * Invariantes: isolamento por company_id; permissões/visibilidade; status unidirecional; sem retry cego.
 */

function sanitizePixConfigPayload(body = {}) {
  const allowedTipos = new Set(['cpf', 'cnpj', 'email', 'telefone', 'aleatoria'])
  const tipo_chave = String(body?.tipo_chave || '').trim().toLowerCase()
  const chave_pix = String(body?.chave_pix || '').trim()
  const nome_recebedor = String(body?.nome_recebedor || '').trim()
  const mensagem_padrao = String(body?.mensagem_padrao || '').trim()

  if (!allowedTipos.has(tipo_chave)) {
    return { ok: false, status: 400, error: 'tipo_chave inválido. Use: cpf, cnpj, email, telefone ou aleatoria.' }
  }
  if (!chave_pix) {
    return { ok: false, status: 400, error: 'chave_pix é obrigatória.' }
  }
  if (!nome_recebedor) {
    return { ok: false, status: 400, error: 'nome_recebedor é obrigatório.' }
  }

  return {
    ok: true,
    data: {
      tipo_chave,
      chave_pix: chave_pix.slice(0, 200),
      nome_recebedor: nome_recebedor.slice(0, 120),
      mensagem_padrao: mensagem_padrao ? mensagem_padrao.slice(0, 500) : null,
    }
  }
}

function formatPixTipoLabel(tipo) {
  const t = String(tipo || '').trim().toLowerCase()
  if (t === 'cpf') return 'CPF'
  if (t === 'cnpj') return 'CNPJ'
  if (t === 'email') return 'E-mail'
  if (t === 'telefone') return 'Telefone'
  if (t === 'aleatoria') return 'Chave aleatória'
  return t || 'Chave Pix'
}

function buildPixMessageFromConfig(cfg) {
  const tipoLabel = formatPixTipoLabel(cfg?.tipo_chave)
  const extra = cfg?.mensagem_padrao ? `\n\n${String(cfg.mensagem_padrao).trim()}` : ''
  return [
    'Segue a chave Pix para pagamento:',
    '',
    `Nome: ${String(cfg?.nome_recebedor || '').trim()}`,
    `Tipo da chave: ${tipoLabel}`,
    `Chave Pix: ${String(cfg?.chave_pix || '').trim()}`,
    extra,
    '',
    'Após o pagamento, por favor envie o comprovante por aqui.'
  ].join('\n').trim()
}

/** GET /chats/pix-config */
exports.getPixConfig = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('empresa_pix_config')
      .select('tipo_chave, chave_pix, nome_recebedor, mensagem_padrao, atualizado_em')
      .eq('company_id', Number(company_id))
      .maybeSingle()

    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('empresa_pix_config') || msg.includes('does not exist')) {
        return res.json({ configured: false, config: null })
      }
      console.error('[chatController] getPixConfig', error?.message)
      return res.status(500).json({ error: 'Erro interno' })
    }

    if (!data) return res.json({ configured: false, config: null })
    return res.json({ configured: true, config: data })
  } catch (err) {
    console.error('[getPixConfig]', err)
    return res.status(500).json({ error: 'Erro ao obter configuração Pix.' })
  }
}

/** PUT /chats/pix-config */
exports.putPixConfig = async (req, res) => {
  try {
    const { company_id, id: user_id } = req.user
    const parsed = sanitizePixConfigPayload(req.body)
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error })

    const payload = {
      company_id: Number(company_id),
      ...parsed.data,
      atualizado_por: Number(user_id),
      atualizado_em: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('empresa_pix_config')
      .upsert(payload, { onConflict: 'company_id' })
      .select('tipo_chave, chave_pix, nome_recebedor, mensagem_padrao, atualizado_em')
      .single()

    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('empresa_pix_config') || msg.includes('does not exist') || msg.includes('schema cache')) {
        return res.status(400).json({
          error: 'Funcionalidade Pix ainda não habilitada no banco. Aplique a migration 20260427233000_empresa_pix_config.sql e tente novamente.'
        })
      }
      console.error('[chatController] putPixConfig', error?.message)
      return res.status(500).json({ error: 'Erro interno' })
    }
    return res.json({ ok: true, config: data })
  } catch (err) {
    console.error('[putPixConfig]', err)
    return res.status(500).json({ error: 'Erro ao salvar configuração Pix.' })
  }
}

/** POST /chats/:id/pix — envia mensagem Pix usando o mesmo fluxo de envio/realtime existente */
exports.enviarMensagemPix = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('empresa_pix_config')
      .select('tipo_chave, chave_pix, nome_recebedor, mensagem_padrao')
      .eq('company_id', Number(company_id))
      .maybeSingle()

    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('empresa_pix_config') || msg.includes('does not exist') || msg.includes('schema cache')) {
        return res.status(400).json({
          error: 'Funcionalidade Pix ainda não habilitada no banco. Aplique a migration 20260427233000_empresa_pix_config.sql.'
        })
      }
      console.error('[chatController] enviarMensagemPix', error?.message)
      return res.status(500).json({ error: 'Erro interno' })
    }
    if (!data) return res.status(400).json({ error: 'Pix não configurado para esta empresa.' })

    const mensagem = buildPixMessageFromConfig(data)
    req.body = { ...req.body, texto: mensagem }
    return exports.enviarMensagemChat(req, res)
  } catch (err) {
    console.error('[enviarMensagemPix]', err)
    return res.status(500).json({ error: 'Erro ao enviar mensagem Pix.' })
  }
}

// =====================================================
// enviarMensagemChat (corrigido + padronizado)
// =====================================================
exports.enviarMensagemChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const { id: conversa_id } = req.params
    const { texto, reply_meta, link, client_temp_id } = req.body
    const clientTempId = normalizeClientTempId(client_temp_id)

    if (!texto || !String(texto).trim()) {
      return res.status(400).json({ error: 'texto é obrigatório' })
    }

    // Deduplicação por client_temp_id em memória: evita double-send por double-click ou retry do frontend.
    // Map com TTL de 30s por (company_id + conversa_id + client_temp_id).
    if (clientTempId) {
      const dedupKey = clientTempIdDedupeKey(company_id, conversa_id, clientTempId)
      const existing = _clientTempIdDeduplicationMap.get(dedupKey)
      if (existing && Date.now() - existing.ts < 30_000) {
        return res.json({
          ok: true,
          id: existing.id,
          conversa_id: Number(conversa_id),
          client_temp_id: clientTempId,
          status: existing.status || 'pending',
          deduplicated: true,
        })
      }
      const persisted = await findMensagemByClientTempId(company_id, conversa_id, clientTempId)
      const persistedResponse = buildClientTempIdDedupResponse(persisted, conversa_id, clientTempId)
      if (persistedResponse) {
        _clientTempIdDeduplicationMap.set(dedupKey, {
          id: persistedResponse.id,
          status: persistedResponse.status,
          ts: Date.now(),
        })
        return res.json(persistedResponse)
      }
    }

    const io = req.app.get('io')
    const modoSimplesEnvio = await empresaModoSimplesAtivo(company_id).catch(() => false)
    const permEnvio = await assertPodeEnviarMensagem({
      company_id,
      conversa_id,
      user_id,
      role: req.user?.perfil,
      user_dep_ids: req.user?.departamento_ids,
      autoAssumirAoEnviar: !modoSimplesEnvio,
      io,
    })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, tipo, nome_contato_cache, foto_perfil_contato_cache, chat_lid, whatsapp_instance_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .single()

    if (errConv || !conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    // Resolver telefone real quando conversa tem apenas LID (lid:xxx) — Z-API não envia para LID
    const whatsappInstanceId = await resolveConversationWhatsappInstance(company_id, conversa)
    let telefoneParaEnvio = conversa.telefone || ''
    if (telefoneParaEnvio && String(telefoneParaEnvio).trim().toLowerCase().startsWith('lid:')) {
      if (conversa.cliente_id) {
        const { data: cli } = await supabase.from('clientes').select('telefone').eq('id', conversa.cliente_id).eq('company_id', company_id).maybeSingle()
        if (cli?.telefone && !String(cli.telefone).startsWith('lid:')) telefoneParaEnvio = cli.telefone
      }
      if (telefoneParaEnvio.startsWith('lid:') && conversa.chat_lid) {
        const telSibling = await resolveTelefoneFromLidSiblingConversation(company_id, conversa, whatsappInstanceId)
        if (telSibling) telefoneParaEnvio = telSibling
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
        const { syncUltraMsgContact } = require('../../services/ultramsgSyncContact')
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

    const linkPayload = normalizeLinkPayload(link)
    const hasLinkPayload = !!linkPayload

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
    if (whatsappInstanceId) basePayload.whatsapp_instance_id = whatsappInstanceId
    if (clientTempId && !_sendMemo.dbDedupeUnavailable) basePayload.client_temp_id = clientTempId
    const payloadWithReply =
      reply_meta && typeof reply_meta === 'object'
        ? {
            ...basePayload,
            reply_meta: {
              name: String(reply_meta.name || '').slice(0, 80),
              snippet: String(reply_meta.snippet || '').slice(0, 180),
              ts: Number(reply_meta.ts || Date.now()),
              replyToId: reply_meta.replyToId != null ? String(reply_meta.replyToId) : undefined,
              ...(reply_meta.thumb
                ? { thumb: String(reply_meta.thumb).slice(0, 500) }
                : {}),
              ...(reply_meta.reply_kind
                ? { reply_kind: String(reply_meta.reply_kind).slice(0, 24) }
                : {}),
            },
          }
        : basePayload

    let msg = null
    let errMsg = null
    let insertPayload = payloadWithReply
    for (let attempt = 0; attempt < 3; attempt++) {
      ;({ data: msg, error: errMsg } = await supabase
        .from('mensagens')
        .insert(insertPayload)
        .select()
        .single())

      if (!errMsg) break

      if (clientTempId && isClientTempIdUniqueViolation(errMsg)) {
        const persisted = await findMensagemByClientTempId(company_id, conversa_id, clientTempId)
        const persistedResponse = buildClientTempIdDedupResponse(persisted, conversa_id, clientTempId)
        if (persistedResponse) {
          _clientTempIdDeduplicationMap.set(clientTempIdDedupeKey(company_id, conversa_id, clientTempId), {
            id: persistedResponse.id,
            status: persistedResponse.status,
            ts: Date.now(),
          })
          return res.json(persistedResponse)
        }
      }

      const missingClientTempId =
        insertPayload.client_temp_id &&
        (isMissingMensagemColumnError(errMsg, 'client_temp_id') || isGenericMissingColumnError(errMsg))
      const missingReplyMeta =
        insertPayload.reply_meta &&
        (isMissingMensagemColumnError(errMsg, 'reply_meta') || (!missingClientTempId && isGenericMissingColumnError(errMsg)))

      if (!missingClientTempId && !missingReplyMeta) break

      insertPayload = { ...insertPayload }
      if (missingClientTempId) {
        delete insertPayload.client_temp_id
        _sendMemo.dbDedupeUnavailable = true
      }
      if (missingReplyMeta) delete insertPayload.reply_meta
    }

    if (errMsg) return res.status(500).json({ error: errMsg.message })

    // Registrar no Map de deduplicação após INSERT bem-sucedido
    if (clientTempId && msg?.id) {
      const dedupKey = clientTempIdDedupeKey(company_id, conversa_id, clientTempId)
      _clientTempIdDeduplicationMap.set(dedupKey, { id: msg.id, status: 'pending', ts: Date.now() })
    }

    // Paralelo: tryMarkWaiting + UPDATE conversas + UPDATE clientes são independentes entre si
    const updateNow = new Date().toISOString()
    const [waitingAfterOutbound, modoSimplesResult] = await Promise.all([
      modoSimplesEnvio
        ? Promise.resolve(null)
        : tryMarkWaitingAfterHumanOutbound({
            company_id,
            conversa_id: Number(conversa_id),
            texto: String(texto || '').trim(),
            criado_em: msg.criado_em,
            autor_usuario_id: Number(user_id),
          }).catch(() => null),
      recalcularEMesclarModoSimples({
        company_id,
        conversa_id: Number(conversa_id),
        mensagemNova: msg,
        io: null,
      }).catch(() => null),
      supabase
        .from('conversas')
        .update({ lida: true, ultima_atividade: updateNow })
        .eq('company_id', Number(company_id))
        .eq('id', Number(conversa_id)),
      isGroup || conversa?.cliente_id == null
        ? Promise.resolve()
        : supabase
            .from('clientes')
            .update({ ultimo_contato: basePayload.criado_em, atualizado_em: updateNow })
            .eq('company_id', Number(company_id))
            .eq('id', Number(conversa.cliente_id)),
    ])

    if (io) {
      const basePayload = { ...msg, id: msg.id, conversa_id: msg.conversa_id ?? Number(conversa_id), status: 'sending', status_mensagem: 'sending', direcao: 'out', ...(clientTempId ? { client_temp_id: clientTempId } : {}) }
      const novaMsgPayload = await enrichMensagemComAutorUsuario(supabase, company_id, basePayload)
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem',
        novaMsgPayload
      )
      // Atualizar sidebar (preview) sem disparar refetch que causa duplicação.
      // Não reenviar foto_perfil: cache e cliente.foto_perfil podem diferir (CDN) e o card “pula”.
      let contatoNome = conversa?.nome_contato_cache ? String(conversa.nome_contato_cache).trim() : null
      const telefoneParaPayload = conversa?.telefone && !String(conversa.telefone).startsWith('lid:') ? String(conversa.telefone).trim() : null
      const whatsappInstanceMetaMap = await loadWhatsappInstanceMetaMap(company_id, [whatsappInstanceId])
      const whatsappInstanceMeta = safeWhatsappInstanceMeta(whatsappInstanceMetaMap.get(Number(whatsappInstanceId)))
      const convPayload = aplicarAguardandoClienteNoPayload({
        id: Number(conversa_id),
        ultima_atividade: novaMsgPayload.criado_em,
        exibir_badge_aberta: true,
        whatsapp_instance_id: whatsappInstanceId ?? conversa?.whatsapp_instance_id ?? null,
        ...whatsappInstanceMeta,
        ...(telefoneParaPayload ? { telefone: telefoneParaPayload } : {}),
        ...(conversa?.cliente_id != null ? { cliente_id: conversa.cliente_id } : {}),
        ...(contatoNome ? { nome_contato_cache: contatoNome, contato_nome: contatoNome } : {}),
        ultima_mensagem_preview: {
          texto: basePayload.texto,
          criado_em: novaMsgPayload.criado_em,
          direcao: 'out',
          fromMe: true,
          usuario_id: novaMsgPayload.usuario_id,
          usuario_nome: novaMsgPayload.usuario_nome,
        },
        reordenar_suave: true // Frontend: animar item para o topo em vez de refetch (evita "desce e sobe")
      }, waitingAfterOutbound, {
        ...(modoSimplesResult?.conversa || {}),
        atendimento_modo_simples: modoSimplesEnvio,
        modo_simples_aguardando: modoSimplesResult?.modo_simples_aguardando ?? null,
      })
      emitirConversaAtualizada(io, company_id, conversa_id, convPayload, { skipAtualizarConversa: true })
    }

    // Envio para WhatsApp via provider (ultramsg, conforme instância configurada)
    let sendResult = null
    if (!telefoneParaEnvio) {
      // Mensagem manual sem telefone: não pode ficar como pending para sempre
      console.warn('[ENVIO_MANUAL] ❌ Conversa sem telefone — mensagem não enviada ao WhatsApp', {
        company_id,
        conversa_id,
        mensagem_id: msg.id,
      })
      await supabase
        .from('mensagens')
        .update({ status: 'erro', status_mensagem: 'failed' })
        .eq('company_id', company_id)
        .eq('id', msg.id)
      const ioNoPhone = req.app.get('io')
      if (ioNoPhone) {
        ioNoPhone.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`)
          .emit('status_mensagem', {
            mensagem_id: msg.id,
            conversa_id: Number(conversa_id),
            status: 'erro',
            status_mensagem: 'failed',
          })
      }
      sendResult = { ok: false, error: 'Número do contato indisponível para envio' }
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

      // Resolve o whatsapp_id real da mensagem citada para enviar reply nativo ao WhatsApp (UltraMsg: body.msgId)
      let replyMessageId = null
      if (reply_meta?.replyToId != null) {
        replyMessageId = await resolveUltraMsgReplyMessageId(supabase, company_id, conversa_id, reply_meta.replyToId)
        if (!replyMessageId) {
          console.warn('[WhatsApp reply] msgId da citação não resolvido — envio sem reply no WhatsApp.', {
            conversa_id,
            replyToId: String(reply_meta.replyToId).slice(0, 96),
          })
        }
      }

      const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, user_id)
      const provider = getProvider()

      // Log de início de envio manual (auditoria e diagnóstico)
      console.log('[ENVIO_MANUAL] Iniciando envio', {
        company_id,
        conversa_id,
        mensagem_id: msg.id,
        telefone_destino: String(telefoneParaEnvio || '').slice(-12),
        whatsapp_instance_id: whatsappInstanceId,
        provedor: 'ultramsg',
        tipo: hasLinkPayload ? 'link' : 'texto',
      })

      try {
        let result = null

        if (hasLinkPayload && provider.sendLink) {
          let messageToSend = String(texto).trim()
          const linkUrlStr = linkPayload.linkUrl
          if (linkUrlStr && !messageToSend.includes(linkUrlStr)) {
            messageToSend = messageToSend ? `${messageToSend} ${linkUrlStr}` : linkUrlStr
          }
          messageToSend = textoParaEnvioWhatsapp(messageToSend, usuarioNome)
          result = await provider.sendLink(telefoneParaEnvio, {
            message: messageToSend,
            image: linkPayload.image || '',
            linkUrl: linkUrlStr,
            title: linkPayload.title || linkUrlStr,
            linkDescription: linkPayload.linkDescription || messageToSend,
          }, {
            companyId: company_id,
            conversaId: conversa_id,
            whatsappInstanceId: whatsappInstanceId || undefined,
            replyMessageId: replyMessageId || undefined,
            sendOrigin: 'atendimento_humano',
          })
        } else {
          const textoParaCliente = textoParaEnvioWhatsapp(String(texto).trim(), usuarioNome)
          result = await provider.sendText(telefoneParaEnvio, textoParaCliente, {
            companyId: company_id,
            conversaId: conversa_id,
            whatsappInstanceId: whatsappInstanceId || undefined,
            phoneId: phoneId || undefined,
            replyMessageId: replyMessageId || undefined,
            referenceId: `crm-${msg.id}`,
            sendOrigin: 'atendimento_humano',
          })
        }

        const ok = typeof result === 'boolean' ? result : result?.ok === true
        const waMessageId = typeof result === 'object' && result?.messageId ? String(result.messageId).trim() : null
        // hasValidId: ID reconhecível como WhatsApp real (hex 12+ chars ou contém @).
        // Usado apenas para salvar whatsapp_id e habilitar rastreamento de ACK.
        // NÃO determina se o envio foi bem-sucedido — isso depende apenas de ok.
        const hasValidId = isRealWhatsAppId(waMessageId)
        const hasQueueId = !!waMessageId && isUltramsgNumericQueueId(waMessageId)
        const providerError = (typeof result === 'object') ? (result?.error || result?.blockedBy || null) : null
        const acceptedWithoutTrace = ok && !hasValidId

        // Regra: sent exige aceite do provider e ID rastreavel.
        // Aceite sem ID rastreavel permanece pending/sending para evitar mensagem fantasma.
        // O whatsapp_id só é salvo quando o ID retornado é um WhatsApp ID rastreável.
        const nextStatus = ok ? (hasValidId ? 'sent' : 'pending') : 'erro'
        const nextStatusMensagem = ok ? (hasValidId ? 'sent' : 'sending') : 'failed'

        if (ok) {
          console.log('[ENVIO_MANUAL] ✅ Sucesso', {
            company_id,
            conversa_id,
            mensagem_id: msg.id,
            telefone_destino: String(telefoneParaEnvio || '').slice(-12),
            whatsapp_instance_id: whatsappInstanceId,
            provedor: 'ultramsg',
            provider_message_id: waMessageId || null,
            whatsapp_id_salvo: hasValidId ? waMessageId : null,
          })
          if (acceptedWithoutTrace) {
            // Provider aceitou a mensagem, mas o ID retornado não é rastreável como WhatsApp ID.
            // Isso é normal quando UltraMsg retorna ID interno de fila (ex: "35096").
            // Não marcar como sent sem ID rastreável; o ACK pode chegar depois via webhook/reconciliação.
            console.warn('[ENVIO_MANUAL] ℹ️ Provider aceitou envio sem WhatsApp ID rastreável', {
              company_id,
              conversa_id,
              mensagem_id: msg.id,
              telefone_destino: String(telefoneParaEnvio || '').slice(-12),
              whatsapp_instance_id: whatsappInstanceId,
              provider_id_recebido: waMessageId || 'NULL',
              nota: 'Mensagem mantida como pending/sending ate chegar ACK rastreavel ou retry confirmar falha.',
            })
          }
        } else {
          console.warn('[ENVIO_MANUAL] ❌ Falha no envio', {
            company_id,
            conversa_id,
            mensagem_id: msg.id,
            telefone_destino: String(telefoneParaEnvio || '').slice(-12),
            whatsapp_instance_id: whatsappInstanceId,
            provedor: 'ultramsg',
            erro: String(providerError || '').slice(0, 200) || 'desconhecido',
          })
        }

        // whatsapp_id só recebe IDs reais do WhatsApp (rastreáveis).
        // IDs de fila numéricos da UltraMsg (ex: "35096") vão para provider_queue_id
        // para permitir reconciliação de ACK sem poluir whatsapp_id com IDs não reais.
        await supabase
          .from('mensagens')
          .update({
            status: nextStatus,
            status_mensagem: nextStatusMensagem,
            ...(hasValidId ? { whatsapp_id: waMessageId } : {}),
            ...(hasQueueId ? { provider_queue_id: waMessageId } : {}),
          })
          .eq('company_id', company_id)
          .eq('id', msg.id)

        if (clientTempId && msg?.id) {
          _clientTempIdDeduplicationMap.set(
            clientTempIdDedupeKey(company_id, conversa_id, clientTempId),
            { id: msg.id, status: nextStatus, ts: Date.now() }
          )
        }

        const io2 = req.app.get('io')
        if (io2) {
          // Emite para empresa, conversa E usuario que enviou (garante ticks ✓✓ em tempo real)
          io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`)
            .emit('status_mensagem', {
              mensagem_id: msg.id,
              conversa_id: Number(conversa_id),
              status: nextStatus,
              status_mensagem: nextStatusMensagem,
              ...(hasValidId ? { whatsapp_id: waMessageId } : {}),
            })
        }

        if (acceptedWithoutTrace) {
          schedulePendingOutboundReconciliation({
            companyId: company_id,
            mensagemId: msg.id,
            io: io2,
          })
        }

        sendResult = result
      } catch (e) {
        console.error('[ENVIO_MANUAL] ❌ Exceção ao enviar mensagem', {
          company_id,
          conversa_id,
          mensagem_id: msg.id,
          telefone_destino: String(telefoneParaEnvio || '').slice(-12),
          whatsapp_instance_id: whatsappInstanceId,
          erro: e?.message || String(e),
        })
        sendResult = { ok: false, error: e?.message || 'Erro ao enviar mensagem' }
        await supabase
          .from('mensagens')
          .update({ status: 'erro', status_mensagem: 'failed' })
          .eq('company_id', company_id)
          .eq('id', msg.id)
        const io2 = req.app.get('io')
        if (io2) {
          io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`)
            .emit('status_mensagem', {
              mensagem_id: msg.id,
              conversa_id: Number(conversa_id),
              status: 'erro',
              status_mensagem: 'failed',
            })
        }
      }
    }

    // Não retornar mensagem completa — evita duplicação no frontend (API + socket).
    // A mensagem chega via socket nova_mensagem (única fonte de verdade para exibição).
    const sendOk = !!telefoneParaEnvio && (typeof sendResult === 'boolean' ? sendResult : sendResult?.ok === true)
    const sendWaMessageId = typeof sendResult === 'object' && sendResult?.messageId ? String(sendResult.messageId).trim() : null
    const sendTraceable = sendOk && isRealWhatsAppId(sendWaMessageId)
    const motivoErro = sendResult?.error || sendResult?.blockedBy
    return res.json({
      ok: true,
      id: msg.id,
      conversa_id: Number(conversa_id),
      ...(clientTempId ? { client_temp_id: clientTempId } : {}),
      ...(sendTraceable ? { status: 'sent', whatsapp_id: sendWaMessageId } : sendOk ? { status: 'pending' } : {
        status: sendResult?.blockedBy ? 'blocked' : 'erro',
        ...(motivoErro ? { motivo: motivoErro } : {})
      })
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao enviar mensagem' })
  }
}

exports.enviarContatoWhatsapp = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const { id: conversa_id } = req.params
    const { cliente_id, messageId } = req.body || {}

    if (!cliente_id) {
      return res.status(400).json({ error: 'cliente_id é obrigatório' })
    }

    const io = req.app.get('io')
    const permEnvio = await assertPodeEnviarMensagem({
      company_id,
      conversa_id,
      user_id,
      role: req.user?.perfil,
      user_dep_ids: req.user?.departamento_ids,
      autoAssumirAoEnviar: true,
      io,
    })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, company_id, chat_lid, whatsapp_instance_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()

    if (errConv || !conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    const whatsappInstanceId = await resolveConversationWhatsappInstance(company_id, conversa)
    let telefoneParaEnvio = conversa.telefone || ''
    if (telefoneParaEnvio && String(telefoneParaEnvio).trim().toLowerCase().startsWith('lid:')) {
      if (conversa.cliente_id) {
        const { data: cliLid } = await supabase.from('clientes').select('telefone').eq('id', conversa.cliente_id).eq('company_id', company_id).maybeSingle()
        if (cliLid?.telefone && !String(cliLid.telefone).startsWith('lid:')) telefoneParaEnvio = cliLid.telefone
      }
      if (telefoneParaEnvio.startsWith('lid:') && conversa.chat_lid) {
        const telSibling = await resolveTelefoneFromLidSiblingConversation(company_id, conversa, whatsappInstanceId)
        if (telSibling) telefoneParaEnvio = telSibling
      }
      if (telefoneParaEnvio.startsWith('lid:')) {
        return res.status(400).json({ error: 'Número do contato indisponível (conversa por LID). Aguarde o contato enviar uma mensagem ou sincronize os contatos.' })
      }
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
        ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
        contact_meta,
      })
      .select()
      .single()

    if (errMsg) {
      return res.status(500).json({ error: errMsg.message })
    }

    let waitingAfterOutbound = null
    try {
      waitingAfterOutbound = await tryMarkWaitingAfterHumanOutbound({
        company_id,
        conversa_id: Number(conversa_id),
        texto: contactName,
        criado_em: criadoEm,
        autor_usuario_id: Number(user_id),
      })
    } catch (_) {}

    const result = await provider.sendContact(telefoneParaEnvio, contactName, contactPhone, {
      companyId: company_id,
      conversaId: Number(conversa_id),
      whatsappInstanceId: whatsappInstanceId || undefined,
      sendOrigin: 'atendimento_humano_contato',
      messageId: messageId || undefined,
      referenceId: `crm-${msg.id}`,
    })
    const ok = typeof result === 'boolean' ? result : result?.ok === true
    const waMessageId =
      typeof result === 'object' && result?.messageId ? String(result.messageId).trim() : null

    const providerErroContato =
      typeof result === 'object' && result?.error ? String(result.error) : null
    const hasTraceableContactId = isRealWhatsAppId(waMessageId)
    const hasQueueContactId = !!waMessageId && isUltramsgNumericQueueId(waMessageId)
    const nextStatus = ok ? (hasTraceableContactId ? 'sent' : 'pending') : 'erro'
    const nextStatusMensagem = ok ? (hasTraceableContactId ? 'sent' : 'sending') : 'erro'
    await supabase
      .from('mensagens')
      .update({ status: nextStatus, status_mensagem: nextStatusMensagem, ...(hasTraceableContactId ? { whatsapp_id: waMessageId } : {}), ...(hasQueueContactId ? { provider_queue_id: waMessageId } : {}) })
      .eq('company_id', company_id)
      .eq('id', msg.id)

    if (io) {
      const payload = await enrichMensagemComAutorUsuario(supabase, company_id, { ...msg, status: nextStatus, status_mensagem: nextStatusMensagem, whatsapp_id: hasTraceableContactId ? waMessageId : null })
      emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', payload)
      const convPayload = aplicarAguardandoClienteNoPayload({
        id: Number(conversa_id),
        ultima_atividade: payload.criado_em || criadoEm,
        ultima_mensagem_preview: {
          texto: contactName,
          criado_em: payload.criado_em || criadoEm,
          direcao: 'out',
          tipo: 'contact',
          contact_meta,
        },
        reordenar_suave: true,
      }, waitingAfterOutbound)
      emitirConversaAtualizada(io, company_id, conversa_id, convPayload, { skipAtualizarConversa: true })
    }

    if (!ok) {
      console.warn('WhatsApp: falha ao enviar contato', {
        mensagem_id: msg.id,
        phone: String(telefoneParaEnvio || '').slice(-12),
        erro: providerErroContato || 'sem detalhes',
      })
    }

    return res.json({
      ok: true,
      id: msg.id,
      conversa_id: Number(conversa_id),
      contact_meta,
      status: nextStatus,
      status_mensagem: nextStatusMensagem,
      ...(hasTraceableContactId ? { whatsapp_id: waMessageId } : {}),
      ...(ok ? {} : { error: providerErroContato || 'Não foi possível enviar o contato ao WhatsApp.' }),
    })
  } catch (err) {
    console.error('Erro ao enviar contato:', err)
    return res.status(500).json({ error: 'Erro ao enviar contato' })
  }
}

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

    const io = req.app.get('io')
    const permEnvio = await assertPodeEnviarMensagem({
      company_id,
      conversa_id,
      user_id,
      role: req.user?.perfil,
      user_dep_ids: req.user?.departamento_ids,
      autoAssumirAoEnviar: true,
      io,
    })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, tipo, nome_contato_cache, foto_perfil_contato_cache, chat_lid, whatsapp_instance_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()

    if (errConv || !conversa) return res.status(404).json({ error: 'Conversa não encontrada' })

    const whatsappInstanceId = await resolveConversationWhatsappInstance(company_id, conversa)
    let telefoneParaEnvio = conversa.telefone || ''
    if (telefoneParaEnvio && String(telefoneParaEnvio).trim().toLowerCase().startsWith('lid:')) {
      if (conversa.cliente_id) {
        const { data: cli } = await supabase.from('clientes').select('telefone').eq('id', conversa.cliente_id).eq('company_id', company_id).maybeSingle()
        if (cli?.telefone && !String(cli.telefone).startsWith('lid:')) telefoneParaEnvio = cli.telefone
      }
      if (telefoneParaEnvio.startsWith('lid:') && conversa.chat_lid) {
        const telSibling = await resolveTelefoneFromLidSiblingConversation(company_id, conversa, whatsappInstanceId)
        if (telSibling) telefoneParaEnvio = telSibling
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
      ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
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

    let waitingAfterOutbound = null
    try {
      waitingAfterOutbound = await tryMarkWaitingAfterHumanOutbound({
        company_id,
        conversa_id: Number(conversa_id),
        texto: textoDisplay,
        criado_em: msg.criado_em || criadoEm,
        autor_usuario_id: Number(user_id),
      })
    } catch (_) {}

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
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'atendimento_humano_localizacao',
        referenceId: `crm-${msg.id}`,
      })
    } else {
      console.warn(`[WhatsApp] Conversa ${conversa_id} sem telefone — localização salva, não enviada ao WhatsApp`)
    }

    const ok = result?.ok === true
    const waMessageId = result?.messageId ? String(result.messageId).trim() : null
    const hasTraceableLocationId = isRealWhatsAppId(waMessageId)
    const hasQueueLocationId = !!waMessageId && isUltramsgNumericQueueId(waMessageId)
    const nextStatus = ok ? (hasTraceableLocationId ? 'sent' : 'pending') : 'erro'
    const nextStatusMensagem = ok ? (hasTraceableLocationId ? 'sent' : 'sending') : 'erro'

    await supabase
      .from('mensagens')
      .update({ status: nextStatus, status_mensagem: nextStatusMensagem, ...(hasTraceableLocationId ? { whatsapp_id: waMessageId } : {}), ...(hasQueueLocationId ? { provider_queue_id: waMessageId } : {}) })
      .eq('company_id', company_id)
      .eq('id', msg.id)

    if (io) {
      const payload = await enrichMensagemComAutorUsuario(supabase, company_id, { ...msg, status: nextStatus, status_mensagem: nextStatusMensagem, whatsapp_id: hasTraceableLocationId ? waMessageId : null, location_meta: msg.location_meta || location_meta })
      emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', payload)
      const convPayload = aplicarAguardandoClienteNoPayload({
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
      }, waitingAfterOutbound)
      emitirConversaAtualizada(io, company_id, conversa_id, convPayload, { skipAtualizarConversa: true })
    }

    const sendOk = !!telefoneParaEnvio && ok

    return res.json({
      ok: true,
      id: msg.id,
      conversa_id: Number(conversa_id),
      location_meta: msg.location_meta || location_meta,
      ...(sendOk && hasTraceableLocationId ? { status: 'sent', whatsapp_id: waMessageId } : sendOk ? { status: 'pending' } : { status: telefoneParaEnvio ? 'erro' : 'pending' })
    })
  } catch (err) {
    console.error('Erro ao enviar localização:', err)
    return res.status(500).json({ error: 'Erro ao enviar localização' })
  }
}

exports.enviarLigacaoWhatsapp = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const { id: conversa_id } = req.params
    const { callDuration } = req.body || {}

    const io = req.app.get('io')
    const permEnvio = await assertPodeEnviarMensagem({
      company_id,
      conversa_id,
      user_id,
      role: req.user?.perfil,
      user_dep_ids: req.user?.departamento_ids,
      autoAssumirAoEnviar: true,
      io,
    })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, company_id, whatsapp_instance_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()

    if (errConv || !conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    const dur = Number(callDuration)
    const safeDur = Number.isFinite(dur) ? Math.max(1, Math.min(15, dur)) : 5
    const whatsappInstanceId = await resolveConversationWhatsappInstance(company_id, conversa)

    const criadoEm = new Date().toISOString()
    const texto = `Ligação via WhatsApp (${safeDur}s)`

    const { data: msg, error: errMsg } = await supabase
      .from('mensagens')
      .insert({
        company_id,
        conversa_id: Number(conversa_id),
        ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
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

    const result = await provider.sendCall(conversa.telefone, safeDur, {
      companyId: company_id,
      conversaId: conversa_id,
      whatsappInstanceId: whatsappInstanceId || undefined,
    })
    const ok = typeof result === 'boolean' ? result : result?.ok === true
    const waMessageId =
      typeof result === 'object' && result?.messageId ? String(result.messageId).trim() : null

    const hasTraceableCallId = isRealWhatsAppId(waMessageId)
    const hasQueueCallId = !!waMessageId && isUltramsgNumericQueueId(waMessageId)
    const nextStatus = ok ? (hasTraceableCallId ? 'sent' : 'pending') : 'erro'
    const nextStatusMensagem = ok ? (hasTraceableCallId ? 'sent' : 'sending') : 'erro'
    await supabase
      .from('mensagens')
      .update({ status: nextStatus, status_mensagem: nextStatusMensagem, ...(hasTraceableCallId ? { whatsapp_id: waMessageId } : {}), ...(hasQueueCallId ? { provider_queue_id: waMessageId } : {}) })
      .eq('company_id', company_id)
      .eq('id', msg.id)

    if (io) {
      const payload = await enrichMensagemComAutorUsuario(supabase, company_id, { ...msg, status: nextStatus, status_mensagem: nextStatusMensagem, whatsapp_id: hasTraceableCallId ? waMessageId : null })
      emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', payload)
      emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id) })
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error('Erro ao registrar ligação:', err)
    return res.status(500).json({ error: 'Erro ao registrar ligação' })
  }
}

