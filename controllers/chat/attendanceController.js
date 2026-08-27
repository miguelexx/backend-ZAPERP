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
 * controllers/chat/attendanceController.js — Atendimento: assumir/encerrar/reabrir/transferir, fila, atendentes e status manual. Preserva estados de atendimento, permissões e lock realtime.
 * Invariantes: isolamento por company_id; permissões/visibilidade; status unidirecional; sem retry cego.
 */

// =====================================================
// 5) assumirChat (lock real)
// =====================================================
exports.assumirChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params

    const result = await executarAssumirConversa({
      company_id,
      conversa_id,
      user_id,
      perfil,
      departamento_ids
    })
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error })
    }

    const io = req.app.get('io')
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

    return res.json({ ok: true, conversa: result.conversa })
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
      .update({
        status_atendimento: 'fechada',
        finalizacao_motivo: null,
        finalizada_automaticamente: false,
        finalizada_automaticamente_em: null,
        aguardando_cliente_desde: null,
        ausencia_mensagem_enviada_em: null,
        pagamento_prazo_ate: null,
        pagamento_prazo_origem: null,
        pagamento_concluido_em: null,
        reaberta_falta_interacao_em: null,
      })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .select()
      .single()

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const { resetOpcaoInvalidaLimitForConversa } = require('../../services/chatbotTriageService')
    // Paralelo: resetOpcaoInvalidaLimit não tem dependência do resultado de registrarAtendimento
    const [, resultAt] = await Promise.all([
      resetOpcaoInvalidaLimitForConversa(supabase, company_id, conversa_id),
      registrarAtendimento({
        conversa_id,
        company_id,
        acao: 'encerrou',
        de_usuario_id: user_id
      }),
    ])
    if (resultAt.error) { console.error('[chatController]', resultAt.error?.message); return res.status(500).json({ error: 'Erro interno' }) }

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
        const { getChatbotConfig, buildMensagemFinalizacao } = require('../../services/chatbotTriageService')
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
              const whatsappInstanceId = await resolveConversationWhatsappInstance(company_id, data)
              const { getProvider } = require('../../services/providers')
              const provider = getProvider()
              if (provider?.sendText) {
                const resultSend = await provider.sendText(telefoneParaEnvio, msg, {
                  companyId: company_id,
                  conversaId: conversa_id,
                  whatsappInstanceId: whatsappInstanceId || undefined,
                  sendOrigin: 'mensagem_finalizacao_atendimento',
                })
                const finalizacaoMessageId = resultSend?.messageId ? String(resultSend.messageId).trim() : null
                const finalizacaoTraceable = isRealWhatsAppId(finalizacaoMessageId)
                const statusMsg = resultSend?.ok ? (finalizacaoTraceable ? 'sent' : 'pending') : 'erro'
                const statusMensagem = resultSend?.ok ? (finalizacaoTraceable ? 'sent' : 'sending') : 'failed'
                const { data: msgInsert, error: errInsert } = await supabase
                  .from('mensagens')
                  .insert({
                    conversa_id: Number(conversa_id),
                    texto: msg,
                    direcao: 'out',
                    company_id,
                    status: statusMsg,
                    status_mensagem: statusMensagem,
                    ...(finalizacaoTraceable ? { whatsapp_id: finalizacaoMessageId } : {}),
                    ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
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

    // Reabrir já assume automaticamente para quem clicou — sem setor (fila geral / visível a todos).
    const assumidaEm = new Date().toISOString()
    await resetAlertaSemRespostaAoAssumirReaberta(company_id, conversa_id, assumidaEm, {
      reaberta_falta_interacao_em: perm.conv?.reaberta_falta_interacao_em,
    })

    const baseReabrirPatch = {
      status_atendimento: 'em_atendimento',
      atendente_id: user_id,
      atendente_atribuido_em: assumidaEm,
      departamento_id: null,
      finalizacao_motivo: null,
      finalizada_automaticamente: false,
      finalizada_automaticamente_em: null,
      aguardando_cliente_desde: null,
      ausencia_mensagem_enviada_em: null,
    }
    const optionalReabrirPatch = {
      pagamento_prazo_ate: null,
      pagamento_prazo_origem: null,
      pagamento_concluido_em: null,
      reaberta_falta_interacao_em: null,
    }

    let { data, error } = await supabase
      .from('conversas')
      .update({ ...baseReabrirPatch, ...optionalReabrirPatch })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .eq('status_atendimento', perm.conv.status_atendimento) // LOCK REAL: só reabre se o status não mudou desde a checagem de permissão
      .select()
      .maybeSingle()

    if (error && /column|schema cache/i.test(String(error.message || ''))) {
      ;({ data, error } = await supabase
        .from('conversas')
        .update(baseReabrirPatch)
        .eq('company_id', company_id)
        .eq('id', conversa_id)
        .eq('status_atendimento', perm.conv.status_atendimento)
        .select()
        .maybeSingle())
    }

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    if (!data) {
      return res.status(409).json({ error: 'Esta conversa já foi reaberta por outra pessoa' })
    }

    await clearReabertaFaltaInteracao(company_id, conversa_id)

    const resultAt = await registrarAtendimento({
      conversa_id,
      company_id,
      acao: 'reabriu',
      de_usuario_id: user_id
    })
    if (resultAt.error) { console.error('[chatController]', resultAt.error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.CONVERSA_REABERTA || 'conversa_reaberta',
        {
          ...data,
          lista_realtime: { minha_fila: true, motivo: 'reaberta_assumida_automaticamente' }
        }
      )
      emitirLock(io, conversa_id, user_id)
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
// Modo simples: marcar como lida (sai de Aguardando atendente)
// =====================================================
exports.marcarLidaModoSimplesChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const conversa_id = Number(req.params.id)
    if (!Number.isFinite(conversa_id) || conversa_id <= 0) {
      return res.status(400).json({ error: 'ID da conversa inválido' })
    }

    const modoSimplesAtivo = await empresaModoSimplesAtivo(company_id)
    if (!modoSimplesAtivo) {
      return res.status(400).json({ error: 'Modo simples de atendimento não está ativo' })
    }

    const perm = await assertPermissaoConversa({
      company_id,
      conversa_id,
      user_id,
      role: perfil,
      user_dep_ids: departamento_ids,
    })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    const conv = perm.conv
    const isGroup = isGroupConversation(conv)

    const { data: convModoSimples, error: convModoErr } = await supabase
      .from('conversas')
      .select('id, tipo, telefone, status_atendimento, modo_simples_aguardando')
      .eq('company_id', Number(company_id))
      .eq('id', conversa_id)
      .maybeSingle()
    if (convModoErr) {
      return res.status(500).json({ error: convModoErr.message || 'Erro ao carregar conversa' })
    }
    if (!convModoSimples) {
      return res.status(404).json({ error: 'Conversa não encontrada' })
    }

    const unreadMap = await obterUnreadMap({ company_id, usuario_id: user_id })
    const unreadCount = unreadMap[conversa_id] || 0
    let aguardandoAtendente = rowAguardandoAtendenteModoSimples(convModoSimples, unreadCount)

    if (!aguardandoAtendente && !isGroup) {
      const lastMsg = await getUltimaMensagemReal(conversa_id, company_id)
      if (resolverModoSimplesAguardando(lastMsg) === 'atendente') {
        aguardandoAtendente = true
      }
    }

    const payloadBase = {
      id: conversa_id,
      lida: true,
      tem_novas_mensagens: false,
      tem_novas_mensagens_em_atendimento: false,
      unread_count: 0,
      modo_simples_aguardando: null,
      atendimento_modo_simples: true,
    }
    const eventPayload = aplicarModoSimplesNoPayload(payloadBase, payloadBase, true)

    if (!aguardandoAtendente) {
      return res.json({ ok: true, already_cleared: true, conversa: eventPayload })
    }

    await marcarComoLidaPorUsuario({ company_id, conversa_id, usuario_id: user_id })

    const limpar = await limparAguardandoAtendenteModoSimples({
      company_id,
      conversa_id,
      isGroup,
    })
    if (!limpar.ok) return res.status(limpar.status || 500).json({ error: limpar.error })

    const io = req.app.get('io')
    if (io) {
      emitirParaUsuario(io, user_id, io.EVENTS?.MENSAGENS_LIDAS || 'mensagens_lidas', {
        conversa_id,
      })
      emitirConversaAtualizada(io, company_id, conversa_id, eventPayload, { skipAtualizarConversa: true })
    }

    return res.json({ ok: true, conversa: eventPayload })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao marcar conversa como lida' })
  }
}

// =====================================================
// Status manual: aguardando cliente / retomar em atendimento
// =====================================================
exports.marcarAguardandoClienteManualChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params
    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_ids: departamento_ids })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })
    if (perm.conv && isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Indisponível para conversas de grupo' })
    }
    const result = await marcarAguardandoClienteManual({ company_id, conversa_id, usuario_id: user_id })
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    const io = req.app.get('io')
    if (io && result.conversa) {
      const payloadAtualizacao = {
        ...result.conversa,
        status_atendimento_real: result.conversa.status_atendimento ?? null,
        aguardando_cliente_desde: result.conversa.aguardando_cliente_desde ?? null,
        lista_realtime: { minha_fila: true, motivo: 'manual_aguardando_cliente' },
      }
      emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada', {
        ...payloadAtualizacao,
      })
      emitirConversaAtualizada(io, company_id, conversa_id, payloadAtualizacao, { skipAtualizarConversa: true })
      emitirSincronizacaoListaConversas(io, company_id, conversa_id)
    }
    return res.json({ ok: true, conversa: result.conversa, idempotent: !!result.idempotent })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao marcar aguardando cliente' })
  }
}

