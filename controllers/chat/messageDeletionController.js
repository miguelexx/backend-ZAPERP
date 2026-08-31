/**
 * Exclusão de mensagens (apagar do sistema + realtime).
 * Extraído de controllers/chatController.js (modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { getProvider } = require('../../services/providers')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../../helpers/timestampApiCompat')
const { isInternalNoteRow } = require('../../helpers/internalNote')
const { resolveConversationWhatsappInstance } = require('../../services/chat/identity/conversationAddressService')
const { emitirConversaAtualizada, emitirEventoEmpresaConversa, emitirParaUsuario } = require('../../services/chat/realtime/chatRealtimeGateway')
const { textoRevogadoApagadaParaTodos, aplicarApagadaParaTodosNaMensagem, enrichMensagemComAutorUsuario } = require('../../services/chat/presentation/messageAuthorEnrichment')

exports.excluirMensagem = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const { id: conversa_id, mensagem_id } = req.params
    const scope = String(req.query?.scope || req.query?.for || '').toLowerCase().trim() || 'all'

    const cid = Number(conversa_id)
    const mid = Number(mensagem_id)
    if (!cid || !mid) return res.status(400).json({ error: 'Parâmetros inválidos' })

    // garante que a conversa pertence à empresa
    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, criado_em, telefone, whatsapp_instance_id')
      .eq('company_id', company_id)
      .eq('id', cid)
      .maybeSingle()

    if (errConv || !conversa) return res.status(404).json({ error: 'Conversa não encontrada' })

    // valida que a mensagem é desta conversa/empresa
    const { data: msg, error: errMsgSel } = await supabase
      .from('mensagens')
      .select('id, conversa_id, criado_em, direcao, autor_usuario_id, whatsapp_id')
      .eq('company_id', company_id)
      .eq('conversa_id', cid)
      .eq('id', mid)
      .maybeSingle()

    if (errMsgSel) return res.status(500).json({ error: errMsgSel.message })
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' })

    // Notas internas não existem no WhatsApp — "apagar para todos" não faz sentido
    if (isInternalNoteRow(msg) && scope !== 'me' && scope !== 'mim' && scope !== 'self') {
      return res.status(400).json({ error: 'Notas internas não podem ser apagadas para todos (não existem no WhatsApp)' })
    }

    // =====================================================
    // Apagar "pra mim" (persistente): oculta para este usuário
    // =====================================================
    if (scope === 'me' || scope === 'mim' || scope === 'self') {
      const { error: errHide } = await supabase
        .from('mensagens_ocultas')
        .insert({
          company_id: Number(company_id),
          conversa_id: cid,
          mensagem_id: mid,
          usuario_id: Number(user_id)
        })

      if (errHide) {
        const msg = String(errHide.message || '')
        if (msg.includes('mensagens_ocultas') || msg.includes('does not exist')) {
          return res.status(400).json({ error: 'Banco desatualizado: rode o supabase/RUN_IN_SUPABASE.sql (tabela mensagens_ocultas).' })
        }
        // se já existe (unique), considera ok
        if (String(errHide.code || '') !== '23505') {
          return res.status(500).json({ error: errHide.message })
        }
      }

      const io = req.app.get('io')
      if (io) {
        // emite só para o usuário (não impacta outros atendentes)
        emitirParaUsuario(io, user_id, 'mensagem_oculta', { conversa_id: cid, mensagem_id: mid })
      }

      return res.json({ ok: true, scope: 'me', conversa_id: cid, mensagem_id: mid })
    }

    // =====================================================
    // Apagar "para todos" — permitido somente para mensagens enviadas pelo próprio usuário
    // (admin pode apagar qualquer mensagem do sistema)
    // =====================================================
    if (String(perfil || '') !== 'admin') {
      const isOut = String(msg?.direcao || '').toLowerCase() === 'out'
      if (!isOut) {
        return res.status(403).json({ error: 'Você só pode apagar para todos mensagens enviadas por você.' })
      }
      if (msg?.autor_usuario_id == null || Number(msg.autor_usuario_id) !== Number(user_id)) {
        return res.status(403).json({ error: 'Você só pode apagar para todos mensagens enviadas por você.' })
      }
    }

    // Apagar no WhatsApp (UltraMsg) antes de alterar o histórico local.
    // Se o provedor não confirmar a remoção, não marcamos como "apagada para todos" no sistema.
    const provider = getProvider()
    const isLidTelefone = String(conversa?.telefone || '').trim().toLowerCase().startsWith('lid:')
    if (!provider?.deleteMessage) {
      return res.status(502).json({ error: 'O provedor WhatsApp atual não suporta apagar mensagem para todos.' })
    }
    if (!msg?.whatsapp_id) {
      return res.status(409).json({ error: 'Mensagem ainda não possui ID do WhatsApp para apagar para todos.' })
    }
    if (!conversa?.telefone || isLidTelefone) {
      return res.status(409).json({ error: 'Não foi possível apagar no WhatsApp: telefone da conversa indisponível.' })
    }

    try {
      const delInstanceId = conversa.whatsapp_instance_id
        ? await resolveConversationWhatsappInstance(company_id, conversa)
        : null
      const deleteResult = await provider.deleteMessage(conversa.telefone, msg.whatsapp_id, {
        companyId: company_id,
        ...(delInstanceId ? { whatsappInstanceId: delInstanceId } : {}),
      })
      const apagouNoWhatsapp = deleteResult === true || deleteResult?.ok === true
      if (!apagouNoWhatsapp) {
        return res.status(502).json({ error: 'O WhatsApp não confirmou a remoção da mensagem. Tente novamente.' })
      }
    } catch (e) {
      console.warn('[excluirMensagem] deleteMessage no WhatsApp:', e?.message || e)
      return res.status(502).json({ error: 'Falha ao apagar a mensagem no WhatsApp. Tente novamente.' })
    }

    const textoRevogado = textoRevogadoApagadaParaTodos(msg, user_id)
    const { data: msgRevogada, error: errUpd } = await supabase
      .from('mensagens')
      .update({
        apagada_para_todos: true,
        apagada_em: new Date().toISOString(),
        texto: textoRevogado,
        reply_meta: null,
      })
      .eq('company_id', company_id)
      .eq('conversa_id', cid)
      .eq('id', mid)
      .select('id, texto, direcao, criado_em, autor_usuario_id, status, whatsapp_id, tipo, url, nome_arquivo, apagada_para_todos, apagada_em')
      .maybeSingle()

    if (errUpd) {
      const errMsg = String(errUpd.message || '')
      if (errMsg.includes('apagada_para_todos') || errMsg.includes('does not exist')) {
        return res.status(400).json({
          error:
            'Banco desatualizado: execute a migration 20260525120000_mensagens_apagada_para_todos.sql no Supabase.',
        })
      }
      return res.status(500).json({ error: errUpd.message })
    }
    if (!msgRevogada) return res.status(404).json({ error: 'Mensagem não encontrada' })

    // recalcula última mensagem (para o preview da lista)
    const { data: lastMsg, error: errLast } = await supabase
      .from('mensagens')
      .select('id, conversa_id, texto, direcao, tipo, url, nome_arquivo, criado_em, status, status_mensagem, whatsapp_id')
      .eq('company_id', company_id)
      .eq('conversa_id', cid)
      .order('criado_em', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)

    if (errLast) console.warn('Excluir mensagem: erro ao buscar última mensagem:', errLast.message)
    let ultima = Array.isArray(lastMsg) && lastMsg.length > 0 ? lastMsg[0] : null
    if (ultima && ultima.criado_em != null) {
      ultima = { ...ultima, criado_em: normalizarTimestampSemFusoAmbiguoParaApi(ultima.criado_em) }
    }

    // atualiza ultima_atividade para manter ordenação coerente
    const ultimaAtividade = ultima?.criado_em || conversa?.criado_em || new Date().toISOString()
    await supabase
      .from('conversas')
      .update({ ultima_atividade: ultimaAtividade })
      .eq('company_id', company_id)
      .eq('id', cid)

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(
        io,
        company_id,
        cid,
        io.EVENTS?.MENSAGEM_EXCLUIDA || 'mensagem_excluida',
        {
          conversa_id: cid,
          mensagem_id: mid,
          ultima_mensagem: ultima
        }
      )
      emitirConversaAtualizada(io, company_id, cid, { id: cid })
    }

    const msgApi = aplicarApagadaParaTodosNaMensagem(
      await enrichMensagemComAutorUsuario(supabase, company_id, msgRevogada),
      user_id
    )
    return res.json({
      ok: true,
      conversa_id: cid,
      mensagem_id: mid,
      ultima_mensagem: ultima,
      mensagem: msgApi,
      apagada_para_todos: true,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao excluir mensagem' })
  }
}
