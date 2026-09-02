/**
 * Envio de mensagem de texto/link (enviarMensagemChat) — fluxo P0: persistir pending → emitir otimista → provider → status.
 * Extraído de controllers/chatController.js (modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { getProvider } = require('../../services/providers')
const { getOrCreateCliente } = require('../../helpers/conversationSync')
const { getDisplayName } = require('../../helpers/contactEnrichment')
const { tryMarkWaitingAfterHumanOutbound } = require('../../services/absenceFinalizationService')
const { empresaModoSimplesAtivo } = require('../../helpers/empresaModoSimplesFlag')
const { isRealWhatsAppId, isUltramsgNumericQueueId } = require('../../helpers/whatsappMessageIdHelper')
const { schedulePendingOutboundReconciliation } = require('../../services/pendingOutboundReconciliationService')
const { safeWhatsappInstanceMeta } = require('../../services/chat/presentation/chatDto')
const { normalizeClientTempId, clientTempIdDedupeKey, isMissingMensagemColumnError, isGenericMissingColumnError, isClientTempIdUniqueViolation, buildClientTempIdDedupResponse } = require('../../services/chat/outbound/idempotencyHelpers')
const { normalizeLinkPayload } = require('../../services/chat/outbound/messageNormalizers')
const { resolveTelefoneFromLidSiblingConversation, resolveConversationWhatsappInstance } = require('../../services/chat/identity/conversationAddressService')
const { emitirConversaAtualizada, emitirEventoEmpresaConversa } = require('../../services/chat/realtime/chatRealtimeGateway')
const { assertPodeEnviarMensagem } = require('../../services/chat/access/conversationPolicy')
const { textoParaEnvioWhatsapp, getUsuarioParaEnvioCliente, enrichMensagemComAutorUsuario } = require('../../services/chat/presentation/messageAuthorEnrichment')
const { loadWhatsappInstanceMetaMap, resolveUltraMsgReplyMessageId } = require('../../services/chat/read/conversationLookups')
const { deduplicationMap: _clientTempIdDeduplicationMap, findMensagemByClientTempId, isDbDedupeUnavailable, markDbDedupeUnavailable } = require('../../services/chat/outbound/idempotencyService')
const { aplicarAguardandoClienteNoPayload, anexarAssumirNoPayloadLista, recalcularEMesclarModoSimples } = require('../../services/chat/outbound/modoSimplesOutbound')

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
      autoAssumirAoEnviar: true,
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
    if (clientTempId && !isDbDedupeUnavailable()) basePayload.client_temp_id = clientTempId
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
        markDbDedupeUnavailable()
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
      const convPayload = anexarAssumirNoPayloadLista(aplicarAguardandoClienteNoPayload({
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
      }), permEnvio)
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
