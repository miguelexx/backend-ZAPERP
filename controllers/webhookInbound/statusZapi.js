/**
 * Handler de ACK (message_ack) do webhook: localiza a mensagem por whatsapp_id (com fallbacks de
 * prefixo, formato WhatsApp, telefone da conversa e id de fila) e aplica o status sem regressao.
 * Extraido de controllers/webhookZapiController.js (Fase 3 - doc 24) sem alteracao de comportamento.
 */

const supabase = require('../../config/supabase')
const { getCompanyIdByInstanceId } = require('../../services/whatsappConfigService')
const { getWhatsappInstanceByProviderInstanceId } = require('../../services/whatsappInstanceService')
const { normalizeMessageAckStatus, canonStatusForEmit, statusRank } = require('../../helpers/messageStatusHelper')
const { isUltramsgNumericQueueId } = require('../../helpers/whatsappMessageIdHelper')
const {
  selectSingleMensagemByWhatsappId,
  updateSingleMensagemByWhatsappId,
  selectSingleMensagemByWhatsappIdRelaxed,
  patchMensagemStatusById,
  applyWhatsappInstanceFilterOrLegacy,
  logAmbiguousWhatsappId,
} = require('./whatsappIdLookup')
const { filterRowsForFromMeReconcile, findPendingOutboundByAckPhone } = require('./fromMeReconcile')

/** Log seguro (sem tokens/conteudo sensivel) — duplicado do controller. */
function _logWebhookSafe(entry) {
  const safe = { ts: new Date().toISOString(), received: true, ...entry }
  console.log('[Z-API-WEBHOOK]', JSON.stringify(safe))
}