exports.marcarAguardandoPagamentoFinanceiroChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params
    const { prazo, data } = req.body || {}
    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_ids: departamento_ids })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })
    if (perm.conv && isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Indisponível para conversas de grupo' })
    }
    const result = await marcarAguardandoPagamento({
      company_id,
      conversa_id,
      usuario_id: user_id,
      departamento_ids,
      prazo,
      data,
    })
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    const io = req.app.get('io')
    if (io && result.conversa) {
      const payloadAtualizacao = {
        ...result.conversa,
        status_atendimento_real: result.conversa.status_atendimento ?? null,
        pagamento_prazo_ate: result.conversa.pagamento_prazo_ate ?? null,
        pagamento_prazo_origem: result.conversa.pagamento_prazo_origem ?? null,
        pagamento_concluido_em: null,
        lista_realtime: { minha_fila: true, motivo: 'financeiro_aguardando_pagamento' },
      }
      emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada', {
        ...payloadAtualizacao,
      })
      emitirConversaAtualizada(io, company_id, conversa_id, payloadAtualizacao, { skipAtualizarConversa: true })
      emitirSincronizacaoListaConversas(io, company_id, conversa_id)
    }
    return res.json({ ok: true, conversa: result.conversa, idempotent: !!result.idempotent })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao marcar aguardando pagamento' })
  }
}

