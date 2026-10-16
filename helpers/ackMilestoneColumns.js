'use strict'

/**
 * Disponibilidade das colunas `entregue_em` / `lida_em` (F9 do doc 33) — fonte ÚNICA.
 *
 * Migration: `supabase/migrations/20261016120000_mensagens_entregue_lida_em.sql`.
 *
 * Por que isto existe em vez de simplesmente pedir as colunas: enquanto a migration não está
 * aplicada, QUALQUER `select` que as inclua falha inteiro. Nos selects grandes de mensagens o
 * preço disso é brutal — a consulta cai no fallback mínimo e a tela perde citação
 * (`reply_meta`), cartão de contato, localização, avisos de apagada, duração de áudio e
 * `client_temp_id` (que reconcilia a bolha otimista; sem ele, bolha duplicada). Ou seja: pedir a
 * coluna nova antes da hora degradaria coisa que já funcionava.
 *
 * Aqui a ausência é descoberta UMA vez por processo e lembrada: a primeira consulta falha, o
 * código refaz sem as colunas novas (mantendo todo o resto) e, das próximas em diante, nem pede.
 * Depois da migration aplicada + restart, volta a pedir normalmente.
 */

let _disponiveis = true

/** Acrescenta as colunas de marco ao select, enquanto elas existirem no banco. */
function selectComMarcos(selectBase) {
  const base = String(selectBase || '').trim()
  if (!_disponiveis || !base) return base
  return `${base}, entregue_em, lida_em`
}

/** O erro é "essa coluna não existe" para `entregue_em`/`lida_em`? */
function erroDeMarcoAusente(error) {
  const msg = String(error?.message || '')
  if (!/entregue_em|lida_em/.test(msg)) return false
  return /does not exist|could not find|unknown column|schema cache/i.test(msg)
}

/** Marca como ausentes (1 aviso por processo) para ninguém mais pedir até o restart. */
function desligarMarcos() {
  if (!_disponiveis) return
  _disponiveis = false
  console.warn(
    '[mensagens] colunas entregue_em/lida_em ausentes — rode a migration ' +
    '20261016120000_mensagens_entregue_lida_em.sql. Nada mais é afetado: status e tiques seguem normais, ' +
    'só o horário de entrega/leitura não aparece.'
  )
}

function marcosDisponiveis() {
  return _disponiveis
}

module.exports = {
  selectComMarcos,
  erroDeMarcoAusente,
  desligarMarcos,
  marcosDisponiveis,
  _test: { religar: () => { _disponiveis = true } },
}
