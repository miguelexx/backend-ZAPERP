const supabase = require('../config/supabase')
const path = require('path')
const fs = require('fs')

/**
 * Envia mensagem para WhatsApp via Meta API (se configurado).
 * phoneId: opcional para multi-tenant; se omitido usa env
 * Exportado para uso em chatController (envio a partir do CRM).
 */
async function enviarMensagemWhatsApp(telefone, texto, phoneId = null) {
  const token = process.env.WHATSAPP_TOKEN || process.env.META_ACCESS_TOKEN
  const defaultPhoneId = process.env.PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID
  const resolvedPhoneId = phoneId || defaultPhoneId
  if (!token || !resolvedPhoneId) return false
  const num = String(telefone).replace(/\D/g, '')
  const url = `https://graph.facebook.com/v18.0/${resolvedPhoneId}/messages`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: num,
        type: 'text',
        text: { body: texto }
      })
    })
    return res.ok
  } catch (e) {
    console.error('Erro ao enviar WhatsApp:', e)
    return false
  }
}

/**
 * Busca mídia do WhatsApp (áudio, imagem, etc.) e salva em uploads
 */
async function buscarEMediasWhatsApp(mediaId) {
  const token = process.env.WHATSAPP_TOKEN || process.env.META_ACCESS_TOKEN
  if (!token) return null
  try {
    const url = `https://graph.facebook.com/v18.0/${mediaId}`
    const res = await fetch(`${url}?access_token=${token}`)
    const data = await res.json()
    const mediaUrl = data?.url
    if (!mediaUrl) return null

    const buf = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.arrayBuffer())
    const buffer = Buffer.from(buf)

    const uploadDir = path.join(__dirname, '../uploads')
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

    const ext = data?.mime_type?.includes('ogg') ? '.ogg' : data?.mime_type?.includes('mp3') ? '.mp3' : '.bin'
    const filename = `${Date.now()}-wa-${Math.random().toString(36).slice(2, 8)}${ext}`
    const filepath = path.join(uploadDir, filename)
    fs.writeFileSync(filepath, buffer)
    return `/uploads/${filename}`
  } catch (e) {
    console.error('Erro ao buscar mídia WhatsApp:', e.message)
    return null
  }
}

async function registrarBotLog(company_id, conversa_id, tipo, detalhes = {}) {
  try {
    await supabase.from('bot_logs').insert({
      company_id,
      conversa_id: conversa_id || null,
      tipo,
      detalhes: typeof detalhes === 'object' ? detalhes : { raw: detalhes }
    })
  } catch (e) {
    console.warn('Erro ao registrar bot_log:', e.message)
  }
}

/**
 * GET /webhook — verificação do Meta para configurar o webhook no Developer Console.
 * Meta envia: hub.mode=subscribe, hub.verify_token=XXX, hub.challenge=YYY
 * Responde com hub.challenge se verify_token bater com WEBHOOK_VERIFY_TOKEN
 */
