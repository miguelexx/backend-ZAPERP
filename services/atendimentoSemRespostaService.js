/**
 * Alertas de atendimento sem resposta — config em ia_config.config.alerta_sem_resposta.
 * Eventos: alerta_atendimento_sem_resposta_eventos
 * Estado/idempotência por conversa: alerta_atendimento_sem_resposta_estado
 */

const supabase = require('../config/supabase')
const { isWithinBusinessHours } = require('./chatbotTriageService')

const DEFAULT_ALERTA_SEM_RESPOSTA = {
  alerta_sem_resposta_ativo: false,
  tempo_primeiro_alerta_minutos: 2,
  tempo_alerta_critico_minutos: 10,
  tempo_notificar_gestor_minutos: 15,
  notificar_por_whatsapp: false,
  notificar_por_email: false,
  notificar_interno: true,
  reabrir_conversa_automaticamente: true,
  aplicar_tag_automatica: true,
  nome_tag_automatica: 'Reaberta por falta de resposta',
  gestor_notificado_id: null,
  responsaveis_notificacao_ids: [],
  telefone_gestor: '',
  horario_comercial_ativo: false,
  timezone: 'America/Sao_Paulo',
}

function coerceAtivo(value) {
  if (value === true || value === 1) return true
  if (typeof value === 'string' && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase())) return true
  return false
}

function normalizeMinutes(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(1440, Math.floor(n)))
}

function normalizeAlertaSemResposta(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const gestorId = Number(r.gestor_notificado_id)
  const responsaveis = Array.isArray(r.responsaveis_notificacao_ids)
    ? r.responsaveis_notificacao_ids.map(Number).filter((id) => Number.isFinite(id) && id > 0)
    : []
  return {
    ...DEFAULT_ALERTA_SEM_RESPOSTA,
    alerta_sem_resposta_ativo: coerceAtivo(r.alerta_sem_resposta_ativo) || coerceAtivo(r.ativo),
    tempo_primeiro_alerta_minutos: normalizeMinutes(r.tempo_primeiro_alerta_minutos, 2),
    tempo_alerta_critico_minutos: normalizeMinutes(r.tempo_alerta_critico_minutos, 10),
    tempo_notificar_gestor_minutos: normalizeMinutes(r.tempo_notificar_gestor_minutos, 15),
    notificar_por_whatsapp: r.notificar_por_whatsapp === true,
    notificar_por_email: false,
    notificar_interno: r.notificar_interno !== false,
    reabrir_conversa_automaticamente: r.reabrir_conversa_automaticamente !== false,
    aplicar_tag_automatica: r.aplicar_tag_automatica !== false,
    nome_tag_automatica: String(r.nome_tag_automatica || DEFAULT_ALERTA_SEM_RESPOSTA.nome_tag_automatica).trim().slice(0, 120),
    gestor_notificado_id: Number.isInteger(gestorId) && gestorId > 0 ? gestorId : null,
    responsaveis_notificacao_ids: responsaveis,
    telefone_gestor: String(r.telefone_gestor || '').trim().slice(0, 40),
    horario_comercial_ativo: r.horario_comercial_ativo === true,
    timezone: String(r.timezone || DEFAULT_ALERTA_SEM_RESPOSTA.timezone).trim().slice(0, 80) || 'America/Sao_Paulo',
  }
}

function validateAlertaSemResposta(cfg) {
  const c = normalizeAlertaSemResposta(cfg)
  if (c.tempo_alerta_critico_minutos <= c.tempo_primeiro_alerta_minutos) {
    return 'O alerta crítico precisa ser maior que o primeiro alerta.'
  }
  if (c.tempo_notificar_gestor_minutos <= c.tempo_alerta_critico_minutos) {
    return 'A notificação ao gestor precisa ser maior que o alerta crítico.'
  }
  if (c.aplicar_tag_automatica && !c.nome_tag_automatica) {
    return 'Informe o nome da tag automática.'
  }
  if (c.notificar_por_whatsapp && !c.telefone_gestor.replace(/\D/g, '')) {
    return 'Para WhatsApp, informe o telefone do gestor.'
  }
  if (!c.notificar_por_whatsapp && !c.notificar_interno) {
    return 'Selecione ao menos um canal de notificação.'
  }
  return null
}

