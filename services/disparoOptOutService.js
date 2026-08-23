/**
 * Opt-out inbound e reativação — Etapa 8 Disparo.
 * Envio de confirmação só quando canSendLive (flags explícitas).
 */

const supabase = require('../config/supabase')
const ultramsg = require('./providers/ultramsg')
const { validarTelefoneDisparo } = require('../helpers/disparoPhoneHelper')
const { getDisparoFlags } = require('../helpers/disparoWorkerConfig')
const { DEFAULT_PALAVRAS, isExactOptOutCommand, normalizeOptOutCommand } = require('../helpers/disparoOptOutHelper')
const { recalcularContadores } = require('./disparoFilaService')
const { emitDisparo, EVENTS } = require('./disparoSocketService')

const CONFIG_SELECT = [
  'company_id', 'palavras_optout', 'mensagem_confirmacao_optout',
  'reativacao_exige_explicito', 'enviar_confirmacao_optout',
  'atualizado_em', 'atualizado_por',
].join(', ')

const DEFAULT_CONFIRMATION =
  'Tudo certo. Seu número foi removido das nossas comunicações. Caso queira voltar a recebê-las, entre em contato conosco.'

const FILA_PENDENTES = ['pendente', 'reservada', 'enviando']

function defaultConfig(companyId) {
  return {
    company_id: Number(companyId),
    palavras_optout: [...DEFAULT_PALAVRAS],
    mensagem_confirmacao_optout: null,
    reativacao_exige_explicito: true,
    enviar_confirmacao_optout: true,
    atualizado_em: null,
    atualizado_por: null,
  }
}

async function getEmpresaConfig(companyId) {
  const cid = Number(companyId)
  if (!cid) return defaultConfig(companyId)

  const { data, error } = await supabase
    .from('disparo_empresa_config')
    .select(CONFIG_SELECT)
    .eq('company_id', cid)
    .maybeSingle()
  if (error) throw error
  if (!data) return defaultConfig(cid)
  return {
    ...defaultConfig(cid),
    ...data,
    palavras_optout: Array.isArray(data.palavras_optout) && data.palavras_optout.length
      ? data.palavras_optout
      : [...DEFAULT_PALAVRAS],
  }
}

async function upsertEmpresaConfig(companyId, patch = {}, userId = null) {
  const cid = Number(companyId)
  if (!cid) throw new Error('company_id inválido')

  const agora = new Date().toISOString()
  const row = {
    company_id: cid,
    atualizado_em: agora,
    atualizado_por: userId ?? null,
  }

  if (patch.palavras_optout != null) {
    const palavras = Array.isArray(patch.palavras_optout) ? patch.palavras_optout : []
    row.palavras_optout = palavras.map((p) => String(p ?? '').trim().toUpperCase()).filter(Boolean)
    if (!row.palavras_optout.length) row.palavras_optout = [...DEFAULT_PALAVRAS]
  }
  if (patch.mensagem_confirmacao_optout !== undefined) {
    row.mensagem_confirmacao_optout = patch.mensagem_confirmacao_optout
      ? String(patch.mensagem_confirmacao_optout).trim().slice(0, 1000)
      : null
  }
  if (patch.reativacao_exige_explicito !== undefined) {
    row.reativacao_exige_explicito = Boolean(patch.reativacao_exige_explicito)
  }
  if (patch.enviar_confirmacao_optout !== undefined) {
    row.enviar_confirmacao_optout = Boolean(patch.enviar_confirmacao_optout)
  }

  const { data, error } = await supabase
    .from('disparo_empresa_config')
    .upsert(row, { onConflict: 'company_id' })
    .select(CONFIG_SELECT)
    .single()
  if (error) throw error
  return data
}