exports.retomarEmAtendimentoManualChat = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params
    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_ids: departamento_ids })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })
    if (perm.conv && isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Indisponível para conversas de grupo' })
    }

    const stConv = String(perm.conv?.status_atendimento || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
    const isCobrancaFinanceira =
      stConv === 'pagamento_pendente' || stConv === 'em_atraso'
    const result = isCobrancaFinanceira
        ? await retomarDeCobrancaFinanceira({
            company_id,
            conversa_id,
            usuario_id: user_id,
            departamento_ids,
          })
        : await retomarEmAtendimentoManual({ company_id, conversa_id, usuario_id: user_id })
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    const io = req.app.get('io')
    if (io && result.conversa) {
      const payloadAtualizacao = {
        ...result.conversa,
        status_atendimento_real: result.conversa.status_atendimento ?? null,
        aguardando_cliente_desde: result.conversa.aguardando_cliente_desde ?? null,
        pagamento_prazo_ate: result.conversa.pagamento_prazo_ate ?? null,
        pagamento_prazo_origem: result.conversa.pagamento_prazo_origem ?? null,
        pagamento_concluido_em: result.conversa.pagamento_concluido_em ?? null,
        lista_realtime: { minha_fila: true, motivo: 'manual_retomar_em_atendimento' },
      }
      emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.CONVERSA_ATUALIZADA || 'conversa_atualizada', {
        ...payloadAtualizacao,
      })
      emitirConversaAtualizada(io, company_id, conversa_id, payloadAtualizacao, { skipAtualizarConversa: true })
      emitirSincronizacaoListaConversas(io, company_id, conversa_id)
    }
    return res.json({ ok: true, conversa: result.conversa, idempotent: !!result.idempotent })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao retomar em atendimento' })
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

    // LOCK REAL: só transfere se o atendente atual ainda for o mesmo observado na checagem de permissão
    let queryTransferir = supabase
      .from('conversas')
      .update({
        atendente_id: para_usuario_id,
        status_atendimento: 'em_atendimento',
        atendente_atribuido_em: new Date().toISOString()
      })
      .eq('company_id', company_id)
      .eq('id', conversa_id)
    queryTransferir = perm.conv.atendente_id == null
      ? queryTransferir.is('atendente_id', null)
      : queryTransferir.eq('atendente_id', perm.conv.atendente_id)

    const { data, error } = await queryTransferir.select().maybeSingle()

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    if (!data) {
      return res.status(409).json({ error: 'Esta conversa já foi transferida ou assumida por outra pessoa' })
    }

    const resultAt = await registrarAtendimento({
      conversa_id,
      company_id,
      acao: 'transferiu',
      de_usuario_id: user_id,
      para_usuario_id,
      observacao
    })
    if (resultAt.error) { console.error('[chatController]', resultAt.error?.message); return res.status(500).json({ error: 'Erro interno' }) }

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

      try {
        const { scheduleHandoffFcmPush } = require('../../services/pushNotificationService')
        scheduleHandoffFcmPush({
          empresa_id: Number(company_id),
          usuario_id: Number(para_usuario_id),
          conversa_id: Number(conversa_id),
          nomeCliente,
          transferido_por_nome: fromNome,
        })
      } catch (_) {}
      
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
      await emitirMovimentacaoInternaAtendimento(io, {
        company_id,
        conversa: data,
        atendimento: resultAt.atendimento,
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
// =====================================================
// participantes do atendimento (nao transfere atendente principal)
// =====================================================
exports.listarAtendentesDisponiveisConversa = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_ids: departamento_ids })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })
    if (perm.conv && isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Nao e possivel adicionar atendente em conversa de grupo.' })
    }

    const participanteIds = new Set(await getConversaParticipanteIdsAtivos(company_id, conversa_id))
    if (perm.conv?.atendente_id != null) participanteIds.add(Number(perm.conv.atendente_id))

    const { data, error } = await supabase
      .from('usuarios')
      .select('id, nome, email, perfil, departamento_id')
      .eq('company_id', Number(company_id))
      .eq('ativo', true)
      .order('nome', { ascending: true })

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    return res.json((data || [])
      .filter((u) => ['atendente', 'supervisor', 'admin'].includes(String(u.perfil || '').toLowerCase()))
      .filter((u) => !participanteIds.has(Number(u.id)))
      .map((u) => ({
        usuario_id: Number(u.id),
        id: Number(u.id),
        nome: u.nome || null,
        email: u.email || null,
        perfil: u.perfil || null,
        departamento_id: u.departamento_id ?? null,
      })))
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar atendentes disponiveis' })
  }
}

