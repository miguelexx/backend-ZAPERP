/**
 * Persistência da mensagem inbound — parte PURA (montagem de campos). Extraído verbatim de receberZapi
 * (Fase 5 — doc 24). O `insert` real + retries + tratamento de `23505` seguem no orquestrador; aqui fica
 * só o mapeamento determinístico `type/mídia → campos do row` (tipo, url, nome_arquivo, metas).
 *
 * `applyInboundMediaFields(insertMsg, media)` MUTA e devolve o `insertMsg`. Único efeito colateral: um
 * `console.warn` diagnóstico quando um áudio chega sem URL de mídia (comportamento preservado).
 */

const supabaseDefault = require('../../config/supabase')
const { selectSingleMensagemByWhatsappId, updateSingleMensagemByWhatsappId, preserveMediaFieldsOnWebhookFallback } = require('./whatsappIdLookup')
const { tipoQualificaPersistencia } = require('../../services/inboundMediaPersistenceService')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../../helpers/timestampApiCompat')
const { scheduleInboundWebPush } = require('../../services/webPushDispatchService')

const WEBHOOK_MSG_SELECT = 'id, conversa_id, company_id, whatsapp_instance_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'

/**
 * Insere a mensagem inbound com os fallbacks de esquema (reply_meta / remetente_* / *_meta ausentes) e
 * trata `23505` (duplicata): quando outro processo já inseriu, mescla mídia https faltante e emite
 * `nova_mensagem`; se não for duplicata, tenta um insert mínimo. Extraído verbatim de receberZapi
 * (Fase 5 — doc 24). NÃO faz `continue` — devolve um sinal (`failed`) para o orquestrador pular o item.
 *
 * ctx: `{ company_id, whatsapp_instance_id, whatsappIdStr, conversa_id, fromMe, isGroup, senderName,
 * participantPhone, texto, criado_em, io }`. Retorna `{ mensagemSalva, mensagemFoiInseridaPeloWebhook, failed }`.
 */
