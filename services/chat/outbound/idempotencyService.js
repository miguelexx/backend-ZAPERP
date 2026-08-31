/**
 * Idempotência de envio por client_temp_id: mapa de deduplicação em memória (com TTL/limpeza),
 * consulta persistente (findMensagemByClientTempId) e flags-latch de indisponibilidade de coluna.
 *
 * Extraído de controllers/chatController.js (Fase 2 da modularização) sem alteração de comportamento.
 * Estado local ao processo (não distribuído), como no original. As flags são expostas por
 * getter/setter porque em CommonJS uma reatribuição de binding importado não se propaga entre módulos.
 */

const supabase = require('../../../config/supabase')
const { isMissingMensagemColumnError, isGenericMissingColumnError } = require('./idempotencyHelpers')

/**
 * Deduplicação in-memory para double-send de texto.
 * Chave: `${company_id}:${conversa_id}:${client_temp_id}` → { id, status, ts }
 * TTL: 30s. Limpo a cada 5 min para evitar memory leak.
 */
const deduplicationMap = new Map()
setInterval(() => {
  const cutoff = Date.now() - 30_000
  for (const [key, val] of deduplicationMap.entries()) {
    if (val.ts < cutoff) deduplicationMap.delete(key)
  }
}, 5 * 60 * 1000).unref()

let _dbDedupeUnavailable = false
let _audioDuracaoSecColumnUnavailable = false

function isDbDedupeUnavailable() { return _dbDedupeUnavailable }
function markDbDedupeUnavailable() { _dbDedupeUnavailable = true }
function isAudioDuracaoSecColumnUnavailable() { return _audioDuracaoSecColumnUnavailable }
function markAudioDuracaoSecColumnUnavailable() { _audioDuracaoSecColumnUnavailable = true }

async function findMensagemByClientTempId(company_id, conversa_id, clientTempId, select = 'id, conversa_id, status, status_mensagem, whatsapp_id, client_temp_id') {
  if (!clientTempId || _dbDedupeUnavailable) return null
  try {
    const { data, error } = await supabase
      .from('mensagens')
      .select(select)
      .eq('company_id', company_id)
      .eq('conversa_id', Number(conversa_id))
      .eq('client_temp_id', clientTempId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      if (isMissingMensagemColumnError(error, 'client_temp_id') || isGenericMissingColumnError(error)) {
        _dbDedupeUnavailable = true
        return null
      }
      console.warn('[client_temp_id] falha ao consultar dedupe persistente:', error?.message || error)
      return null
    }
    return data || null
  } catch (error) {
    if (isMissingMensagemColumnError(error, 'client_temp_id') || isGenericMissingColumnError(error)) {
      _dbDedupeUnavailable = true
      return null
    }
    console.warn('[client_temp_id] excecao ao consultar dedupe persistente:', error?.message || error)
    return null
  }
}

module.exports = {
  deduplicationMap,
  findMensagemByClientTempId,
  isDbDedupeUnavailable,
  markDbDedupeUnavailable,
  isAudioDuracaoSecColumnUnavailable,
  markAudioDuracaoSecColumnUnavailable,
}