exports.removerAtendenteConversa = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id, usuario_id: usuarioParaRemoverId } = req.params

    const uidRemover = Number(usuarioParaRemoverId)
    if (!Number.isInteger(uidRemover) || uidRemover <= 0) {
      return res.status(400).json({ error: 'usuario_id inválido' })
    }

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_ids: departamento_ids })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    // Responsável principal não pode ser removido — transferir é o fluxo correto
    if (perm.conv?.atendente_id && Number(perm.conv.atendente_id) === uidRemover) {
      return res.status(409).json({ error: 'O responsável principal não pode ser removido. Use Transferir.' })
    }

    // Verifica se existe participação ativa
    const { data: participante } = await supabase
      .from('conversa_atendentes')
      .select('id')
      .eq('company_id', Number(company_id))
      .eq('conversa_id', Number(conversa_id))
      .eq('usuario_id', uidRemover)
      .eq('ativo', true)
      .maybeSingle()

    if (!participante) {
      return res.status(404).json({ error: 'Participante não encontrado nesta conversa' })
    }

    // Soft-delete: marca como inativo com timestamp e quem removeu
    const updatePayload = { ativo: false }
    try {
      updatePayload.removido_em = new Date().toISOString()
      updatePayload.removido_por = Number(user_id)
    } catch (_) {}

    const { data: updated, error: updateErr } = await supabase
      .from('conversa_atendentes')
      .update(updatePayload)
      .eq('id', participante.id)
      .eq('ativo', true)
      .select('id')
      .maybeSingle()

    if (updateErr) {
      return res.status(500).json({ error: 'Erro ao remover atendente' })
    }

    if (!updated) {
      return res.status(409).json({ error: 'Conflito: participante já foi removido por outra operação' })
    }

    const { data: removedUser } = await supabase
      .from('usuarios')
      .select('nome')
      .eq('company_id', Number(company_id))
      .eq('id', uidRemover)
      .maybeSingle()
    const { data: byUser } = await supabase
      .from('usuarios')
      .select('nome')
      .eq('company_id', Number(company_id))
      .eq('id', Number(user_id))
      .maybeSingle()

    await registrarAtendimento({
      conversa_id,
      company_id,
      acao: 'removeu_atendente',
      de_usuario_id: user_id,
      para_usuario_id: uidRemover,
      observacao: `${byUser?.nome || 'Usuário'} removeu ${removedUser?.nome || 'atendente'} do atendimento.`,
    })

    invalidateConversaVisibilityCache(company_id, conversa_id)

    const io = req.app.get('io')
    if (io) {
      const payload = {
        conversa_id: Number(conversa_id),
        company_id: Number(company_id),
        usuario_id: uidRemover,
        removido_por: Number(user_id),
      }
      emitirParaUsuario(io, uidRemover, 'conversa_atendente_removido', payload)
      emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id), company_id: Number(company_id) })
      emitirSincronizacaoListaConversas(io, company_id, conversa_id)
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error('[removerAtendenteConversa]', err)
    return res.status(500).json({ error: 'Erro ao remover atendente da conversa' })
  }
}

