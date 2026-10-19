/**
 * Limpeza e exclusão de conversa.
 * Extraído de controllers/chatController.js (modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { isGroupConversation } = require('../../helpers/conversaHelper')
const { getProvider } = require('../../services/providers')
const {
  resolveConversationWhatsappInstance,
  resolveConversationProvider,
} = require('../../services/chat/identity/conversationAddressService')
const { emitirConversaAtualizada, emitirEventoEmpresaConversa } = require('../../services/chat/realtime/chatRealtimeGateway')
const { assertPermissaoConversa } = require('../../services/chat/access/conversationPolicy')
const { marcarComoLidaPorUsuario } = require('../../services/chat/unread/conversationUnreadService')
const {
  contatoExiste,
  apagarDependenciasEConversa,
  apagarCadastroDoCliente,
  emitirConversaApagada,
} = require('../../services/chat/deletion/conversationDeletionService')
const { registrarExclusaoLocal } = require('../../services/chat/sync/chatDeletionSyncService')

/**
 * Apaga a conversa também no WhatsApp do próprio número conectado (UltraMSG/Whapi),
 * best-effort. Remove o chat só da conta de atendimento — o WhatsApp não expõe API para
 * apagar a conversa no aparelho do cliente. Nunca lança: falha aqui não pode impedir a
 * exclusão no sistema. Retorna true só quando o provedor confirmou a remoção.
 */
async function apagarChatNoWhatsapp(company_id, conv) {
  try {
    if (!conv || isGroupConversation(conv)) return false
    const telefone = String(conv?.telefone || '').trim()
    if (!telefone) return false
    // Endereço LID (sem telefone canônico) não é apagável pelos endpoints de chat.
    if (telefone.toLowerCase().startsWith('lid:')) return false

    const instanceId = conv.whatsapp_instance_id
      ? await resolveConversationWhatsappInstance(company_id, conv)
      : null
    const instanceProvider = await resolveConversationProvider(company_id, instanceId)
    const provider = getProvider({ provider: instanceProvider })
    if (typeof provider?.deleteChat !== 'function') return false

    // Guarda anti-loop ANTES de chamar o provedor: apagar lá faz o canal ecoar "chat removido"
    // no webhook (Whapi chats.delete). Registrado antes porque a chamada pode aplicar no WhatsApp
    // e ainda devolver timeout — o eco chegaria sem nós sabermos que a exclusão foi nossa.
    registrarExclusaoLocal({ company_id, telefone })

    const result = await provider.deleteChat(telefone, {
      companyId: company_id,
      ...(instanceId ? { whatsappInstanceId: instanceId } : {}),
    })
    return result === true || result?.ok === true
  } catch (e) {
    console.warn('[apagarConversa] deleteChat no WhatsApp falhou:', e?.message || e)
    return false
  }
}

/**
 * Limpa as mensagens do chat também no WhatsApp do número conectado, best-effort.
 * UltraMSG: POST /chats/clearMessages. Whapi não tem equivalente → no-op (retorna false).
 * Nunca lança: falha aqui não pode impedir a limpeza no sistema.
 */
async function limparChatNoWhatsapp(company_id, conv) {
  try {
    if (!conv || isGroupConversation(conv)) return false
    const telefone = String(conv?.telefone || '').trim()
    if (!telefone || telefone.toLowerCase().startsWith('lid:')) return false

    const instanceId = conv.whatsapp_instance_id
      ? await resolveConversationWhatsappInstance(company_id, conv)
      : null
    const instanceProvider = await resolveConversationProvider(company_id, instanceId)
    const provider = getProvider({ provider: instanceProvider })
    if (typeof provider?.clearChatMessages !== 'function') return false

    const result = await provider.clearChatMessages(telefone, {
      companyId: company_id,
      ...(instanceId ? { whatsappInstanceId: instanceId } : {}),
    })
    return result === true || result?.ok === true
  } catch (e) {
    console.warn('[limparMensagensConversa] clearChatMessages no WhatsApp falhou:', e?.message || e)
    return false
  }
}

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

    // Limpa também no WhatsApp do número conectado (best-effort, antes de perder as mensagens).
    const { data: convLimpar } = await supabase
      .from('conversas')
      .select('id, tipo, telefone, whatsapp_instance_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()
    const whatsappLimpo = convLimpar ? await limparChatNoWhatsapp(company_id, convLimpar) : false

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

    return res.json({ ok: true, conversa_id, ultima_atividade: now, whatsapp_limpo: whatsappLimpo })
  } catch (err) {
    console.error('[limparMensagensConversa]', err)
    return res.status(500).json({ error: 'Erro ao limpar mensagens da conversa' })
  }
}