async function upsertExclusaoOptOut({ companyId, telefoneNormalizado, telefoneOriginal, userId }) {
  const agora = new Date().toISOString()
  const { data: existente } = await supabase
    .from('disparo_exclusoes')
    .select('id, ativo')
    .eq('company_id', companyId)
    .eq('telefone_normalizado', telefoneNormalizado)
    .maybeSingle()

  if (existente?.ativo) {
    return { exclusao_id: existente.id, created: false }
  }

  if (existente && !existente.ativo) {
    const { data, error } = await supabase
      .from('disparo_exclusoes')
      .update({
        ativo: true,
        origem: 'optout',
        motivo: 'Opt-out via WhatsApp',
        telefone_original: telefoneOriginal,
        criado_por: userId,
        criado_em: agora,
        removido_por: null,
        removido_em: null,
      })
      .eq('id', existente.id)
      .eq('company_id', companyId)
      .select('id')
      .single()
    if (error) throw error
    return { exclusao_id: data.id, created: false, reativado: true }
  }

  const { data, error } = await supabase
    .from('disparo_exclusoes')
    .insert({
      company_id: companyId,
      telefone_normalizado: telefoneNormalizado,
      telefone_original: telefoneOriginal,
      motivo: 'Opt-out via WhatsApp',
      origem: 'optout',
      ativo: true,
      criado_por: userId,
    })
    .select('id')
    .single()
  if (error) throw error
  return { exclusao_id: data.id, created: true }
}

async function buscarDestinatarioIdsPorTelefone(companyId, telefoneNormalizado) {
  const { data, error } = await supabase
    .from('disparo_campanha_destinatarios')
    .select('id')
    .eq('company_id', companyId)
    .eq('telefone_normalizado', telefoneNormalizado)
  if (error) throw error
  return (data ?? []).map((d) => d.id)
}

async function marcarFilaItensOptOut({ companyId, telefoneNormalizado, agora, io }) {
  const destIds = await buscarDestinatarioIdsPorTelefone(companyId, telefoneNormalizado)
  if (!destIds.length) return { itens_ignorados: 0, execucoes: [] }

  const { data: itens, error } = await supabase
    .from('disparo_fila_itens')
    .select('id, campanha_id, execucao_id, status')
    .eq('company_id', companyId)
    .in('destinatario_id', destIds)
    .in('status', FILA_PENDENTES)
  if (error) throw error
  if (!itens?.length) return { itens_ignorados: 0, execucoes: [] }

  const ids = itens.map((i) => i.id)
  const { error: updErr } = await supabase
    .from('disparo_fila_itens')
    .update({
      status: 'optout',
      optout_em: agora,
      atualizado_em: agora,
    })
    .eq('company_id', companyId)
    .in('id', ids)
  if (updErr) throw updErr

  const execucoes = [...new Set(itens.map((i) => i.execucao_id))]
  for (const execucaoId of execucoes) {
    await recalcularContadores(execucaoId, companyId)
  }

  for (const item of itens) {
    emitDisparo(io, companyId, EVENTS.ITEM_ATUALIZADO, {
      campanha_id: item.campanha_id,
      execucao_id: item.execucao_id,
      item_id: item.id,
      status: 'optout',
      origem: 'optout',
    })
  }

  return { itens_ignorados: ids.length, execucoes }
}

async function enviarConfirmacaoOptOut({ companyId, telefone, instanciaId, texto, io }) {
  const flags = getDisparoFlags()
  if (!flags.canSendLive) {
    console.log('[disparo:optout] confirmação não enviada (dry/off):', {
      company_id: companyId,
      telefone: String(telefone).slice(-4),
    })
    return { confirmationQueued: false, confirmationSent: false, dryRun: true }
  }

  try {
    const result = await ultramsg.sendText(telefone, texto, {
      companyId,
      whatsappInstanceId: instanciaId,
    })
    return {
      confirmationQueued: true,
      confirmationSent: Boolean(result?.ok),
      messageId: result?.messageId ?? null,
      error: result?.error ?? null,
    }
  } catch (e) {
    console.warn('[disparo:optout] falha ao enviar confirmação:', e?.message || e)
    return { confirmationQueued: true, confirmationSent: false, error: e?.message || String(e) }
  }
}

/**
 * Processa mensagem inbound que pode ser comando de opt-out.
 */
