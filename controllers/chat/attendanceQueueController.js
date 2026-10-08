/**
 * Histórico de atendimentos e puxar conversa da fila.
 * Extraído de controllers/chatController.js (modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { registrarAtendimento } = require('../../services/atendimentosRegistroService')
const { resetAlertaSemRespostaAoAssumirReaberta } = require('../../services/atendimentoSemRespostaService')
const { clearReabertaFaltaInteracao } = require('../../helpers/reabertaFaltaInteracaoHelper')
const { emitirConversaAtualizada, emitirLock, emitirMovimentacaoInternaAtendimento } = require('../../services/chat/realtime/chatRealtimeGateway')

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
