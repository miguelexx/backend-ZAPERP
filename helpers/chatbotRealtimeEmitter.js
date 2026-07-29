/**
 * Emite eventos Socket.IO após o chatbot de triagem inserir mensagem outbound.
 * O fluxo normal do webhook só emite a mensagem recebida do cliente; sem isso o painel não vê as respostas do bot em tempo real.
 */

const { normalizarTimestampSemFusoAmbiguoParaApi } = require('./timestampApiCompat')
const { empresaRoom, conversaRoom, departamentoRoom } = require('./socketRooms')

function canonicalMsgStatus(row) {
  const raw = (row?.status_mensagem ?? row?.status ?? '').toString().toLowerCase()
  if (raw === 'enviada' || raw === 'enviado') return 'sent'
  if (raw === 'entregue' || raw === 'received') return 'delivered'
  return raw || 'sent'
}

/**
 * @param {object} opts
 * @param {import('socket.io').Server} opts.io
 * @param {object} opts.supabase
 * @param {number} opts.company_id
 * @param {number} opts.conversa_id
 * @param {object} opts.mensagem - linha retornada por insert().select('*').single()
 */
async function emitBotMensagemRealtime({ io, supabase, company_id, conversa_id, mensagem }) {
  if (!io || !mensagem || !company_id || !conversa_id) return

  const cid = Number(conversa_id || mensagem.conversa_id)
  const canon = canonicalMsgStatus(mensagem)
  const emitPayload = {
    ...mensagem,
    criado_em: normalizarTimestampSemFusoAmbiguoParaApi(mensagem.criado_em),
    conversa_id: cid,
    status: canon,
    status_mensagem: canon,
    fromMe: true,
    direcao: mensagem.direcao || 'out',
  }

  let convRow = null
  try {
    const { data } = await supabase
      .from('conversas')
      .select(
        'id, ultima_atividade, nome_contato_cache, foto_perfil_contato_cache, telefone, cliente_id, departamento_id, status_atendimento, atendente_id, tipo'
      )
      .eq('id', cid)
      .eq('company_id', company_id)
      .maybeSingle()
    convRow = data
  } catch (e) {
    console.warn('[chatbotRealtimeEmitter] conversa:', e?.message || e)
  }

  const depId = convRow?.departamento_id != null ? Number(convRow.departamento_id) : null
  const depRoom = departamentoRoom(company_id, depId)
  const emitScoped = async (eventName, payload) => {
    try {
      // Lazy require evita ciclo de inicialização: webhook -> este helper -> chatController.
      const { emitirParaUsuariosQuePodemVerConversa } = require('../controllers/chatController')
      const emitted = await emitirParaUsuariosQuePodemVerConversa(
        io,
        company_id,
        cid,
        eventName,
        payload
      )
      if (emitted) return true
    } catch (e) {
      console.warn('[chatbotRealtimeEmitter] emissão escopada:', e?.message || e)
    }
    // A room da conversa só admite sockets que passaram pela autorização de join.
    const convRoom = conversaRoom(cid)
    if (convRoom) io.to(convRoom).emit(eventName, payload)
    return false
  }

  await emitScoped('nova_mensagem', emitPayload)
  const empRoom = empresaRoom(company_id)
  if (empRoom) io.to(empRoom).emit('atualizar_conversa', { id: cid })

  const isGroup = String(convRow?.tipo || '').toLowerCase() === 'grupo' || String(convRow?.telefone || '').includes('@g.us')
  const contatoNome = convRow?.nome_contato_cache ? String(convRow.nome_contato_cache).trim() : null
  const fotoPerfil = convRow?.foto_perfil_contato_cache ? String(convRow.foto_perfil_contato_cache).trim() : null

  const convPayload = {
    id: cid,
    ultima_atividade: convRow?.ultima_atividade ?? new Date().toISOString(),
    telefone: convRow?.telefone ?? null,
    exibir_badge_aberta: !isGroup,
    ...(isGroup ? { status_atendimento: null } : {}),
    // Sempre enviar (null = sem setor) para o painel atualizar badge/lista sem recarregar
    departamento_id: depId,
    ...(contatoNome ? { nome_contato_cache: contatoNome, contato_nome: contatoNome } : {}),
    ...(fotoPerfil ? { foto_perfil_contato_cache: fotoPerfil, foto_perfil: fotoPerfil } : {}),
    ultima_mensagem_preview: {
      texto: String(mensagem.texto ?? '(mensagem)').slice(0, 500),
      criado_em: normalizarTimestampSemFusoAmbiguoParaApi(mensagem.criado_em),
      direcao: 'out',
      fromMe: true,
    },
    reordenar_suave: true,
  }

  await emitScoped('conversa_atualizada', convPayload)
  if (depRoom) {
    io.to(depRoom).emit('atualizar_conversa', { id: cid })
  }
}

/**
 * Após reabrir conversa encerrada: notifica lista/canais com o estado real retornado pelo BD (aberta ou em_atendimento).
 */
function emitReaberturaSemSetorRealtime({ io, company_id, conversa_id, reabertaRow, departamentoIdAntigo }) {
  if (!io || !company_id || !conversa_id) return
  const cid = Number(conversa_id)
  const depNovo =
    reabertaRow?.departamento_id != null && Number.isFinite(Number(reabertaRow.departamento_id))
      ? Number(reabertaRow.departamento_id)
      : null
  const atendNovo =
    reabertaRow?.atendente_id != null && Number.isFinite(Number(reabertaRow.atendente_id))
      ? Number(reabertaRow.atendente_id)
      : null
  const statusLista = String(reabertaRow?.status_atendimento || 'aberta')
  const convPayload = {
    id: cid,
    departamento_id: depNovo,
    atendente_id: atendNovo,
    status_atendimento: statusLista,
    ultima_atividade: reabertaRow?.ultima_atividade ?? new Date().toISOString(),
    telefone: reabertaRow?.telefone ?? null,
    exibir_badge_aberta: true,
    reaberta_por_falta_interacao: reabertaRow?.reaberta_por_falta_interacao === true,
    reaberta_falta_interacao_em: reabertaRow?.reaberta_falta_interacao_em ?? null,
    reordenar_suave: true,
  }
  const empRoom = empresaRoom(company_id)
  const convRoom = conversaRoom(cid)
  if (empRoom) io.to(empRoom).emit('atualizar_conversa', { id: cid })
  if (empRoom) io.to(empRoom).emit('conversa_atualizada', convPayload)
  if (convRoom) io.to(convRoom).emit('conversa_atualizada', convPayload)
  const antigo =
    departamentoIdAntigo != null && Number.isFinite(Number(departamentoIdAntigo))
      ? Number(departamentoIdAntigo)
      : null
  if (antigo != null && antigo !== depNovo) {
    const oldRoom = departamentoRoom(company_id, antigo)
    if (oldRoom) {
      io.to(oldRoom).emit('atualizar_conversa', { id: cid })
      io.to(oldRoom).emit('conversa_atualizada', convPayload)
    }
  }
  if (depNovo != null) {
    const newRoom = departamentoRoom(company_id, depNovo)
    if (newRoom) {
      io.to(newRoom).emit('atualizar_conversa', { id: cid })
      io.to(newRoom).emit('conversa_atualizada', convPayload)
    }
  }
}

module.exports = { emitBotMensagemRealtime, emitReaberturaSemSetorRealtime }
