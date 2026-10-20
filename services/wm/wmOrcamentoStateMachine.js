'use strict'

const crypto = require('crypto')

/**
 * Máquina de estados da operação de orçamento WM (seção 7 do doc 36) e o hash canônico
 * do payload de criação (decisão D4).
 *
 * Módulo puro: não conhece schema da WM, não faz I/O, não toca banco. A trava real de
 * concorrência é o UPDATE condicional no Postgres (`AND estado = 'PREPARADO'`); este módulo
 * é a definição única de quais transições existem, para que nenhum caminho invente uma.
 *
 *   PREPARADO ──confirmação (gera e persiste comando_id)──▶ ENVIANDO
 *      │                                                      ├─ 200 ──────────────────▶ CRIADO
 *      └── prazo local ──▶ EXPIRADO                           ├─ recusa pré-escrita ──▶ FALHA_SEGURA
 *                                                             ├─ timeout/rede/504 ────▶ INCERTO
 *                                                             └─ falha ANTES de despacho
 *                                                                comprovado ──────────▶ PREPARADO
 *
 * INCERTO é TERMINAL (D10): enquanto a WM não definir por escrito a semântica de
 * reconciliação, nenhum fluxo gera `comando_id` novo para "corrigir" um incerto.
 * FALHA_SEGURA também é terminal — repreparar cria uma operação nova, não reusa esta.
 */

const ESTADOS = Object.freeze({
  PREPARADO: 'PREPARADO',
  ENVIANDO: 'ENVIANDO',
  CRIADO: 'CRIADO',
  FALHA_SEGURA: 'FALHA_SEGURA',
  INCERTO: 'INCERTO',
  EXPIRADO: 'EXPIRADO',
})

const TODOS_OS_ESTADOS = Object.freeze(Object.values(ESTADOS))

const TRANSICOES = Object.freeze({
  [ESTADOS.PREPARADO]: Object.freeze([ESTADOS.ENVIANDO, ESTADOS.EXPIRADO]),
  // ENVIANDO → PREPARADO só vale para falha ANTES de despacho comprovado; qualquer dúvida
  // sobre o despacho é INCERTO, nunca volta a PREPARADO.
  [ESTADOS.ENVIANDO]: Object.freeze([
    ESTADOS.CRIADO,
    ESTADOS.FALHA_SEGURA,
    ESTADOS.INCERTO,
    ESTADOS.PREPARADO,
  ]),
  [ESTADOS.CRIADO]: Object.freeze([]),
  [ESTADOS.FALHA_SEGURA]: Object.freeze([]),
  [ESTADOS.INCERTO]: Object.freeze([]),
  [ESTADOS.EXPIRADO]: Object.freeze([]),
})

const ESTADOS_TERMINAIS = Object.freeze(
  TODOS_OS_ESTADOS.filter((e) => TRANSICOES[e].length === 0)
)

function estadoValido(estado) {
  return typeof estado === 'string' && Object.prototype.hasOwnProperty.call(TRANSICOES, estado)
}

function isTerminal(estado) {
  return estadoValido(estado) && TRANSICOES[estado].length === 0
}

/**
 * @param {string} de
 * @param {string} para
 * @returns {boolean} false para estado desconhecido, transição não listada e auto-transição
 */
function transicaoPermitida(de, para) {
  if (!estadoValido(de) || !estadoValido(para)) return false
  return TRANSICOES[de].includes(para)
}

/**
 * Versão que lança — para usar no caminho de escrita, onde seguir adiante seria pior
 * que falhar. O erro carrega `code` para o mapeador de erro não precisar adivinhar.
 * @throws {Error & { code: 'TRANSICAO_INVALIDA', de: string, para: string }}
 */
function assertTransicao(de, para) {
  if (transicaoPermitida(de, para)) return true
  const err = new Error(`Transição de estado inválida: ${de} → ${para}`)
  err.code = 'TRANSICAO_INVALIDA'
  err.de = de
  err.para = para
  throw err
}

/** Próximos estados possíveis (array vazio em terminal ou estado desconhecido). */
function proximosEstados(de) {
  return estadoValido(de) ? [...TRANSICOES[de]] : []
}

/**
 * JSON canônico: chaves de objeto em ordem lexicográfica, ordem de array preservada
 * (ordem de item do orçamento é significativa), `undefined` descartado como no JSON.stringify.
 *
 * Tipos são preservados: `1` e `"1"` produzem hashes diferentes de propósito — o transporte
 * monetário é string decimal, e um número onde deveria haver string é mudança de payload.
 */
function jsonCanonico(valor) {
  return JSON.stringify(canonizar(valor))
}

function canonizar(valor) {
  if (valor === null || typeof valor !== 'object') return valor
  if (Array.isArray(valor)) return valor.map(canonizar)
  const out = {}
  for (const chave of Object.keys(valor).sort()) {
    const v = canonizar(valor[chave])
    if (v === undefined) continue
    out[chave] = v
  }
  return out
}

/**
 * SHA-256 do JSON canônico do payload de criação (D4). Determinístico para o mesmo payload
 * com as chaves em ordem diferente — é o que detecta "mesmo comando_id, payload diferente",
 * que é erro crítico local e nunca é despachado.
 *
 * @param {unknown} payload
 * @returns {string} hex de 64 caracteres
 */
function calcularPayloadHash(payload) {
  return crypto.createHash('sha256').update(jsonCanonico(payload), 'utf8').digest('hex')
}

/** Comparação de hash em tempo constante (ambos são hex de mesmo tamanho). */
function payloadHashIgual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8')
  const bb = Buffer.from(String(b ?? ''), 'utf8')
  if (ba.length !== bb.length || ba.length === 0) return false
  return crypto.timingSafeEqual(ba, bb)
}

module.exports = {
  ESTADOS,
  TODOS_OS_ESTADOS,
  TRANSICOES,
  ESTADOS_TERMINAIS,
  estadoValido,
  isTerminal,
  transicaoPermitida,
  assertTransicao,
  proximosEstados,
  jsonCanonico,
  calcularPayloadHash,
  payloadHashIgual,
}
