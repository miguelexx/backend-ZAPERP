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
 * controllers/chat/contactController.js — Contatos e integração: vincular cliente, criar/atualizar contato, nome, observações, preferências, status/sync WhatsApp e instâncias de atendimento.
 * Invariantes: isolamento por company_id; permissões/visibilidade; status unidirecional; sem retry cego.
 */

// =====================================================
// 3a) Instâncias WhatsApp ativas (atendimento — sem tokens)
// GET /chats/whatsapp-instances
// =====================================================
exports.listWhatsappInstancesAtendimento = async (req, res) => {
  try {
    const company_id = req.user?.company_id
    if (!company_id) return res.status(401).json({ error: 'Não autenticado' })
    const result = await listWhatsappInstances(company_id)
    if (result.error) return res.status(500).json({ error: result.error })
    const active = (result.instances || [])
      .filter((i) => i && i.ativo !== false)
      .map(sanitizeWhatsappInstance)
      .filter(Boolean)
    return res.json({
      instances: active,
      has_multiple_whatsapp_instances: active.length > 1,
      active_count: active.length,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar instâncias WhatsApp' })
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

    const { getStatus } = require('../../services/ultramsgIntegrationService')
    const { getEmpresaWhatsappConfig } = require('../../services/whatsappConfigService')
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

    // Quantidade atual no banco ANTES da sync (resposta imediata ao frontend).
    const { count: totalBanco } = await supabase
      .from('clientes')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', Number(company_id))

    const totalClientesBanco = Number(totalBanco || 0)

    // Enfileira job que o worker (iniciado no index.js) vai processar em background.
    // Continua mesmo se o usuário sair da tela.
    const { enqueue, JOB_TIPOS, resumeAll, recoverStaleRunningJobs } = require('../../services/queueManager')

    // Clique manual = intenção explícita de sincronizar. Dois estados silenciosos
    // impediam o botão de "puxar nada":
    //  1) processamento_pausado=true — o worker auto-pausa a empresa após falhas
    //     repetidas de job; enquanto pausado, getNextPendingJob ignora a fila e o
    //     job novo fica pendente para sempre. Retomamos aqui.
    //  2) job anterior travado em 'running' (crash/deploy) — bloqueia novo enqueue
    //     por jobDuplicado até a varredura de stale (10 min). Recuperamos agora.
    try { await resumeAll(company_id) } catch (e) { console.warn('[SYNC-CONTATOS] resumeAll:', e?.message || e) }
    try { await recoverStaleRunningJobs() } catch (e) { console.warn('[SYNC-CONTATOS] recoverStale:', e?.message || e) }

    const result = await enqueue(company_id, JOB_TIPOS.SYNC_CONTATOS, {
      reset: true,
      includeConversationCache: false
    })

    if (!result.ok) {
      const jaRodando = /enfileirado|execu/i.test(result.error || '')
      return res.json({
        ok: true,
        queued: false,
        running: jaRodando,
        message: jaRodando
          ? 'Sincronização já em andamento. Os contatos serão atualizados em breve.'
          : (result.error || 'Não foi possível iniciar sincronização'),
        total_contatos: totalClientesBanco,
        criados: 0,
        atualizados: 0,
        fotos_atualizadas: 0
      })
    }

    console.log(`[SYNC-CONTATOS] empresa=${company_id} job_id=${result.job_id} enfileirado — banco atual: ${totalClientesBanco}`)
    return res.json({
      ok: true,
      queued: true,
      running: true,
      job_id: result.job_id,
      message: 'Sincronização iniciada. Os contatos serão importados em lotes e a tela atualizará ao terminar.',
      total_contatos: totalClientesBanco,
      criados: 0,
      atualizados: 0,
      fotos_atualizadas: 0
    })
  } catch (err) {
    console.error('sincronizarContatosZapi:', err)
    return res.json({ ok: false, message: 'Erro ao iniciar sincronização de contatos', total_contatos: 0, criados: 0, atualizados: 0 })
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

    const { getEmpresaWhatsappConfig } = require('../../services/whatsappConfigService')
    const ultramsgSvc = require('../../services/ultramsgIntegrationService')
    const { getProvider } = require('../../services/providers')

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
    const gcr = await provider.getContacts(1, 10, { companyId: company_id })
    const primeiraLeva = gcr?.data != null ? gcr.data : (Array.isArray(gcr) ? gcr : [])
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
    const { normalizePhoneBR } = require('../../helpers/phoneHelper')
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

    const { syncFotosFullProgressiva } = require('../../services/syncFotosProgressivaService')
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
// Vincular cliente existente a uma conversa — PUT /chats/:id/cliente
// =====================================================
exports.vincularClienteConversa = async (req, res) => {
  try {
    const conversa_id = Number(req.params.id)
    const cliente_id = Number(req.body?.cliente_id)
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user

    if (!Number.isFinite(conversa_id) || conversa_id <= 0) {
      return res.status(400).json({ error: 'ID da conversa inválido' })
    }
    if (!Number.isFinite(cliente_id) || cliente_id <= 0) {
      return res.status(400).json({ error: 'cliente_id inválido' })
    }

    const perm = await assertPermissaoConversa({
      company_id,
      conversa_id,
      user_id,
      role: perfil,
      user_dep_ids: departamento_ids,
    })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })
    if (isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Não é possível vincular cliente em conversa de grupo.' })
    }

    const { data: cliente, error: errCli } = await supabase
      .from('clientes')
      .select('id, nome, telefone, email, empresa, observacoes, foto_perfil')
      .eq('id', cliente_id)
      .eq('company_id', Number(company_id))
      .maybeSingle()

    if (errCli) return res.status(500).json({ error: errCli.message })
    if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' })

    const nomeContato = normalizeName(cliente.nome || '') || null
    const patch = {
      cliente_id,
      ...(nomeContato ? { nome_contato_cache: nomeContato } : {}),
      ...(cliente.foto_perfil ? { foto_perfil_contato_cache: cliente.foto_perfil } : {}),
    }

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .update(patch)
      .eq('id', conversa_id)
      .eq('company_id', Number(company_id))
      .select('id, cliente_id, telefone, tipo, nome_contato_cache, foto_perfil_contato_cache, status_atendimento, atendente_id, departamento_id')
      .maybeSingle()

    if (errConv) return res.status(500).json({ error: errConv.message })
    if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada' })

    const payload = {
      id: conversa_id,
      cliente_id,
      contato_nome: nomeContato || undefined,
      nome_contato_cache: nomeContato || undefined,
      foto_perfil: cliente.foto_perfil || undefined,
      foto_perfil_contato_cache: cliente.foto_perfil || undefined,
      status_atendimento: conversa.status_atendimento,
      atendente_id: conversa.atendente_id,
      departamento_id: conversa.departamento_id,
    }

    const io = req.app?.get?.('io') || null
    if (io) {
      emitirConversaAtualizada(io, company_id, conversa_id, payload, { skipAtualizarConversa: true })
    }

    return res.json({ ok: true, conversa: { ...conversa, ...payload }, cliente })
  } catch (err) {
    console.error('[vincularClienteConversa]', err)
    return res.status(500).json({ error: 'Erro ao vincular cliente à conversa' })
  }
}

// =====================================================
// Nome exibido do contato (conversa + cliente vinculado) — PUT /chats/:id/nome-contato
// =====================================================
exports.atualizarNomeContato = async (req, res) => {
  const conversa_id = Number(req.params.id)
  const company_id = Number(req.user?.company_id)
  const user_id = req.user?.id
  const role = req.user?.perfil
  let gravouConversa = false
  let payload = null
  let clienteAtualizado = null

  const responderOk = () => {
    if (res.headersSent) return
    return res.json({
      ok: true,
      conversa: payload,
      cliente: clienteAtualizado,
    })
  }

  try {
    if (!Number.isFinite(conversa_id) || conversa_id <= 0) {
      return res.status(400).json({ error: 'ID da conversa inválido' })
    }
    if (!Number.isFinite(company_id) || company_id <= 0) {
      return res.status(401).json({ error: 'Tenant inválido' })
    }

    const nomeRaw = req.body?.nome != null ? String(req.body.nome) : ''
    const nome = normalizeName(nomeRaw)
    if (!nome) {
      return res.status(400).json({ error: 'Informe um nome válido para o contato.' })
    }
    let nomeInvalido = false
    try {
      nomeInvalido = isBadName(nome)
    } catch (badNameErr) {
      console.error('[atualizarNomeContato] isBadName', badNameErr)
      nomeInvalido = false
    }
    if (nomeInvalido) {
      return res.status(400).json({ error: 'Nome inválido. Use o nome do contato, não apenas números.' })
    }

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, company_id, cliente_id, tipo, telefone, nome_contato_cache, atendente_id, status_atendimento')
      .eq('id', conversa_id)
      .eq('company_id', company_id)
      .maybeSingle()

    if (errConv) return res.status(500).json({ error: errConv.message })
    if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada' })
    if (isGroupConversation(conversa)) {
      return res.status(400).json({ error: 'Não é possível renomear contato em conversa de grupo.' })
    }

    const isAdmin = role === 'admin' || role === 'supervisor'
    const isAtendente = conversa.atendente_id != null && Number(conversa.atendente_id) === Number(user_id)
    if (!isAdmin && !isAtendente) {
      return res.status(403).json({ error: 'Assuma a conversa para editar o nome do contato.' })
    }

    const { error: errCache } = await supabase
      .from('conversas')
      .update({ nome_contato_cache: nome })
      .eq('id', conversa_id)
      .eq('company_id', company_id)

    if (errCache) return res.status(500).json({ error: errCache.message })
    gravouConversa = true

    const clienteId = conversa.cliente_id != null ? Number(conversa.cliente_id) : null
    payload = {
      id: conversa_id,
      contato_nome: nome,
      nome_contato_cache: nome,
      cliente_nome: nome,
      ...(clienteId ? { cliente_id: clienteId } : {}),
    }

    if (clienteId) {
      try {
        const first = await supabase
          .from('clientes')
          .update({ nome, atualizado_em: new Date().toISOString() })
          .eq('id', clienteId)
          .eq('company_id', company_id)
          .select('id, nome, telefone, email, empresa, observacoes, foto_perfil')
          .maybeSingle()

        let cli = first.data
        let errCli = first.error

        if (errCli) {
          const retry = await supabase
            .from('clientes')
            .update({ nome })
            .eq('id', clienteId)
            .eq('company_id', company_id)
            .select('id, nome, telefone, email, empresa, observacoes, foto_perfil')
            .maybeSingle()
          cli = retry.data
          errCli = retry.error
        }

        if (errCli) {
          console.error('[atualizarNomeContato] cliente', errCli)
        } else {
          clienteAtualizado = cli
        }
      } catch (cliErr) {
        console.error('[atualizarNomeContato] cliente', cliErr)
      }
    }

    try {
      const io = req.app?.get?.('io') || null
      if (io) {
        emitirConversaAtualizada(io, company_id, conversa_id, payload, { skipAtualizarConversa: true })
      }
    } catch (emitErr) {
      console.error('[atualizarNomeContato] emit', emitErr)
    }

    return responderOk()
  } catch (err) {
    console.error('[atualizarNomeContato]', err)
    if (gravouConversa && payload) return responderOk()
    if (res.headersSent) return
    return res.status(500).json({ error: 'Erro ao atualizar nome do contato' })
  }
}

exports.atualizarObservacao = async (req, res) => {
  try {
    const { id } = req.params;
    const { observacao } = req.body;
    const { company_id, id: user_id, perfil } = req.user;

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id: Number(id), user_id, role: req.user?.perfil, user_dep_ids: req.user?.departamento_ids })
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
      console.error('[chatController] conversa_prefs', error?.message)
      return res.status(500).json({ error: 'Erro interno' })
    }

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
// 5b) ABRIR CONVERSA POR CLIENTE (lista de clientes → chat list)
// =====================================================
exports.abrirConversaCliente = async (req, res) => {
  try {
    const io = req.app.get('io')
    const { company_id, id: usuario_id } = req.user
    const { cliente_id, whatsapp_instance_id } = req.body

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

    const r = await ensureConversaForCliente({ company_id, usuario_id, cliente, whatsapp_instance_id })
    if (!r.ok) {
      if (r.codigo === 'SELECIONE_WHATSAPP_INSTANCE') {
        return res.status(400).json({
          error: r.error,
          codigo: r.codigo,
          whatsapp_instances: r.whatsapp_instances || [],
        })
      }
      const st = r.error === 'Cliente sem telefone cadastrado' ? 400 : 500
      return res.status(st).json({ error: r.error })
    }

    if (r.criada && io) {
      emitirEventoEmpresaConversa(io, company_id, r.conversa.id, 'nova_conversa', r.conversa)
    }

    return res.json({ conversa: r.conversa, criada: r.criada })
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
    const { nome, telefone, whatsapp_instance_id } = req.body

    const telefoneRaw = telefone != null ? String(telefone).trim() : ''
    if (!telefoneRaw) {
      return res.status(400).json(erroTelefoneNovoContato('TELEFONE_OBRIGATORIO'))
    }

    const instanceRes = await resolveWhatsappInstanceForManualAction(company_id, whatsapp_instance_id)
    if (instanceRes.code === 'SELECIONE_WHATSAPP_INSTANCE') {
      return res.status(400).json({
        error: instanceRes.error,
        codigo: instanceRes.code,
        whatsapp_instances: instanceRes.instances || [],
      })
    }
    if (instanceRes.error || !instanceRes.instanceId) {
      return res.status(400).json({ error: instanceRes.error || 'Instância WhatsApp indisponível' })
    }

    // Bloquear apenas LID e JID de grupo — números internacionais são permitidos como fallback
    let telefoneCanonico = getCanonicalPhone(telefoneRaw)
    const isLidOrGroup = telefoneCanonico.startsWith('lid:') || telefoneCanonico.endsWith('@g.us')
    if (isLidOrGroup) {
      return res.status(400).json(
        erroTelefoneNovoContato('TELEFONE_INVALIDO', {
          detalhe: 'Grupos e identificadores internos (LID) não podem ser cadastrados por este formulário.'
        })
      )
    }

    let allowNonBR = false
    if (!telefoneCanonico) {
      const intlCanonical = getCanonicalPhoneAnyIntl(telefoneRaw)
      if (!intlCanonical) {
        return res.status(400).json(
          erroTelefoneNovoContato('TELEFONE_INVALIDO', {
            detalhe: 'Não foi possível interpretar um telefone válido. Verifique DDD e quantidade de dígitos.'
          })
        )
      }
      telefoneCanonico = intlCanonical
      allowNonBR = true
    }

    const nomeTrim = nome != null ? String(nome).trim() : ''

    // Cliente: getOrCreateCliente evita 23505 e unifica variantes (55… vs DDD…).
    const { cliente_id: clienteId } = await getOrCreateCliente(supabase, company_id, telefoneRaw, {
      ...(nomeTrim ? { nome: nomeTrim } : {}),
      allowNonBR,
    })
    if (!clienteId) {
      return res.status(400).json(
        erroTelefoneNovoContato('TELEFONE_INVALIDO', {
          detalhe: 'Não foi possível cadastrar ou localizar o cliente para este número.'
        })
      )
    }

    // Conversa: findOrCreateConversation inclui conversas fechadas e trata race (23505).
    let resultado
    try {
      resultado = await findOrCreateConversation(supabase, {
        company_id,
        phone: telefoneCanonico,
        cliente_id: clienteId,
        isGroup: false,
        whatsapp_instance_id: instanceRes.instanceId,
        whatsapp_instance_is_default: instanceRes.isDefault === true,
        logPrefix: '[criarContato]',
        allowNonBR,
      })
    } catch (e) {
      console.error(e)
      return res.status(500).json({ error: 'Erro ao criar contato' })
    }

    if (!resultado?.conversa?.id) {
      return res.status(500).json({ error: 'Erro ao criar contato' })
    }

    const convId = Number(resultado.conversa.id)
    const convNova = resultado.created === true

    if (Number(resultado.conversa.cliente_id) !== Number(clienteId)) {
      await supabase
        .from('conversas')
        .update({ cliente_id: clienteId })
        .eq('company_id', company_id)
        .eq('id', convId)
    }

    if (convNova) {
      const patch = { tipo: 'cliente', usuario_id }
      await supabase.from('conversas').update(patch).eq('company_id', company_id).eq('id', convId)
    }

    const { data: conversa, error: errFull } = await supabase
      .from('conversas')
      .select('*')
      .eq('company_id', company_id)
      .eq('id', convId)
      .single()

    if (errFull || !conversa) {
      return res.status(500).json({ error: errFull?.message || 'Erro ao carregar conversa' })
    }

    if (convNova && io) {
      emitirEventoEmpresaConversa(io, company_id, conversa.id, 'nova_conversa', conversa)
    }

    const whatsappInstanceMetaMap = await loadWhatsappInstanceMetaMap(company_id, [conversa.whatsapp_instance_id, instanceRes.instanceId])
    const whatsappInstanceMeta = safeWhatsappInstanceMeta(
      whatsappInstanceMetaMap.get(Number(conversa.whatsapp_instance_id)) ||
      whatsappInstanceMetaMap.get(Number(instanceRes.instanceId)) ||
      instanceRes.instance
    )

    // reutilizada: número já tinha conversa (ex.: fechada ou duplicata) — frontend pode só navegar, sem toast de erro.
    return res.json({ ...conversa, ...whatsappInstanceMeta, reutilizada: !convNova })

  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar contato' })
  }
}