exports.statusZapi = async (req, res) => {
  try {
    if ((req.path || '').includes('statusht')) {
      console.log('[Z-API] alias_hit: /statusht -> handler status (ticks ✓✓)')
    }
    const body = req.body || {}
    let company_id = req.zapiContext?.company_id
    let whatsapp_instance_id = req.zapiContext?.whatsapp_instance_id ?? null
    if (company_id == null) {
      const instanceIdRaw = (body?.instanceId ?? body?.instance_id ?? body?.instance ?? '').toString().trim()
      if (instanceIdRaw) {
        const resolved = await getWhatsappInstanceByProviderInstanceId('ultramsg', instanceIdRaw)
        if (resolved?.code === 'DUPLICATE_PROVIDER_INSTANCE') {
          _logWebhookSafe({ eventType: 'MessageStatusCallback', instanceId: instanceIdRaw.slice(0, 24), companyIdResolved: 'duplicate_blocked' })
          return res.status(200).json({ ok: true, ignored: 'duplicate_provider_instance' })
        }
        if (resolved?.instance) {
          company_id = resolved.instance.company_id
          whatsapp_instance_id = resolved.instance.id ?? null
        } else {
          company_id = await getCompanyIdByInstanceId(instanceIdRaw)
        }
      } else {
        company_id = null
      }
      const instanceIdResolved = instanceIdRaw ? instanceIdRaw.slice(0, 24) + (instanceIdRaw.length > 24 ? '…' : '') : '(empty)'
      _logWebhookSafe({ eventType: 'MessageStatusCallback', instanceId: instanceIdResolved, companyIdResolved: company_id != null ? company_id : 'not_mapped' })
      if (company_id == null) return res.status(200).json({ ok: true })
    }

    // Z-API oficial usa "ids" (array); fallback para messageId, zaapId, id
    const idsRaw = body?.ids
    const messageIds = Array.isArray(idsRaw) && idsRaw.length > 0
      ? idsRaw.map((id) => (id != null ? String(id).trim() : '')).filter(Boolean)
      : []
    const singleId = body?.messageId ?? body?.zaapId ?? body?.id ?? (messageIds.length > 0 ? messageIds[0] : null)
    const idsToProcess = messageIds.length > 0 ? messageIds : (singleId ? [String(singleId).trim()] : [])

    const statusNorm = normalizeMessageAckStatus(body)

    // Debug: log toda requisição recebida em /webhooks/ultramsg/status (apenas com WHATSAPP_DEBUG=1)
    const logDebug = process.env.WHATSAPP_DEBUG === '1'
    if (logDebug) {
      console.log('[DEBUG] /webhooks/ultramsg/status recebido:', {
        ids: idsToProcess.length ? idsToProcess.slice(0, 3).map((id) => id.slice(0, 24) + (id.length > 24 ? '…' : '')) : null,
        statusBruto: body?.status ?? body?.ack ?? '(vazio)',
        ack: body?.ack,
        statusMapeado: statusNorm,
        erro: body?.error != null ? String(body.error).slice(0, 100) : null
      })
    }

    if (idsToProcess.length === 0) {
      if (logDebug) console.log('[DEBUG] /webhooks/ultramsg/status: sem messageId nem ids, ignorando.')
      return res.status(200).json({ ok: true })
    }

    if (!statusNorm) {
      if (logDebug) console.log('[DEBUG] /webhooks/ultramsg/status: status não mapeado, ignorando. raw=', body?.status ?? body?.ack ?? '(vazio)')
      return res.status(200).json({ ok: true })
    }

    // Fallback: deriva company_id da mensagem (whatsapp_id) quando instanceId ausente
    if (company_id == null && idsToProcess.length > 0) {
      const { data: msgRows } = await supabase
        .from('mensagens')
        .select('company_id')
        .eq('whatsapp_id', idsToProcess[0])
        .is('whatsapp_instance_id', null)
        .limit(2)
      if (Array.isArray(msgRows) && msgRows.length > 1) {
        logAmbiguousWhatsappId('status.company_fallback', {
          company_id: null,
          whatsapp_instance_id: null,
          whatsapp_id: idsToProcess[0],
          count: msgRows.length,
        })
        return res.status(200).json({ ok: true, ignored: 'ambiguous_status_without_instance' })
      }
      company_id = Array.isArray(msgRows) && msgRows[0]?.company_id != null ? msgRows[0].company_id : null
    }
    if (company_id == null) {
      if (body?.instanceId) console.log('[Z-API] status: instance not mapped:', String(body.instanceId).slice(0, 16) + '…')
      return res.status(200).json({ ok: true })
    }
    const io = req.app.get('io')
    let updated = 0

    for (const messageId of idsToProcess) {
      if (!messageId) continue
      const idStr = String(messageId)

      // Grupos: WhatsApp não envia read receipts confiáveis — cap em delivered
      let effectiveStatus = statusNorm
      if (statusNorm === 'read' || statusNorm === 'played') {
        const { data: msgForConv } = await selectSingleMensagemByWhatsappId(supabase, {
          company_id,
          whatsapp_id: idStr,
          whatsapp_instance_id,
          select: 'conversa_id',
          context: 'status.group_cap',
        })
        if (msgForConv?.conversa_id) {
          const { data: conv } = await supabase
            .from('conversas')
            .select('tipo, telefone')
            .eq('id', msgForConv.conversa_id)
            .eq('company_id', company_id)
            .maybeSingle()
          const isGroup = conv?.tipo === 'grupo' || (conv?.telefone && String(conv.telefone).endsWith('@g.us'))
          if (isGroup) effectiveStatus = 'delivered'
        }
      }

      // Evita que um ack atrasado (ex.: "delivered") regrida uma mensagem já em status mais avançado (ex.: "read").
      const { data: currentForRank } = await selectSingleMensagemByWhatsappId(supabase, {
        company_id,
        whatsapp_id: idStr,
        whatsapp_instance_id,
        select: 'status',
        context: 'status.rank_check',
      })
      if (currentForRank?.status && statusRank(currentForRank.status) > statusRank(effectiveStatus)) {
        effectiveStatus = currentForRank.status
      }

      const statusUpdates = { status: effectiveStatus, status_mensagem: effectiveStatus }
      const statusSelect = 'id, conversa_id, company_id, autor_usuario_id, whatsapp_instance_id, whatsapp_id'

      // 1) Atualiza por (company_id, whatsapp_id) — match exato com filtro de instância
      let { data: msg } = await updateSingleMensagemByWhatsappId(supabase, {
        company_id,
        whatsapp_id: idStr,
        whatsapp_instance_id,
        updates: statusUpdates,
        select: statusSelect,
        context: 'status.exact',
      })

      // 1b) Fallback: ACK não encontrou por whatsapp_instance_id — tenta match exato na empresa
      if (!msg) {
        const relaxed = await selectSingleMensagemByWhatsappIdRelaxed(supabase, {
          company_id,
          whatsapp_id: idStr,
          select: statusSelect,
          context: 'status.exact_relaxed',
        })
        if (relaxed.data?.id) {
          const cur = relaxed.data.status || 'pending'
          if (statusRank(cur) > statusRank(effectiveStatus)) effectiveStatus = cur
          const patched = await patchMensagemStatusById(supabase, {
            company_id,
            mensagem_id: relaxed.data.id,
            effectiveStatus,
            whatsapp_id: idStr,
            select: statusSelect,
          })
          msg = patched.data || null
        }
      }

      // 2) Fallback: Z-API às vezes trunca o ID no status callback.
      //    Tenta prefixo (primeiros 20 chars) ainda dentro do company_id (sem cross-tenant).
      if (!msg && idStr.length >= 20) {
        const prefix = idStr.slice(0, 20)
        let prefixQuery = supabase
          .from('mensagens')
          .select('id, conversa_id, company_id, autor_usuario_id, whatsapp_id, status')
          .eq('company_id', company_id)
          .ilike('whatsapp_id', `${prefix}%`)
          .order('id', { ascending: false })
          .limit(2)
        prefixQuery = applyWhatsappInstanceFilterOrLegacy(prefixQuery, whatsapp_instance_id)
        const { data: prefixRows } = await prefixQuery
        if (Array.isArray(prefixRows) && prefixRows.length > 1) {
          logAmbiguousWhatsappId('status.prefix', {
            company_id,
            whatsapp_instance_id,
            whatsapp_id: `${prefix}%`,
            count: prefixRows.length,
          })
        }
        const candidate = Array.isArray(prefixRows) && prefixRows.length === 1 ? prefixRows[0] : null
        if (candidate?.id) {
          if (candidate.status && statusRank(candidate.status) > statusRank(effectiveStatus)) {
            effectiveStatus = candidate.status
          }
          const patched = await patchMensagemStatusById(supabase, {
            company_id,
            mensagem_id: candidate.id,
            effectiveStatus,
            select: statusSelect,
          })
          msg = patched.data || null
        }
      }

      // 3) Fallback UltraMsg: message_ack pode chegar ANTES do ReceivedCallback (id formato WhatsApp).
      //    Busca mensagem out recente com whatsapp_id pendente (null ou fila numérica) e atualiza status + whatsapp_id.
      const isWhatsAppFormatId = idStr.includes('@') || idStr.includes('_')
      if (!msg && isWhatsAppFormatId && company_id) {
        const fromIso = new Date(Date.now() - 5 * 60 * 1000).toISOString()
        let recentOutQuery = supabase
          .from('mensagens')
          .select('id, conversa_id, company_id, autor_usuario_id, whatsapp_instance_id, whatsapp_id')
          .eq('company_id', company_id)
          .eq('direcao', 'out')
          .gte('criado_em', fromIso)
          .order('criado_em', { ascending: false })
          .order('id', { ascending: false })
          .limit(5)
        recentOutQuery = applyWhatsappInstanceFilterOrLegacy(recentOutQuery, whatsapp_instance_id)
        const { data: recentOutRows } = await recentOutQuery
        const pendingRows = filterRowsForFromMeReconcile(recentOutRows)
        const cand = Array.isArray(pendingRows) && pendingRows.length === 1 ? pendingRows[0] : null
        if (cand?.id) {
          const patched = await patchMensagemStatusById(supabase, {
            company_id,
            mensagem_id: cand.id,
            effectiveStatus,
            whatsapp_id: idStr,
            select: statusSelect,
          })
          msg = patched.data || null
          if (msg && logDebug) console.log('[DEBUG] status reconciliação: message_ack antes do ReceivedCallback', { mensagem_id: msg.id })
        }
      }

      // 3b) Campanha: vários pendentes na empresa (fallback 3 exige exatamente 1).
      //     O id do ACK traz o JID (`true_5534…@c.us_SID`) — casa a conversa daquele telefone.
      if (!msg && isWhatsAppFormatId && company_id) {
        const fromIsoPhone = new Date(Date.now() - 30 * 60 * 1000).toISOString()
        try {
          const candPhone = await findPendingOutboundByAckPhone({
            company_id,
            whatsapp_instance_id,
            ackId: idStr,
            fromIso: fromIsoPhone,
            select: 'id, conversa_id, company_id, autor_usuario_id, whatsapp_instance_id, whatsapp_id, status',
          })
          if (candPhone?.id) {
            const patched = await patchMensagemStatusById(supabase, {
              company_id,
              mensagem_id: candPhone.id,
              effectiveStatus,
              whatsapp_id: idStr,
              select: statusSelect,
            })
            msg = patched.data || null
            if (msg && logDebug) {
              console.log('[DEBUG] status reconciliação: ACK casado pelo telefone da conversa', { mensagem_id: msg.id })
            }
          }
        } catch (ackPhoneErr) {
          console.warn('[ULTRAMSG] ACK por telefone da conversa:', ackPhoneErr?.message || ackPhoneErr)
        }
      }

      // 4) Fallback UltraMsg: id numérico de fila — match exato em whatsapp_id (várias mensagens seguidas OK)
      const isUltramsgNumericId = isUltramsgNumericQueueId(idStr)
      if (!msg && isUltramsgNumericId && company_id) {
        const relaxed = await selectSingleMensagemByWhatsappIdRelaxed(supabase, {
          company_id,
          whatsapp_id: idStr,
          select: statusSelect,
          context: 'status.numeric_queue',
        })
        if (relaxed.data?.id) {
          const cur = relaxed.data.status || 'pending'
          if (statusRank(cur) > statusRank(effectiveStatus)) effectiveStatus = cur
          const patched = await patchMensagemStatusById(supabase, {
            company_id,
            mensagem_id: relaxed.data.id,
            effectiveStatus,
            select: statusSelect,
          })
          msg = patched.data || null
        }
      }

      // 4b) Fallback: ID numérico de fila — busca por provider_queue_id (linhas novas após migration M2).
      //     O fallback 4 acima cobre linhas antigas (whatsapp_id numérico); este cobre linhas novas.
      if (!msg && isUltramsgNumericId && company_id) {
        let qIdQuery = supabase
          .from('mensagens')
          .select(`${statusSelect}, status`)
          .eq('company_id', company_id)
          .eq('provider_queue_id', idStr)
          .order('id', { ascending: false })
          .limit(1)
        qIdQuery = applyWhatsappInstanceFilterOrLegacy(qIdQuery, whatsapp_instance_id)
        const { data: queueRows } = await qIdQuery
        const queueRow = Array.isArray(queueRows) ? queueRows[0] : queueRows
        if (queueRow?.id) {
          const cur = queueRow.status || 'pending'
          if (statusRank(cur) > statusRank(effectiveStatus)) effectiveStatus = cur
          const patched = await patchMensagemStatusById(supabase, {
            company_id,
            mensagem_id: queueRow.id,
            effectiveStatus,
            select: statusSelect,
          })
          msg = patched.data || null
        }
      }

      if (msg) {
        updated++
        if (io) {
          const emitStatus = canonStatusForEmit(effectiveStatus)
          const payload = {
            mensagem_id: msg.id,
            conversa_id: msg.conversa_id,
            status: emitStatus,
            status_mensagem: emitStatus,
            whatsapp_id: msg.whatsapp_id || idStr,
          }
          // Emite para empresa, conversa E usuario do autor (garante ticks ✓✓ em tempo real)
          let chain = io.to(`empresa_${msg.company_id}`).to(`conversa_${msg.conversa_id}`)
          if (msg.autor_usuario_id != null) chain = chain.to(`usuario_${msg.autor_usuario_id}`)
          chain.emit('status_mensagem', payload)
        }

        // Rollout R2 (empresa 1): ACK confirmou o envio (status final) → espelha a mídia para o R2
        // agora. ACKs só existem para mensagens outbound. No-op p/ outras empresas / tipo não-mídia.
        try {
          const { scheduleR2MirrorIfNeeded } = require('../../services/mediaR2MirrorService')
          scheduleR2MirrorIfNeeded({ supabase, io, company_id: msg.company_id, mensagem_id: msg.id })
        } catch (_) { /* best-effort; nunca afeta o webhook */ }

        if (logDebug) console.log('[DEBUG] /webhooks/ultramsg/status resultado:', { status: statusNorm, mensagem_id: msg.id, conversa_id: msg.conversa_id, whatsapp_id: idStr.slice(0, 20) + '…' })
      } else {
        console.log('[ULTRAMSG] Status', statusNorm, 'para id', idStr.slice(0, 20) + '… — mensagem não encontrada no banco (ignorado)')
      }

      // UltraMSG muitas vezes não ecoa referenceId no ACK. A fila do disparo
      // precisa casar também pelo id do provedor e pela mensagem do chat.
      try {
        await require('../../services/disparoWebhookHook').aplicarStatusDisparoFromWebhook({
          referenceId: body?.ultramsgReferenceId ?? body?.referenceId ?? null,
          providerMessageId: idStr,
          mensagemId: msg?.id ?? null,
          status: effectiveStatus,
          companyId: company_id,
          io,
        })
      } catch (e) {
        console.warn('[disparo] webhook status hook:', e?.message || e)
      }
    }

    return res.status(200).json({ ok: true })
  } catch (e) {
    if (process.env.WHATSAPP_DEBUG === '1') console.error('[DEBUG] /webhooks/ultramsg/status ERRO:', e?.message || e)
    return res.status(200).json({ ok: true })
  }
}