async function loadIaConfig(company_id) {
  const { data, error } = await supabase
    .from('ia_config')
    .select('config')
    .eq('company_id', company_id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data?.config && typeof data.config === 'object' ? data.config : {}
}

async function getAlertaSemRespostaConfig(company_id) {
  const config = await loadIaConfig(company_id)
  return normalizeAlertaSemResposta(config.alerta_sem_resposta || {})
}

async function saveAlertaSemRespostaConfig(company_id, patch) {
  const err = validateAlertaSemResposta({ ...(await getAlertaSemRespostaConfig(company_id)), ...(patch || {}) })
  if (err) return { ok: false, error: err }

  const current = await loadIaConfig(company_id)
  const merged = normalizeAlertaSemResposta({
    ...(current.alerta_sem_resposta || {}),
    ...(patch || {}),
  })

  const nextConfig = { ...current, alerta_sem_resposta: merged }
  const { error } = await supabase
    .from('ia_config')
    .upsert(
      { company_id, config: nextConfig, updated_at: new Date().toISOString() },
      { onConflict: 'company_id' }
    )
  if (error) return { ok: false, error: error.message }
  return { ok: true, config: merged }
}

function isMissingTableError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('relation') || msg.includes('schema cache')
}

async function listAlertaSemRespostaEventos(company_id, { limit = 20, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 20))
  const off = Math.max(0, Number(offset) || 0)
  try {
    const { data, error } = await supabase
      .from('alerta_atendimento_sem_resposta_eventos')
      .select('id, conversa_id, atendente_id, tipo, nivel, mensagem, metadata, criado_em')
      .eq('company_id', company_id)
      .order('criado_em', { ascending: false })
      .range(off, off + lim - 1)
    if (error) {
      if (isMissingTableError(error)) return { ok: true, eventos: [] }
      return { ok: false, error: error.message, eventos: [] }
    }
    const eventos = (data || []).map((e) => ({
      ...e,
      detalhes: e?.metadata && typeof e.metadata === 'object' ? e.metadata : {},
    }))
    return { ok: true, eventos }
  } catch (e) {
    if (isMissingTableError(e)) return { ok: true, eventos: [] }
    return { ok: false, error: e?.message || String(e), eventos: [] }
  }
}

async function recordEvento(company_id, row) {
  try {
    const { error } = await supabase.from('alerta_atendimento_sem_resposta_eventos').insert({
      company_id,
      conversa_id: row.conversa_id,
      atendente_id: row.atendente_id ?? null,
      tipo: row.tipo,
      nivel: row.nivel ?? null,
      mensagem: row.mensagem ?? null,
      metadata: {
        ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
        ...(row.detalhes && typeof row.detalhes === 'object' ? row.detalhes : {}),
      },
    })
    if (error && !isMissingTableError(error)) {
      console.warn('[atendimentoSemResposta] recordEvento:', error.message)
    }
  } catch (e) {
    if (!isMissingTableError(e)) console.warn('[atendimentoSemResposta] recordEvento:', e?.message || e)
  }
}

async function getEstado(company_id, conversa_id) {
  try {
    const { data, error } = await supabase
      .from('alerta_atendimento_sem_resposta_estado')
      .select('*')
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
      .maybeSingle()
    if (error) {
      if (isMissingTableError(error)) return null
      console.warn('[atendimentoSemResposta] getEstado:', error.message)
      return null
    }
    return data
  } catch (e) {
    return null
  }
}

async function upsertEstado(company_id, conversa_id, patch) {
  try {
    const { error } = await supabase.from('alerta_atendimento_sem_resposta_estado').upsert(
      {
        company_id,
        conversa_id,
        ...patch,
        atualizado_em: new Date().toISOString(),
      },
      { onConflict: 'company_id,conversa_id' }
    )
    if (error && !isMissingTableError(error)) {
      console.warn('[atendimentoSemResposta] upsertEstado:', error.message)
    }
  } catch (e) {
    if (!isMissingTableError(e)) console.warn('[atendimentoSemResposta] upsertEstado:', e?.message || e)
  }
}

async function clearEstado(company_id, conversa_id) {
  try {
    await supabase
      .from('alerta_atendimento_sem_resposta_estado')
      .delete()
      .eq('company_id', company_id)
      .eq('conversa_id', conversa_id)
  } catch (_) {}
}

function emitAlertaRealtime(io, company_id, payload, opts = {}) {
  if (!io || !company_id || !payload?.conversa_id) return
  const base = {
    company_id: Number(company_id),
    conversa_id: Number(payload.conversa_id),
    atendente_id: payload.atendente_id != null ? Number(payload.atendente_id) : null,
    tipo: payload.tipo,
    nivel: payload.nivel || null,
    mensagem: payload.mensagem || null,
  }
  if (base.atendente_id) {
    io.to(`usuario_${base.atendente_id}`).emit('alerta_sem_resposta', base)
  }
  const gestorId = Number(opts.gestorId)
  if (Number.isFinite(gestorId) && gestorId > 0) {
    io.to(`usuario_${gestorId}`).emit('alerta_sem_resposta', base)
  }
  io.to(`empresa_${company_id}`).emit('alerta_sem_resposta_evento', base)
}

