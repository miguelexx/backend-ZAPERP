/**
 * Helpers centrais para Nota Interna.
 * Nota interna nunca vai ao WhatsApp — isolada por tipo, direcao e status.
 */

const INTERNAL_NOTE_TIPO = 'internal_note'
const INTERNAL_NOTE_DIRECAO = 'interna'
const INTERNAL_NOTE_STATUS = 'interna'
const INTERNAL_NOTE_PERMISSAO = 'atendimentos.nota_interna'
const INTERNAL_NOTE_MAX_LEN = 4000

/** Todas as direções de mensagens reais (excluem notas internas). */
const REAL_MESSAGE_DIRECOES = ['in', 'out']

/**
 * Retorna true se a linha/objeto é uma nota interna.
 * Aceita row do banco OU objeto enriquecido do frontend.
 */
function isInternalNoteRow(row) {
  if (!row || typeof row !== 'object') return false
  return (
    String(row.tipo || '').toLowerCase() === INTERNAL_NOTE_TIPO ||
    String(row.direcao || '').toLowerCase() === INTERNAL_NOTE_DIRECAO ||
    String(row.status || '').toLowerCase() === INTERNAL_NOTE_STATUS
  )
}

/**
 * Lança erro se o payload for uma nota interna tentando ir ao provedor.
 * Chamado no início de ultramsg.post() como última barreira.
 */
function assertNotInternalNote(payload, contexto) {
  if (!payload || typeof payload !== 'object') return
  if (isInternalNoteRow(payload)) {
    const err = new Error(`[INTERNAL_NOTE_BLOCKED] Nota interna bloqueada de ir ao WhatsApp (${contexto || 'provider'})`)
    err.code = 'INTERNAL_NOTE_BLOCKED'
    throw err
  }
}

/**
 * Valida e sanitiza o texto de uma nota interna.
 * Remove caracteres de controle invisíveis, limita a INTERNAL_NOTE_MAX_LEN.
 * Retorna string limpa ou lança erro.
 */
function sanitizeInternalNoteTexto(raw) {
  if (raw == null) throw new Error('Texto da nota é obrigatório')
  const str = String(raw)

  // Remove caracteres de controle invisíveis (U+0000–U+001F exceto tab/lf/cr)
  let cleaned = ''
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue
    cleaned += str[i]
  }

  const trimmed = cleaned.trim()
  if (!trimmed) throw new Error('O texto da nota não pode ser vazio')
  if (trimmed.length > INTERNAL_NOTE_MAX_LEN) {
    throw new Error(`Nota interna limitada a ${INTERNAL_NOTE_MAX_LEN} caracteres`)
  }
  return trimmed
}

/**
 * Monta o payload de INSERT para nota interna.
 * Usa apenas colunas essenciais (NOT NULL + identificadores da nota) para máxima compatibilidade.
 * Campos opcionais (url, nome_arquivo, etc.) ficam com DEFAULT do banco.
 */
function buildInternalNoteInsert({ company_id, conversa_id, autor_usuario_id, texto }) {
  return {
    company_id: Number(company_id),
    conversa_id: Number(conversa_id),
    autor_usuario_id: Number(autor_usuario_id),
    texto: texto,
    tipo: INTERNAL_NOTE_TIPO,   // 'internal_note' — identificador primário
    direcao: INTERNAL_NOTE_DIRECAO, // 'interna' — exclui de queries in/out
  }
}

module.exports = {
  INTERNAL_NOTE_TIPO,
  INTERNAL_NOTE_DIRECAO,
  INTERNAL_NOTE_STATUS,
  INTERNAL_NOTE_PERMISSAO,
  INTERNAL_NOTE_MAX_LEN,
  REAL_MESSAGE_DIRECOES,
  isInternalNoteRow,
  assertNotInternalNote,
  sanitizeInternalNoteTexto,
  buildInternalNoteInsert,
}
