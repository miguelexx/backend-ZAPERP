const supabase = require('../config/supabase')

// 🔥 helper: incrementa unread para todos da empresa (por enquanto global)
async function incrementarUnread(company_id, conversa_id) {
  // aqui você pode depois refinar por usuário
  const { data: existentes, error: errSel } = await supabase
    .from('conversa_unreads')
    .select('id, unread_count')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)

  if (errSel) {
    console.error('Erro ao buscar unreads:', errSel)
    return
  }

  if (existentes && existentes.length > 0) {
    for (const row of existentes) {
      await supabase
        .from('conversa_unreads')
        .update({
          unread_count: (row.unread_count || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', row.id)
    }
  } else {
    // cria um registro global (usuario_id null)
    await supabase
      .from('conversa_unreads')
      .insert({
        company_id,
        conversa_id,
        usuario_id: null,
        unread_count: 1
      })
  }
}

exports.receberWebhook = async (req, res) => {
  try {
    const entry = req.body.entry?.[0]
    const changes = entry?.changes?.[0]
    const value = changes?.value
    const messages = value?.messages

    if (!messages || messages.length === 0) {
      return res.status(200).json({ ok: true, message: 'Sem mensagens' })
    }

    const msg = messages[0]
    const from = msg.from // telefone do cliente
    const texto = msg.text?.body || ''

    // 🔧 FUTURO: mapear company_id pelo número do WhatsApp Business
    const company_id = 1

    console.log('📩 Webhook recebido:', from, texto)

    // 1) CLIENTE (cria se não existir)
    let cliente_id = null

    const { data: clienteExistente, error: errCli } = await supabase
      .from('clientes')
      .select('id')
      .eq('company_id', company_id)
      .eq('telefone', from)
      .maybeSingle()

    if (errCli) {
      console.error('Erro ao buscar cliente:', errCli)
      return res.sendStatus(500)
    }

    if (clienteExistente?.id) {
      cliente_id = clienteExistente.id
    } else {
      const { data: novoCliente, error: errNovoCli } = await supabase
        .from('clientes')
        .insert({
          telefone: from,
          nome: null,
          observacoes: null,
          company_id
        })
        .select('id')
        .single()

      if (errNovoCli) {
        console.error('Erro ao criar cliente:', errNovoCli)
        return res.sendStatus(500)
      }

      cliente_id = novoCliente.id
    }

    // 2) CONVERSA ABERTA DO CLIENTE (reutiliza se existir)
    let conversa_id = null

    const { data: conversasAbertas, error: errConv } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .eq('cliente_id', cliente_id)
      .neq('status_atendimento', 'fechada')
      .order('id', { ascending: false })
      .limit(1)

    if (errConv) {
      console.error('Erro ao buscar conversa:', errConv)
      return res.sendStatus(500)
    }

    if (conversasAbertas && conversasAbertas.length > 0) {
      conversa_id = conversasAbertas[0].id
    } else {
      const { data: novaConversa, error: errNovaConv } = await supabase
        .from('conversas')
        .insert({
          telefone: from,
          cliente_id,
          lida: false,
          status_atendimento: 'aberta',
          company_id,
          last_message_at: new Date().toISOString()
        })
        .select('id')
        .single()

      if (errNovaConv) {
        console.error('Erro ao criar conversa:', errNovaConv)
        return res.sendStatus(500)
      }

      conversa_id = novaConversa.id
    }

    // 3) SALVAR MENSAGEM (direcao: in)
    const { data: mensagemSalva, error: errMsg } = await supabase
      .from('mensagens')
      .insert({
        conversa_id,
        texto,
        direcao: 'in',
        company_id,
        whatsapp_id: msg.id || null,
        criado_em: new Date().toISOString()
      })
      .select('*')
      .single()

    if (errMsg) {
      console.error('Erro ao salvar mensagem:', errMsg)
      return res.sendStatus(500)
    }

    // 4) ATUALIZAR CONVERSA (last_message_at + lida = false)
    await supabase
      .from('conversas')
      .update({
        lida: false,
        last_message_at: new Date().toISOString()
      })
      .eq('company_id', company_id)
      .eq('id', conversa_id)

    // 5) INCREMENTAR UNREAD
    await incrementarUnread(company_id, conversa_id)

    // 6) REALTIME
    const io = req.app.get('io')

    if (io) {
      io.to(`empresa_${company_id}`).emit('nova_mensagem', mensagemSalva)

      io.to(`conversa_${conversa_id}`).emit('nova_mensagem', mensagemSalva)

      io.to(`empresa_${company_id}`).emit('conversa_atualizada', {
        id: conversa_id,
        last_message_at: mensagemSalva.criado_em
      })
    }

    return res.sendStatus(200)
  } catch (err) {
    console.error('Erro webhook:', err)
    return res.sendStatus(500)
  }
}
