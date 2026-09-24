/**
 * Pix da empresa: ler/gravar empresa_pix_config e enviar mensagem Pix.
 * Extraído de controllers/chatController.js (modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const {
  sanitizePixConfigPayload,
  buildPixMessageFromConfig,
  buildPixReplyMeta,
  buildPixInteractivePayload,
} = require('../../services/chat/outbound/pixConfig')
// enviarMensagemChat: fallback de TEXTO (UltraMSG ou quando o cartão interativo falha).
const { enviarMensagemChat } = require('./textMessageController')
// Helpers do envio de cartão nativo (mesmo padrão de enviarEnquete/enviarProduto).
const { getProvider } = require('../../services/providers')
const { tryMarkWaitingAfterHumanOutbound } = require('../../services/absenceFinalizationService')
const { resolveTelefoneFromLidSiblingConversation, resolveConversationWhatsappInstance, resolveConversationProvider } = require('../../services/chat/identity/conversationAddressService')
const { emitirConversaAtualizada, emitirEventoEmpresaConversa } = require('../../services/chat/realtime/chatRealtimeGateway')
const { assertPodeEnviarMensagem } = require('../../services/chat/access/conversationPolicy')
const { enrichMensagemComAutorUsuario } = require('../../services/chat/presentation/messageAuthorEnrichment')
const { aplicarAguardandoClienteNoPayload, anexarAssumirNoPayloadLista } = require('../../services/chat/outbound/modoSimplesOutbound')
const { mapProviderSendResult } = require('../../services/chat/outbound/providerResultMapper')
const { schedulePendingOutboundReconciliation } = require('../../services/pendingOutboundReconciliationService')

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

/**
 * POST /chats/:id/pix — envia a chave Pix.
 * Whapi: cartão nativo com botão "Copiar chave Pix" (o corpo já traz a chave por extenso,
 * então mesmo que o botão não copie no aparelho, a chave continua visível). Se o cartão
 * interativo falhar, cai automaticamente no texto. UltraMSG: texto (comportamento atual).
 */
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

    const pixTexto = buildPixMessageFromConfig(data)

    // Descobre o provedor da conversa. Só o Whapi tem cartão nativo com botão de copiar;
    // qualquer erro na descoberta cai no texto (comportamento atual, seguro).
    let instanceProvider = 'ultramsg'
    let whatsappInstanceId = null
    try {
      const { id: conversa_id } = req.params
      const { data: convProv } = await supabase
        .from('conversas')
        .select('id, whatsapp_instance_id, chat_lid, telefone, cliente_id')
        .eq('company_id', Number(company_id))
        .eq('id', conversa_id)
        .maybeSingle()
      if (convProv) {
        whatsappInstanceId = await resolveConversationWhatsappInstance(company_id, convProv)
        instanceProvider = await resolveConversationProvider(company_id, whatsappInstanceId)
      }
    } catch (_) {
      instanceProvider = 'ultramsg'
    }

    if (String(instanceProvider || '').toLowerCase() === 'whapi') {
      const cardResult = await enviarPixCartaoWhapi(req, res, { cfg: data, pixTexto, whatsappInstanceId })
      if (cardResult?.handled) return cardResult.response
      // Não conseguiu nem persistir o cartão → cai no texto (fluxo padrão).
    }

    req.body = { ...req.body, texto: pixTexto }
    return enviarMensagemChat(req, res)
  } catch (err) {
    console.error('[enviarMensagemPix]', err)
    return res.status(500).json({ error: 'Erro ao enviar mensagem Pix.' })
  }
}

/**
 * Envia o Pix como cartão nativo Whapi (botão "Copiar chave Pix"), persistindo + emitindo
 * realtime no mesmo molde de enviarEnquete. Se o provedor recusar o interativo, reenvia o
 * MESMO registro como texto (a chave continua chegando ao cliente).
 * Retorna { handled:true, response } quando assumiu o envio, ou { handled:false } para o
 * chamador cair no texto (ex.: falha ao persistir a linha).
 */
