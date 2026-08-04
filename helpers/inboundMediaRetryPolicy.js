/**
 * Política de retentativa da cópia de mídia inbound (UltraMSG -> /uploads).
 *
 * Regras puras, sem I/O: quando vale tentar de novo, quando desistir e o que pode ir para o log.
 * O link do provedor expira em ~24h, então o backoff precisa concentrar as tentativas nas primeiras
 * horas em vez de espalhá-las.
 */

/** Espera até cada nova tentativa, a partir da falha da tentativa imediata pós-webhook. */
const RETRY_DELAYS_MS = Object.freeze([
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
])

/** A imediata mais uma por atraso configurado. */
const MAX_TENTATIVAS = RETRY_DELAYS_MS.length + 1

const STATUS = Object.freeze({
  PENDENTE: 'pendente',
  CONCLUIDA: 'concluida',
  FALHA_DEFINITIVA: 'falha_definitiva',
})

const FALHA = Object.freeze({
  TEMPORARIA: 'temporaria',
  DEFINITIVA: 'definitiva',
})

/**
 * HTTP que ainda pode dar certo depois: o provedor pode estar instável ou o objeto pode ainda não
 * ter terminado de subir no S3 quando o webhook chegou.
 */
function classificarStatusHttp(status) {
  const s = Number(status) || 0
  if (s === 408 || s === 425 || s === 429) return FALHA.TEMPORARIA
  if (s >= 500) return FALHA.TEMPORARIA
  return FALHA.DEFINITIVA
}

/**
 * Classifica uma falha de cópia.
 * @param {{ motivo: string, status?: number }} params
 * @returns {{ tipo: 'temporaria'|'definitiva', motivo: string }}
 */
function classificarFalha({ motivo, status } = {}) {
  const m = String(motivo || 'desconhecido')

  switch (m) {
    // O objeto pode estar sendo escrito no S3 no instante do webhook; vale reler depois.
    case 'corpo_vazio':
    case 'timeout':
    case 'rede':
    case 'escrita_disco':
    case 'arquivo_incompleto':
    case 'update_db':
      return { tipo: FALHA.TEMPORARIA, motivo: m }

    case 'url_invalida':
    case 'url_fora_allowlist':
    case 'redirect_fora_allowlist':
    case 'redirects_demais':
    case 'arquivo_grande_demais':
    case 'formato_nao_identificado':
    case 'tipo_nao_qualifica':
      return { tipo: FALHA.DEFINITIVA, motivo: m }

    case 'http':
      return { tipo: classificarStatusHttp(status), motivo: `http_${Number(status) || 0}` }

    default:
      return { tipo: FALHA.TEMPORARIA, motivo: m }
  }
}

/**
 * Próximo estado a gravar depois de uma falha. Falha definitiva ou limite de tentativas atingido
 * encerram o ciclo; caso contrário agenda a próxima janela do backoff.
 * @param {{ tentativas: number, tipo: string, motivo: string, agora?: Date }} params
 * @returns {{ status: string, tentativas: number, tipo: string, motivo: string, proximaEm: Date|null }}
 */
function planejarProximaTentativa({ tentativas, tipo, motivo, agora = new Date() } = {}) {
  const feitas = Math.max(0, Number(tentativas) || 0)
  const base = { tentativas: feitas, tipo, motivo }

  if (tipo === FALHA.DEFINITIVA) {
    return { ...base, status: STATUS.FALHA_DEFINITIVA, proximaEm: null }
  }

  const atraso = RETRY_DELAYS_MS[feitas - 1]
  if (atraso == null) {
    // Backoff esgotado: a falha é temporária, mas paramos de insistir.
    return { ...base, status: STATUS.FALHA_DEFINITIVA, motivo: `${motivo}_sem_tentativas`, proximaEm: null }
  }

  return { ...base, status: STATUS.PENDENTE, proximaEm: new Date(agora.getTime() + atraso) }
}

/**
 * Resumo de URL seguro para log: host e caminho, sem query string — é lá que ficam a assinatura do
 * S3 e qualquer token. O caminho também é truncado para não vazar identificadores longos inteiros.
 * @param {string|URL} url
 * @returns {string}
 */
function resumoUrlParaLog(url) {
  try {
    const u = url instanceof URL ? url : new URL(String(url || ''))
    const caminho = String(u.pathname || '')
    const cortado = caminho.length > 48 ? `${caminho.slice(0, 48)}…` : caminho
    return `${u.hostname}${cortado}`
  } catch {
    return '(url inválida)'
  }
}

module.exports = {
  RETRY_DELAYS_MS,
  MAX_TENTATIVAS,
  STATUS,
  FALHA,
  classificarFalha,
  classificarStatusHttp,
  planejarProximaTentativa,
  resumoUrlParaLog,
}
