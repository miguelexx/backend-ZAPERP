/**
 * Reenvio automático de MÍDIA outbound que falhou (status='erro').
 *
 * Problema: às vezes um áudio (ou outra mídia) enviado pelo atendente não é entregue — o
 * upload/POST ao provedor falha por um blip de rede e a mensagem fica marcada como 'erro'.
 * O único caminho de recuperação era o botão "Tentar novamente" do frontend, que depende do
 * navegador ainda ter o arquivo em memória; após um reload aparecia "O áudio não está mais
 * disponível. Grave novamente." e a mídia nunca chegava ao cliente.
 *
 * Solução: o arquivo JÁ fica salvo no servidor em /uploads/<filename> (coluna `url` da mensagem).
 * Este serviço reenvia a partir desse arquivo — sem depender do navegador. Um reenvio imediato é
 * agendado quando o envio falha, e uma varredura periódica (scheduler) pega o que sobrou.
 *
 * Segurança contra duplicidade: antes de reenviar, consulta o provedor por referenceId (crm-<id>).
 * Se a mensagem JÁ chegou ao provedor (mesmo que o webhook de status tenha demorado), NÃO reenvia —
 * apenas corrige o status e deixa a reconciliação pending cuidar. Só reenvia quando o provedor não
 * tem registro da mensagem (ou seja, o envio realmente não aconteceu).
 *
 * Escopo: só toca mensagens já em 'erro' — nunca interfere no caminho feliz que já funciona.
 * Relacionado: services/pendingOutboundReconciliationService.js (reconcilia pending/sending),
 * helpers/serialDispatchQueue.js (ordem de despacho no envio original).
 */

const path = require('path')
const fs = require('fs')
const supabase = require('../config/supabase')
const { getProvider } = require('./providers')
const { getUploadsRoot } = require('../config/uploadsRoot')
const { isRealWhatsAppId, buildCrmReferenceId } = require('../helpers/whatsappMessageIdHelper')
const { schedulePendingOutboundReconciliation } = require('./pendingOutboundReconciliationService')

// Tipos de mídia cujo reenvio é suportado (o arquivo está em /uploads e pode ser re-subido).
const RESENDABLE_TIPOS = ['voice', 'audio', 'imagem', 'video', 'arquivo', 'sticker']
const RESENDABLE_TIPOS_SET = new Set(RESENDABLE_TIPOS)

// Estado por processo. attemptsById limita tentativas; inFlight evita reenvio concorrente da mesma
// mensagem (varredura periódica + agendamento imediato podem coincidir). deferredTimers deduplica
// agendamentos imediatos. Nada disso é durável — a varredura periódica cobre reinícios.
const attemptsById = new Map()
const inFlight = new Set()
const deferredTimers = new Map()

const PROVIDER_SUCCESS_OR_QUEUE = ['sent', 'server', 'device', 'read', 'played', 'delivered', 'queue']
const PROVIDER_FAILURE = ['unsent', 'invalid', 'expired', 'failed', 'error', 'erro']

function parseIntEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(process.env[name])
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function isEnabled() {
  const raw = String(process.env.OUTBOUND_MEDIA_RESEND_ENABLED ?? 'true').trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(raw)
}

// Janela curta de propósito: se um áudio falhou há mais de X min o atendente já seguiu adiante
// (provavelmente regravou); não faz sentido "ressuscitar" mídia antiga automaticamente.
function getLookbackMs() {
  return parseIntEnv('OUTBOUND_MEDIA_RESEND_LOOKBACK_MINUTES', 30, { min: 5, max: 240 }) * 60_000
}
function getMinAgeMs() {
  return parseIntEnv('OUTBOUND_MEDIA_RESEND_MIN_AGE_SECONDS', 10, { min: 3, max: 600 }) * 1000
}
function getMaxAttempts() {
  return parseIntEnv('OUTBOUND_MEDIA_RESEND_MAX_ATTEMPTS', 4, { min: 1, max: 12 })
}
function getBatchLimit() {
  return parseIntEnv('OUTBOUND_MEDIA_RESEND_BATCH_LIMIT', 30, { min: 1, max: 200 })
}
function getDeferMs() {
  return parseIntEnv('OUTBOUND_MEDIA_RESEND_DEFER_MS', 15_000, { min: 5_000, max: 120_000 })
}

function isResendableTipo(tipo) {
  return RESENDABLE_TIPOS_SET.has(String(tipo || '').toLowerCase().trim())
}

