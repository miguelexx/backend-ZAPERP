/**
 * Reconciliação de eco `fromMe` no fluxo "received" (antes de inserir uma nova linha). Extraído verbatim
 * de receberZapi (Fase 5 — doc 24). Roda só quando ainda não há `mensagemSalva`, é `fromMe` e há
 * `whatsappIdStr`. Ordem: (1) `referenceId crm-*` (mais confiável); (2) candidato outbound por assinatura
 * de mídia/texto numa janela de 15 min (na conversa, depois na empresa toda). Faz o patch do candidato
 * (whatsapp_id / status sem regressão / reply_meta), aplica status ACK tardio e agenda o mirror R2.
 *
 * Devolve a `mensagemSalva` reconciliada (ou `null` se nada casou). NUNCA insere linha nova — isso é
 * do orquestrador. `ctx` traz o tenant + os campos do payload em processamento + `io`.
 */

const supabaseDefault = require('../../config/supabase')
const {
  tryReconcileFromMeByCrmReferenceId,
  findFromMeOutboundMediaCandidate,
  filterRowsForFromMeReconcile,
  whatsappIdCompativelParaReconcile,
  mapWebhookTypeToStorageTipo,
} = require('./fromMeReconcile')
const { applyWhatsappInstanceFilterOrLegacy, isRemoteMediaUrl } = require('./whatsappIdLookup')
const { normalizeRawAckStatus, statusRank } = require('../../helpers/messageStatusHelper')
const { extrairNomePrefixoTexto } = require('../../helpers/mensagemAtendenteNomeHelper')

const WEBHOOK_MSG_SELECT = 'id, conversa_id, company_id, whatsapp_instance_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'
const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'

