/**
 * Nota interna ("mensagem invisível"): registro que vive na linha do tempo da conversa
 * mas NUNCA sai para o WhatsApp / UltraMsg / qualquer integração externa.
 *
 * A identificação é explícita e redundante de propósito:
 *  - `tipo = 'internal_note'`   → identifica a linha;
 *  - `direcao = 'interna'`      → mantém a nota fora de TODA query existente que filtra
 *                                 `direcao in ('in','out')` ou `direcao = 'out'`
 *                                 (fila/outbox, retry, SLA, limites, métricas, protecoes);
 *  - `status = 'interna'`       → nunca 'pending'/'sending'/'sent'/'erro', logo nunca é
 *                                 recolhida por reconciliação de pendentes nem por reenvio.
 *
 * Nenhuma dessas colunas é reaproveitada de forma improvisada: a migration
 * 20260728120000_mensagens_nota_interna.sql adiciona um CHECK que amarra as três
 * entre si e proíbe whatsapp_id/provider_queue_id em nota interna.
 */

const INTERNAL_NOTE_TIPO = 'internal_note'
const INTERNAL_NOTE_DIRECAO = 'interna'
const INTERNAL_NOTE_STATUS = 'interna'

/** Direções de mensagem "real" (cliente ↔ WhatsApp). Nota interna fica fora por definição. */
const REAL_MESSAGE_DIRECOES = ['in', 'out']

/** Limite de caracteres (code points, então emoji conta como 1). */
const INTERNAL_NOTE_MAX_LEN = 4000

/** Permissão do catálogo central (helpers/permissoesCatalogo.js). */
const INTERNAL_NOTE_PERMISSAO = 'atendimentos.nota_interna'

/** Verdadeiro para qualquer linha/payload que represente uma nota interna. */
function isInternalNoteRow(row) {
  if (!row || typeof row !== 'object') return false
  if (String(row.tipo || '').toLowerCase() === INTERNAL_NOTE_TIPO) return true
  return String(row.direcao || '').toLowerCase() === INTERNAL_NOTE_DIRECAO
}

/**
 * Igual a isInternalNoteRow, mas também reconhece os aliases usados por payloads de
 * envio (meta do provider: `type`, `origin`/`sendOrigin`). Usado só nas barreiras.
 */
function payloadPareceNotaInterna(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (isInternalNoteRow(payload)) return true
  const alias = [payload.type, payload.origin, payload.sendOrigin, payload.send_origin]
  return alias.some((v) => String(v || '').toLowerCase() === INTERNAL_NOTE_TIPO)
}

/**
 * Barreira de último nível: lança se uma nota interna chegar a um caminho de envio externo.
 * Usada em pontos onde o custo de um vazamento é alto (provider, reenvio, reconciliação).
 */
function assertNotInternalNote(payload, contexto = 'envio_externo') {
  if (!payloadPareceNotaInterna(payload)) return
  const err = new Error(`Nota interna bloqueada em caminho de envio externo (${contexto})`)
  err.code = 'INTERNAL_NOTE_BLOCKED'
  err.contexto = contexto
  throw err
}

/** Caractere de controle sem representação na UI. Quebra de linha e tab são preservados; CR é descartado. */
function isCaractereDeControleInvisivel(code) {
  if (code === 0x0a || code === 0x09) return false
  return code < 0x20 || code === 0x7f
}

/**
 * Normaliza e valida o conteúdo. Preserva emojis e acentuação; remove apenas caracteres
 * de controle (exceto quebra de linha e tab) que não têm representação na UI.
 */
function sanitizeInternalNoteTexto(raw) {
  if (raw == null) return { ok: false, error: 'conteudo_vazio' }
  if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, error: 'conteudo_invalido' }

  let semControle = ''
  for (const ch of String(raw)) {
    if (ch.length === 1 && isCaractereDeControleInvisivel(ch.charCodeAt(0))) continue
    semControle += ch
  }
  const texto = semControle.trim()

  if (!texto) return { ok: false, error: 'conteudo_vazio' }
  if (Array.from(texto).length > INTERNAL_NOTE_MAX_LEN) {
    return { ok: false, error: 'conteudo_muito_longo', max: INTERNAL_NOTE_MAX_LEN }
  }
  return { ok: true, texto }
}

/**
 * Payload de INSERT em `mensagens`. Só campos internos: sem url, sem whatsapp_id,
 * sem whatsapp_instance_id, sem client_temp_id — nada que ligue a nota a um envio.
 */
function buildInternalNoteInsert({ company_id, conversa_id, autor_usuario_id, texto, criado_em = null }) {
  return {
    company_id: Number(company_id),
    conversa_id: Number(conversa_id),
    autor_usuario_id: Number(autor_usuario_id),
    texto: String(texto),
    tipo: INTERNAL_NOTE_TIPO,
    direcao: INTERNAL_NOTE_DIRECAO,
    status: INTERNAL_NOTE_STATUS,
    status_mensagem: INTERNAL_NOTE_STATUS,
    whatsapp_id: null,
    criado_em: criado_em || new Date().toISOString(),
  }
}

module.exports = {
  INTERNAL_NOTE_TIPO,
  INTERNAL_NOTE_DIRECAO,
  INTERNAL_NOTE_STATUS,
  INTERNAL_NOTE_MAX_LEN,
  INTERNAL_NOTE_PERMISSAO,
  REAL_MESSAGE_DIRECOES,
  isInternalNoteRow,
  payloadPareceNotaInterna,
  assertNotInternalNote,
  sanitizeInternalNoteTexto,
  buildInternalNoteInsert,
}
