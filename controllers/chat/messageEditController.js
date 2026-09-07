/**
 * Edição de mensagem (texto e legenda de mídia) no WhatsApp + persistência local.
 * PATCH /chats/:id/mensagens/:mensagem_id
 * Whapi: POST /messages/text { edit }. UltraMSG: 422 (API não edita).
 */

const supabase = require('../../config/supabase')
const { getProvider } = require('../../services/providers')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../../helpers/timestampApiCompat')
const { isInternalNoteRow } = require('../../helpers/internalNote')
const { textoMensagemMidiaParaBanco, captionWhatsappParaMidia } = require('../../helpers/midiaMensagemHelper')
const {
  pickEditTextoFromBody,
  normalizeEditTexto,
  isEditWindowOpen,
  isMediaCaptionTipo,
  buildEditadaDbUpdates,
  isMissingEditadaColumnError,
  aplicarCamposEdicaoNaMensagem,
  buildMensagemEditadaSocketPayload,
} = require('../../helpers/mensagemEditHelper')
const { resolveConversationWhatsappInstance, resolveConversationProvider } = require('../../services/chat/identity/conversationAddressService')
const { assertPermissaoConversa } = require('../../services/chat/access/conversationPolicy')
const { emitirConversaAtualizada, emitirEventoEmpresaConversa } = require('../../services/chat/realtime/chatRealtimeGateway')
const { textoParaEnvioWhatsapp, getUsuarioParaEnvioCliente, enrichMensagemComAutorUsuario } = require('../../services/chat/presentation/messageAuthorEnrichment')

const MSG_SELECT = 'id, conversa_id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo, apagada_para_todos, apagada_em, editada, editada_em, reply_meta, client_temp_id'
const MSG_SELECT_FALLBACK = 'id, conversa_id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo'

async function persistEditedMensagem({ company_id, cid, mid, updates }) {
  const apply = async (select) => supabase
    .from('mensagens')
    .update(updates)
    .eq('company_id', company_id)
    .eq('conversa_id', cid)
    .eq('id', mid)
    .select(select)
    .maybeSingle()

  let { data, error } = await apply(MSG_SELECT)
  if (error && isMissingEditadaColumnError(error)) {
    const { texto } = updates
    const retry = await supabase
      .from('mensagens')
      .update({ texto })
      .eq('company_id', company_id)
      .eq('conversa_id', cid)
      .eq('id', mid)
      .select(MSG_SELECT_FALLBACK)
      .maybeSingle()
    return retry
  }
  if (error && String(error.message || '').includes('does not exist')) {
    return apply(MSG_SELECT_FALLBACK)
  }
  return { data, error }
}