async function processInboundOptOut({
  companyId,
  telefone,
  texto,
  mensagemId = null,
  conversaId = null,
  instanciaId = null,
  io = null,
  userId = null,
}) {
  const config = await getEmpresaConfig(companyId)
  const palavraDetectada = isExactOptOutCommand(texto, config.palavras_optout)
    ? normalizeOptOutCommand(texto)
    : null

  if (!palavraDetectada) {
    return { matched: false }
  }

  const validacao = validarTelefoneDisparo(telefone)
  if (!validacao.valido) {
    return { matched: true, ok: false, error: validacao.motivo || 'Telefone inválido' }
  }

  const agora = new Date().toISOString()
  const { exclusao_id } = await upsertExclusaoOptOut({
    companyId,
    telefoneNormalizado: validacao.normalizado,
    telefoneOriginal: validacao.original,
    userId,
  })

  const { itens_ignorados } = await marcarFilaItensOptOut({
    companyId,
    telefoneNormalizado: validacao.normalizado,
    agora,
    io,
  })

  const { data: evento, error: evtErr } = await supabase
    .from('disparo_optout_eventos')
    .insert({
      company_id: companyId,
      telefone_normalizado: validacao.normalizado,
      palavra: palavraDetectada.toUpperCase(),
      exclusao_id,
      mensagem_id: mensagemId,
      conversa_id: conversaId,
      tipo: 'optout',
      motivo: 'Comando inbound',
      usuario_id: userId,
    })
    .select('id')
    .single()
  if (evtErr) throw evtErr

  emitDisparo(io, companyId, EVENTS.OPTOUT_REGISTRADO, {
    telefone_normalizado: validacao.normalizado,
    exclusao_id,
    evento_id: evento?.id,
    itens_ignorados,
    palavra: palavraDetectada,
  })

  const confirmationText =
    (config.mensagem_confirmacao_optout && String(config.mensagem_confirmacao_optout).trim())
    || DEFAULT_CONFIRMATION

  let confirmationResult = {
    shouldConfirm: Boolean(config.enviar_confirmacao_optout),
    confirmationText,
    confirmationQueued: false,
    confirmationSent: false,
  }

  if (config.enviar_confirmacao_optout) {
    confirmationResult = {
      ...confirmationResult,
      ...(await enviarConfirmacaoOptOut({
        companyId,
        telefone: validacao.normalizado,
        instanciaId,
        texto: confirmationText,
        io,
      })),
    }
  }

  return {
    matched: true,
    ok: true,
    exclusao_id,
    evento_id: evento?.id,
    itens_ignorados,
    palavra: palavraDetectada,
    ...confirmationResult,
  }
}

/**
 * Reativa telefone na lista de exclusão (ação manual).
 */
async function reativar({ companyId, telefone, motivo, userId, io = null }) {
  const motivoTrim = String(motivo ?? '').trim()
  if (!motivoTrim) {
    throw Object.assign(new Error('Motivo obrigatório para reativação.'), { code: 'MOTIVO_OBRIGATORIO' })
  }

  const config = await getEmpresaConfig(companyId)
  if (config.reativacao_exige_explicito && !userId) {
    throw Object.assign(new Error('Reativação exige ação explícita de usuário.'), { code: 'USUARIO_OBRIGATORIO' })
  }

  const validacao = validarTelefoneDisparo(telefone)
  if (!validacao.valido) {
    throw Object.assign(new Error(validacao.motivo || 'Telefone inválido.'), { code: 'TELEFONE_INVALIDO' })
  }

  const agora = new Date().toISOString()
  const { data: exclusao, error: findErr } = await supabase
    .from('disparo_exclusoes')
    .select('id, ativo')
    .eq('company_id', companyId)
    .eq('telefone_normalizado', validacao.normalizado)
    .maybeSingle()
  if (findErr) throw findErr

  if (!exclusao?.ativo) {
    return { ok: false, error: 'Telefone não está na lista de exclusão ativa.' }
  }

  const { error: updErr } = await supabase
    .from('disparo_exclusoes')
    .update({
      ativo: false,
      removido_por: userId,
      removido_em: agora,
    })
    .eq('id', exclusao.id)
    .eq('company_id', companyId)
  if (updErr) throw updErr

  const { data: evento, error: evtErr } = await supabase
    .from('disparo_optout_eventos')
    .insert({
      company_id: companyId,
      telefone_normalizado: validacao.normalizado,
      exclusao_id: exclusao.id,
      tipo: 'reativacao',
      motivo: motivoTrim.slice(0, 500),
      usuario_id: userId,
    })
    .select('id')
    .single()
  if (evtErr) throw evtErr

  emitDisparo(io, companyId, EVENTS.OPTOUT_REATIVADO, {
    telefone_normalizado: validacao.normalizado,
    exclusao_id: exclusao.id,
    evento_id: evento?.id,
  })

  return {
    ok: true,
    exclusao_id: exclusao.id,
    evento_id: evento?.id,
    telefone_normalizado: validacao.normalizado,
  }
}

module.exports = {
  getEmpresaConfig,
  upsertEmpresaConfig,
  processInboundOptOut,
  reativar,
  DEFAULT_CONFIRMATION,
}
