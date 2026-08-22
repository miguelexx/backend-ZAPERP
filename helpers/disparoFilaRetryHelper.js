/**
 * Classificação de erros e backoff para a fila do Disparo.
 */

const PERMANENTE_CODES = new Set([
  'TELEFONE_INVALIDO',
  'MIDIA_REJEITADA',
  'CREDENCIAL_INVALIDA',
  'FORMATO_NAO_SUPORTADO',
  'EXCLUIDO',
  'CAMPANHA_CANCELADA',
  'VARIACAO_INVALIDA',
  'INSTANCIA_INVALIDA',
  'ALLOWLIST',
])

function classificarErro({ httpStatus, code, message, beforeSend = false } = {}) {
  const c = String(code || '').toUpperCase()
  const msg = String(message || '').toLowerCase()

  if (PERMANENTE_CODES.has(c)) {
    return { classificacao: 'permanente', code: c || 'PERMANENTE' }
  }
  if (/invalid.?token|wrong token|unauthorized|forbidden|credencial/i.test(msg)) {
    return { classificacao: 'permanente', code: 'CREDENCIAL_INVALIDA' }
  }
  if (/invalid.?number|not a whatsapp|telefone inválido/i.test(msg)) {
    return { classificacao: 'permanente', code: 'TELEFONE_INVALIDO' }
  }
  if (/unsupported|formato|media.*reject|file type/i.test(msg)) {
    return { classificacao: 'permanente', code: 'FORMATO_NAO_SUPORTADO' }
  }

  const status = Number(httpStatus)
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) {
    return { classificacao: 'temporario', code: c || `HTTP_${status}` }
  }
  if (beforeSend && (/timeout|network|econn|fetch failed|aborted/i.test(msg))) {
    return { classificacao: 'temporario', code: c || 'REDE' }
  }
  if (!beforeSend && /timeout|network|econn/i.test(msg)) {
    // Após chamada iniciada: preferir estado incerto no caller
    return { classificacao: 'temporario', code: 'TIMEOUT_POS_CHAMADA', incerto: true }
  }
  if (/rate.?limit|too many|throttl/i.test(msg)) {
    return { classificacao: 'temporario', code: 'RATE_LIMIT' }
  }

  return { classificacao: 'temporario', code: c || 'TEMPORARIO' }
}

/**
 * Backoff exponencial com jitter. Respeita Retry-After (segundos) se informado.
 */
function calcularProximaTentativa({
  tentativas,
  baseSec = 30,
  maxSec = 3600,
  retryAfterSec = null,
  agora = Date.now(),
} = {}) {
  if (retryAfterSec != null && Number.isFinite(Number(retryAfterSec)) && Number(retryAfterSec) > 0) {
    const sec = Math.min(maxSec, Math.max(1, Math.floor(Number(retryAfterSec))))
    return new Date(agora + sec * 1000).toISOString()
  }
  const exp = Math.min(maxSec, baseSec * (2 ** Math.max(0, tentativas - 1)))
  const jitter = Math.floor(Math.random() * Math.max(1, exp * 0.2))
  const sec = Math.min(maxSec, exp + jitter)
  return new Date(agora + sec * 1000).toISOString()
}

/** Ordem de progresso de status da fila (webhook não regride). */
const FILA_STATUS_RANK = {
  pendente: 0,
  reservada: 1,
  enviando: 2,
  enviada: 3,
  entregue: 4,
  lida: 5,
  falhou: 6,
  incerta: 3,
  ignorada: 6,
  cancelada: 6,
}

function podeAvancarStatusFila(atual, novo) {
  const a = FILA_STATUS_RANK[atual]
  const b = FILA_STATUS_RANK[novo]
  if (a == null || b == null) return false
  // falhou/cancelada/ignorada são terminais (exceto reconciliação especial)
  if (['falhou', 'cancelada', 'ignorada'].includes(atual) && novo !== atual) return false
  if (atual === 'lida') return false
  if (atual === 'entregue' && novo === 'enviada') return false
  return b >= a || (atual === 'incerta' && ['enviada', 'entregue', 'lida', 'falhou'].includes(novo))
}

module.exports = {
  classificarErro,
  calcularProximaTentativa,
  FILA_STATUS_RANK,
  podeAvancarStatusFila,
  PERMANENTE_CODES,
}
