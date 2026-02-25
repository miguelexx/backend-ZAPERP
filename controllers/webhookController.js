const supabase = require('../config/supabase')
const path = require('path')
const fs = require('fs')
const { normalizePhoneBR, possiblePhonesBR } = require('../helpers/phoneHelper')
const { findOrCreateConversation } = require('../helpers/conversationSync')

/**
 * Envia mensagem para WhatsApp via Meta API (se configurado).
 * phoneId: opcional para multi-tenant; se omitido usa env
 * Exportado para uso em chatController (envio a partir do CRM).
 */
async function enviarMensagemWhatsApp(telefone, texto, phoneId = null, replyMessageId = null) {
  const token = process.env.WHATSAPP_TOKEN || process.env.META_ACCESS_TOKEN
  const defaultPhoneId = process.env.PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID
  const resolvedPhoneId = phoneId || defaultPhoneId
  if (!token || !resolvedPhoneId) return { ok: false, messageId: null }
  const num = String(telefone).replace(/\D/g, '')
  const url = `https://graph.facebook.com/v18.0/${resolvedPhoneId}/messages`
  try {
    const body = {
      messaging_product: 'whatsapp',
      to: num,
      type: 'text',
      text: { body: texto }
    }
    // Reply nativo (WhatsApp Cloud API): context.message_id
    if (replyMessageId) {
      body.context = { message_id: String(replyMessageId).trim() }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    const json = await res.json().catch(() => null)
    const messageId = json?.messages?.[0]?.id ? String(json.messages[0].id).trim() : null
    return { ok: !!res.ok, messageId }
  } catch (e) {
    console.error('Erro ao enviar WhatsApp:', e)
    return { ok: false, messageId: null }
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
    const statuses = value?.statuses

    // ✅ Atualização de status (Meta Cloud API): entrega/leitura
    // Quando vier somente "statuses" (sem messages), atualiza ticks e retorna.
    if ((!messages || messages.length === 0) && Array.isArray(statuses) && statuses.length > 0) {
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

      const io = req.app.get('io')

      for (const st of statuses) {
        const wId = st?.id ? String(st.id).trim() : null
        const raw = st?.status ? String(st.status).trim().toLowerCase() : ''
        if (!wId) continue

        const norm =
          raw === 'sent' ? 'sent' :
          raw === 'delivered' ? 'delivered' :
          raw === 'read' ? 'read' :
          (raw || 'sent')

        const { data: msgRow, error } = await supabase
          .from('mensagens')
          .update({ status: norm })
          .eq('company_id', company_id)
          .eq('whatsapp_id', wId)
          .select('id, conversa_id, company_id')
          .maybeSingle()

        if (!error && msgRow && io) {
          // Emite para empresa + conversa em UMA única operação (evita evento duplicado
          // quando o mesmo socket está nas duas rooms).
          io.to(`empresa_${msgRow.company_id}`)
            .to(`conversa_${msgRow.conversa_id}`)
            .emit('status_mensagem', { mensagem_id: msgRow.id, conversa_id: msgRow.conversa_id, status: norm })
        }
      }

      return res.status(200).json({ ok: true, statuses: statuses.length })
    }

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

    // ---------- Evitar conversa duplicada: mensagem enviada pelo celular (nosso número) ----------
    // Se "from" for o número do negócio, a mensagem foi ENVIADA por nós; o contato é o DESTINATÁRIO.
    let displayPhone = value?.metadata?.display_phone_number ? String(value.metadata.display_phone_number).trim() : ''
    if (!displayPhone && phoneNumberId) {
      const { data: ewPhone } = await supabase.from('empresas_whatsapp').select('phone_number').eq('phone_number_id', phoneNumberId).maybeSingle()
      if (ewPhone?.phone_number) displayPhone = String(ewPhone.phone_number).trim()
    }
    const ourNumberNorm = displayPhone ? normalizePhoneBR(displayPhone) || displayPhone.replace(/\D/g, '') : ''
    const ourNumberVariants = ourNumberNorm ? [ourNumberNorm, ...possiblePhonesBR(displayPhone || ourNumberNorm)] : []
    const fromDigits = String(from || '').replace(/\D/g, '')
    const isOutgoing = ourNumberVariants.length > 0 && fromDigits && ourNumberVariants.some((v) => String(v).replace(/\D/g, '') === fromDigits)

    let contactPhone = from
    if (isOutgoing) {
      const recipient = msg.to ? String(msg.to).trim() : null
      if (!recipient) {
        console.log('📤 Meta webhook: mensagem enviada por nós (from=nosso número) sem destinatário (to); ignorada para evitar conversa duplicada.')
        return res.status(200).json({ ok: true, message: 'Outgoing without recipient' })
      }
      contactPhone = recipient
      console.log('📤 Mensagem enviada por nós (celular) → destinatário:', contactPhone, texto?.slice(0, 50))
    } else {
      console.log('📩 Mensagem recebida:', from, texto?.slice(0, 50))
    }

    // Normalizar telefone do contato para busca/criação (evita conversa duplicada 55DD9... vs 55DD8...)
    const contactPhoneNorm = normalizePhoneBR(contactPhone) || String(contactPhone).replace(/\D/g, '')
    const contactPhonesForSearch = contactPhoneNorm ? possiblePhonesBR(contactPhoneNorm) : [contactPhone]

    // 1) Cliente (cria se não existir) — sempre pelo CONTATO (destinatário se for mensagem nossa)
    let cliente_id = null
    let clienteQuery = supabase.from('clientes').select('id').eq('company_id', company_id)
    if (contactPhonesForSearch.length > 0) clienteQuery = clienteQuery.in('telefone', contactPhonesForSearch)
    else clienteQuery = clienteQuery.eq('telefone', contactPhoneNorm || contactPhone)
    const { data: clientesCandidatos, error: errCli } = await clienteQuery.order('id', { ascending: true }).limit(5)

    if (errCli) {
      console.error('Erro ao buscar cliente:', errCli)
      return res.sendStatus(500)
    }

    const clienteExistente = Array.isArray(clientesCandidatos) && clientesCandidatos.length > 0 ? clientesCandidatos[0] : null

    if (clienteExistente?.id) {
      cliente_id = clienteExistente.id
    } else {
      const { data: novoCliente, error: errNovoCli } = await supabase
        .from('clientes')
        .insert({
          telefone: contactPhoneNorm || contactPhone,
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

    // 2) Conversa — findOrCreateConversation garante UMA conversa por contato.
    //    Mensagens recebidas (in) e enviadas pelo celular (out/fromMe) sempre encontram a mesma conversa.
    let conversa_id = null
    let departamento_id = null

    try {
      const syncResult = await findOrCreateConversation(supabase, {
        company_id,
        phone: contactPhoneNorm || contactPhone,
        cliente_id,
        isGroup: false,
        logPrefix: `[Meta fromMe=${isOutgoing}]`,
      })

      if (!syncResult) {
        console.error('[Meta] findOrCreateConversation retornou null para:', contactPhone)
        return res.sendStatus(500)
      }

      conversa_id = syncResult.conversa.id
      departamento_id = syncResult.conversa.departamento_id ?? null
    } catch (errConv) {
      console.error('[Meta] ❌ Erro ao obter/criar conversa:', errConv?.message || errConv)
      return res.sendStatus(500)
    }

    // 3) Roteamento por setor (apenas mensagens recebidas do contato; não para mensagens enviadas por nós)
    if (!isOutgoing && departamento_id == null) {
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
          await enviarMensagemWhatsApp(contactPhone, menuTexto, phoneId)
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

    // 4) Salvar mensagem (do contato ou enviada por nós pelo celular)
    const insertMsg = {
      conversa_id,
      texto: texto || '(mídia ou vazio)',
      direcao: isOutgoing ? 'out' : 'in',
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

    // Atualiza ordenação (ultima_atividade) e CRM (ultimo_contato)
    try {
      await supabase
        .from('conversas')
        .update({ ultima_atividade: new Date().toISOString() })
        .eq('company_id', company_id)
        .eq('id', conversa_id)
    } catch (_) {}
    try {
      const { data: convRow } = await supabase
        .from('conversas')
        .select('cliente_id, tipo, telefone')
        .eq('company_id', company_id)
        .eq('id', conversa_id)
        .maybeSingle()
      const convIsGroup = String(convRow?.tipo || '').toLowerCase() === 'grupo' || String(convRow?.telefone || '').includes('@g.us')
      if (!convIsGroup && convRow?.cliente_id != null) {
        await supabase
          .from('clientes')
          .update({ ultimo_contato: mensagemSalva.criado_em || new Date().toISOString(), atualizado_em: new Date().toISOString() })
          .eq('company_id', company_id)
          .eq('id', Number(convRow.cliente_id))
      }
    } catch (_) {}

    // 5) Realtime: empresa, conversa e room do departamento
    const io = req.app.get('io')
    if (io) {
      // 🔒 Privacidade por setor:
      // - Se a conversa tem departamento_id, NÃO enviar "nova_mensagem" para a empresa inteira.
      // - Enviar para room do departamento + room da conversa (e somente esses).
      const rooms = [`conversa_${conversa_id}`]
      if (departamento_id != null) rooms.push(`departamento_${departamento_id}`)
      else rooms.push(`empresa_${company_id}`)

      io.to(rooms).emit('nova_mensagem', mensagemSalva)

      const roomList = departamento_id != null ? `departamento_${departamento_id}` : `empresa_${company_id}`
      io.to(roomList).emit('atualizar_conversa', { id: conversa_id })
    }

    return res.sendStatus(200)
  } catch (err) {
    console.error('Erro webhook:', err)
    return res.sendStatus(500)
  }
}

exports.enviarMensagemWhatsApp = enviarMensagemWhatsApp