async function enviarPixCartaoWhapi(req, res, { cfg, pixTexto, whatsappInstanceId }) {
  const { company_id, id: user_id } = req.user
  const { id: conversa_id } = req.params
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
  if (!permEnvio.ok) return { handled: true, response: res.status(permEnvio.status).json({ error: permEnvio.error }) }

  const { data: conversa, error: errConv } = await supabase
    .from('conversas')
    .select('id, telefone, cliente_id, chat_lid, whatsapp_instance_id')
    .eq('company_id', company_id)
    .eq('id', conversa_id)
    .maybeSingle()
  if (errConv || !conversa) return { handled: true, response: res.status(404).json({ error: 'Conversa não encontrada' }) }

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
      return { handled: true, response: res.status(400).json({ error: 'Número do contato indisponível (conversa por LID). Aguarde o contato enviar uma mensagem ou sincronize os contatos.' }) }
    }
  }

  const provider = getProvider({ provider: 'whapi' })
  if (!provider || typeof provider.sendInteractive !== 'function') {
    return { handled: false } // sem suporte → chamador cai no texto
  }

  const replyMeta = buildPixReplyMeta(cfg)
  const criadoEm = new Date().toISOString()
  const insertRow = {
    company_id,
    conversa_id: Number(conversa_id),
    texto: pixTexto,
    direcao: 'out',
    tipo: 'interactive',
    status: 'pending',
    autor_usuario_id: Number(user_id),
    criado_em: criadoEm,
    reply_meta: replyMeta,
    ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
  }

  let { data: msg, error: errMsg } = await supabase
    .from('mensagens')
    .insert(insertRow)
    .select()
    .single()
  if (errMsg && String(errMsg.message || '').includes('reply_meta')) {
    delete insertRow.reply_meta
    ;({ data: msg, error: errMsg } = await supabase.from('mensagens').insert(insertRow).select().single())
  }
  if (errMsg || !msg) return { handled: false } // não persistiu → chamador cai no texto

  let waitingAfterOutbound = null
  try {
    waitingAfterOutbound = await tryMarkWaitingAfterHumanOutbound({
      company_id,
      conversa_id: Number(conversa_id),
      texto: pixTexto,
      criado_em: msg.criado_em || criadoEm,
      autor_usuario_id: Number(user_id),
    })
  } catch (_) {}

  const sendOpts = {
    companyId: company_id,
    conversaId: Number(conversa_id),
    whatsappInstanceId: whatsappInstanceId || undefined,
    sendOrigin: 'atendimento_humano_pix',
    referenceId: `crm-${msg.id}`,
  }

  // Tenta o cartão interativo; se recusado, reenvia o MESMO registro como texto.
  let result = await provider.sendInteractive(telefoneParaEnvio, buildPixInteractivePayload(cfg), sendOpts)
  let tipoFinal = 'interactive'
  if (!result?.ok && typeof provider.sendText === 'function') {
    console.warn('[enviarMensagemPix] cartão interativo Whapi falhou; reenviando como texto:', String(result?.error || '').slice(0, 160))
    result = await provider.sendText(telefoneParaEnvio, pixTexto, sendOpts)
    tipoFinal = 'texto'
    await supabase.from('mensagens').update({ tipo: 'texto' }).eq('company_id', company_id).eq('id', msg.id)
    msg.tipo = 'texto'
  }

  const mappedResult = mapProviderSendResult(result)
  const {
    ok, waMessageId, providerError: providerErro,
    hasValidId: hasTraceableId, hasQueueId,
    nextStatus, nextStatusMensagem,
  } = mappedResult

  await supabase
    .from('mensagens')
    .update({
      status: nextStatus,
      status_mensagem: nextStatusMensagem,
      ...(hasTraceableId ? { whatsapp_id: waMessageId } : {}),
      ...(hasQueueId ? { provider_queue_id: waMessageId } : {}),
    })
    .eq('company_id', company_id)
    .eq('id', msg.id)

  if (io) {
    const payload = await enrichMensagemComAutorUsuario(supabase, company_id, {
      ...msg,
      tipo: tipoFinal,
      status: nextStatus,
      status_mensagem: nextStatusMensagem,
      whatsapp_id: hasTraceableId ? waMessageId : null,
      reply_meta: msg.reply_meta || replyMeta,
    })
    emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', payload)
    const convPayload = anexarAssumirNoPayloadLista(aplicarAguardandoClienteNoPayload({
      id: Number(conversa_id),
      ultima_atividade: payload.criado_em || criadoEm,
      ultima_mensagem_preview: {
        texto: '🔑 Chave Pix',
        criado_em: payload.criado_em || criadoEm,
        direcao: 'out',
      },
      reordenar_suave: true,
    }, waitingAfterOutbound), permEnvio)
    emitirConversaAtualizada(io, company_id, conversa_id, convPayload, { skipAtualizarConversa: true })
  }

  if (mappedResult.needsReconciliation) {
    schedulePendingOutboundReconciliation({ companyId: company_id, mensagemId: msg.id, io })
  }

  if (!ok) {
    const status = Number(result?.httpStatus)
    const httpOut = [400, 401, 403, 404, 409, 422, 429, 503].includes(status) ? status : 422
    return {
      handled: true,
      response: res.status(httpOut).json({
        ok: false,
        id: msg.id,
        error: providerErro || 'Não foi possível enviar a chave Pix ao WhatsApp.',
      }),
    }
  }

  return {
    handled: true,
    response: res.json({
      ok: true,
      id: msg.id,
      conversa_id: Number(conversa_id),
      tipo: tipoFinal,
      status: nextStatus,
      status_mensagem: nextStatusMensagem,
      ...(hasTraceableId ? { whatsapp_id: waMessageId } : {}),
    }),
  }
}