function flagApagarCliente(req) {
  const raw = req.query?.apagar_cliente ?? req.body?.apagar_cliente
  const s = String(raw ?? '').trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'sim' || s === 'yes'
}

// =====================================================
// Apagar conversa e dependências — DELETE /chats/:id
// Query/body apagar_cliente=1 também remove o cadastro do cliente.
// =====================================================
exports.apagarConversa = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids } = req.user
    const conversa_id = Number(req.params.id)
    if (!Number.isFinite(conversa_id) || conversa_id <= 0) {
      return res.status(400).json({ error: 'ID da conversa inválido' })
    }
    const apagarCliente = flagApagarCliente(req)
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
      .select('id, tipo, cliente_id, telefone, whatsapp_instance_id')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()
    if (errC) return res.status(500).json({ error: errC.message })
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' })
    if (isGroupConversation(conv)) {
      return res.status(400).json({ error: 'Exclusão de conversa de grupo não suportada neste endpoint.' })
    }

    // Apaga também no WhatsApp do número conectado (best-effort, antes de perder telefone/instância).
    // Só remove do nosso atendimento — não apaga no aparelho do cliente (limitação do WhatsApp).
    const whatsappApagado = await apagarChatNoWhatsapp(company_id, conv)

    const cid = company_id
    const convId = conversa_id
    const clienteId = conv?.cliente_id ? Number(conv.cliente_id) : null

    // Sem apagar_cliente: o contato deve permanecer. Com apagar_cliente: remove cadastro depois.
    const contatoExistiaAntes = clienteId ? await contatoExiste(cid, clienteId) : false

    // Cascata compartilhada com a exclusão vinda do WhatsApp (mesma ordem de sempre).
    const cascata = await apagarDependenciasEConversa({ company_id: cid, conversa_id: convId })
    if (!cascata.ok) return res.status(500).json({ error: cascata.error })

    let clienteApagado = false
    if (apagarCliente && clienteId && contatoExistiaAntes) {
      const rCli = await apagarCadastroDoCliente({ company_id: cid, cliente_id: clienteId })
      if (!rCli.ok) {
        console.error('[apagarConversa] falha ao apagar cliente', {
          company_id: cid,
          conversa_id: convId,
          cliente_id: clienteId,
          error: rCli.error,
        })
        return res.status(500).json({
          error: 'Conversa apagada, mas falhou ao apagar o cadastro do cliente',
          id: convId,
          cliente_id: clienteId,
        })
      }
      clienteApagado = true
    }

    emitirConversaApagada(req.app.get('io'), {
      company_id: cid,
      conversa_id: convId,
      cliente_id: clienteId,
      cliente_apagado: clienteApagado,
      whatsapp_apagado: whatsappApagado,
      origem: 'usuario',
    })

    let contatoPreservado = true
    if (clienteId && contatoExistiaAntes) {
      if (apagarCliente) {
        contatoPreservado = !clienteApagado
      } else {
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
    }

    return res.json({
      ok: true,
      id: convId,
      contato_preservado: contatoPreservado,
      cliente_apagado: clienteApagado,
      cliente_id: clienteId,
      cliente_id_preservado: contatoPreservado ? clienteId : null,
      whatsapp_apagado: whatsappApagado,
    })
  } catch (err) {
    console.error('[apagarConversa]', err)
    return res.status(500).json({ error: 'Erro ao apagar conversa' })
  }
}
