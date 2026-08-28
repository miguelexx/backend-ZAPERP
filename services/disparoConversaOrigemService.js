/**
 * Origem persistente de conversas do módulo Disparo/Campanhas.
 * Marca aguardando_resposta_campanha no envio e consome na 1ª resposta inbound.
 */

const supabase = require('../config/supabase')
const {
  atendimentoHumanoAtivo,
  deveMarcarAguardandoCampanha,
  isMissingAguardandoCampanhaColumn,
} = require('../helpers/disparoConversaOrigem')

const STATUS_FILA_ELEGIVEL = ['enviada', 'entregue', 'lida', 'respondida']
const STATUS_REABRIR_PARA_FILA = new Set(['fechada', 'finalizada', 'encerrada', 'mensagem_disparada', 'aberta', 'ociosa'])

function listaRealtimeCampanha(motivo) {
  return { minha_fila: true, campanhas: true, motivo }
}

function emitirListaCampanha(io, companyId, conversaId, extra = {}) {
  if (!io || !companyId || !conversaId) return
  const cid = Number(conversaId)
  const company = Number(companyId)
  const payload = {
    id: cid,
    company_id: company,
    lista_realtime: extra.lista_realtime || listaRealtimeCampanha(extra.motivo || 'campanha'),
    aguardando_resposta_campanha: extra.aguardando_resposta_campanha === true,
    ...extra.patch,
  }
  try {
    io.to(`empresa_${company}`).emit('conversa_atualizada', payload)
    io.to(`conversa_${cid}`).emit('conversa_atualizada', payload)
  } catch (e) {
    console.warn('[disparo:campanha] emit conversa_atualizada:', e?.message || e)
  }
}

async function carregarConversaOrigem(companyId, conversaId) {
  const cid = Number(companyId)
  const convId = Number(conversaId)
  if (!cid || !convId) return { conversa: null, missingColumn: false }

  const { data, error } = await supabase
    .from('conversas')
    .select('id, company_id, status_atendimento, atendente_id, aguardando_resposta_campanha, tipo, departamento_id, whatsapp_instance_id')
    .eq('id', convId)
    .eq('company_id', cid)
    .maybeSingle()

  if (error && isMissingAguardandoCampanhaColumn(error)) {
    return { conversa: null, missingColumn: true }
  }
  if (error) throw error
  return { conversa: data || null, missingColumn: false }
}

async function marcarAguardandoRespostaCampanha({
  companyId,
  conversaId,
  io = null,
} = {}) {
  const cid = Number(companyId)
  const convId = Number(conversaId)
  if (!cid || !convId) {
    return { ok: false, ignored: 'params_invalidos' }
  }

  const { conversa, missingColumn } = await carregarConversaOrigem(cid, convId)
  if (missingColumn) {
    return { ok: false, ignored: 'coluna_ausente' }
  }
  if (!conversa) {
    return { ok: false, ignored: 'conversa_nao_encontrada' }
  }
  if (!deveMarcarAguardandoCampanha(conversa)) {
    return {
      ok: true,
      marked: false,
      ignored: atendimentoHumanoAtivo(conversa) ? 'atendimento_humano_ativo' : 'nao_elegivel',
    }
  }
  if (conversa.aguardando_resposta_campanha === true) {
    return { ok: true, marked: true, already: true, conversa_id: convId }
  }

  const agora = new Date().toISOString()
  const { error } = await supabase
    .from('conversas')
    .update({
      aguardando_resposta_campanha: true,
      ultima_atividade: agora,
    })
    .eq('id', convId)
    .eq('company_id', cid)

  if (error && isMissingAguardandoCampanhaColumn(error)) {
    return { ok: false, ignored: 'coluna_ausente' }
  }
  if (error) throw error

  emitirListaCampanha(io, cid, convId, {
    motivo: 'campanha_enviada',
    aguardando_resposta_campanha: true,
    patch: {
      ultima_atividade: agora,
      aguardando_resposta_campanha: true,
    },
  })

  return { ok: true, marked: true, conversa_id: convId }
}