async function reconcileFromMeInReceived(supabaseClient, ctx) {
  const supabase = supabaseClient || supabaseDefault
  const {
    company_id, conversa_id, whatsapp_instance_id, payload, whatsappIdStr,
    type, imageUrl, documentUrl, audioUrl, videoUrl, stickerUrl, locationUrl,
    criado_em, fileName, texto, webhookReplyMeta, io,
  } = ctx || {}
  let mensagemSalva = null
  try {
    const statusPayload = (payload.status && String(payload.status).toLowerCase()) || null

    // referenceId crm-{id} enviado no POST UltraMSG — reconciliação mais confiável que texto
    if (!mensagemSalva) {
      mensagemSalva = await tryReconcileFromMeByCrmReferenceId(supabase, {
        company_id,
        conversa_id,
        whatsapp_instance_id,
        payload,
        whatsappIdStr,
      })
    }

    if (!mensagemSalva) {
    // assinatura da mídia para bater com a mensagem enviada pelo sistema
    const urlSig =
      (type === 'image' && imageUrl) ? imageUrl :
      ((type === 'document' || type === 'file') && documentUrl) ? documentUrl :
      (type === 'audio' && audioUrl) ? audioUrl :
      (type === 'video' && videoUrl) ? videoUrl :
      (type === 'sticker' && stickerUrl) ? stickerUrl :
      (type === 'location' && locationUrl) ? locationUrl :
      null

    const tsMs = Date.parse(criado_em)
    // Janela ampliada para 15 min: cobre delay de envio UltraMsg e diferenças de relógio entre servidores
    const windowMs = 15 * 60 * 1000
    const fromIso = Number.isFinite(tsMs) ? new Date(tsMs - windowMs).toISOString() : null
    const toIso = Number.isFinite(tsMs) ? new Date(tsMs + windowMs).toISOString() : null

    const buildQuery = (filterConversa) => {
      let q = supabase
        .from('mensagens')
        .select('id, criado_em, texto, url, nome_arquivo, tipo, whatsapp_id, reply_meta, conversa_id, autor_usuario_id')
        .eq('company_id', company_id)
        .eq('direcao', 'out')
        .order('criado_em', { ascending: false })
        .order('id', { ascending: false })
        .limit(15)
      if (filterConversa) q = q.eq('conversa_id', conversa_id)
      q = applyWhatsappInstanceFilterOrLegacy(q, whatsapp_instance_id)
      if (fromIso && toIso) q = q.gte('criado_em', fromIso).lte('criado_em', toIso)
      // URL do webhook (CDN) ≠ /uploads/ do CRM — não filtrar por url remota
      if (urlSig && !isRemoteMediaUrl(urlSig)) q = q.eq('url', urlSig)
      return q
    }

    const nomeAtendenteReconcile = extrairNomePrefixoTexto(texto)
    const findCand = (rows) =>
      findFromMeOutboundMediaCandidate(filterRowsForFromMeReconcile(rows), {
        fileName,
        texto,
        tipo: mapWebhookTypeToStorageTipo(type),
        nomeAtendente: nomeAtendenteReconcile,
        whatsappId: whatsappIdStr,
      })

    // Busca 1: na conversa específica resolvida pelo webhook
    const { data: candidates } = await buildQuery(true)
    let cand = findCand(candidates)

    // Busca 2 (fallback): na empresa inteira — cobre divergência de conversa_id entre
    // chatController (URL param) e webhook (findOrCreateConversation pode resolver diferente)
    if (!cand) {
      const { data: fallbackCandidates } = await buildQuery(false)
      cand = findCand(fallbackCandidates)
      if (cand && WHATSAPP_DEBUG) {
        console.log('[Z-API] fromMe reconcile fallback: encontrado fora da conversa', {
          cand_conversa: cand.conversa_id, webhook_conversa: conversa_id
        })
      }
    }

    if (!cand && WHATSAPP_DEBUG) {
      console.warn('[Z-API] fromMe reconcile: nenhum candidato encontrado', {
        conversa_id, texto: String(texto || '').slice(0, 30), fromIso, toIso
      })
    }

    if (cand?.id) {
      const updates = {}
      if (whatsappIdCompativelParaReconcile(cand, whatsappIdStr)) {
        updates.whatsapp_id = whatsappIdStr
      }
      const ackStatus = normalizeRawAckStatus(statusPayload ?? payload?.status ?? payload?.ack)
      if (ackStatus && statusRank(ackStatus) >= statusRank(cand.status || 'pending')) {
        updates.status = ackStatus
        updates.status_mensagem = ackStatus
      }
      if (webhookReplyMeta && !cand.reply_meta) updates.reply_meta = webhookReplyMeta

      if (Object.keys(updates).length === 0) {
        mensagemSalva = cand
      } else {
        const { data: patched, error: patchErr } = await supabase
          .from('mensagens')
          .update(updates)
          .eq('company_id', company_id)
          .eq('id', cand.id)
          .select(WEBHOOK_MSG_SELECT)
          .single()

        if (!patchErr && patched) {
          mensagemSalva = patched
        } else if (patchErr) {
          console.warn('⚠️ fromMe reconcile: falha ao atualizar candidato:', patchErr?.message)
        } else {
          mensagemSalva = cand
        }
      }
    }
    }

    if (mensagemSalva?.id && statusPayload) {
      const ackStatus = normalizeRawAckStatus(statusPayload)
      const cur = mensagemSalva.status || mensagemSalva.status_mensagem || 'pending'
      if (ackStatus && statusRank(ackStatus) >= statusRank(cur)) {
        const { data: statusPatched } = await supabase
          .from('mensagens')
          .update({ status: ackStatus, status_mensagem: ackStatus })
          .eq('company_id', company_id)
          .eq('id', mensagemSalva.id)
          .select(WEBHOOK_MSG_SELECT)
          .maybeSingle()
        if (statusPatched) mensagemSalva = statusPatched
      }
    }

    // Rollout R2 (empresa 1): mensagem outbound confirmada pelo webhook → espelha para o R2
    // agora (mesmo gatilho inline do inbound). Cobre envios que ficaram pending por ID de fila
    // e só chegam a status final aqui. No-op para outras empresas / R2 desligado / tipo não-mídia.
    if (mensagemSalva?.id && String(mensagemSalva.direcao || '') === 'out') {
      try {
        const { scheduleR2MirrorIfNeeded } = require('../../services/mediaR2MirrorService')
        scheduleR2MirrorIfNeeded({ supabase, io, company_id, mensagem_id: mensagemSalva.id })
      } catch (_) { /* best-effort; nunca afeta o webhook */ }
    }
  } catch (e) {
    console.warn('⚠️ fromMe reconcile: erro ao reconciliar:', e?.message || e)
  }
  return mensagemSalva
}

module.exports = { reconcileFromMeInReceived }