exports.listarAtendentesConversa = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_ids: departamento_ids })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    const { data: participantes, error } = await supabase
      .from('conversa_atendentes')
      .select('id, usuario_id, adicionado_por, ativo, criado_em')
      .eq('company_id', Number(company_id))
      .eq('conversa_id', Number(conversa_id))
      .eq('ativo', true)
      .order('criado_em', { ascending: true })

    if (error) {
      if (isConversaAtendentesMissingTable(error)) return res.json([])
      console.error('[chatController] conversa_atendentes', error?.message)
      return res.status(500).json({ error: 'Erro interno' })
    }

    const ids = [...new Set([
      ...(perm.conv?.atendente_id != null ? [Number(perm.conv.atendente_id)] : []),
      ...(participantes || []).map((p) => Number(p.usuario_id)),
      ...(participantes || []).map((p) => Number(p.adicionado_por)).filter(Boolean),
    ])]

    let userMap = new Map()
    if (ids.length > 0) {
      const { data: usuarios } = await supabase
        .from('usuarios')
        .select('id, nome, email, perfil')
        .eq('company_id', Number(company_id))
        .in('id', ids)
      userMap = new Map((usuarios || []).map((u) => [Number(u.id), u]))
    }

    const principal = perm.conv?.atendente_id != null
      ? [{
          usuario_id: Number(perm.conv.atendente_id),
          id: null,
          tipo: 'principal',
          ativo: true,
          criado_em: null,
          usuario: userMap.get(Number(perm.conv.atendente_id)) || null,
          adicionado_por_usuario: null,
        }]
      : []

    const adicionais = (participantes || []).map((p) => ({
      id: Number(p.id),
      usuario_id: Number(p.usuario_id),
      tipo: 'participante',
      ativo: p.ativo === true,
      criado_em: p.criado_em,
      usuario: userMap.get(Number(p.usuario_id)) || null,
      adicionado_por_usuario: p.adicionado_por ? (userMap.get(Number(p.adicionado_por)) || null) : null,
    }))

    return res.json([...principal, ...adicionais])
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar atendentes da conversa' })
  }
}