async function persistInboundMensagemRow(supabaseClient, ctx, insertMsg) {
  const supabase = supabaseClient || supabaseDefault
  const {
    company_id, whatsapp_instance_id, whatsappIdStr, conversa_id, fromMe, isGroup,
    senderName, participantPhone, texto, criado_em, io,
  } = ctx || {}
  let mensagemSalva = null
  let mensagemFoiInseridaPeloWebhook = false

  let { data: inserted, error: errMsg } = await supabase
    .from('mensagens')
    .insert(insertMsg)
    .select(WEBHOOK_MSG_SELECT)
    .single()

  // Compatibilidade: se a coluna reply_meta não existir ainda, remove e tenta de novo
  if (errMsg && (String(errMsg.message || '').includes('reply_meta') || String(errMsg.message || '').includes('does not exist'))) {
    delete insertMsg.reply_meta
    const retryReply = await supabase.from('mensagens').insert(insertMsg).select(WEBHOOK_MSG_SELECT).single()
    inserted = retryReply.data
    errMsg = retryReply.error
  }

  if (errMsg && (String(errMsg.message || '').includes('remetente_nome') || String(errMsg.message || '').includes('remetente_telefone') || String(errMsg.message || '').includes('does not exist'))) {
    delete insertMsg.remetente_nome
    delete insertMsg.remetente_telefone
    const retry = await supabase.from('mensagens').insert(insertMsg).select(WEBHOOK_MSG_SELECT).single()
    inserted = retry.data
    errMsg = retry.error
  }
  if (errMsg && (String(errMsg.message || '').includes('contact_meta') || String(errMsg.message || '').includes('location_meta') || String(errMsg.message || '').includes('does not exist'))) {
    delete insertMsg.contact_meta
    delete insertMsg.location_meta
    const retryMeta = await supabase.from('mensagens').insert(insertMsg).select(WEBHOOK_MSG_SELECT).single()
    inserted = retryMeta.data
    errMsg = retryMeta.error
  }
  if (errMsg) {
    if (String(errMsg.code || '') === '23505' || String(errMsg.message || '').includes('duplicate') || String(errMsg.message || '').includes('unique')) {
      const { data: existente } = await selectSingleMensagemByWhatsappId(supabase, {
        company_id,
        whatsapp_id: whatsappIdStr,
        whatsapp_instance_id,
        select: WEBHOOK_MSG_SELECT,
        context: 'received.insert.duplicate',
      })
      // Corrida: outro processo inseriu primeiro (sem URL) e este webhook traz mídia https —
      // sem merge, a linha fica sem url até expirar o link remoto. Mescla só mídia persistível.
      let mergedDup = existente
      const insUrl = String(insertMsg.url || '').trim()
      const exUrl = String(existente?.url || '').trim()
      if (
        existente?.id &&
        insUrl.startsWith('https://') &&
        !exUrl &&
        insertMsg.tipo &&
        tipoQualificaPersistencia(insertMsg.tipo)
      ) {
        try {
          const upDup = {
            url: insUrl,
            tipo: insertMsg.tipo || existente.tipo,
          }
          if (insertMsg.nome_arquivo) upDup.nome_arquivo = insertMsg.nome_arquivo
          if (insertMsg.location_meta && typeof insertMsg.location_meta === 'object') {
            upDup.location_meta = insertMsg.location_meta
          }
          if (insertMsg.contact_meta && typeof insertMsg.contact_meta === 'object') {
            upDup.contact_meta = insertMsg.contact_meta
          }
          const { data: patchedDup, error: patchDupErr } = await supabase
            .from('mensagens')
            .update(upDup)
            .eq('id', existente.id)
            .eq('company_id', company_id)
            .select(WEBHOOK_MSG_SELECT)
            .single()
          if (!patchDupErr && patchedDup) {
            mergedDup = patchedDup
            if (io) {
              const io2 = io
              const rooms = [`conversa_${conversa_id}`, `empresa_${company_id}`]
              const emitPayload = {
                ...patchedDup,
                criado_em: normalizarTimestampSemFusoAmbiguoParaApi(patchedDup.criado_em),
                conversa_id: patchedDup.conversa_id ?? conversa_id,
                status: patchedDup.status || 'delivered',
                status_mensagem: patchedDup.status_mensagem || patchedDup.status || 'delivered',
                fromMe,
                direcao: patchedDup.direcao ?? (fromMe ? 'out' : 'in'),
              }
              io2.to(rooms).emit(io2.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', emitPayload)
              scheduleInboundWebPush(company_id, conversa_id, 'nova_mensagem', emitPayload)
            }
          }
        } catch (e) {
          console.warn('[webhook] duplicate+media merge:', e?.message || e)
        }
      }
      mensagemSalva = mergedDup
    } else {
      // Fallback: qualquer mensagem que chega TEM que ficar no sistema — tenta inserir com payload mínimo
      console.warn('⚠️ ULTRAMSG fallback insert após erro:', errMsg.message)
      let fallbackPayload = {
        conversa_id,
        texto: texto || '(mensagem)',
        direcao: fromMe ? 'out' : 'in',
        company_id,
        whatsapp_id: whatsappIdStr || null,
        criado_em,
      }
      // Nunca remover tipo/url/caminho da mídia já resolvidos no insertMsg.
      preserveMediaFieldsOnWebhookFallback(fallbackPayload, insertMsg)
      if (isGroup && senderName) fallbackPayload.remetente_nome = senderName
      if (isGroup && participantPhone) fallbackPayload.remetente_telefone = participantPhone
      let fallback = await supabase.from('mensagens').insert(fallbackPayload).select(WEBHOOK_MSG_SELECT).single()
      if (fallback.error && (String(fallback.error.message || '').includes('remetente_nome') || String(fallback.error.message || '').includes('remetente_telefone'))) {
        delete fallbackPayload.remetente_nome
        delete fallbackPayload.remetente_telefone
        fallback = await supabase.from('mensagens').insert(fallbackPayload).select(WEBHOOK_MSG_SELECT).single()
      }
      if (!fallback.error) {
        mensagemSalva = fallback.data
        mensagemFoiInseridaPeloWebhook = true
        console.log('✅ Mensagem salva (fallback):', mensagemSalva.id)
      } else {
        console.error('❌ ULTRAMSG Erro ao salvar mensagem:', errMsg?.code, errMsg?.message, errMsg?.details)
        // IMPORTANTE: payload é 1 de N num lote (ver getPayloads) — abortar a requisição aqui
        // descartaria as demais mensagens do lote. Sinaliza para o orquestrador pular só esta.
        return { mensagemSalva: null, mensagemFoiInseridaPeloWebhook: false, failed: true }
      }
    }
  } else {
    mensagemSalva = inserted
    mensagemFoiInseridaPeloWebhook = true
  }
  return { mensagemSalva, mensagemFoiInseridaPeloWebhook, failed: false }
}

/**
 * isEdit: mensagem editada pelo remetente → atualiza o texto da linha existente (por whatsapp_id), em
 * vez de inserir nova, e emite `mensagem_editada`. Extraído verbatim de receberZapi (Fase 5 — doc 24).
 * Chamado só quando `!mensagemSalva && isEdit && whatsappIdStr`. Devolve a linha atualizada ou `null`.
 */
async function resolveEditedMensagemRow(supabaseClient, { company_id, whatsapp_instance_id, whatsappIdStr, conversa_id, texto, io }) {
  const supabase = supabaseClient || supabaseDefault
  try {
    const { data: editTarget } = await updateSingleMensagemByWhatsappId(supabase, {
      company_id,
      whatsapp_id: whatsappIdStr,
      whatsapp_instance_id,
      updates: { texto },
      select: WEBHOOK_MSG_SELECT,
      context: 'received.isEdit',
    })
    if (editTarget) {
      console.log(`✏️ Z-API isEdit: mensagem ${editTarget.id} atualizada (conversa ${conversa_id})`)
      if (io) {
        io.to(`conversa_${conversa_id}`).to(`empresa_${company_id}`).emit('mensagem_editada', {
          id: editTarget.id,
          conversa_id,
          texto,
        })
      }
      return editTarget
    }
  } catch (editErr) {
    console.warn('[Z-API] isEdit: erro ao atualizar mensagem:', editErr?.message)
  }
  return null
}

function applyInboundMediaFields(insertMsg, media) {
  const {
    type, imageUrl, documentUrl, audioUrl, videoUrl, stickerUrl,
    locationUrl, locationMeta, contactMeta, fileName, diag = {},
  } = media || {}

  if (type === 'image' && imageUrl) {
    insertMsg.tipo = 'imagem'
    insertMsg.url = imageUrl
    insertMsg.nome_arquivo = fileName || 'imagem.jpg'
  } else if ((type === 'document' || type === 'file') && documentUrl) {
    insertMsg.tipo = 'arquivo'
    insertMsg.url = documentUrl
    insertMsg.nome_arquivo = fileName || 'arquivo'
  } else if (type === 'audio' || type === 'ptt') {
    insertMsg.tipo = type === 'ptt' ? 'voice' : 'audio'
    if (audioUrl) {
      insertMsg.url = audioUrl
      insertMsg.nome_arquivo = fileName || (type === 'ptt' ? 'voice.ogg' : 'audio')
    } else {
      console.warn('[webhook] áudio inbound sem URL de mídia:', {
        company_id: diag.company_id,
        conversa_id: diag.conversa_id,
        whatsapp_id: diag.whatsapp_id ?? null,
        whatsapp_instance_id: diag.whatsapp_instance_id ?? null,
        type,
        fromMe: diag.fromMe,
        fileName: fileName || null,
        hasImageUrl: !!imageUrl,
        hasDocumentUrl: !!documentUrl,
        hasVideoUrl: !!videoUrl,
        hasStickerUrl: !!stickerUrl,
      })
    }
  } else if (type === 'video' && videoUrl) {
    insertMsg.tipo = 'video'
    insertMsg.url = videoUrl
    insertMsg.nome_arquivo = fileName || 'video'
  } else if (type === 'sticker' && stickerUrl) {
    insertMsg.tipo = 'sticker'
    insertMsg.url = stickerUrl
    insertMsg.nome_arquivo = fileName || 'sticker.webp'
  } else if (type === 'location') {
    insertMsg.tipo = 'location'
    if (locationUrl) insertMsg.url = locationUrl
    insertMsg.nome_arquivo = 'localização'
    if (locationMeta && (locationMeta.latitude != null || locationMeta.longitude != null)) {
      insertMsg.location_meta = locationMeta
    }
  } else if (type === 'contact') {
    insertMsg.tipo = 'contact'
    if (contactMeta && (contactMeta.nome || contactMeta.telefone)) {
      insertMsg.contact_meta = contactMeta
    }
  } else if (type === 'reaction') {
    insertMsg.tipo = 'reaction'
  }
  // Demais tipos: já têm texto preenchido; tipo padrão é texto (não seta insertMsg.tipo).
  return insertMsg
}

module.exports = { applyInboundMediaFields, persistInboundMensagemRow, resolveEditedMensagemRow }
