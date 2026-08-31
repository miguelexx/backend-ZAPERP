const supabase = require('../../config/supabase')

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

async function resolveGestorEmailDestination(company_id, cfg) {
  const gestorId = Number(cfg?.gestor_notificado_id)
  if (!Number.isInteger(gestorId) || gestorId <= 0) {
    return { ok: false, reason: 'gestor_notificado_nao_selecionado' }
  }

  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome, email')
    .eq('company_id', company_id)
    .eq('id', gestorId)
    .maybeSingle()

  if (error) return { ok: false, reason: 'gestor_lookup_failed', error: error.message }
  if (!data) return { ok: false, reason: 'gestor_not_found' }

  const email = String(data.email || '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, reason: 'gestor_email_invalido', gestor_id: gestorId }
  }

  return {
    ok: true,
    gestor_id: gestorId,
    gestor_nome: String(data.nome || '').trim(),
    email,
  }
}

async function resolveGestorWhatsappDestination(company_id, cfg) {
  const clienteId = Number(cfg?.gestor_cliente_id)
  if (Number.isInteger(clienteId) && clienteId > 0) {
    const { data, error } = await supabase
      .from('clientes')
      .select('id, telefone, wa_id, nome, pushname')
      .eq('company_id', company_id)
      .eq('id', clienteId)
      .maybeSingle()

    if (error) {
      return { ok: false, reason: 'contact_lookup_failed', error: error.message, cliente_id: clienteId }
    }
    if (!data) {
      return { ok: false, reason: 'contact_not_found', cliente_id: clienteId }
    }

    const telefone = String(data.telefone || data.wa_id || '').trim()
    if (
      telefone.includes('@g.us') ||
      telefone.toLowerCase().startsWith('lid:') ||
      (telefone.replace(/\D/g, '').startsWith('120') && telefone.replace(/\D/g, '').length >= 15)
    ) {
      return { ok: false, reason: 'group_not_supported', cliente_id: clienteId, cliente_nome: String(data.nome || data.pushname || '').trim() }
    }
    const digits = telefone.replace(/\D/g, '')
    if (!digits || digits.length < 10) {
      return {
        ok: false,
        reason: 'invalid_contact_phone',
        cliente_id: clienteId,
        cliente_nome: String(data.nome || data.pushname || '').trim(),
      }
    }

    return {
      ok: true,
      source: 'cliente',
      telefone,
      digits,
      cliente_id: clienteId,
      cliente_nome: String(data.nome || data.pushname || cfg?.gestor_cliente_nome || '').trim(),
    }
  }

  const telefone = String(cfg?.telefone_gestor || '').trim()
  const digits = telefone.replace(/\D/g, '')
  if (!digits || digits.length < 10) {
    return { ok: false, reason: 'invalid_phone', source: 'manual' }
  }
  return { ok: true, source: 'manual', telefone, digits, cliente_id: null, cliente_nome: '' }
}

async function fetchAtendenteNome(company_id, atendente_id) {
  const id = Number(atendente_id)
  if (!Number.isFinite(id) || id <= 0) return null
  const { data, error } = await supabase
    .from('usuarios')
    .select('nome, email')
    .eq('company_id', company_id)
    .eq('id', id)
    .maybeSingle()
  if (error) {
    console.warn('[atendimentoSemResposta] fetchAtendenteNome:', error.message)
    return null
  }
  return String(data?.nome || data?.email || '').trim() || null
}

function formatTempoSemResposta(minutos) {
  const total = Math.max(0, Math.floor(Number(minutos) || 0))
  if (total < 60) return `${total}min`

  const days = Math.floor(total / 1440)
  const rem = total % 1440
  const hours = Math.floor(rem / 60)
  const mins = rem % 60

  if (days > 0) {
    let out = `${days}d`
    if (hours > 0) out += ` ${hours}h`
    return `${out}${mins}min`
  }

  if (mins > 0) return `${hours}h${mins}min`
  return `${hours}h`
}

function buildGestorWhatsappText({ clienteNome, atendenteNome, minutos, cfg }) {
  const tempo = formatTempoSemResposta(minutos)
  const lines = [
    '🚨 ZapERP — Atendimento sem resposta',
    '',
    `Cliente: ${clienteNome}`,
    `Atendente: ${atendenteNome || 'Não informado'}`,
    `Tempo sem resposta: ${tempo}`,
    '',
  ]
  if (cfg?.reabrir_conversa_automaticamente) {
    lines.push('Status: conversa reaberta e liberada para novo atendimento.')
  } else {
    lines.push('Status: gestor notificado; conversa permanece com o atendente atual.')
  }
  return lines.join('\n')
}

async function sendGestorWhatsapp(company_id, telefone, texto) {
  const tel = String(telefone || '').trim()
  const digits = tel.replace(/\D/g, '')
  if (!digits || digits.length < 10) return { ok: false, error: 'telefone_invalido' }
  try {
    const { getProvider } = require('../providers')
    const provider = getProvider()
    const send = provider?.sendText
    if (typeof send !== 'function') return { ok: false, error: 'sendText_indisponivel' }
    const result = await send(tel, texto, {
      companyId: company_id,
      sendOrigin: 'alerta_sem_resposta_gestor',
    })
    if (result?.ok === false || result?.error) return { ok: false, error: result.error || 'falha_envio' }
    return { ok: true, messageId: result?.messageId ?? null }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

module.exports = {
  emitAlertaRealtime,
  resolveGestorEmailDestination,
  resolveGestorWhatsappDestination,
  fetchAtendenteNome,
  formatTempoSemResposta,
  buildGestorWhatsappText,
  sendGestorWhatsapp,
}
