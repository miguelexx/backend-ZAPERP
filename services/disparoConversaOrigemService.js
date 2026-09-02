/**
 * Origem persistente de conversas do módulo Disparo/Campanhas.
 * Marca aguardando_resposta_campanha no envio e consome na 1ª resposta inbound.
 */

const supabase = require('../config/supabase')
const { registrarAtendimento } = require('./atendimentosRegistroService')
const {
  atendimentoHumanoAtivo,
  deveMarcarAguardandoCampanha,
  isMissingAguardandoCampanhaColumn,
} = require('../helpers/disparoConversaOrigem')

const STATUS_FILA_ELEGIVEL = ['enviada', 'entregue', 'lida', 'respondida']
const STATUS_FILA_AGUARDANDO_RESPOSTA = ['enviada', 'entregue', 'lida']

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
    let chain = io.to(`empresa_${company}`).to(`conversa_${cid}`)
    const uid = extra.atendente_id != null ? Number(extra.atendente_id) : Number(extra.patch?.atendente_id)
    if (Number.isFinite(uid) && uid > 0) chain = chain.to(`usuario_${uid}`)
    chain.emit('conversa_atualizada', payload)
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
  const { data: updated, error } = await supabase
    .from('conversas')
    .update({
      aguardando_resposta_campanha: true,
      status_atendimento: 'aberta',
      atendente_id: null,
      atendente_atribuido_em: null,
      ultima_atividade: agora,
    })
    .eq('id', convId)
    .eq('company_id', cid)
    .select('id, status_atendimento, aguardando_resposta_campanha')
    .maybeSingle()

  if (error && isMissingAguardandoCampanhaColumn(error)) {
    return { ok: false, ignored: 'coluna_ausente' }
  }
  if (error) throw error
  if (!updated) {
    return { ok: true, marked: false, ignored: 'nao_elegivel', conversa_id: convId }
  }

  emitirListaCampanha(io, cid, convId, {
    motivo: 'campanha_enviada',
    aguardando_resposta_campanha: true,
    patch: {
      ultima_atividade: agora,
      aguardando_resposta_campanha: true,
      status_atendimento: 'aberta',
      status_atendimento_real: 'aberta',
      atendente_id: null,
      exibir_badge_aberta: false,
    },
  })

  return { ok: true, marked: true, conversa_id: convId }
}

/**
 * Eco fromMe / persistência tardia: só marca se esta mensagem (whatsapp_id ou
 * mensagens.id) estiver na fila de disparo da mesma empresa.
 */
async function marcarOrigemCampanhaSeMensagemFila({
  companyId,
  conversaId,
  providerMessageId = null,
  mensagemId = null,
  io = null,
} = {}) {
  const cid = Number(companyId)
  const convId = Number(conversaId)
  if (!cid || !convId) return { ok: false, ignored: 'params_invalidos' }

  const wamid = providerMessageId != null ? String(providerMessageId).trim() : ''
  const mid = mensagemId != null ? Number(mensagemId) : null
  if (!wamid && !(Number.isFinite(mid) && mid > 0)) {
    return { ok: true, marked: false, ignored: 'sem_id_mensagem' }
  }

  let q = supabase
    .from('disparo_fila_itens')
    .select('id')
    .eq('company_id', cid)
    .in('status', STATUS_FILA_AGUARDANDO_RESPOSTA)
    .limit(1)

  if (wamid && Number.isFinite(mid) && mid > 0) {
    const wamidSafe = wamid.replace(/[,()]/g, '')
    q = q.or(`provider_message_id.eq.${wamidSafe},mensagem_id.eq.${mid}`)
  } else if (wamid) {
    q = q.eq('provider_message_id', wamid)
  } else {
    q = q.eq('mensagem_id', mid)
  }

  const { data: itens, error } = await q
  if (error) throw error
  if (!itens?.length) {
    return { ok: true, marked: false, ignored: 'sem_fila' }
  }

  return marcarAguardandoRespostaCampanha({
    companyId: cid,
    conversaId: convId,
    io,
  })
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
 * Com responsável da campanha (iniciado_por / criado_por ativo na mesma empresa):
 * assume em_atendimento para a Minha fila dele. Sem responsável: aberta na fila geral.
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

  let usuarioId = null
  try {
    const resolved = await resolverResponsavelCampanha({
      companyId: cid,
      conversaId: convId,
      instanciaId,
    })
    usuarioId = resolved?.usuarioId ?? null
  } catch (e) {
    console.warn('[disparo:campanha] resolver responsável:', e?.message || e)
  }

  const assumir = Number.isFinite(Number(usuarioId)) && Number(usuarioId) > 0
  const agora = new Date().toISOString()
  const patch = {
    aguardando_resposta_campanha: false,
    status_atendimento: assumir ? 'em_atendimento' : 'aberta',
    atendente_id: assumir ? Number(usuarioId) : null,
    atendente_atribuido_em: assumir ? agora : null,
    ultima_atividade: agora,
    aguardando_cliente_desde: null,
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

  if (assumir) {
    try {
      await registrarAtendimento({
        conversa_id: convId,
        company_id: cid,
        acao: 'assumiu',
        de_usuario_id: null,
        para_usuario_id: Number(usuarioId),
        observacao: 'campanha_respondida',
      })
    } catch (e) {
      console.warn('[disparo:campanha] registrar atendimento:', e?.message || e)
    }
  }

  const status = updated.status_atendimento ?? patch.status_atendimento
  const atendenteId = updated.atendente_id ?? patch.atendente_id
  emitirListaCampanha(io, cid, convId, {
    motivo: 'campanha_respondida',
    aguardando_resposta_campanha: false,
    atendente_id: atendenteId,
    patch: {
      aguardando_resposta_campanha: false,
      atendente_id: atendenteId,
      status_atendimento: status,
      status_atendimento_real: status,
      ultima_atividade: agora,
      exibir_badge_aberta: !assumir,
    },
  })

  return {
    ok: true,
    consumed: true,
    conversa_id: convId,
    atendente_id: atendenteId ?? null,
    status_atendimento: status ?? null,
  }
}

module.exports = {
  marcarAguardandoRespostaCampanha,
  marcarOrigemCampanhaSeMensagemFila,
  consumirPrimeiraRespostaCampanha,
  resolverResponsavelCampanha,
  listaRealtimeCampanha,
}
