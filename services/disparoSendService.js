/**
 * Envio de um item da fila de disparo — Etapa 7.
 * Dry-run nunca chama UltraMSG. Live exige flags explícitas.
 */

const supabase = require('../config/supabase')
const ultramsg = require('./providers/ultramsg')
const { findOrCreateConversation } = require('../helpers/conversationSync')
const { telefoneNaAllowlist, getDisparoFlags } = require('../helpers/disparoWorkerConfig')
const { buildDispReferenceId } = require('../helpers/disparoReferenceHelper')
const {
  _substituirVariaveis: substituirVariaveis,
  _conteudoEditorial: conteudoEditorial,
} = require('../controllers/disparoVariacoesController')
const { empresaUsaR2, getPresignExpiresSeconds } = require('../config/r2')
const { presignGetUrl } = require('./storage/r2Client')

const DRY_RUN_DELAY_MS = 80
const TIPOS_MIDIA = new Set(['imagem', 'video', 'audio', 'documento'])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function phoneLast4(telefone) {
  const d = String(telefone || '').replace(/\D/g, '')
  return d.slice(-4) || '????'
}

function withTimeout(promise, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return promise
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error('Timeout no envio'), { code: 'TIMEOUT' })), timeoutMs)
    }),
  ])
}

function resolveBaseUrl() {
  return (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/$/, '')
}

/**
 * URL pública acessível pelo UltraMSG para mídia da variação.
 */
async function buildMidiaPublicUrl(variacao, companyId) {
  if (variacao.midia_storage_key) {
    if (empresaUsaR2(companyId)) {
      return presignGetUrl(
        variacao.midia_storage_key,
        Math.max(3600, getPresignExpiresSeconds()),
      )
    }
    const baseUrl = resolveBaseUrl()
    if (baseUrl && !/localhost|127\.0\.0\.1/i.test(baseUrl)) {
      return `${baseUrl}/media/r2/${variacao.midia_storage_key}`
    }
    return null
  }

  if (variacao.midia_url_disco) {
    const baseUrl = resolveBaseUrl()
    if (!baseUrl || /localhost|127\.0\.0\.1/i.test(baseUrl)) return null
    return `${baseUrl}/uploads/${variacao.midia_url_disco}`
  }

  return null
}

function resolverTextoFinal(variacao, destinatario, padraoValores) {
  const tipo = variacao.tipo_mensagem || 'texto'
  const editorial = conteudoEditorial(variacao)
  const textoSubst = substituirVariaveis(editorial, destinatario, padraoValores)

  if (tipo === 'texto') {
    return { tipo, texto: textoSubst, legenda: null }
  }

  const legendaRaw = variacao.legenda || variacao.texto || ''
  const legendaSubst = legendaRaw
    ? substituirVariaveis(legendaRaw, destinatario, padraoValores)
    : null

  return { tipo, texto: textoSubst, legenda: legendaSubst }
}

async function carregarContexto(item) {
  const companyId = Number(item.company_id)
  const [destRes, varRes, instRes, campRes] = await Promise.all([
    supabase
      .from('disparo_campanha_destinatarios')
      .select('id, nome, telefone_normalizado, telefone_original, variaveis, cliente_id, status')
      .eq('id', item.destinatario_id)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('disparo_campanha_variacoes')
      .select('id, tipo_mensagem, texto, legenda, midia_storage_key, midia_url_disco, midia_nome_original, midia_mime, ativa')
      .eq('id', item.variacao_id)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('whatsapp_instances')
      .select('id, nome, status, ativo')
      .eq('id', item.instancia_id)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('disparo_campanhas')
      .select('variacao_padrao_valores')
      .eq('id', item.campanha_id)
      .eq('company_id', companyId)
      .maybeSingle(),
  ])

  if (destRes.error) throw destRes.error
  if (varRes.error) throw varRes.error
  if (instRes.error) throw instRes.error
  if (campRes.error) throw campRes.error

  return {
    destinatario: destRes.data,
    variacao: varRes.data,
    instancia: instRes.data,
    padraoValores: campRes.data?.variacao_padrao_valores ?? {},
  }
}

async function verificarExclusao(companyId, telefoneNormalizado) {
  const { data, error } = await supabase
    .from('disparo_exclusoes')
    .select('id')
    .eq('company_id', companyId)
    .eq('telefone_normalizado', telefoneNormalizado)
    .eq('ativo', true)
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}

