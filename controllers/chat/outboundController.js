/**
 * Envio de mensagens não-mídia: reações, contato, localização e ligação (registro).
 * Extraído de controllers/chatController.js (Fase 6 da modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { getProvider } = require('../../services/providers')
const { getDisplayName } = require('../../helpers/contactEnrichment')
const { tryMarkWaitingAfterHumanOutbound } = require('../../services/absenceFinalizationService')
const { isRealWhatsAppId, isUltramsgNumericQueueId } = require('../../helpers/whatsappMessageIdHelper')
const { resolveTelefoneFromLidSiblingConversation, resolveConversationWhatsappInstance, resolveConversationProvider } = require('../../services/chat/identity/conversationAddressService')
const { emitirConversaAtualizada, emitirEventoEmpresaConversa } = require('../../services/chat/realtime/chatRealtimeGateway')
const { assertPodeEnviarMensagem } = require('../../services/chat/access/conversationPolicy')
const { getUsuarioParaEnvioCliente, enrichMensagemComAutorUsuario } = require('../../services/chat/presentation/messageAuthorEnrichment')
const { aplicarAguardandoClienteNoPayload, anexarAssumirNoPayloadLista } = require('../../services/chat/outbound/modoSimplesOutbound')

exports.enviarReacaoMensagem = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const { id: conversa_id, mensagem_id } = req.params
    const { reaction } = req.body || {}

    if (!reaction || !String(reaction).trim()) {
      return res.status(400).json({ error: 'reaction é obrigatório' })
    }

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id, user_id, role: req.user?.perfil, user_dep_ids: req.user?.departamento_ids })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error })

    // busca conversa + mensagem para garantir que pertencem à empresa
    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, telefone, company_id, whatsapp_instance_id')
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

    const whatsappInstanceId = await resolveConversationWhatsappInstance(company_id, conversa)

    if (String(conversa.telefone || '').trim().toLowerCase().startsWith('lid:')) {
      return res.status(400).json({ error: 'Número do contato indisponível (conversa por LID). Aguarde o contato enviar uma mensagem.' })
    }

    const instanceProvider = await resolveConversationProvider(company_id, whatsappInstanceId)
    const provider = getProvider({ provider: instanceProvider })
    if (!provider || !provider.sendReaction) {
      return res.status(500).json({ error: 'Provider WhatsApp não suporta reações' })
    }

    const ok = await provider.sendReaction(conversa.telefone, msg.whatsapp_id, String(reaction).trim(), {
      companyId: company_id,
      whatsappInstanceId: whatsappInstanceId || undefined,
    })
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

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id, user_id, role: req.user?.perfil, user_dep_ids: req.user?.departamento_ids })
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

    const whatsappInstanceId = await resolveConversationWhatsappInstance(company_id, conversa)

    if (String(conversa.telefone || '').trim().toLowerCase().startsWith('lid:')) {
      return res.status(400).json({ error: 'Número do contato indisponível (conversa por LID). Aguarde o contato enviar uma mensagem.' })
    }

    const instanceProvider = await resolveConversationProvider(company_id, whatsappInstanceId)
    const provider = getProvider({ provider: instanceProvider })
    if (!provider || !provider.removeReaction) {
      return res.status(500).json({ error: 'Provider WhatsApp não suporta remoção de reação' })
    }

    const ok = await provider.removeReaction(conversa.telefone, msg.whatsapp_id, {
      companyId: company_id,
      whatsappInstanceId: whatsappInstanceId || undefined,
    })
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

    const instanceProvider = await resolveConversationProvider(company_id, whatsappInstanceId)
    const provider = getProvider({ provider: instanceProvider })
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
      const convPayload = anexarAssumirNoPayloadLista(aplicarAguardandoClienteNoPayload({
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
      }, waitingAfterOutbound), permEnvio)
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

    const instanceProvider = await resolveConversationProvider(company_id, whatsappInstanceId)
    const provider = getProvider({ provider: instanceProvider })
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
      const convPayload = anexarAssumirNoPayloadLista(aplicarAguardandoClienteNoPayload({
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
      }, waitingAfterOutbound), permEnvio)
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

// =====================================================
// Registro de ligações via WhatsApp (Z-API /send-call)
// =====================================================

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

    const instanceProvider = await resolveConversationProvider(company_id, whatsappInstanceId)
    const provider = getProvider({ provider: instanceProvider })
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