async function carregarUltimaMensagem(company_id, cid) {
  const { data: lastMsg, error: errLast } = await supabase
    .from('mensagens')
    .select('id, conversa_id, texto, direcao, tipo, url, nome_arquivo, criado_em, status, status_mensagem, whatsapp_id, editada, editada_em')
    .eq('company_id', company_id)
    .eq('conversa_id', cid)
    .order('criado_em', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)

  if (errLast && isMissingEditadaColumnError(errLast)) {
    const retry = await supabase
      .from('mensagens')
      .select('id, conversa_id, texto, direcao, tipo, url, nome_arquivo, criado_em, status, status_mensagem, whatsapp_id')
      .eq('company_id', company_id)
      .eq('conversa_id', cid)
      .order('criado_em', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
    const rows = retry.data
    let ultima = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    if (ultima && ultima.criado_em != null) {
      ultima = { ...ultima, criado_em: normalizarTimestampSemFusoAmbiguoParaApi(ultima.criado_em) }
    }
    return ultima
  }
  if (errLast) {
    console.warn('[editarMensagem] última mensagem:', errLast.message)
    return null
  }
  let ultima = Array.isArray(lastMsg) && lastMsg.length > 0 ? lastMsg[0] : null
  if (ultima && ultima.criado_em != null) {
    ultima = { ...ultima, criado_em: normalizarTimestampSemFusoAmbiguoParaApi(ultima.criado_em) }
  }
  return ultima
}

exports.editarMensagem = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user
    const cid = Number(req.params.id)
    const mid = Number(req.params.mensagem_id)
    if (!cid || !mid) return res.status(400).json({ error: 'Parâmetros inválidos' })

    const picked = pickEditTextoFromBody(req.body)
    if (!picked.present) {
      return res.status(400).json({ error: 'texto é obrigatório', code: 'EDIT_EMPTY_TEXT' })
    }

    const perm = await assertPermissaoConversa({
      company_id,
      conversa_id: cid,
      user_id,
      role: perfil,
      user_dep_ids: departamento_ids,
    })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, criado_em, telefone, whatsapp_instance_id')
      .eq('company_id', company_id)
      .eq('id', cid)
      .maybeSingle()
    if (errConv || !conversa) return res.status(404).json({ error: 'Conversa não encontrada' })

    const { data: msg, error: errMsgSel } = await supabase
      .from('mensagens')
      .select('id, conversa_id, criado_em, direcao, autor_usuario_id, whatsapp_id, tipo, texto, url, nome_arquivo, apagada_para_todos, status')
      .eq('company_id', company_id)
      .eq('conversa_id', cid)
      .eq('id', mid)
      .maybeSingle()
    if (errMsgSel) return res.status(500).json({ error: errMsgSel.message })
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' })

    const isNote = isInternalNoteRow(msg)
    if (msg.apagada_para_todos === true) {
      return res.status(409).json({ error: 'Mensagem apagada não pode ser editada.', code: 'EDIT_DELETED' })
    }

    if (!isNote && String(msg.direcao || '').toLowerCase() !== 'out') {
      return res.status(403).json({
        error: 'Só é possível editar mensagens enviadas por você.',
        code: 'EDIT_INBOUND',
      })
    }
    if (String(perfil || '') !== 'admin') {
      if (msg.autor_usuario_id == null || Number(msg.autor_usuario_id) !== Number(user_id)) {
        return res.status(403).json({
          error: 'Você só pode editar mensagens enviadas por você.',
          code: 'EDIT_NOT_AUTHOR',
        })
      }
    }

    const normalized = normalizeEditTexto(picked.raw, isNote ? 'texto' : msg.tipo)
    if (!normalized.ok) {
      return res.status(400).json({ error: normalized.error, code: normalized.code })
    }

    let textoCrm = normalized.texto
    if (!isNote && isMediaCaptionTipo(msg.tipo)) {
      textoCrm = textoMensagemMidiaParaBanco({
        tipo: msg.tipo,
        captionUsuarioTrim: normalized.texto,
        originalname: msg.nome_arquivo,
      })
    }

    if (String(msg.texto || '') === textoCrm) {
      const atual = aplicarCamposEdicaoNaMensagem(
        await enrichMensagemComAutorUsuario(supabase, company_id, msg)
      )
      return res.json({
        ok: true,
        unchanged: true,
        conversa_id: cid,
        mensagem_id: mid,
        mensagem: atual,
      })
    }

    if (isNote) {
      const editedAt = new Date()
      const { data: saved, error: errUpd } = await persistEditedMensagem({
        company_id, cid, mid, updates: buildEditadaDbUpdates(textoCrm, editedAt),
      })
      if (errUpd) return res.status(500).json({ error: errUpd.message })
      if (!saved) return res.status(404).json({ error: 'Mensagem não encontrada' })
      const ultima = await carregarUltimaMensagem(company_id, cid)
      const io = req.app.get('io')
      const msgApi = aplicarCamposEdicaoNaMensagem(
        await enrichMensagemComAutorUsuario(supabase, company_id, saved)
      )
      if (io) {
        emitirEventoEmpresaConversa(
          io,
          company_id,
          cid,
          io.EVENTS?.MENSAGEM_EDITADA || 'mensagem_editada',
          buildMensagemEditadaSocketPayload({
            id: mid,
            conversa_id: cid,
            company_id,
            texto: textoCrm,
            editada_em: msgApi.editada_em || editedAt.toISOString(),
            tipo: msgApi.tipo,
            ultima_mensagem: ultima,
          })
        )
        emitirConversaAtualizada(io, company_id, cid, { id: cid })
      }
      return res.json({
        ok: true,
        conversa_id: cid,
        mensagem_id: mid,
        mensagem: msgApi,
        ultima_mensagem: ultima,
      })
    }

    if (!isEditWindowOpen(msg.criado_em)) {
      return res.status(409).json({
        error: 'O WhatsApp só permite editar mensagens enviadas há menos de 15 minutos.',
        code: 'EDIT_WINDOW_EXPIRED',
      })
    }

    const editInstanceId = conversa.whatsapp_instance_id
      ? await resolveConversationWhatsappInstance(company_id, conversa)
      : null
    const instanceProvider = await resolveConversationProvider(company_id, editInstanceId)
    const provider = getProvider({ provider: instanceProvider })
    if (typeof provider?.editMessage !== 'function') {
      return res.status(422).json({
        error: 'Edição de mensagem não é suportada neste número (apenas Whapi).',
        code: 'EDIT_NOT_SUPPORTED',
      })
    }
    if (!msg.whatsapp_id) {
      return res.status(409).json({
        error: 'Mensagem ainda não possui ID do WhatsApp para editar.',
        code: 'EDIT_NO_WHATSAPP_ID',
      })
    }
    const isLidTelefone = String(conversa?.telefone || '').trim().toLowerCase().startsWith('lid:')
    if (!conversa?.telefone || isLidTelefone) {
      return res.status(409).json({
        error: 'Não foi possível editar no WhatsApp: telefone da conversa indisponível.',
        code: 'EDIT_NO_PHONE',
      })
    }

    const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, user_id)
    const textoWhatsapp = isMediaCaptionTipo(msg.tipo)
      ? captionWhatsappParaMidia({
          tipo: msg.tipo,
          captionUsuarioTrim: normalized.texto,
          usuarioNome,
        })
      : textoParaEnvioWhatsapp(normalized.texto, usuarioNome)

    let editResult
    try {
      editResult = await provider.editMessage(conversa.telefone, msg.whatsapp_id, textoWhatsapp, {
        companyId: company_id,
        ...(editInstanceId ? { whatsappInstanceId: editInstanceId } : {}),
        allowEmpty: isMediaCaptionTipo(msg.tipo) && !String(textoWhatsapp || '').trim(),
      })
    } catch (e) {
      console.warn('[editarMensagem] editMessage no WhatsApp:', e?.message || e)
      return res.status(502).json({ error: 'Falha ao editar a mensagem no WhatsApp. Tente novamente.' })
    }

    if (editResult?.status === 501 || editResult?.error === 'not_implemented') {
      return res.status(422).json({
        error: 'Edição de mensagem não é suportada neste número (apenas Whapi).',
        code: 'EDIT_NOT_SUPPORTED',
      })
    }
    const okProvider = editResult === true || editResult?.ok === true
    if (!okProvider) {
      return res.status(502).json({
        error: editResult?.error || 'O WhatsApp não confirmou a edição da mensagem. Tente novamente.',
      })
    }

    const editedAt = new Date()
    const { data: saved, error: errUpd } = await persistEditedMensagem({
      company_id, cid, mid, updates: buildEditadaDbUpdates(textoCrm, editedAt),
    })
    if (errUpd) return res.status(500).json({ error: errUpd.message })
    if (!saved) return res.status(404).json({ error: 'Mensagem não encontrada' })

    const ultima = await carregarUltimaMensagem(company_id, cid)
    const io = req.app.get('io')
    const msgApi = aplicarCamposEdicaoNaMensagem(
      await enrichMensagemComAutorUsuario(supabase, company_id, saved)
    )
    if (io) {
      emitirEventoEmpresaConversa(
        io,
        company_id,
        cid,
        io.EVENTS?.MENSAGEM_EDITADA || 'mensagem_editada',
        buildMensagemEditadaSocketPayload({
          id: mid,
          conversa_id: cid,
          company_id,
          texto: textoCrm,
          editada_em: msgApi.editada_em || editedAt.toISOString(),
          tipo: msgApi.tipo || msg.tipo,
          ultima_mensagem: ultima,
        })
      )
      emitirConversaAtualizada(io, company_id, cid, { id: cid })
    }

    return res.json({
      ok: true,
      conversa_id: cid,
      mensagem_id: mid,
      mensagem: msgApi,
      ultima_mensagem: ultima,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao editar mensagem' })
  }
}

exports._test = {
  persistEditedMensagem,
}
