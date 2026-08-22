/**
 * Vincula respostas inbound a itens da fila de disparo — Etapa 8.
 */

const supabase = require('../config/supabase')
const { getOrCreateCliente } = require('../helpers/conversationSync')
const { validarTelefoneDisparo } = require('../helpers/disparoPhoneHelper')
const { podeAvancarStatusFila } = require('../helpers/disparoFilaRetryHelper')
const { recalcularContadores } = require('./disparoFilaService')
const { emitDisparo, EVENTS } = require('./disparoSocketService')

const STATUS_RESPOSTA_ELEGIVEL = ['enviada', 'entregue', 'lida', 'respondida']

const RESPOSTA_SELECT = [
  'id', 'company_id', 'campanha_id', 'execucao_id', 'fila_item_id',
  'destinatario_id', 'instancia_id', 'mensagem_entrada_id', 'mensagem_disparo_id',
  'conversa_id', 'telefone_normalizado', 'criado_em',
].join(', ')

const FILA_ITEM_SELECT = [
  'id', 'company_id', 'campanha_id', 'execucao_id', 'destinatario_id',
  'instancia_id', 'status', 'mensagem_id', 'conversa_id', 'enviado_em',
  'entregue_em', 'lido_em', 'respondida_em',
].join(', ')

async function buscarDestinatarioIdsPorTelefone(companyId, telefoneNormalizado) {
  const { data, error } = await supabase
    .from('disparo_campanha_destinatarios')
    .select('id, nome')
    .eq('company_id', companyId)
    .eq('telefone_normalizado', telefoneNormalizado)
  if (error) throw error
  return data ?? []
}

async function encontrarUltimoItemFila({ companyId, telefoneNormalizado, instanciaId }) {
  const dests = await buscarDestinatarioIdsPorTelefone(companyId, telefoneNormalizado)
  if (!dests.length) return { item: null, destinatario: null }

  const destIds = dests.map((d) => d.id)
  const { data: itens, error } = await supabase
    .from('disparo_fila_itens')
    .select(FILA_ITEM_SELECT)
    .eq('company_id', companyId)
    .in('destinatario_id', destIds)
    .in('status', STATUS_RESPOSTA_ELEGIVEL)
    .order('enviado_em', { ascending: false, nullsFirst: false })
    .limit(20)
  if (error) throw error
  if (!itens?.length) return { item: null, destinatario: null }

  const instId = instanciaId != null ? Number(instanciaId) : null
  let item = null
  if (instId) {
    item = itens.find((i) => Number(i.instancia_id) === instId) ?? null
  }
  if (!item) item = itens[0]

  const destinatario = dests.find((d) => d.id === item.destinatario_id) ?? dests[0]
  return { item, destinatario }
}