// Resolve o caminho absoluto do arquivo salvo a partir da URL /uploads/<filename>.
// Usa apenas o basename (bloqueia path traversal via ../).
function resolveStoredMediaPath(url) {
  const s = String(url || '').trim()
  if (!s.startsWith('/uploads/')) return null
  const filename = path.basename(s)
  if (!filename || filename === '.' || filename === '..') return null
  return path.join(getUploadsRoot(), filename)
}

function providerRowStatus(row) {
  return String(row?.status ?? '').trim().toLowerCase()
}

async function queryProviderForReference(row) {
  const provider = getProvider()
  if (!provider?.getMessages) return { checked: false, found: false, list: [] }
  const referenceId = buildCrmReferenceId(row.id)
  if (!referenceId) return { checked: false, found: false, list: [] }
  try {
    const res = await provider.getMessages({
      companyId: row.company_id,
      whatsappInstanceId: row.whatsapp_instance_id || undefined,
      referenceId,
      status: 'all',
      page: 1,
      limit: 5,
      sort: 'desc',
    })
    const list = res?.ok && Array.isArray(res.data) ? res.data : []
    return { checked: true, found: list.length > 0, list }
  } catch (_) {
    return { checked: false, found: false, list: [] }
  }
}

function emitStatus(io, row, status, statusMensagem, whatsappId) {
  if (!io) return
  const payload = {
    mensagem_id: row.id,
    conversa_id: Number(row.conversa_id),
    status,
    status_mensagem: statusMensagem,
    ...(whatsappId ? { whatsapp_id: whatsappId } : {}),
  }
  let chain = io.to(`empresa_${row.company_id}`).to(`conversa_${row.conversa_id}`)
  if (row.autor_usuario_id != null) chain = chain.to(`usuario_${row.autor_usuario_id}`)
  chain.emit(io.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', payload)
}

async function markMessage(row, status, statusMensagem, io, extra = {}) {
  await supabase
    .from('mensagens')
    .update({ status, status_mensagem: statusMensagem, ...extra })
    .eq('company_id', row.company_id)
    .eq('id', row.id)
  emitStatus(io, row, status, statusMensagem, extra.whatsapp_id)
}

// Sobe o arquivo salvo e reenvia pelo método correto do provedor. Sem legenda no reenvio:
// a mídia foi salva sem re-derivar a legenda com prefixo do atendente; entregar a mídia (que antes
// nunca chegou) é o objetivo — melhor que não entregar. Áudio/sticker não têm legenda de qualquer modo.
async function sendStoredMediaOnce(row, tipo, phone, filePath, whatsappInstanceId) {
  const provider = getProvider()
  if (!provider) return { ok: false, error: 'provider_indisponivel' }
  if (!provider.uploadMedia) return { ok: false, error: 'upload_indisponivel' }

  const filename = path.basename(filePath)
  const displayName = row.nome_arquivo || filename

  const up = await provider.uploadMedia(filePath, displayName, {
    companyId: row.company_id,
    whatsappInstanceId,
  })
  if (!up?.ok || !up?.url) {
    return { ok: false, error: up?.error || 'upload_falhou' }
  }
  const mediaUrl = up.url

  const isAudio = tipo === 'voice' || tipo === 'audio'
  const opts = {
    companyId: row.company_id,
    conversaId: row.conversa_id,
    whatsappInstanceId,
    sendOrigin: 'reenvio_automatico_midia',
    referenceId: `crm-${row.id}`,
    returnDetails: true,
    ...(isAudio ? { audioMeta: { originalName: displayName } } : {}),
  }

  let promise
  if (tipo === 'voice' && provider.sendVoice) promise = provider.sendVoice(phone, mediaUrl, opts)
  else if (tipo === 'audio' && provider.sendAudio) promise = provider.sendAudio(phone, mediaUrl, opts)
  else if (tipo === 'sticker' && provider.sendSticker) promise = provider.sendSticker(phone, mediaUrl, { ...opts, stickerAuthor: 'ZapERP' })
  else if (tipo === 'imagem' && provider.sendImage) promise = provider.sendImage(phone, mediaUrl, '', opts)
  else if (tipo === 'video' && provider.sendVideo) promise = provider.sendVideo(phone, mediaUrl, '', opts)
  else if (provider.sendFile) promise = provider.sendFile(phone, mediaUrl, displayName, { ...opts, caption: '' })
  else return { ok: false, error: 'metodo_envio_indisponivel' }

  const result = await promise
  const norm = typeof result === 'boolean'
    ? { ok: result, error: null, messageId: null }
    : (result || { ok: false, error: 'resultado_provider_vazio', messageId: null })
  return {
    ok: norm.ok === true,
    messageId: norm.messageId ? String(norm.messageId).trim() : null,
    error: norm.error || null,
  }
}

async function resendOutboundMediaMessage(row, { io = null } = {}) {
  if (!isEnabled()) return { action: 'disabled' }
  if (!row?.id || !row?.company_id) return { action: 'invalid_row' }

  const tipo = String(row.tipo || '').toLowerCase().trim()
  if (!isResendableTipo(tipo)) return { action: 'skip_tipo' }

  const status = String(row.status_mensagem || row.status || '').toLowerCase()
  if (status !== 'erro') return { action: 'skip_not_erro' }

  // Já tem ID real do WhatsApp → na verdade foi entregue; só conserta o status.
  if (isRealWhatsAppId(row.whatsapp_id)) {
    await markMessage(row, 'sent', 'sent', io)
    return { action: 'already_sent' }
  }

  const filePath = resolveStoredMediaPath(row.url)
  if (!filePath) return { action: 'skip_sem_url' }
  if (!fs.existsSync(filePath)) {
    // Arquivo perdido do disco (ex.: volume efêmero recriado no deploy). Não há como reenviar;
    // para de tentar para não varrer em vão a cada ciclo.
    attemptsById.set(row.id, getMaxAttempts())
    return { action: 'skip_arquivo_ausente' }
  }

  if ((attemptsById.get(row.id) || 0) >= getMaxAttempts()) return { action: 'skip_max_attempts' }
  if (inFlight.has(row.id)) return { action: 'skip_in_flight' }

  inFlight.add(row.id)
  try {
    // Guarda anti-duplicidade: se o provedor já conhece a mensagem, não reenvia.
    const providerHit = await queryProviderForReference(row)
    if (providerHit.found) {
      const anySuccessOrQueue = providerHit.list.some((r) => PROVIDER_SUCCESS_OR_QUEUE.includes(providerRowStatus(r)))
      const anyFail = providerHit.list.some((r) => PROVIDER_FAILURE.includes(providerRowStatus(r)))
      if (anySuccessOrQueue) {
        await markMessage(row, 'pending', 'sending', io)
        schedulePendingOutboundReconciliation({ companyId: row.company_id, mensagemId: row.id, io })
        return { action: 'already_at_provider' }
      }
      if (anyFail) {
        // Provedor rejeitou explicitamente (número inválido etc.) — reenviar não resolve.
        attemptsById.set(row.id, getMaxAttempts())
        return { action: 'provider_confirmou_falha' }
      }
      // Encontrou mas ambíguo → trata como já no provedor e deixa a reconciliação decidir.
      await markMessage(row, 'pending', 'sending', io)
      schedulePendingOutboundReconciliation({ companyId: row.company_id, mensagemId: row.id, io })
      return { action: 'already_at_provider' }
    }

    const { data: conversa } = await supabase
      .from('conversas')
      .select('id, telefone, tipo, whatsapp_instance_id')
      .eq('company_id', row.company_id)
      .eq('id', row.conversa_id)
      .maybeSingle()

    const tel = String(conversa?.telefone || '').trim()
    if (!tel) return { action: 'skip_sem_conversa' }
    if (tel.toLowerCase().startsWith('lid:')) {
      attemptsById.set(row.id, getMaxAttempts())
      return { action: 'skip_telefone_invalido' }
    }

    const whatsappInstanceId = row.whatsapp_instance_id || conversa?.whatsapp_instance_id || undefined
    attemptsById.set(row.id, (attemptsById.get(row.id) || 0) + 1)

    const result = await sendStoredMediaOnce(row, tipo, tel, filePath, whatsappInstanceId)
    const ok = result.ok === true
    const traceable = isRealWhatsAppId(result.messageId)

    if (ok) {
      const nextStatus = traceable ? 'sent' : 'pending'
      const nextStatusMensagem = traceable ? 'sent' : 'sending'
      await markMessage(row, nextStatus, nextStatusMensagem, io, traceable ? { whatsapp_id: result.messageId } : {})
      attemptsById.delete(row.id)
      if (!traceable) schedulePendingOutboundReconciliation({ companyId: row.company_id, mensagemId: row.id, io })
      console.log('[outboundMediaResend] mídia reenviada com sucesso', {
        mensagem_id: row.id, company_id: row.company_id, tipo,
      })
      return { action: 'resent', status: nextStatus }
    }

    // Continua 'erro'; próximo ciclo tenta de novo até o teto de tentativas.
    await markMessage(row, 'erro', 'erro', io)
    console.warn('[outboundMediaResend] reenvio falhou', {
      mensagem_id: row.id, company_id: row.company_id, tipo, erro: result.error,
      tentativa: attemptsById.get(row.id), teto: getMaxAttempts(),
    })
    return { action: 'resend_failed', error: result.error }
  } finally {
    inFlight.delete(row.id)
  }
}

async function fetchResendableRows({ companyId = null, mensagemId = null, limit = null } = {}) {
  let query = supabase
    .from('mensagens')
    .select('id, company_id, conversa_id, whatsapp_instance_id, whatsapp_id, provider_queue_id, status, status_mensagem, direcao, tipo, url, nome_arquivo, criado_em, autor_usuario_id')
    .eq('direcao', 'out')
    .eq('status', 'erro')
    .in('tipo', RESENDABLE_TIPOS)
    .not('url', 'is', null)
    .order('criado_em', { ascending: true })
    .limit(limit || getBatchLimit())

  if (companyId != null) query = query.eq('company_id', Number(companyId))
  if (mensagemId != null) {
    // Reenvio direcionado (agendamento imediato): sem janela de tempo.
    query = query.eq('id', Number(mensagemId))
  } else {
    // Varredura: só falhas recentes, com uma pequena carência para não correr com o envio original.
    const oldestIso = new Date(Date.now() - getLookbackMs()).toISOString()
    const graceIso = new Date(Date.now() - getMinAgeMs()).toISOString()
    query = query.gte('criado_em', oldestIso).lte('criado_em', graceIso)
  }

  const { data, error } = await query
  if (error) return { ok: false, rows: [], error: error.message }
  return { ok: true, rows: data || [] }
}

async function runOutboundMediaResendSweep({ io = null, companyId = null, mensagemId = null } = {}) {
  if (!isEnabled()) return { ok: true, skipped: true, reason: 'disabled' }

  const { ok, rows, error } = await fetchResendableRows({ companyId, mensagemId })
  if (!ok) return { ok: false, error }

  const summary = { ok: true, scanned: rows.length, resent: 0, failed: 0, skipped: 0, actions: {} }

  // Sequencial: preserva a ordem de entrega (rows já vêm por criado_em asc) e evita rajada de uploads.
  for (const row of rows) {
    try {
      const result = await resendOutboundMediaMessage(row, { io })
      const action = result.action || 'ok'
      summary.actions[action] = (summary.actions[action] || 0) + 1
      if (action === 'resent') summary.resent += 1
      else if (action === 'resend_failed') summary.failed += 1
      else summary.skipped += 1
    } catch (e) {
      summary.failed += 1
      summary.actions.error = (summary.actions.error || 0) + 1
      console.warn('[outboundMediaResend] erro em mensagem', {
        mensagem_id: row.id, company_id: row.company_id, error: e?.message || e,
      })
    }
  }

  if (summary.resent > 0 || summary.failed > 0) {
    console.log('[outboundMediaResend] ciclo concluído', summary)
  }
  return summary
}

// Agenda um reenvio imediato (poucos segundos) logo após uma falha de envio — recuperação rápida
// sem esperar a varredura periódica, e sem depender do navegador do atendente.
function scheduleOutboundMediaResend({ companyId, mensagemId, io = null, delayMs = null } = {}) {
  if (!isEnabled()) return
  const cid = Number(companyId)
  const mid = Number(mensagemId)
  if (!Number.isFinite(cid) || !Number.isFinite(mid) || mid <= 0) return

  const key = `${cid}:${mid}`
  if (deferredTimers.has(key)) return

  const delay = Number.isFinite(Number(delayMs))
    ? Math.max(5_000, Math.min(120_000, Number(delayMs)))
    : getDeferMs()

  const timer = setTimeout(() => {
    deferredTimers.delete(key)
    runOutboundMediaResendSweep({ io, companyId: cid, mensagemId: mid }).catch((e) => {
      console.warn('[outboundMediaResend] reenvio imediato falhou', {
        company_id: cid, mensagem_id: mid, error: e?.message || e,
      })
    })
  }, delay)

  if (typeof timer.unref === 'function') timer.unref()
  deferredTimers.set(key, timer)
}

module.exports = {
  runOutboundMediaResendSweep,
  resendOutboundMediaMessage,
  scheduleOutboundMediaResend,
  RESENDABLE_TIPOS,
  _test: {
    isEnabled,
    isResendableTipo,
    resolveStoredMediaPath,
    parseIntEnv,
    getMaxAttempts,
    getLookbackMs,
    getMinAgeMs,
    _state: { attemptsById, inFlight, deferredTimers },
  },
}
