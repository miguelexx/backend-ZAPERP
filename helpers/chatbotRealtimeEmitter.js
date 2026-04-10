/**
 * Emite eventos Socket.IO após o chatbot de triagem inserir mensagem outbound.
 * O fluxo normal do webhook só emite a mensagem recebida do cliente; sem isso o painel não vê as respostas do bot em tempo real.
 */

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
  const rooms = [`conversa_${cid}`, `empresa_${company_id}`]
  if (depId != null) rooms.push(`departamento_${depId}`)

  io.to(rooms).emit('nova_mensagem', emitPayload)
  io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: cid })

  const isGroup = String(convRow?.tipo || '').toLowerCase() === 'grupo' || String(convRow?.telefone || '').includes('@g.us')
  const contatoNome = convRow?.nome_contato_cache ? String(convRow.nome_contato_cache).trim() : null
  const fotoPerfil = convRow?.foto_perfil_contato_cache ? String(convRow.foto_perfil_contato_cache).trim() : null

  const convPayload = {
    id: cid,
    ultima_atividade: convRow?.ultima_atividade ?? new Date().toISOString(),
    telefone: convRow?.telefone ?? null,
    exibir_badge_aberta: !isGroup,
    ...(isGroup ? { status_atendimento: null } : {}),
    ...(depId != null ? { departamento_id: depId } : {}),
    ...(contatoNome ? { nome_contato_cache: contatoNome, contato_nome: contatoNome } : {}),
    ...(fotoPerfil ? { foto_perfil_contato_cache: fotoPerfil, foto_perfil: fotoPerfil } : {}),
    ultima_mensagem_preview: {
      texto: String(mensagem.texto ?? '(mensagem)').slice(0, 500),
      criado_em: mensagem.criado_em,
      direcao: 'out',
      fromMe: true,
    },
    reordenar_suave: true,
  }

  io.to(`empresa_${company_id}`).emit('conversa_atualizada', convPayload)
  if (depId != null) {
    io.to(`departamento_${depId}`).emit('atualizar_conversa', { id: cid })
    io.to(`departamento_${depId}`).emit('conversa_atualizada', convPayload)
  }
}

module.exports = { emitBotMensagemRealtime }