async function ensureTagForConversa(company_id, conversa_id, nomeTag) {
  const nome = String(nomeTag || '').trim()
  if (!nome) return null
  const { data: tag } = await supabase
    .from('tags')
    .select('id, nome')
    .eq('company_id', company_id)
    .ilike('nome', nome)
    .maybeSingle()
  let tagId = tag?.id
  if (!tagId) {
    const { data: created } = await supabase
      .from('tags')
      .insert({ company_id, nome, cor: '#f59e0b' })
      .select('id')
      .single()
    tagId = created?.id
  }
  if (!tagId) return null
  const { data: existente } = await supabase
    .from('conversa_tags')
    .select('id')
    .eq('company_id', company_id)
    .eq('conversa_id', conversa_id)
    .eq('tag_id', tagId)
    .maybeSingle()
  if (!existente) {
    await supabase.from('conversa_tags').insert({ company_id, conversa_id, tag_id: tagId }).catch(() => {})
  }
  return tagId
}

async function sendGestorWhatsapp(company_id, telefone, texto) {
  const digits = String(telefone || '').replace(/\D/g, '')
  if (!digits || digits.length < 10) return { ok: false, error: 'telefone_invalido' }
  try {
    const { getProvider } = require('./providers')
    const provider = getProvider()
    const send = provider?.sendText
    if (typeof send !== 'function') return { ok: false, error: 'sendText_indisponivel' }
    const result = await send(company_id, digits, texto)
    if (result?.ok === false || result?.error) return { ok: false, error: result.error || 'falha_envio' }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function reabrirConversa(company_id, conversa_id) {
  const { error } = await supabase
    .from('conversas')
    .update({
      status_atendimento: 'aberta',
      atendente_id: null,
      atendente_atribuido_em: null,
    })
    .eq('company_id', company_id)
    .eq('id', conversa_id)
    .eq('status_atendimento', 'em_atendimento')
  if (error) return { ok: false, error: error.message }
  await supabase.from('historico_atendimentos').insert({
    conversa_id,
    usuario_id: null,
    acao: 'alerta_sem_resposta_reabertura',
    observacao: 'Conversa reaberta automaticamente por falta de resposta do atendente',
  }).catch(() => {})
  return { ok: true }
}

function minutesSince(iso) {
  if (!iso) return 0
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 60000))
}

async function shouldRunForBusinessHours(company_id, cfg) {
  if (!cfg.horario_comercial_ativo) return true
  const full = await loadIaConfig(company_id)
  const ct = full.chatbot_triage || {}
  const tz = cfg.timezone || ct.timezone || 'America/Sao_Paulo'
  return isWithinBusinessHours(ct.horarioInicio || '09:00', ct.horarioFim || '18:00', new Date(), tz)
}

