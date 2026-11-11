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
  findFromMeOutboundCandidateWithPollFallback,
  filterRowsForFromMeReconcile,
  whatsappIdCompativelParaReconcile,
  mapWebhookTypeToStorageTipo,
} = require('./fromMeReconcile')
const { applyWhatsappInstanceFilterOrLegacy, isRemoteMediaUrl } = require('./whatsappIdLookup')
const { normalizeRawAckStatus, statusRank } = require('../../helpers/messageStatusHelper')
const { extrairNomePrefixoTexto } = require('../../helpers/mensagemAtendenteNomeHelper')
const { textoParaLog } = require('../../helpers/redactLogPII')

const WEBHOOK_MSG_SELECT = 'id, conversa_id, company_id, whatsapp_instance_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'
const { whatsappDebugAtivo } = require('../../helpers/whatsappDebug')

/**
 * Conversas da MESMA empresa que são o mesmo contato da `conversa_id` — ela própria, as do mesmo
 * `cliente_id` e as do mesmo telefone (incluindo as variantes de identidade BR, ± 9º dígito).
 *
 * É o que a "Busca 2" da reconciliação de eco precisa: a divergência de `conversa_id` que ela
 * cobre é sempre o mesmo contato resolvido para outra linha de `conversas` (lid vs telefone,
 * nono dígito, split por instância) — nunca outro cliente. Devolve `[]` quando não há irmãs,
 * e nesse caso o chamador não faz a Busca 2.
 */
async function conversaIdsDoMesmoContato(supabase, { company_id, conversa_id }) {
  if (!company_id || !conversa_id) return []
  try {
    const { data: base } = await supabase
      .from('conversas')
      .select('id, cliente_id, telefone')
      .eq('company_id', company_id)
      .eq('id', conversa_id)
      .maybeSingle()
    if (!base?.id) return []

    const ids = new Set([Number(base.id)])

    if (base.cliente_id != null) {
      const { data: porCliente } = await supabase
        .from('conversas')
        .select('id')
        .eq('company_id', company_id)
        .eq('cliente_id', base.cliente_id)
        .limit(16)
      for (const c of porCliente || []) if (c?.id != null) ids.add(Number(c.id))
    }

    const digitos = String(base.telefone || '').replace(/\D/g, '')
    if (digitos.length >= 10) {
      const { possiblePhonesForWhatsappIdentity } = require('../../helpers/phoneHelper')
      const telefones = Array.from(new Set(
        [digitos, ...(possiblePhonesForWhatsappIdentity(digitos) || [])]
          .map((t) => String(t || '').replace(/\D/g, ''))
          .filter((t) => t.length >= 10),
      ))
      if (telefones.length) {
        const { data: porTelefone } = await supabase
          .from('conversas')
          .select('id')
          .eq('company_id', company_id)
          .in('telefone', telefones)
          .limit(16)
        for (const c of porTelefone || []) if (c?.id != null) ids.add(Number(c.id))
      }
    }

    return [...ids]
  } catch (e) {
    console.warn('[Z-API] fromMe reconcile: conversas do mesmo contato:', e?.message || e)
    return []
  }
}

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

    const buildQuery = (filterConversa, conversaIdsIrmas = null) => {
      let q = supabase
        .from('mensagens')
        .select('id, criado_em, texto, url, nome_arquivo, tipo, whatsapp_id, reply_meta, conversa_id, autor_usuario_id')
        .eq('company_id', company_id)
        .eq('direcao', 'out')
        .order('criado_em', { ascending: false })
        .order('id', { ascending: false })
        .limit(15)
      if (filterConversa) q = q.eq('conversa_id', conversa_id)
      else if (Array.isArray(conversaIdsIrmas) && conversaIdsIrmas.length) q = q.in('conversa_id', conversaIdsIrmas)
      q = applyWhatsappInstanceFilterOrLegacy(q, whatsapp_instance_id)
      if (fromIso && toIso) q = q.gte('criado_em', fromIso).lte('criado_em', toIso)
      // URL do webhook (CDN) ≠ /uploads/ do CRM — não filtrar por url remota
      if (urlSig && !isRemoteMediaUrl(urlSig)) q = q.eq('url', urlSig)
      return q
    }

    const nomeAtendenteReconcile = extrairNomePrefixoTexto(texto)
    const findCand = (rows) =>
      findFromMeOutboundCandidateWithPollFallback(rows, {
        fileName,
        texto,
        tipo: mapWebhookTypeToStorageTipo(type),
        nomeAtendente: nomeAtendenteReconcile,
        whatsappId: whatsappIdStr,
      })

    // Busca 1: na conversa específica resolvida pelo webhook
    const { data: candidates } = await buildQuery(true)
    let cand = findCand(candidates)

    // Busca 2 (fallback): fora da conversa resolvida pelo webhook — cobre divergência de
    // conversa_id entre chatController (URL param) e webhook (findOrCreateConversation pode
    // resolver diferente). Essa divergência é SEMPRE o MESMO contato (± 9º dígito, lid vs
    // telefone, split por instância), então a busca agora é restrita às conversas desse
    // contato em vez da empresa inteira: na empresa toda, um eco podia casar com o outbound de
    // OUTRO cliente só por ter texto/mídia parecidos e gravar whatsapp_id/status na linha
    // errada (doc 29 §3 item 12). Sem conversas irmãs, Busca 2 não tem o que cobrir.
    if (!cand) {
      const irmas = await conversaIdsDoMesmoContato(supabase, { company_id, conversa_id })
      if (irmas.length) {
        const { data: fallbackCandidates } = await buildQuery(false, irmas)
        cand = findCand(fallbackCandidates)
        if (cand && whatsappDebugAtivo()) {
          console.log('[Z-API] fromMe reconcile fallback: encontrado fora da conversa', {
            cand_conversa: cand.conversa_id, webhook_conversa: conversa_id
          })
        }
      } else if (whatsappDebugAtivo()) {
        console.log('[Z-API] fromMe reconcile: Busca 2 ignorada (nenhuma conversa irmã do mesmo contato)')
      }
    }

    if (!cand && whatsappDebugAtivo()) {
      console.warn('[Z-API] fromMe reconcile: nenhum candidato encontrado', {
        conversa_id, texto: textoParaLog(texto), fromIso, toIso
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
