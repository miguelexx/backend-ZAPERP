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
 * controllers/chat/conversationController.js — Ciclo da conversa: limpar/apagar, sincronizar histórico antigo, merge de duplicatas e criação de grupo/comunidade.
 * Invariantes: isolamento por company_id; permissões/visibilidade; status unidirecional; sem retry cego.
 */

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
      .select('id, telefone, chat_lid, ultima_atividade, criado_em, tipo, whatsapp_instance_id')
      .eq('company_id', cid)
      .neq('status_atendimento', 'fechada')
      .not('telefone', 'is', null)

    if (errList) return res.status(500).json({ error: errList.message })

    const individuais = (conversas || []).filter((c) => !c.tipo || String(c.tipo).toLowerCase() !== 'grupo')
    const byKey = new Map()
    for (const c of individuais) {
      const phoneKey = phoneKeyBR(c.telefone) || String(c.telefone || '').replace(/\D/g, '')
      if (!phoneKey) continue
      const instanceScope = c.whatsapp_instance_id ? `wi:${c.whatsapp_instance_id}` : 'wi:legacy'
      const scopedKey = `${instanceScope}:${phoneKey}`
      if (!byKey.has(scopedKey)) byKey.set(scopedKey, [])
      byKey.get(scopedKey).push(c)
    }

    let merged = 0
    const redirects = []
    const ioMerge = req.app.get('io')
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
        const mergeResult = await mergeConversasIntoCanonico(supabase, cid, canonical.id, otherIds, { io: ioMerge })
        if (mergeResult?.ok && Array.isArray(mergeResult.mergedFrom)) {
          merged += mergeResult.mergedFrom.length
          for (const fromId of mergeResult.mergedFrom) {
            redirects.push({ from: Number(fromId), to: Number(canonical.id) })
          }
        }
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
        .filter((c) =>
          c.id !== lidConv.id &&
          !String(c.telefone || '').startsWith('lid:') &&
          c.chat_lid === lidPart &&
          (
            (lidConv.whatsapp_instance_id == null && c.whatsapp_instance_id == null) ||
            Number(c.whatsapp_instance_id) === Number(lidConv.whatsapp_instance_id)
          )
        )
        .sort((a, b) => new Date(b.ultima_atividade || 0).getTime() - new Date(a.ultima_atividade || 0).getTime())[0]
      if (canonPhone) {
        try {
          const mergeResult = await mergeConversasIntoCanonico(supabase, cid, canonPhone.id, [lidConv.id], { io: ioMerge })
          if (mergeResult?.ok && Array.isArray(mergeResult.mergedFrom) && mergeResult.mergedFrom.length) {
            merged += mergeResult.mergedFrom.length
            for (const fromId of mergeResult.mergedFrom) {
              redirects.push({ from: Number(fromId), to: Number(canonPhone.id) })
            }
            await supabase.from('conversas').update({ chat_lid: lidPart }).eq('id', canonPhone.id).eq('company_id', cid)
          }
        } catch (e) {
          console.warn('mergeConversasDuplicadas LID:', e?.message || e)
        }
      }
    }

    const msgParts = []
    if (clientesRemovidos) msgParts.push(`${clientesRemovidos} contato(s) removido(s)`)
    if (merged) msgParts.push(`${merged} conversa(s) unificada(s)`)
    const message = msgParts.length ? msgParts.join('. ') + '.' : 'Nenhuma duplicata encontrada.'
    return res.json({ ok: true, merged, clientesRemovidos, redirects, message })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao mesclar duplicatas' })
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

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

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

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    emitirEventoEmpresaConversa(io, company_id, data.id, 'nova_conversa', data)

    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar comunidade' })
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