async function processCompanyAtendimentoSemResposta(company_id, opts = {}) {
  const dryRun = opts.dryRun === true
  const io = opts.io || null
  const cfg = await getAlertaSemRespostaConfig(company_id)
  if (!cfg.alerta_sem_resposta_ativo) {
    return { ok: true, processadas: 0, skipped: 'inativo' }
  }
  if (!(await shouldRunForBusinessHours(company_id, cfg))) {
    return { ok: true, processadas: 0, skipped: 'fora_horario' }
  }

  const { data: conversas, error: convErr } = await supabase
    .from('conversas')
    .select('id, atendente_id, nome_contato_cache, telefone, cliente_id')
    .eq('company_id', company_id)
    .eq('status_atendimento', 'em_atendimento')
    .not('atendente_id', 'is', null)

  if (convErr) return { ok: false, error: convErr.message, processadas: 0 }
  if (!conversas?.length) return { ok: true, processadas: 0 }

  const ids = conversas.map((c) => c.id)
  const { data: mensagens } = await supabase
    .from('mensagens')
    .select('conversa_id, criado_em, direcao, texto')
    .eq('company_id', company_id)
    .in('conversa_id', ids)
    .order('criado_em', { ascending: false })

  const ultimaPorConversa = {}
  ;(mensagens || []).forEach((m) => {
    if (!ultimaPorConversa[m.conversa_id]) ultimaPorConversa[m.conversa_id] = m
  })

  let processadas = 0
  const detalhes = []

  for (const conv of conversas) {
    const ultima = ultimaPorConversa[conv.id]
    if (!ultima) continue

    if (ultima.direcao !== 'in') {
      if (!dryRun) await clearEstado(company_id, conv.id)
      continue
    }

    const minutos = minutesSince(ultima.criado_em)
    let estado = (await getEstado(company_id, conv.id)) || {}
    const anchor = ultima.criado_em

    if (estado.ultimo_cliente_msg_em && String(estado.ultimo_cliente_msg_em) !== String(anchor)) {
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
        estadoPatch: { primeiro_alerta_em: new Date().toISOString() },
      })
    }

    if (minutos >= cfg.tempo_alerta_critico_minutos && !estado.alerta_critico_em) {
      actions.push({
        tipo: 'alerta_critico',
        nivel: 'critico',
        mensagem: `Alerta crítico: ${nome} sem resposta há ${minutos} min.`,
        estadoPatch: { alerta_critico_em: new Date().toISOString() },
      })
    }

    if (minutos >= cfg.tempo_notificar_gestor_minutos && !estado.gestor_notificado_em) {
      actions.push({
        tipo: 'gestor_notificado',
        nivel: 'gestor',
        mensagem: `Gestor notificado: ${nome} sem resposta há ${minutos} min.`,
        estadoPatch: { gestor_notificado_em: new Date().toISOString() },
        notifyGestor: true,
      })
    }

    if (!actions.length) continue
    processadas += 1

    if (dryRun) {
      detalhes.push({ conversa_id: conv.id, minutos, acoes: actions.map((a) => a.tipo) })
      continue
    }

    for (const action of actions) {
      emitAlertaRealtime(io, company_id, { ...basePayload, ...action }, {
        gestorId: action.notifyGestor ? cfg.gestor_notificado_id : null,
      })
      if (cfg.notificar_interno !== false) {
        await recordEvento(company_id, { ...basePayload, ...action })
      }

      if (action.notifyGestor) {
        if (cfg.notificar_por_whatsapp && cfg.telefone_gestor) {
          const waText = `[ZapERP] Atendimento sem resposta\nCliente: ${nome}\nTempo: ${minutos} min\nConversa #${conv.id}`
          const wa = await sendGestorWhatsapp(company_id, cfg.telefone_gestor, waText)
          if (!wa.ok) {
            await recordEvento(company_id, {
              ...basePayload,
              tipo: 'whatsapp_falha',
              nivel: 'gestor',
              mensagem: wa.error || 'Falha ao enviar WhatsApp ao gestor',
            })
          }
        }

        if (cfg.reabrir_conversa_automaticamente) {
          const reopened = await reabrirConversa(company_id, conv.id)
          if (reopened.ok) {
            await recordEvento(company_id, {
              ...basePayload,
              tipo: 'conversa_reaberta',
              nivel: 'gestor',
              mensagem: `Conversa ${conv.id} reaberta automaticamente.`,
            })
            if (io) {
              io.to(`empresa_${company_id}`).emit('conversa_atualizada', {
                id: conv.id,
                status_atendimento: 'aberta',
                atendente_id: null,
                exibir_badge_aberta: true,
              })
            }
          }
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
          }
        }
      }

      await upsertEstado(company_id, conv.id, {
        ultimo_cliente_msg_em: anchor,
        ...action.estadoPatch,
      })
    }

    detalhes.push({ conversa_id: conv.id, minutos, acoes: actions.map((a) => a.tipo) })
  }

  return { ok: true, processadas, detalhes }
}

async function runAtendimentoSemRespostaForAllCompanies(opts = {}) {
  const dryRun = opts.dryRun === true
  const io = opts.io || null
  const { data: empresas, error } = await supabase.from('empresas').select('id')
  if (error) return { ok: false, error: error.message, processadas: 0 }

  let total = 0
  const detalhes = []
  for (const emp of empresas || []) {
    const r = await processCompanyAtendimentoSemResposta(emp.id, { dryRun, io })
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
  DEFAULT_ALERTA_SEM_RESPOSTA,
  normalizeAlertaSemResposta,
  validateAlertaSemResposta,
  getAlertaSemRespostaConfig,
  saveAlertaSemRespostaConfig,
  listAlertaSemRespostaEventos,
  processCompanyAtendimentoSemResposta,
  runAtendimentoSemRespostaForAllCompanies,
  emitAlertaRealtime,
  clearEstado,
}