async function garantirClienteConversa({ companyId, telefone, conversaId, nomeDestinatario }) {
  if (!conversaId) return null

  const { data: conversa, error: convErr } = await supabase
    .from('conversas')
    .select('id, cliente_id, telefone')
    .eq('id', conversaId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (convErr) throw convErr
  if (!conversa) return null
  if (conversa.cliente_id) return conversa.cliente_id

  const tel = telefone || conversa.telefone
  const { cliente_id } = await getOrCreateCliente(supabase, companyId, tel, {
    nome: nomeDestinatario || undefined,
    nomeSource: 'disparo_resposta',
  })
  if (cliente_id) {
    await supabase
      .from('conversas')
      .update({ cliente_id })
      .eq('id', conversaId)
      .eq('company_id', companyId)
      .is('cliente_id', null)
  }
  return cliente_id ?? null
}

/**
 * Tag interna "Campanha: {nome}" na conversa — não enviada ao WhatsApp.
 */
async function aplicarTagCampanhaInterna({ companyId, conversaId, campanhaId }) {
  if (!conversaId || !campanhaId || !companyId) return null

  const { data: campanha } = await supabase
    .from('disparo_campanhas')
    .select('id, nome')
    .eq('id', campanhaId)
    .eq('company_id', companyId)
    .maybeSingle()
  const nomeCampanha = String(campanha?.nome || '').trim() || String(campanhaId)
  const tagNome = `Campanha: ${nomeCampanha}`.slice(0, 120)

  let tagId = null
  const { data: existente } = await supabase
    .from('tags')
    .select('id')
    .eq('company_id', companyId)
    .eq('nome', tagNome)
    .maybeSingle()
  if (existente?.id) {
    tagId = existente.id
  } else {
    const { data: criada, error } = await supabase
      .from('tags')
      .insert({ company_id: companyId, nome: tagNome, cor: '#0d9488' })
      .select('id')
      .single()
    if (error) {
      // race: rebusca
      const { data: again } = await supabase
        .from('tags')
        .select('id')
        .eq('company_id', companyId)
        .eq('nome', tagNome)
        .maybeSingle()
      tagId = again?.id ?? null
    } else {
      tagId = criada?.id ?? null
    }
  }
  if (!tagId) return null

  const { data: link } = await supabase
    .from('conversa_tags')
    .select('id')
    .eq('company_id', companyId)
    .eq('conversa_id', conversaId)
    .eq('tag_id', tagId)
    .maybeSingle()
  if (!link) {
    await supabase.from('conversa_tags').insert({
      company_id: companyId,
      conversa_id: conversaId,
      tag_id: tagId,
    }).catch(() => {})
  }
  return tagId
}

/**
 * Vincula mensagem inbound a um item de fila enviado recentemente.
 */
async function vincularRespostaInbound({
  companyId,
  telefone,
  mensagemId,
  conversaId = null,
  instanciaId = null,
  io = null,
}) {
  const cid = Number(companyId)
  const msgId = Number(mensagemId)
  if (!cid || !msgId) {
    return { ok: false, ignored: 'params_invalidos' }
  }

  const { data: existente } = await supabase
    .from('disparo_respostas')
    .select('id, fila_item_id')
    .eq('company_id', cid)
    .eq('mensagem_entrada_id', msgId)
    .maybeSingle()
  if (existente) {
    return { ok: true, idempotent: true, resposta_id: existente.id, fila_item_id: existente.fila_item_id }
  }

  const validacao = validarTelefoneDisparo(telefone)
  if (!validacao.valido) {
    return { ok: false, ignored: 'telefone_invalido', motivo: validacao.motivo }
  }

  const { item, destinatario } = await encontrarUltimoItemFila({
    companyId: cid,
    telefoneNormalizado: validacao.normalizado,
    instanciaId,
  })
  if (!item) {
    return { ok: false, ignored: 'fila_item_nao_encontrado' }
  }

  await garantirClienteConversa({
    companyId: cid,
    telefone: validacao.normalizado,
    conversaId,
    nomeDestinatario: destinatario?.nome,
  })

  const agora = new Date().toISOString()
  const { data: resposta, error: insErr } = await supabase
    .from('disparo_respostas')
    .insert({
      company_id: cid,
      campanha_id: item.campanha_id,
      execucao_id: item.execucao_id,
      fila_item_id: item.id,
      destinatario_id: item.destinatario_id,
      instancia_id: item.instancia_id,
      mensagem_entrada_id: msgId,
      mensagem_disparo_id: item.mensagem_id ?? null,
      conversa_id: conversaId,
      telefone_normalizado: validacao.normalizado,
    })
    .select(RESPOSTA_SELECT)
    .single()
  if (insErr) {
    if (insErr.code === '23505') {
      const { data: dup } = await supabase
        .from('disparo_respostas')
        .select('id, fila_item_id')
        .eq('company_id', cid)
        .eq('mensagem_entrada_id', msgId)
        .maybeSingle()
      return { ok: true, idempotent: true, resposta_id: dup?.id, fila_item_id: dup?.fila_item_id }
    }
    throw insErr
  }

  // Tag interna "Campanha: {nome}" — após vínculo; não enviada ao cliente
  try {
    await aplicarTagCampanhaInterna({
      companyId: cid,
      conversaId,
      campanhaId: item.campanha_id,
    })
  } catch (e) {
    console.warn('[disparo:resposta] tag campanha:', e?.message || e)
  }

  if (podeAvancarStatusFila(item.status, 'respondida')) {
    const updates = {
      status: 'respondida',
      respondida_em: agora,
      resposta_mensagem_id: msgId,
      resposta_conversa_id: conversaId,
      atualizado_em: agora,
    }
    const { error: updErr } = await supabase
      .from('disparo_fila_itens')
      .update(updates)
      .eq('id', item.id)
      .eq('company_id', cid)
    if (updErr) throw updErr

    await recalcularContadores(item.execucao_id, cid)

    emitDisparo(io, cid, EVENTS.ITEM_ATUALIZADO, {
      campanha_id: item.campanha_id,
      execucao_id: item.execucao_id,
      item_id: item.id,
      status: 'respondida',
      origem: 'resposta_inbound',
    })
  }

  emitDisparo(io, cid, EVENTS.RESPOSTA_VINCULADA, {
    campanha_id: item.campanha_id,
    execucao_id: item.execucao_id,
    fila_item_id: item.id,
    resposta_id: resposta.id,
    mensagem_entrada_id: msgId,
  })

  return {
    ok: true,
    resposta_id: resposta.id,
    fila_item_id: item.id,
    campanha_id: item.campanha_id,
    execucao_id: item.execucao_id,
  }
}

async function listarRespostas(campanhaId, companyId, { page = 1, limit = 50 } = {}) {
  const cid = Number(companyId)
  const campId = Number(campanhaId)
  const pg = Math.max(1, Number(page) || 1)
  const lim = Math.min(200, Math.max(1, Number(limit) || 50))
  const offset = (pg - 1) * lim

  const { data, error, count } = await supabase
    .from('disparo_respostas')
    .select(RESPOSTA_SELECT, { count: 'exact' })
    .eq('company_id', cid)
    .eq('campanha_id', campId)
    .order('criado_em', { ascending: false })
    .range(offset, offset + lim - 1)
  if (error) throw error

  return {
    page: pg,
    limit: lim,
    total: count ?? 0,
    total_pages: Math.ceil((count ?? 0) / lim) || 0,
    itens: data ?? [],
  }
}

module.exports = {
  vincularRespostaInbound,
  listarRespostas,
  encontrarUltimoItemFila,
}
