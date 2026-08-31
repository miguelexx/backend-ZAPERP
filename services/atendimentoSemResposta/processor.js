const supabase = require('../../config/supabase')
const { isBusinessTime, businessMinutesBetween } = require('../../helpers/businessSchedule')
const {
  resolveAlertaRuntimeConfig,
  getAlertaSemRespostaConfig,
  getBusinessScheduleInfo,
  loadBusinessSchedule,
  hasSmtpConfig,
} = require('./config')
const {
  recordEvento,
  getEstado,
  upsertEstado,
  clearEstado,
  fetchUltimaMensagem,
  revalidateConversaElegivel,
  claimEstadoStage,
} = require('./stateStore')
const { resolveAlertaSemRespostaCycleAnchor } = require('./cycle')
const {
  emitAlertaRealtime,
  resolveGestorEmailDestination,
  resolveGestorWhatsappDestination,
  fetchAtendenteNome,
  buildGestorWhatsappText,
  sendGestorWhatsapp,
} = require('./notifications')
const { fetchConversaTagsForRealtime, ensureTagForConversa } = require('./tags')
const { reabrirConversa } = require('./reopen')

async function processCompanyAtendimentoSemResposta(company_id, opts = {}) {
  const dryRun = opts.dryRun === true
  const io = opts.io || null
  const now = opts.now ? new Date(opts.now) : new Date()
  const cfg = resolveAlertaRuntimeConfig(await getAlertaSemRespostaConfig(company_id))
  const businessInfo = await getBusinessScheduleInfo(company_id, cfg)
  if (!cfg.alerta_sem_resposta_ativo) {
    return { ok: true, processadas: 0, skipped: 'inativo', horario_comercial: businessInfo }
  }
  const businessSchedule = await loadBusinessSchedule(company_id, cfg)
  if (!isBusinessTime(now, businessSchedule)) {
    return {
      ok: true,
      processadas: 0,
      skipped: 'fora_horario',
      horario_comercial: businessInfo,
      detalhes: [{
        paused: true,
        motivo: 'fora_horario',
        mensagem: 'Contador pausado fora do horario comercial.',
      }],
    }
  }

  const { data: conversas, error: convErr } = await supabase
    .from('conversas')
    .select('id, atendente_id, atendente_atribuido_em, nome_contato_cache, telefone, cliente_id')
    .eq('company_id', company_id)
    .eq('status_atendimento', 'em_atendimento')
    .not('atendente_id', 'is', null)

  if (convErr) return { ok: false, error: convErr.message, processadas: 0 }
  if (!conversas?.length) return { ok: true, processadas: 0, horario_comercial: businessInfo }

  let processadas = 0
  const detalhes = []

  for (const conv of conversas) {
    let ultima = null
    try {
      ultima = await fetchUltimaMensagem(company_id, conv.id)
    } catch (e) {
      detalhes.push({ conversa_id: conv.id, error: e?.message || String(e) })
      continue
    }
    if (!ultima) continue

    if (ultima.direcao !== 'in') {
      if (!dryRun) await clearEstado(company_id, conv.id)
      continue
    }

    let estado = (await getEstado(company_id, conv.id)) || {}
    let anchor = resolveAlertaSemRespostaCycleAnchor({ ultima, estado, conv })
    if (!anchor) continue

    const ultimoClienteMs = new Date(ultima.criado_em).getTime()
    const estadoAnchorMs = estado.ultimo_cliente_msg_em ? new Date(estado.ultimo_cliente_msg_em).getTime() : NaN
    const novaMensagemClienteNoCiclo =
      estado.ultimo_cliente_msg_em &&
      Number.isFinite(ultimoClienteMs) &&
      Number.isFinite(estadoAnchorMs) &&
      ultimoClienteMs > estadoAnchorMs

    if (novaMensagemClienteNoCiclo) {
      anchor = ultima.criado_em
      estado = {
        ...estado,
        ultimo_cliente_msg_em: anchor,
        primeiro_alerta_em: null,
        alerta_critico_em: null,
        gestor_notificado_em: null,
      }
      if (!dryRun) {
        await upsertEstado(company_id, conv.id, {
          ultimo_cliente_msg_em: anchor,
          primeiro_alerta_em: null,
          alerta_critico_em: null,
          gestor_notificado_em: null,
        })
      }
    } else if (!estado.ultimo_cliente_msg_em && !dryRun) {
      await upsertEstado(company_id, conv.id, { ultimo_cliente_msg_em: anchor })
    }

    const maxStageMinutes = Math.max(
      cfg.tempo_primeiro_alerta_minutos,
      cfg.tempo_alerta_critico_minutos,
      cfg.tempo_notificar_gestor_minutos
    )
    const minutos = businessMinutesBetween(anchor, now, businessSchedule, maxStageMinutes)

    const nome = conv.nome_contato_cache || conv.telefone || `Conversa ${conv.id}`
    const eventoDetalhes = { cliente_nome: nome }
    const basePayload = {
      conversa_id: conv.id,
      atendente_id: conv.atendente_id,
      detalhes: eventoDetalhes,
    }

    const actions = []

    if (minutos >= cfg.tempo_primeiro_alerta_minutos && !estado.primeiro_alerta_em) {
      actions.push({
        tipo: 'primeiro_alerta',
        nivel: 'atencao',
        mensagem: `Cliente aguardando resposta há ${minutos} min (${nome}).`,
        estadoPatch: { primeiro_alerta_em: now.toISOString() },
      })
    }

    if (minutos >= cfg.tempo_alerta_critico_minutos && !estado.alerta_critico_em) {
      actions.push({
        tipo: 'alerta_critico',
        nivel: 'critico',
        mensagem: `Alerta crítico: ${nome} sem resposta há ${minutos} min.`,
        estadoPatch: { alerta_critico_em: now.toISOString() },
      })
    }

    if (minutos >= cfg.tempo_notificar_gestor_minutos && !estado.gestor_notificado_em) {
      actions.push({
        tipo: 'gestor_notificado',
        nivel: 'gestor',
        mensagem: `Gestor notificado: ${nome} sem resposta há ${minutos} min.`,
        estadoPatch: { gestor_notificado_em: now.toISOString() },
        notifyGestor: true,
      })
    }

    if (!actions.length) continue

    if (dryRun) {
      processadas += 1
      detalhes.push({ conversa_id: conv.id, minutos, acoes: actions.map((a) => a.tipo) })
      continue
    }

    const executedActions = []
    for (const action of actions) {
      let stillEligible = false
      try {
        stillEligible = await revalidateConversaElegivel(company_id, conv, anchor)
      } catch (e) {
        console.warn('[atendimentoSemResposta] revalidate:', e?.message || e)
      }
      if (!stillEligible) continue

      const isGestorNotify = action.notifyGestor === true
      let claimed = false
      if (!isGestorNotify) {
        claimed = await claimEstadoStage(company_id, conv.id, anchor, action.estadoPatch)
        if (!claimed) continue
      }

      let gestorWhatsappOk = !(isGestorNotify && cfg.notificar_por_whatsapp)

      if (cfg.notificar_interno !== false) {
        emitAlertaRealtime(io, company_id, { ...basePayload, ...action }, {
          gestorId: action.notifyGestor ? cfg.gestor_notificado_id : null,
        })
        await recordEvento(company_id, { ...basePayload, ...action })
      }

      if (action.notifyGestor) {
        if (cfg.notificar_por_whatsapp) {
          const destination = await resolveGestorWhatsappDestination(company_id, cfg)
          if (!destination.ok) {
            gestorWhatsappOk = false
            await recordEvento(company_id, {
              ...basePayload,
              tipo: 'whatsapp_falha',
              nivel: 'gestor',
              mensagem: destination.error || destination.reason || 'Contato do gestor inválido',
              detalhes: {
                reason: destination.reason,
                cliente_id: destination.cliente_id ?? cfg.gestor_cliente_id ?? null,
              },
            })
          } else {
            const atendenteNome = await fetchAtendenteNome(company_id, conv.atendente_id)
            const waText = buildGestorWhatsappText({
              clienteNome: nome,
              atendenteNome,
              minutos,
              cfg,
            })
            const wa = await sendGestorWhatsapp(company_id, destination.telefone, waText)
            if (!wa.ok) {
              gestorWhatsappOk = false
              await recordEvento(company_id, {
                ...basePayload,
                tipo: 'whatsapp_falha',
                nivel: 'gestor',
                mensagem: wa.error || 'Falha ao enviar WhatsApp ao gestor',
                detalhes: {
                  destino: destination.source,
                  cliente_id: destination.cliente_id,
                  cliente_nome: destination.cliente_nome || cfg.gestor_cliente_nome || null,
                },
              })
            } else {
              gestorWhatsappOk = true
              await recordEvento(company_id, {
                ...basePayload,
                tipo: 'whatsapp_enviado',
                nivel: 'gestor',
                mensagem: `WhatsApp enviado para ${destination.cliente_nome || destination.telefone}.`,
                detalhes: {
                  destino: destination.source,
                  cliente_id: destination.cliente_id,
                  cliente_nome: destination.cliente_nome || cfg.gestor_cliente_nome || null,
                },
              })
            }
          }
        }

        if (isGestorNotify && cfg.notificar_por_whatsapp && !gestorWhatsappOk) {
          continue
        }

        if (isGestorNotify) {
          claimed = await claimEstadoStage(company_id, conv.id, anchor, action.estadoPatch)
          if (!claimed) continue
        }

        if (cfg.notificar_por_email) {
          const emailDestination = await resolveGestorEmailDestination(company_id, cfg)
          const smtpConfigured = hasSmtpConfig()
          await recordEvento(company_id, {
            ...basePayload,
            tipo: 'email_indisponivel',
            nivel: 'gestor',
            mensagem: !emailDestination.ok
              ? 'E-mail do gestor não enviado: responsável interno sem e-mail válido.'
              : !smtpConfigured
                ? 'E-mail do gestor não enviado: SMTP não configurado.'
                : 'E-mail do gestor não enviado: serviço de envio não implementado no backend.',
            detalhes: {
              reason: emailDestination.ok
                ? (smtpConfigured ? 'email_sender_not_configured' : 'smtp_not_configured')
                : emailDestination.reason,
              gestor_id: emailDestination.gestor_id ?? cfg.gestor_notificado_id ?? null,
              smtp_configurado: smtpConfigured,
            },
          })
        }

        if (cfg.reabrir_conversa_automaticamente) {
          const reopened = await reabrirConversa(company_id, conv.id)
          if (reopened.ok) {
            await recordEvento(company_id, {
              ...basePayload,
              tipo: 'conversa_reaberta',
              nivel: 'gestor',
              mensagem: `Conversa ${conv.id} reaberta automaticamente após notificação ao gestor.`,
            })
            if (io) {
              const reabertaEm = reopened.reaberta_em || new Date().toISOString()
              io.to(`empresa_${company_id}`).emit('conversa_atualizada', {
                id: conv.id,
                status_atendimento: 'aberta',
                atendente_id: null,
                exibir_badge_aberta: true,
                reaberta_por_falta_interacao: true,
                reaberta_falta_interacao_em: reabertaEm,
              })
            }
          }
        } else if (io) {
          io.to(`empresa_${company_id}`).emit('conversa_atualizada', {
            id: conv.id,
            reaberta_por_falta_interacao: false,
          })
        }

        if (cfg.aplicar_tag_automatica) {
          const tagId = await ensureTagForConversa(company_id, conv.id, cfg.nome_tag_automatica)
          if (tagId) {
            await recordEvento(company_id, {
              ...basePayload,
              tipo: 'tag_aplicada',
              nivel: 'gestor',
              mensagem: `Tag "${cfg.nome_tag_automatica}" aplicada.`,
              metadata: { tag_id: tagId },
            })
            if (io) {
              const tags = await fetchConversaTagsForRealtime(company_id, conv.id)
              io.to(`empresa_${company_id}`).emit('conversa_atualizada', {
                id: conv.id,
                tags,
              })
            }
          }
        }
      }

      await upsertEstado(company_id, conv.id, {
        ultimo_cliente_msg_em: anchor,
        ...action.estadoPatch,
      })
      executedActions.push(action.tipo)
    }

    if (executedActions.length) {
      processadas += 1
      detalhes.push({ conversa_id: conv.id, minutos, acoes: executedActions })
    }
  }

  return { ok: true, processadas, detalhes, horario_comercial: businessInfo }
}

async function runAtendimentoSemRespostaForAllCompanies(opts = {}) {
  const dryRun = opts.dryRun === true
  const io = opts.io || null
  const { data: empresas, error } = await supabase.from('empresas').select('id')
  if (error) return { ok: false, error: error.message, processadas: 0 }

  let total = 0
  const detalhes = []
  for (const emp of empresas || []) {
    const r = await processCompanyAtendimentoSemResposta(emp.id, { dryRun, io, now: opts.now })
    if (!r.ok) {
      detalhes.push({ company_id: emp.id, error: r.error })
      continue
    }
    total += r.processadas || 0
    if (r.detalhes?.length) detalhes.push({ company_id: emp.id, itens: r.detalhes })
  }
  return { ok: true, processadas: total, detalhes }
}

module.exports = {
  processCompanyAtendimentoSemResposta,
  runAtendimentoSemRespostaForAllCompanies,
}
