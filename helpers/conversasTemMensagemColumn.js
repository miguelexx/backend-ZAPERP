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
 * DUAS condições, não uma (lição de 11/11/2026, doc 41): a coluna EXISTIR não basta — se o
 * backfill (passo A2 da migration) não terminou, `tem_mensagem = false` em conversas que TÊM
 * mensagem faz o contador sair MENOR que o real, em silêncio. Por isso `temMensagemPronta()`
 * confere, uma vez por processo, se ainda há conversa com mensagem e flag `false`; enquanto
 * houver, fica no caminho antigo, avisa 1× e reconfere a cada CONVERSAS_TEM_MENSAGEM_RECHECK_MS.
 * Quando confirma que zerou, lembra para sempre (o trigger garante que não regride).
 *
 * A sonda do backfill é uma leitura de ESTADO DO SCHEMA (existe alguma linha inconsistente?),
 * não de dados de uma empresa — devolve só um `id` e nunca sai para o cliente; por isso é a
 * única leitura deste módulo sem `company_id`.
 *
 * Mesmo padrão de `helpers/ackMilestoneColumns.js`.
 */

const COLUNA = 'tem_mensagem'
const MIGRATION = '20261111135500_conversas_tem_mensagem.sql'
const RECHECK_MS_DEFAULT = 10 * 60_000

let _disponivel = true
/** `true` = backfill confirmado concluído (nunca regride); `null` = ainda não conferido. */
let _backfillOk = null
let _backfillRecheckAt = 0
let _backfillAvisou = false
let _sondaEmVoo = null

function recheckMs() {
  const raw = Number(process.env.CONVERSAS_TEM_MENSAGEM_RECHECK_MS)
  return Number.isFinite(raw) && raw >= 1000 ? raw : RECHECK_MS_DEFAULT
}

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

/**
 * A coluna existe E o backfill terminou? Só então os contadores podem confiar nela.
 * Falha transitória da sonda não decide nada: devolve `false` (caminho antigo) e tenta de novo
 * na próxima chamada. Chamadas concorrentes partilham UMA sonda.
 */
async function temMensagemPronta() {
  if (!_disponivel) return false
  if (_backfillOk === true) return true
  if (Date.now() < _backfillRecheckAt) return false
  if (_sondaEmVoo) return _sondaEmVoo

  _sondaEmVoo = (async () => {
    try {
      // Alguma conversa com flag `false` que TEM mensagem? (`!inner` = só conversas com ≥1 linha
      // em `mensagens`; `limit(1)` nos dois níveis: basta 1 para saber que o backfill não acabou.)
      let data = null
      let error = null
      try {
        const supabase = require('../config/supabase')
        ;({ data, error } = await supabase
          .from('conversas')
          .select(`id, mensagens!inner(id)`)
          .eq(COLUNA, false)
          .limit(1, { referencedTable: 'mensagens' })
          .limit(1))
      } catch (e) {
        // Exceção de transporte/cliente: transitória — não decide nada, tenta na próxima chamada.
        error = { message: e?.message || String(e), code: e?.code }
      }
      if (error) {
        if (erroDeTemMensagemAusente(error)) {
          desligarTemMensagem()
          return false
        }
        console.warn('[conversas] sonda do backfill de tem_mensagem falhou (transitório):', error?.message || error)
        return false
      }
      const pendente = Array.isArray(data) && data.length > 0
      if (pendente) {
        _backfillRecheckAt = Date.now() + recheckMs()
        if (!_backfillAvisou) {
          _backfillAvisou = true
          console.warn(
            `[conversas] coluna ${COLUNA} existe mas o BACKFILL não terminou (há conversa com mensagem e ` +
            `flag false) — repita o passo A2 da migration ${MIGRATION} até devolver 0. Até lá os contadores ` +
            `de Abertas/Minha fila/Em atendimento seguem pelo caminho antigo; reconfere a cada ${Math.round(recheckMs() / 1000)} s.`
          )
        }
        return false
      }
      _backfillOk = true
      return true
    } finally {
      _sondaEmVoo = null
    }
  })()
  return _sondaEmVoo
}

module.exports = {
  temMensagemDisponivel,
  temMensagemPronta,
  erroDeTemMensagemAusente,
  desligarTemMensagem,
  _test: {
    religar: () => {
      _disponivel = true
      _backfillOk = null
      _backfillRecheckAt = 0
      _backfillAvisou = false
      _sondaEmVoo = null
    },
  },
}