async function persistirMensagem({
  item,
  destinatario,
  variacao,
  textoFinal,
  mediaUrlRelativa,
  messageId,
  io,
}) {
  const companyId = Number(item.company_id)
  const phone = destinatario.telefone_normalizado || destinatario.telefone_original
  const referenceId = buildDispReferenceId(item.id)

  const convResult = await findOrCreateConversation(supabase, {
    company_id: companyId,
    phone,
    cliente_id: destinatario.cliente_id ?? null,
    whatsapp_instance_id: item.instancia_id,
    logPrefix: '[disparo:send]',
    initial_status_atendimento: 'aberta',
    io,
  })

  if (!convResult?.conversa?.id) return null

  const tipo = variacao.tipo_mensagem || 'texto'
  const tipoMensagem = tipo === 'documento' ? 'arquivo' : tipo
  const textoBanco = tipo === 'texto'
    ? textoFinal.texto
    : (textoFinal.legenda || variacao.midia_nome_original || `(${tipo})`)

  const { data: mensagem, error } = await supabase
    .from('mensagens')
    .insert({
      conversa_id: convResult.conversa.id,
      texto: textoBanco || '(disparo)',
      tipo: tipoMensagem,
      url: mediaUrlRelativa || null,
      nome_arquivo: variacao.midia_nome_original || null,
      direcao: 'out',
      company_id: companyId,
      whatsapp_instance_id: item.instancia_id,
      status: messageId ? 'sent' : 'pending',
      whatsapp_id: messageId || null,
      criado_em: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) {
    console.warn('[disparo:send] persistir mensagem falhou item=', item.id, error.message)
    return null
  }

  await supabase
    .from('disparo_fila_itens')
    .update({
      mensagem_id: mensagem.id,
      conversa_id: convResult.conversa.id,
      reference_id: referenceId,
      provider_message_id: messageId || null,
      atualizado_em: new Date().toISOString(),
    })
    .eq('id', item.id)
    .eq('company_id', companyId)

  return mensagem
}

async function enviarViaUltramsg({
  tipo,
  telefone,
  textoFinal,
  mediaUrl,
  variacao,
  item,
  timeoutMs,
}) {
  const opts = {
    companyId: item.company_id,
    whatsappInstanceId: item.instancia_id,
    referenceId: buildDispReferenceId(item.id),
    returnDetails: true,
  }

  let sendPromise

  switch (tipo) {
    case 'texto':
      sendPromise = ultramsg.sendText(telefone, textoFinal.texto, opts)
      break
    case 'imagem':
      sendPromise = ultramsg.sendImage(telefone, mediaUrl, textoFinal.legenda || '', opts)
      break
    case 'video':
      sendPromise = ultramsg.sendVideo(telefone, mediaUrl, textoFinal.legenda || '', opts)
      break
    case 'audio':
      sendPromise = ultramsg.sendAudio(telefone, mediaUrl, opts)
      break
    case 'documento':
      sendPromise = ultramsg.sendFile(
        telefone,
        mediaUrl,
        variacao.midia_nome_original || 'documento',
        { ...opts, caption: textoFinal.legenda || '' },
      )
      break
    default:
      return { ok: false, messageId: null, error: `Tipo de mensagem não suportado: ${tipo}`, httpStatus: 400 }
  }

  const result = await withTimeout(sendPromise, timeoutMs)
  if (result === false) {
    return { ok: false, messageId: null, error: 'Envio rejeitado pelo provedor', httpStatus: 502 }
  }
  if (typeof result === 'object' && result !== null) {
    return {
      ok: result.ok !== false,
      messageId: result.messageId || result.id || null,
      error: result.error || null,
      httpStatus: result.httpStatus || (result.ok === false ? 502 : 200),
    }
  }
  return { ok: true, messageId: null, error: null, httpStatus: 200 }
}

/**
 * Processa o envio de um item da fila.
 */
async function enviarItemFila(item, { dryRun, liveEnabled, allowlist, timeoutMs, io } = {}) {
  const itemId = item?.id
  const companyId = Number(item?.company_id)

  if (!itemId || !companyId) {
    return { ok: false, error: 'Item inválido', httpStatus: 400, beforeSend: true }
  }

  let destinatario
  let variacao
  let instancia
  let padraoValores

  try {
    const ctx = await carregarContexto(item)
    destinatario = ctx.destinatario
    variacao = ctx.variacao
    instancia = ctx.instancia
    padraoValores = ctx.padraoValores
  } catch (err) {
    console.warn('[disparo:send] carregar contexto item=', itemId, err?.message)
    return { ok: false, error: 'Erro ao carregar dados do item', httpStatus: 500, beforeSend: true }
  }

  if (!destinatario || destinatario.status === 'excluido') {
    return { ok: false, error: 'Destinatário inválido ou excluído', httpStatus: 404, beforeSend: true }
  }
  if (!variacao || variacao.ativa === false) {
    return { ok: false, error: 'Variação inválida ou inativa', httpStatus: 404, beforeSend: true }
  }
  if (!instancia || !instancia.ativo) {
    return { ok: false, error: 'Instância inativa', httpStatus: 409, beforeSend: true }
  }
  // Status no banco pode estar stale/"disconnected" por parser UltraMSG aninhado.
  // Se a instância está ativa, permite o envio (igual ao atendimento).
  const statusInst = String(instancia.status || '').toLowerCase()
  if (['qr', 'qr_code', 'qrcode'].includes(statusInst)) {
    return { ok: false, error: 'Instância aguardando QR Code', httpStatus: 409, beforeSend: true }
  }

  const telefone = destinatario.telefone_normalizado || destinatario.telefone_original
  if (!telefone) {
    return { ok: false, error: 'Telefone do destinatário ausente', httpStatus: 400, beforeSend: true }
  }

  const excluido = await verificarExclusao(companyId, destinatario.telefone_normalizado)
  if (excluido) {
    return {
      ok: false,
      error: 'Telefone na lista de exclusão',
      httpStatus: 403,
      beforeSend: true,
      errorCodigo: 'EXCLUIDO',
    }
  }

  if (!telefoneNaAllowlist(telefone, allowlist)) {
    return {
      ok: false,
      error: 'Telefone fora da allowlist de testes',
      httpStatus: 403,
      beforeSend: true,
      errorCodigo: 'ALLOWLIST',
    }
  }

  const textoFinal = resolverTextoFinal(variacao, destinatario, padraoValores)
  const tipo = textoFinal.tipo

  if (tipo === 'texto' && !String(textoFinal.texto || '').trim()) {
    return { ok: false, error: 'Texto vazio após substituição de variáveis', httpStatus: 400, beforeSend: true }
  }

  let mediaUrl = null
  let mediaUrlRelativa = null
  if (TIPOS_MIDIA.has(tipo)) {
    mediaUrl = await buildMidiaPublicUrl(variacao, companyId)
    if (variacao.midia_storage_key) {
      mediaUrlRelativa = `/media/r2/${variacao.midia_storage_key}`
    } else if (variacao.midia_url_disco) {
      mediaUrlRelativa = `/uploads/${variacao.midia_url_disco}`
    }
    if (!mediaUrl) {
      return { ok: false, error: 'URL pública da mídia indisponível', httpStatus: 400, beforeSend: true }
    }
  }

  const flags = getDisparoFlags()
  const effectiveDryRun = dryRun !== false || !liveEnabled || !flags.canSendLive

  if (effectiveDryRun) {
    await sleep(DRY_RUN_DELAY_MS)
    console.log('[disparo:send] dry-run item=', itemId, 'tel=****', phoneLast4(telefone))
    return {
      ok: true,
      dryRun: true,
      messageId: `dry-${itemId}`,
      beforeSend: false,
    }
  }

  console.log('[disparo:send] live item=', itemId, 'tel=****', phoneLast4(telefone), 'tipo=', tipo)

  let sendResult
  try {
    sendResult = await enviarViaUltramsg({
      tipo,
      telefone,
      textoFinal,
      mediaUrl,
      variacao,
      item,
      timeoutMs: timeoutMs || 45000,
    })
  } catch (err) {
    const isTimeout = err?.code === 'TIMEOUT'
    console.warn('[disparo:send] falha item=', itemId, 'tel=****', phoneLast4(telefone), err?.message)
    return {
      ok: false,
      error: isTimeout ? 'Timeout no envio' : (err?.message || 'Erro no envio'),
      httpStatus: isTimeout ? 504 : 502,
      beforeSend: false,
      // Timeout após a chamada ter sido iniciada → estado incerto (não reenviar de imediato)
      incerto: isTimeout === true,
      code: isTimeout ? 'TIMEOUT_POS_CHAMADA' : undefined,
      referenceId: buildDispReferenceId(itemId),
    }
  }

  if (!sendResult.ok) {
    return {
      ok: false,
      error: sendResult.error || 'Falha no envio',
      httpStatus: sendResult.httpStatus || 502,
      beforeSend: false,
    }
  }

  try {
    await persistirMensagem({
      item,
      destinatario,
      variacao,
      textoFinal,
      mediaUrlRelativa,
      messageId: sendResult.messageId,
      io,
    })
  } catch (err) {
    console.warn('[disparo:send] persistência pós-envio item=', itemId, err?.message)
  }

  return {
    ok: true,
    dryRun: false,
    messageId: sendResult.messageId,
    beforeSend: false,
    referenceId: buildDispReferenceId(itemId),
  }
}

module.exports = {
  enviarItemFila,
  buildMidiaPublicUrl,
}