exports.adicionarAtendenteConversa = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const { id: conversa_id } = req.params
    const usuario_id = Number(req.body?.usuario_id ?? req.body?.para_usuario_id)

    if (!Number.isInteger(usuario_id) || usuario_id <= 0) {
      return res.status(400).json({ error: 'usuario_id e obrigatorio' })
    }

    const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role: perfil, user_dep_ids: departamento_ids })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })
    if (perm.conv && isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Nao e possivel adicionar atendente em conversa de grupo.' })
    }
    if (isClosedAttendanceStatus(perm.conv?.status_atendimento)) {
      return res.status(409).json({ error: 'Reabra a conversa antes de adicionar atendente.' })
    }
    if (perm.conv?.atendente_id && Number(perm.conv.atendente_id) === usuario_id) {
      return res.status(409).json({ error: 'Este atendente ja e o responsavel principal da conversa.' })
    }

    const { data: targetUser, error: userError } = await supabase
      .from('usuarios')
      .select('id, nome, email, perfil, ativo')
      .eq('company_id', Number(company_id))
      .eq('id', usuario_id)
      .eq('ativo', true)
      .maybeSingle()

    if (userError) return res.status(500).json({ error: 'Erro ao validar atendente' })
    if (!targetUser) return res.status(404).json({ error: 'Atendente nao encontrado ou inativo' })

    const perfilDestino = String(targetUser.perfil || '').toLowerCase()
    if (!['atendente', 'supervisor', 'admin'].includes(perfilDestino)) {
      return res.status(400).json({ error: 'Usuario selecionado nao possui perfil de atendimento' })
    }

    if (await usuarioParticipaAtivamenteDaConversa(company_id, conversa_id, usuario_id)) {
      return res.status(409).json({ error: 'Este atendente ja participa da conversa.' })
    }

    const participantesAtivos = await getConversaParticipanteIdsAtivos(company_id, conversa_id)
    if (participantesAtivos.length >= 3) {
      return res.status(409).json({ error: 'Limite de 4 atendentes por conversa atingido (1 principal + 3 co-atendentes).' })
    }

    const { data: inserted, error: insertError } = await supabase
      .from('conversa_atendentes')
      .insert({
        company_id: Number(company_id),
        conversa_id: Number(conversa_id),
        usuario_id,
        adicionado_por: Number(user_id),
        ativo: true,
      })
      .select('id, company_id, conversa_id, usuario_id, adicionado_por, ativo, criado_em')
      .single()

    if (insertError) {
      if (String(insertError?.code || '') === '23505') {
        return res.status(409).json({ error: 'Este atendente ja participa da conversa.' })
      }
      return res.status(500).json({ error: insertError.message })
    }

    const { data: fromUser } = await supabase
      .from('usuarios')
      .select('nome')
      .eq('company_id', Number(company_id))
      .eq('id', Number(user_id))
      .maybeSingle()
    const fromNome = (fromUser?.nome && String(fromUser.nome).trim()) || 'Atendente'
    const targetNome = (targetUser?.nome && String(targetUser.nome).trim()) || 'atendente'

    await registrarAtendimento({
      conversa_id,
      company_id,
      acao: 'adicionou_atendente',
      de_usuario_id: user_id,
      para_usuario_id: usuario_id,
      observacao: `${fromNome} adicionou ${targetNome} ao atendimento.`,
    })

    invalidateConversaVisibilityCache(company_id, conversa_id)

    const io = req.app.get('io')
    if (io) {
      const payload = {
        conversa_id: Number(conversa_id),
        company_id: Number(company_id),
        usuario_id,
        adicionado_por: Number(user_id),
        participante: inserted,
        lista_realtime: { minha_fila: true, motivo: 'atendente_adicionado' },
      }
      emitirParaUsuario(io, usuario_id, 'conversa_atendente_adicionado', payload)
      emitirConversaAtualizada(io, company_id, conversa_id, { id: Number(conversa_id), company_id: Number(company_id) })
      emitirSincronizacaoListaConversas(io, company_id, conversa_id)
    }

    return res.status(201).json({
      ok: true,
      participante: inserted,
      usuario: {
        id: Number(targetUser.id),
        nome: targetUser.nome || null,
        email: targetUser.email || null,
        perfil: targetUser.perfil || null,
      },
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao adicionar atendente a conversa' })
  }
}

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

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

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

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

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
        .in('status_atendimento', ['em_atendimento', 'aguardando_cliente'])
      if (count >= limite) {
        return res.status(409).json({ error: `Limite de ${limite} conversas simultâneas atingido. Encerre uma antes de puxar outra.` })
      }
    }

    const assumidaEm = new Date().toISOString()

    await resetAlertaSemRespostaAoAssumirReaberta(company_id, conversa.id, assumidaEm, {
      reaberta_falta_interacao_em: conversa.reaberta_falta_interacao_em,
    })

    const { data: atualizada, error: errUpdate } = await supabase
      .from('conversas')
      .update({
        atendente_id: user_id,
        status_atendimento: 'em_atendimento',
        lida: true,
        atendente_atribuido_em: assumidaEm,
        reaberta_falta_interacao_em: null,
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

    await clearReabertaFaltaInteracao(company_id, conversa.id)

    const resultAt = await registrarAtendimento({
      conversa_id: conversa.id,
      company_id,
      acao: 'assumiu',
      de_usuario_id: user_id,
      para_usuario_id: user_id, // ✅ corrigido
      observacao: 'Puxou da fila'
    })
    if (resultAt.error) { console.error('[chatController]', resultAt.error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const io = req.app.get('io')
    if (io) {
      emitirConversaAtualizada(io, company_id, conversa.id, { id: Number(conversa.id) })
      emitirLock(io, conversa.id, user_id)
      await emitirMovimentacaoInternaAtendimento(io, {
        company_id,
        conversa: atualizada,
        atendimento: resultAt.atendimento,
      })
    }

    return res.json({ conversa_id: conversa.id })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao puxar conversa da fila' })
  }
}

exports.finalizacaoAusenciaLoteAuth = async (req, res) => {
  try {
    const company_id = Number(req.user?.company_id)
    if (!Number.isFinite(company_id) || company_id <= 0) {
      return res.status(400).json({ error: 'company_id inválido na sessão' })
    }
    const { finalizeAbsenceForConversaIds } = require('../../services/absenceFinalizationService')
    const body = req.body || {}
    const result = await finalizeAbsenceForConversaIds({
      company_id,
      conversa_ids: body.conversa_ids,
      dryRun: !!body.dry_run,
      execute: body.execute === true,
      confirm: body.confirm,
    })
    if (!result.ok) return res.status(400).json({ error: result.error || 'Falha na operação' })
    return res.json(result)
  } catch (err) {
    console.error('finalizacaoAusenciaLoteAuth:', err)
    return res.status(500).json({ error: 'Erro interno' })
  }
}