exports.verificarWebhook = (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || 'whatsapp_verify_me'

  if (mode === 'subscribe' && token === verifyToken && challenge) {
    console.log('✅ Webhook verificado pelo Meta')
    return res.status(200).send(String(challenge))
  }

  res.sendStatus(403)
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
    const from = msg.from
    let texto = (msg.text?.body || '').trim()
    let tipo = 'texto'
    let url = null
    let nome_arquivo = null
    let reply_meta = null

    // Mídia: áudio, imagem, vídeo, documento
    if (msg.audio) {
      tipo = 'audio'
      nome_arquivo = 'audio.ogg'
      url = await buscarEMediasWhatsApp(msg.audio.id)
      if (!texto) texto = '(áudio)'
    } else if (msg.image) {
      tipo = 'imagem'
      nome_arquivo = msg.image.caption || 'imagem.jpg'
      url = await buscarEMediasWhatsApp(msg.image.id)
      if (msg.image.caption) texto = msg.image.caption
      else if (!texto) texto = '(imagem)'
    } else if (msg.video) {
      tipo = 'video'
      nome_arquivo = msg.video.caption || 'video.mp4'
      url = await buscarEMediasWhatsApp(msg.video.id)
      if (!texto) texto = '(vídeo)'
    } else if (msg.document) {
      tipo = 'arquivo'
      nome_arquivo = msg.document.filename || msg.document.caption || 'arquivo'
      url = await buscarEMediasWhatsApp(msg.document.id)
      if (!texto) texto = '(arquivo)'
    }

    // Multi-tenant: metadata.phone_number_id → empresas_whatsapp → company_id
    const phoneNumberId = value?.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : null
    let company_id = Number(process.env.WEBHOOK_COMPANY_ID || 1)
    if (phoneNumberId) {
      const { data: ew } = await supabase
        .from('empresas_whatsapp')
        .select('company_id')
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle()
      if (ew?.company_id) company_id = Number(ew.company_id)
    }

    console.log('📩 Mensagem recebida:', from, texto)

    // 1) Cliente (cria se não existir)
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

    // 2) Conversa (busca aberta ou cria) — trazer departamento_id
    let conversa_id = null
    let departamento_id = null
    const { data: conversasAbertas, error: errConv } = await supabase
      .from('conversas')
      .select('id, departamento_id')
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
      departamento_id = conversasAbertas[0].departamento_id ?? null
    } else {
      const { data: novaConversa, error: errNovaConv } = await supabase
        .from('conversas')
        .insert({
          telefone: from,
          cliente_id,
          lida: false,
          status_atendimento: 'aberta',
          company_id
        })
        .select('id, departamento_id')
        .single()

      if (errNovaConv) {
        console.error('Erro ao criar conversa:', errNovaConv)
        return res.sendStatus(500)
      }
      conversa_id = novaConversa.id
      departamento_id = novaConversa.departamento_id ?? null
    }

    // 3) Roteamento por setor (respeita ia_config): se conversa ainda sem departamento
    if (departamento_id == null) {
      const { data: iaConfigRow } = await supabase
        .from('ia_config')
        .select('config')
        .eq('company_id', company_id)
        .maybeSingle()

      const roteamento = iaConfigRow?.config?.roteamento || {}
      const ativarMenu = roteamento.ativar_menu_setores !== false
      const textoMenu = roteamento.texto_menu || 'Escolha o setor pelo número:'
      const departamentosIds = roteamento.departamentos_ids || []

      let departamentos = []
      if (ativarMenu) {
        let q = supabase
          .from('departamentos')
          .select('id, nome')
          .eq('company_id', company_id)
        if (Array.isArray(departamentosIds) && departamentosIds.length > 0) {
          q = q.in('id', departamentosIds)
        }
        q = q.order('nome')
        const { data: depList, error: errDep } = await q
        if (!errDep && depList) departamentos = depList
      }

      if (departamentos.length > 0) {
        const opcao = texto ? parseInt(texto, 10) : NaN
        if (Number.isInteger(opcao) && opcao >= 1 && opcao <= departamentos.length) {
          const dept = departamentos[opcao - 1]
          const { error: errUpd } = await supabase
            .from('conversas')
            .update({ departamento_id: dept.id })
            .eq('id', conversa_id)
            .eq('company_id', company_id)
          if (!errUpd) {
            departamento_id = dept.id
            console.log('✅ Setor atribuído:', dept.nome, 'conversa', conversa_id)
            await registrarBotLog(company_id, conversa_id, 'setor_atribuido', { departamento_id: dept.id, departamento_nome: dept.nome })
          }
        } else {
          const linhas = departamentos.map((d, i) => `${i + 1} - ${d.nome}`)
          const menuTexto = textoMenu + '\n\n' + linhas.join('\n')
          await supabase.from('mensagens').insert({
            conversa_id,
            texto: menuTexto,
            direcao: 'out',
            company_id,
            status: 'enviada'
          })
          const phoneId = phoneNumberId || undefined
          await enviarMensagemWhatsApp(from, menuTexto, phoneId)
          await registrarBotLog(company_id, conversa_id, 'menu_setores_enviado', { departamentos: departamentos.map(d => d.nome) })
        }
      }
    }

    // Reply (WhatsApp Cloud API): msg.context.id referencia a mensagem citada
    // Ex.: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
    const quotedId = msg?.context?.id ? String(msg.context.id).trim() : null
    if (quotedId) {
      try {
        const { data: quoted } = await supabase
          .from('mensagens')
          .select('texto, direcao, remetente_nome')
          .eq('company_id', company_id)
          .eq('conversa_id', conversa_id)
          .eq('whatsapp_id', quotedId)
          .maybeSingle()
        const snippet = String(quoted?.texto || '').trim().slice(0, 180) || 'Mensagem'
        const name =
          quoted?.direcao === 'out'
            ? 'Você'
            : (String(quoted?.remetente_nome || '').trim() || 'Contato')
        reply_meta = {
          name,
          snippet,
          ts: Date.now(),
          replyToId: quotedId
        }
      } catch (_) {
        reply_meta = { name: 'Mensagem', snippet: 'Mensagem', ts: Date.now(), replyToId: quotedId }
      }
    }

    // 4) Salvar mensagem do cliente (texto ou mídia)
    const insertMsg = {
      conversa_id,
      texto: texto || '(mídia ou vazio)',
      direcao: 'in',
      company_id,
      whatsapp_id: msg.id || null,
    }
    if (tipo !== 'texto') {
      insertMsg.tipo = tipo
      if (url) insertMsg.url = url
      if (nome_arquivo) insertMsg.nome_arquivo = nome_arquivo
    }
    if (reply_meta) insertMsg.reply_meta = reply_meta

    let mensagemSalva = null
    let errMsg = null
    {
      const r = await supabase
        .from('mensagens')
        .insert(insertMsg)
        .select('*')
        .single()
      mensagemSalva = r.data
      errMsg = r.error
    }

    // Compatibilidade: se a coluna reply_meta não existir, tenta inserir sem ela
    if (errMsg && (String(errMsg.message || '').includes('reply_meta') || String(errMsg.message || '').includes('does not exist'))) {
      delete insertMsg.reply_meta
      const retry = await supabase.from('mensagens').insert(insertMsg).select('*').single()
      if (retry.error) {
        console.error('Erro ao salvar mensagem:', retry.error)
        return res.sendStatus(500)
      }
      // substitui a referência para o realtime
      mensagemSalva = retry.data
      errMsg = null
    }

    if (errMsg) {
      console.error('Erro ao salvar mensagem:', errMsg)
      return res.sendStatus(500)
    }

    // 5) Realtime: empresa, conversa e room do departamento
    const io = req.app.get('io')
    if (io) {
      io.to(`empresa_${company_id}`).emit('nova_mensagem', mensagemSalva)
      io.to(`conversa_${conversa_id}`).emit('nova_mensagem', mensagemSalva)
      io.to(`empresa_${company_id}`).emit('atualizar_conversa', { id: conversa_id })
      if (departamento_id != null) {
        io.to(`departamento_${departamento_id}`).emit('nova_mensagem', mensagemSalva)
        io.to(`departamento_${departamento_id}`).emit('atualizar_conversa', { id: conversa_id })
      }
    }

    return res.sendStatus(200)
  } catch (err) {
    console.error('Erro webhook:', err)
    return res.sendStatus(500)
  }
}

exports.enviarMensagemWhatsApp = enviarMensagemWhatsApp
