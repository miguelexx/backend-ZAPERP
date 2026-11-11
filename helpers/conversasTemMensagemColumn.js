'use strict'

/**
 * Disponibilidade da coluna `conversas.tem_mensagem` (doc 40 §3.3) — fonte ÚNICA.
 *
 * Migration: `supabase/migrations/20261111135500_conversas_tem_mensagem.sql`.
 *
 * Por que isto existe: a coluna denormaliza "a conversa tem mensagem?" e deixa os contadores
 * de "Abertas" / "Minha fila" / "Em atendimento" serem um `count(*)` exato, sem o embed
 * `mensagens(id)` e sem o teto de CHAT_FILTER_ID_LIMIT. Enquanto a migration não está
 * aplicada, a primeira consulta que filtra por ela falha (42703) — e, se insistíssemos, TODO
 * contador dessas abas falharia a cada chamada. Então a ausência é descoberta UMA vez por
 * processo e lembrada: a chamada que falhou refaz pelo caminho antigo (varredura com embed) e,
 * das próximas em diante, nem tenta. Depois da migration aplicada + restart, volta a usar.
 *
 * Mesmo padrão de `helpers/ackMilestoneColumns.js`.
 */

const COLUNA = 'tem_mensagem'
const MIGRATION = '20261111135500_conversas_tem_mensagem.sql'

let _disponivel = true

/** A coluna ainda é considerada presente neste processo? */
function temMensagemDisponivel() {
  return _disponivel
}

/** O erro é "a coluna tem_mensagem não existe" (Postgres 42703 ou cache de schema do PostgREST)? */
function erroDeTemMensagemAusente(error) {
  const msg = String(error?.message || error || '')
  if (!msg.toLowerCase().includes(COLUNA)) return false
  if (String(error?.code || '') === '42703') return true
  return /does not exist|could not find|unknown column|schema cache/i.test(msg)
}

/** Marca como ausente (1 aviso por processo) para ninguém mais filtrar por ela até o restart. */
function desligarTemMensagem() {
  if (!_disponivel) return
  _disponivel = false
  console.warn(
    `[conversas] coluna ${COLUNA} ausente — rode a migration ${MIGRATION} (coluna + backfill + ` +
    'trigger) e reinicie. Até lá os contadores de Abertas/Minha fila/Em atendimento seguem pelo ' +
    'caminho antigo: varredura com embed e teto de CHAT_FILTER_ID_LIMIT.'
  )
}

module.exports = {
  temMensagemDisponivel,
  erroDeTemMensagemAusente,
  desligarTemMensagem,
  _test: { religar: () => { _disponivel = true } },
}
