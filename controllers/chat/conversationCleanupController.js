/**
 * Limpeza e exclusão de conversa.
 * Extraído de controllers/chatController.js (modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { isGroupConversation } = require('../../helpers/conversaHelper')
const { emitirConversaAtualizada, emitirEventoEmpresaConversa } = require('../../services/chat/realtime/chatRealtimeGateway')
const { assertPermissaoConversa } = require('../../services/chat/access/conversationPolicy')
const { marcarComoLidaPorUsuario } = require('../../services/chat/unread/conversationUnreadService')

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

function flagApagarCliente(req) {
  const raw = req.query?.apagar_cliente ?? req.body?.apagar_cliente
  const s = String(raw ?? '').trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'sim' || s === 'yes'
}

async function softDeleteOptional(table, build) {
  try {
    const { error } = await build(supabase.from(table))
    if (error && !String(error.message || '').includes('does not exist')) {
      console.warn(`[apagarConversa] ${table}:`, error.message)
    }
  } catch (_) { /* tabela opcional */ }
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

    // Sem apagar_cliente: o contato deve permanecer. Com apagar_cliente: remove cadastro depois.
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

    await softDeleteOptional('mensagens_ocultas', (q) => q.delete().eq('company_id', cid).eq('conversa_id', convId))
    await softDeleteOptional('conversa_unreads', (q) => q.delete().eq('company_id', cid).eq('conversa_id', convId))
    await softDeleteOptional('conversa_atendentes', (q) => q.delete().eq('conversa_id', convId))
    await softDeleteOptional('conversa_usuario_prefs', (q) => q.delete().eq('conversa_id', convId))
    await supabase.from('atendimentos').delete().eq('company_id', cid).eq('conversa_id', convId)
    await supabase.from('historico_atendimentos').delete().eq('conversa_id', convId)
    await softDeleteOptional('conversa_tags', (q) => q.delete().eq('company_id', cid).eq('conversa_id', convId))
    await softDeleteOptional('bot_logs', (q) => q.delete().eq('company_id', cid).eq('conversa_id', convId))
    await supabase.from('mensagens').delete().eq('company_id', cid).eq('conversa_id', convId)

    await supabase.from('conversas').update({ cliente_id: null }).eq('company_id', cid).eq('id', convId)

    const { error: errDel } = await supabase.from('conversas').delete().eq('company_id', cid).eq('id', convId)
    if (errDel) return res.status(500).json({ error: errDel.message })

    let clienteApagado = false
    if (apagarCliente && clienteId && contatoExistiaAntes) {
      await supabase.from('conversas').update({ cliente_id: null }).eq('company_id', cid).eq('cliente_id', clienteId)
      await softDeleteOptional('cliente_nomes_vinculados', (q) => q.delete().eq('company_id', cid).eq('cliente_id', clienteId))
      await softDeleteOptional('cliente_tags', (q) => q.delete().eq('company_id', cid).eq('cliente_id', clienteId))
      await softDeleteOptional('contato_opt_in', (q) => q.delete().eq('company_id', cid).eq('cliente_id', clienteId))
      await softDeleteOptional('contato_opt_out', (q) => q.delete().eq('company_id', cid).eq('cliente_id', clienteId))
      await softDeleteOptional('campanha_envios', (q) => q.delete().eq('cliente_id', clienteId))
      await softDeleteOptional('avaliacoes_atendimento', (q) => q.delete().eq('company_id', cid).eq('cliente_id', clienteId))
      await softDeleteOptional('crm_leads', (q) => q.update({ cliente_id: null }).eq('company_id', cid).eq('cliente_id', clienteId))

      const { error: errCli } = await supabase
        .from('clientes')
        .delete()
        .eq('company_id', cid)
        .eq('id', clienteId)
      if (errCli) {
        console.error('[apagarConversa] falha ao apagar cliente', {
          company_id: cid,
          conversa_id: convId,
          cliente_id: clienteId,
          error: errCli.message,
        })
        return res.status(500).json({
          error: 'Conversa apagada, mas falhou ao apagar o cadastro do cliente',
          id: convId,
          cliente_id: clienteId,
        })
      }
      clienteApagado = true
    }

    const io = req.app.get('io')
    if (io) {
      emitirEventoEmpresaConversa(io, cid, convId, 'conversa_apagada', {
        id: convId,
        cliente_id: clienteId,
        cliente_apagado: clienteApagado,
      })
      io.to(`empresa_${cid}`).emit('atualizar_conversa', {
        id: convId,
        removida: true,
        cliente_id: clienteId,
        cliente_apagado: clienteApagado,
      })
    }

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
    })
  } catch (err) {
    console.error('[apagarConversa]', err)
    return res.status(500).json({ error: 'Erro ao apagar conversa' })
  }
}
