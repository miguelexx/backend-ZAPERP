/**
 * Regras puras de edição de mensagem (texto e legenda de mídia).
 * WhatsApp: janela ~15 min; só outbound; mídia = caption, não troca o arquivo.
 */

const { MAX_MEDIA_CAPTION_CHARS } = require('./midiaMensagemHelper')

const EDIT_WINDOW_MS = 15 * 60 * 1000
const TEXT_MAX_LEN = 4096

const TEXT_TIPOS = new Set(['texto', 'text', 'chat'])
const CAPTION_TIPOS = new Set(['imagem', 'image', 'video', 'vídeo', 'arquivo', 'document', 'documento', 'file'])

function normalizeTipoMensagem(tipo) {
  return String(tipo || 'texto').trim().toLowerCase()
}

function isTextEditTipo(tipo) {
  return TEXT_TIPOS.has(normalizeTipoMensagem(tipo))
}

function isMediaCaptionTipo(tipo) {
  return CAPTION_TIPOS.has(normalizeTipoMensagem(tipo))
}

function isEditableMessageTipo(tipo) {
  return isTextEditTipo(tipo) || isMediaCaptionTipo(tipo)
}

function maxLenForTipo(tipo) {
  return isMediaCaptionTipo(tipo) ? MAX_MEDIA_CAPTION_CHARS : TEXT_MAX_LEN
}

function pickEditTextoFromBody(body) {
  if (!body || typeof body !== 'object') return { present: false, raw: '' }
  for (const key of ['texto', 'conteudo', 'caption', 'legenda', 'body']) {
    if (Object.prototype.hasOwnProperty.call(body, key) && body[key] != null) {
      return { present: true, raw: String(body[key]) }
    }
  }
  return { present: false, raw: '' }
}

/**
 * Normaliza o texto/legenda enviado pelo cliente.
 * Texto: obrigatório após trim. Legenda de mídia: pode ficar vazia (remove caption).
 */
function normalizeEditTexto(raw, tipo) {
  const max = maxLenForTipo(tipo)
  const trimmed = String(raw ?? '').trim()
  if (trimmed.length > max) {
    return { ok: false, error: `Texto excede ${max} caracteres.`, code: 'EDIT_TOO_LONG' }
  }
  if (!trimmed && isTextEditTipo(tipo)) {
    return { ok: false, error: 'texto é obrigatório', code: 'EDIT_EMPTY_TEXT' }
  }
  if (!isEditableMessageTipo(tipo)) {
    return { ok: false, error: 'Este tipo de mensagem não pode ser editado.', code: 'EDIT_TYPE_UNSUPPORTED' }
  }
  return { ok: true, texto: trimmed }
}

function parseCriadoEmMs(criadoEm, nowMs = Date.now()) {
  if (criadoEm == null || criadoEm === '') return NaN
  if (criadoEm instanceof Date) {
    const t = criadoEm.getTime()
    return Number.isFinite(t) ? t : NaN
  }
  const s = String(criadoEm).trim()
  const asNum = Number(s)
  if (Number.isFinite(asNum) && asNum > 1e11) return asNum
  if (Number.isFinite(asNum) && asNum > 1e9 && asNum < 1e11) return asNum * 1000
  const parsed = Date.parse(s)
  if (Number.isFinite(parsed)) return parsed
  return Number.isFinite(nowMs) ? nowMs : Date.now()
}

function remainingEditWindowMs(criadoEm, nowMs = Date.now()) {
  const created = parseCriadoEmMs(criadoEm, nowMs)
  if (!Number.isFinite(created)) return 0
  return EDIT_WINDOW_MS - (nowMs - created)
}

function isEditWindowOpen(criadoEm, nowMs = Date.now()) {
  return remainingEditWindowMs(criadoEm, nowMs) > 0
}

function buildEditadaDbUpdates(texto, at = new Date()) {
  const iso = at instanceof Date ? at.toISOString() : String(at)
  return {
    texto,
    editada: true,
    editada_em: iso,
  }
}

function isMissingEditadaColumnError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return msg.includes('editada')
}

function aplicarCamposEdicaoNaMensagem(m) {
  if (!m || typeof m !== 'object') return m
  const editada = m.editada === true || m.editado === true
  return {
    ...m,
    editada,
    editado: editada,
    editada_em: m.editada_em || null,
  }
}

function buildMensagemEditadaSocketPayload({
  id,
  conversa_id,
  company_id,
  texto,
  editada_em = null,
  tipo = null,
  ultima_mensagem = null,
}) {
  const payload = {
    id: Number(id),
    conversa_id: Number(conversa_id),
    texto,
    conteudo: texto,
    editada: true,
    editado: true,
    editada_em,
  }
  if (company_id != null) payload.company_id = Number(company_id)
  if (tipo != null) payload.tipo = tipo
  if (ultima_mensagem) payload.ultima_mensagem = ultima_mensagem
  return payload
}

module.exports = {
  EDIT_WINDOW_MS,
  TEXT_MAX_LEN,
  isTextEditTipo,
  isMediaCaptionTipo,
  isEditableMessageTipo,
  maxLenForTipo,
  pickEditTextoFromBody,
  normalizeEditTexto,
  remainingEditWindowMs,
  isEditWindowOpen,
  buildEditadaDbUpdates,
  isMissingEditadaColumnError,
  aplicarCamposEdicaoNaMensagem,
  buildMensagemEditadaSocketPayload,
}