async function resolverResponsavelCampanha({ companyId, conversaId, instanciaId = null }) {
  const cid = Number(companyId)
  const convId = Number(conversaId)
  if (!cid || !convId) return { item: null, usuarioId: null }

  const { data: itens, error } = await supabase
    .from('disparo_fila_itens')
    .select('id, execucao_id, campanha_id, instancia_id, destinatario_id, enviado_em')
    .eq('company_id', cid)
    .eq('conversa_id', convId)
    .in('status', STATUS_FILA_ELEGIVEL)
    .order('enviado_em', { ascending: false, nullsFirst: false })
    .limit(10)
  if (error) throw error
  if (!itens?.length) return { item: null, usuarioId: null }

  const instId = instanciaId != null ? Number(instanciaId) : null
  let item = null
  if (Number.isFinite(instId) && instId > 0) {
    item = itens.find((i) => Number(i.instancia_id) === instId) || null
  }
  if (!item) item = itens[0]

  let usuarioId = null
  if (item.execucao_id) {
    const { data: exec, error: execErr } = await supabase
      .from('disparo_execucoes')
      .select('iniciado_por, campanha_id')
      .eq('id', item.execucao_id)
      .eq('company_id', cid)
      .maybeSingle()
    if (execErr) throw execErr
    usuarioId = exec?.iniciado_por ?? null
  }
  if (!usuarioId && item.campanha_id) {
    const { data: camp, error: campErr } = await supabase
      .from('disparo_campanhas')
      .select('criado_por')
      .eq('id', item.campanha_id)
      .eq('company_id', cid)
      .maybeSingle()
    if (campErr) throw campErr
    usuarioId = camp?.criado_por ?? null
  }

  const uid = usuarioId != null ? Number(usuarioId) : null
  if (!Number.isFinite(uid) || uid <= 0) {
    return { item, usuarioId: null }
  }

  const { data: user, error: userErr } = await supabase
    .from('usuarios')
    .select('id, ativo, company_id')
    .eq('id', uid)
    .eq('company_id', cid)
    .maybeSingle()
  if (userErr) throw userErr
  if (!user || user.ativo === false) {
    return { item, usuarioId: null }
  }
  return { item, usuarioId: Number(user.id) }
}

/**
 * Primeira resposta válida do contato a uma campanha aguardando.
 * Idempotente: só altera se aguardando_resposta_campanha ainda for true.
 */
async function consumirPrimeiraRespostaCampanha({
  companyId,
  conversaId,
  instanciaId = null,
  io = null,
} = {}) {
  const cid = Number(companyId)
  const convId = Number(conversaId)
  if (!cid || !convId) {
    return { ok: false, ignored: 'params_invalidos' }
  }

  const { conversa, missingColumn } = await carregarConversaOrigem(cid, convId)
  if (missingColumn) {
    return { ok: false, ignored: 'coluna_ausente' }
  }
  if (!conversa) {
    return { ok: false, ignored: 'conversa_nao_encontrada' }
  }
  if (conversa.aguardando_resposta_campanha !== true) {
    return { ok: true, consumed: false, idempotent: true, conversa_id: convId }
  }

  const { usuarioId } = await resolverResponsavelCampanha({
    companyId: cid,
    conversaId: convId,
    instanciaId,
  })

  const agora = new Date().toISOString()
  const statusAtual = String(conversa.status_atendimento || '').trim().toLowerCase()
  const atendenteAtual =
    conversa.atendente_id != null && Number.isFinite(Number(conversa.atendente_id))
      ? Number(conversa.atendente_id)
      : null

  const patch = {
    aguardando_resposta_campanha: false,
    ultima_atividade: agora,
  }

  if (atendenteAtual) {
    if (STATUS_REABRIR_PARA_FILA.has(statusAtual) && statusAtual !== 'aberta') {
      patch.status_atendimento = 'em_atendimento'
    } else if (statusAtual === 'aberta') {
      patch.status_atendimento = 'em_atendimento'
    }
  } else if (usuarioId) {
    patch.atendente_id = usuarioId
    patch.atendente_atribuido_em = agora
    patch.status_atendimento = 'em_atendimento'
  } else if (STATUS_REABRIR_PARA_FILA.has(statusAtual) || !statusAtual) {
    patch.status_atendimento = 'aberta'
  }

  const { data: updated, error } = await supabase
    .from('conversas')
    .update(patch)
    .eq('id', convId)
    .eq('company_id', cid)
    .eq('aguardando_resposta_campanha', true)
    .select('id, atendente_id, status_atendimento, aguardando_resposta_campanha')
    .maybeSingle()

  if (error && isMissingAguardandoCampanhaColumn(error)) {
    return { ok: false, ignored: 'coluna_ausente' }
  }
  if (error) throw error
  if (!updated) {
    return { ok: true, consumed: false, idempotent: true, conversa_id: convId }
  }

  emitirListaCampanha(io, cid, convId, {
    motivo: 'campanha_respondida',
    aguardando_resposta_campanha: false,
    patch: {
      aguardando_resposta_campanha: false,
      atendente_id: updated.atendente_id ?? patch.atendente_id ?? atendenteAtual,
      status_atendimento: updated.status_atendimento ?? patch.status_atendimento ?? statusAtual,
      status_atendimento_real: updated.status_atendimento ?? patch.status_atendimento ?? statusAtual,
      ultima_atividade: agora,
      exibir_badge_aberta: !updated.atendente_id && (updated.status_atendimento || '') === 'aberta',
    },
  })

  return {
    ok: true,
    consumed: true,
    conversa_id: convId,
    atendente_id: updated.atendente_id ?? null,
    status_atendimento: updated.status_atendimento ?? null,
  }
}

module.exports = {
  marcarAguardandoRespostaCampanha,
  consumirPrimeiraRespostaCampanha,
  resolverResponsavelCampanha,
  listaRealtimeCampanha,
}
