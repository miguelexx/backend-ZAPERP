/**
 * Reconciliacao de eco "fromMe" (celular/CRM) com o outbound ja persistido, e matching de midia.
 * Extraido de controllers/webhookZapiController.js (Fase 2 - doc 24) sem alteracao de comportamento.
 */

const supabase = require('../../config/supabase')
const { possiblePhonesBR } = require('../../helpers/phoneHelper')
const {
  isUltramsgNumericQueueId,
  parseCrmReferenceMensagemId,
  isReconcilablePendingWhatsappId,
  areEquivalentWhatsAppIds,
  extractPhoneDigitsFromWhatsappMessageId,
} = require('../../helpers/whatsappMessageIdHelper')
const { normalizeRawAckStatus, statusRank } = require('../../helpers/messageStatusHelper')
const { applyWhatsappInstanceFilterOrLegacy, isLocalUploadMediaUrl } = require('./whatsappIdLookup')

const WEBHOOK_MSG_SELECT = 'id, conversa_id, company_id, whatsapp_instance_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'
const WHATSAPP_DEBUG = String(process.env.WHATSAPP_DEBUG || '').toLowerCase() === 'true'

function normalizeMediaFileNameForMatch(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function normalizeMediaBaseNameForMatch(name) {
  const clean = normalizeMediaFileNameForMatch(name).split(/[?#]/)[0].split(/[\\/]/).pop() || ''
  return clean.replace(/\.[a-z0-9]{2,5}$/i, '')
}

function mediaFamilyForStorageTipo(tipo) {
  const t = String(tipo || '').toLowerCase().trim()
  if (t === 'text' || t === 'texto' || t === 'chat') return 'texto'
  if (t === 'audio' || t === 'voice' || t === 'ptt') return 'audio'
  // Figurinha e imagem compartilham família na reconciliação fromMe (webp pode vir como image no webhook).
  if (t === 'image' || t === 'imagem' || t === 'sticker') return 'imagem'
  if (t === 'video' || t === 'vídeo') return 'video'
  if (t === 'document' || t === 'file' || t === 'arquivo' || t === 'documento') return 'arquivo'
  return t || ''
}

function whatsappIdCompativelParaReconcile(row, whatsappId) {
  const atual = row?.whatsapp_id != null ? String(row.whatsapp_id).trim() : ''
  const alvo = whatsappId != null ? String(whatsappId).trim() : ''
  if (!atual || !alvo) return true
  if (atual === alvo) return true
  // Mesmo envio UltraMSG em formatos diferentes (sid hex vs false_jid@c.us_sid).
  if (areEquivalentWhatsAppIds(atual, alvo)) return true
  // CRM pode ter guardado id de fila UltraMSG (ex: 35096); webhook traz id real do WhatsApp.
  if (isUltramsgNumericQueueId(atual) && !isUltramsgNumericQueueId(alvo)) return true
  return false
}

function filterRowsForFromMeReconcile(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => isReconcilablePendingWhatsappId(r?.whatsapp_id))
}

/**
 * ACK wamid (`true_5534…@c.us_…`) quando há vários outbound pendentes na empresa
 * (campanha). Casa só a conversa daquele telefone — um pendente por contato é seguro.
 */
async function findPendingOutboundByAckPhone({
  company_id,
  whatsapp_instance_id,
  ackId,
  fromIso,
  select,
}) {
  const digits = extractPhoneDigitsFromWhatsappMessageId(ackId)
  if (!digits || !company_id || !fromIso) return null
  const phones = Array.from(new Set(
    [digits, ...(possiblePhonesBR(digits) || [])]
      .map((p) => String(p || '').replace(/\D/g, ''))
      .filter((p) => p.length >= 10),
  ))
  if (!phones.length) return null

  let convQuery = supabase
    .from('conversas')
    .select('id')
    .eq('company_id', company_id)
    .in('telefone', phones)
    .limit(8)
  convQuery = applyWhatsappInstanceFilterOrLegacy(convQuery, whatsapp_instance_id)
  const { data: convs, error: convErr } = await convQuery
  if (convErr) throw convErr
  const convIds = [...new Set((convs || []).map((c) => c.id).filter(Boolean))]
  if (!convIds.length) return null

  let msgQuery = supabase
    .from('mensagens')
    .select(select)
    .eq('company_id', company_id)
    .eq('direcao', 'out')
    .in('conversa_id', convIds)
    .gte('criado_em', fromIso)
    .order('criado_em', { ascending: false })
    .order('id', { ascending: false })
    .limit(5)
  msgQuery = applyWhatsappInstanceFilterOrLegacy(msgQuery, whatsapp_instance_id)
  const { data: rows, error: msgErr } = await msgQuery
  if (msgErr) throw msgErr
  const pending = filterRowsForFromMeReconcile(rows)
  if (pending.length !== 1) return null
  return pending[0]
}

function getCrmReferenceIdFromPayload(payload) {
  return payload?.ultramsgReferenceId ?? payload?.referenceId ?? null
}

async function tryReconcileFromMeByCrmReferenceId(supabase, {
  company_id,
  conversa_id,
  whatsapp_instance_id,
  payload,
  whatsappIdStr,
  statusPayload = null,
}) {
  const crmMsgId = parseCrmReferenceMensagemId(getCrmReferenceIdFromPayload(payload))
  if (!crmMsgId || !whatsappIdStr) return null
  try {
    // company_id + id (chave primaria) ja identifica a mensagem sem ambiguidade.
    // Filtrar por instancia aqui so produz falso negativo quando um dos lados esta null,
    // e o eco cai na heuristica por conteudo, criando linha duplicada.
    const q = supabase
      .from('mensagens')
      .select(WEBHOOK_MSG_SELECT)
      .eq('company_id', company_id)
      .eq('id', crmMsgId)
      .eq('direcao', 'out')
    const { data: row } = await q.maybeSingle()
    if (!row?.id) return null
    // Divergencia real de instancia (ambos conhecidos) segue bloqueada: nao misturar instancias.
    if (
      whatsapp_instance_id &&
      row.whatsapp_instance_id &&
      Number(row.whatsapp_instance_id) !== Number(whatsapp_instance_id)
    ) {
      return null
    }

    const idsCompat = whatsappIdCompativelParaReconcile(row, whatsappIdStr)
    const updates = {}
    // referenceId crm-{id} e identidade forte: absorve o eco sem INSERT.
    // So promove whatsapp_id quando e promocao segura (null/fila→real ou formatos equivalentes).
    // IDs reais genuinamente distintos: nao sobrescreve o canonico (ACK/delete/reacao).
    if (idsCompat) {
      updates.whatsapp_id = whatsappIdStr
    } else {
      console.warn('[Z-API] fromMe reconcile referenceId: IDs divergentes, absorvendo eco sem overwrite', {
        mensagem_id: row.id,
        referenceId: getCrmReferenceIdFromPayload(payload),
        whatsapp_id_atual: String(row.whatsapp_id || '').slice(0, 40),
        whatsapp_id_webhook: String(whatsappIdStr).slice(0, 40),
      })
    }

    const ackStatus = normalizeRawAckStatus(statusPayload ?? payload?.status ?? payload?.ack)
    if (ackStatus && statusRank(ackStatus) >= statusRank(row.status || row.status_mensagem || 'pending')) {
      updates.status = ackStatus
      updates.status_mensagem = ackStatus
    }

    if (Object.keys(updates).length === 0) {
      return row
    }

    const { data: updated } = await supabase
      .from('mensagens')
      .update(updates)
      .eq('company_id', company_id)
      .eq('id', row.id)
      .select(WEBHOOK_MSG_SELECT)
      .maybeSingle()
    if (WHATSAPP_DEBUG && (updated || row)) {
      console.log('[Z-API] fromMe reconcile via referenceId crm:', {
        mensagem_id: row.id,
        referenceId: getCrmReferenceIdFromPayload(payload),
        whatsapp_id: String(whatsappIdStr).slice(0, 24),
        ids_compat: idsCompat,
      })
    }
    return updated || row
  } catch (e) {
    console.warn('[Z-API] fromMe reconcile referenceId:', e?.message || e)
    return null
  }
}

function mapWebhookTypeToStorageTipo(type) {
  const t = String(type || '').toLowerCase().trim()
  if (t === 'text' || t === 'chat') return 'texto'
  if (t === 'ptt') return 'voice'
  if (t === 'document' || t === 'file') return 'arquivo'
  if (t === 'image') return 'imagem'
  if (t === 'video') return 'video'
  if (t === 'audio') return 'audio'
  if (t === 'sticker') return 'sticker'
  return t || null
}

/**
 * Casa eco fromMe (webhook) com mensagem outbound recente do CRM.
 * Não usa URL remota vs /uploads/ — evita segunda linha no chat ao enviar PDF/arquivo.
 */
const {
  textosOutboundFromMeEquivalentes,
  extrairNomePrefixoTexto,
} = require('../../helpers/mensagemAtendenteNomeHelper')

function findFromMeOutboundMediaCandidate(rows, { fileName, texto, tipo, nomeAtendente, whatsappId }) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const nomeW = normalizeMediaFileNameForMatch(fileName)
  const nomeBaseW = normalizeMediaBaseNameForMatch(fileName)
  const tipoW = tipo ? String(tipo).toLowerCase() : null
  const familiaW = mediaFamilyForStorageTipo(tipoW)
  const candidates = rows.filter((c) => whatsappIdCompativelParaReconcile(c, whatsappId))
  if (candidates.length === 0) return null

  if (nomeW) {
    const byNome = candidates.find((c) => {
      const candNome = normalizeMediaFileNameForMatch(c.nome_arquivo || c.texto)
      const candBase = normalizeMediaBaseNameForMatch(c.nome_arquivo || c.texto)
      if (!candNome || (candNome !== nomeW && candBase !== nomeBaseW)) return false
      if (familiaW && mediaFamilyForStorageTipo(c.tipo) !== familiaW) return false
      return true
    })
    if (byNome) return byNome
  }

  if (texto) {
    const textoNorm = String(texto || '').trim()
    const byTexto = candidates.find((c) => {
      const t = String(c.texto || '').trim()
      if (!t) return false
      if (familiaW && mediaFamilyForStorageTipo(c.tipo) !== familiaW) return false
      if (textosOutboundFromMeEquivalentes(textoNorm, t, nomeAtendente)) return true
      return false
    })
    if (byTexto) return byTexto
  }

  if (familiaW) {
    const byTipoCrm = candidates.find(
      (c) =>
        mediaFamilyForStorageTipo(c.tipo) === familiaW &&
        (c.autor_usuario_id != null || isLocalUploadMediaUrl(c.url))
    )
    if (byTipoCrm) return byTipoCrm
  }

  return null
}

module.exports = {
  normalizeMediaFileNameForMatch,
  normalizeMediaBaseNameForMatch,
  mediaFamilyForStorageTipo,
  whatsappIdCompativelParaReconcile,
  filterRowsForFromMeReconcile,
  findPendingOutboundByAckPhone,
  getCrmReferenceIdFromPayload,
  tryReconcileFromMeByCrmReferenceId,
  mapWebhookTypeToStorageTipo,
  findFromMeOutboundMediaCandidate,
}
