/**
 * Contrato HTTP de envio especializado (contato, localização, link, ligação).
 * Espelha o padrão do texto manual: ok:true só com aceite do provedor;
 * nunca ok:true junto com status erro.
 */
const {
  classifyManualTextProviderResult,
  manualTextResponseFromClassification,
} = require('../services/manualTextOutboundService')

const FAILED_STATUSES = new Set([
  'erro',
  'error',
  'failed',
  'falhou',
  'blocked',
  'invalid',
  'unsent',
  'expired',
])

function isFailedOutboundStatus(status) {
  return FAILED_STATUSES.has(String(status || '').trim().toLowerCase())
}

function specialtyOutboundFailureHttpStatus(classification) {
  if (String(classification?.status || '').toLowerCase() === 'blocked') return 422
  if (classification?.timeout) return 504
  if (classification?.network) return 503
  if (classification?.retryable) return 503
  return 502
}

/**
 * @returns {{ httpStatus: number, body: object }}
 */
function buildSpecialtyOutboundHttpResult(providerResult, row, thrownError = null, extra = {}) {
  const classification = classifyManualTextProviderResult(providerResult, thrownError)
  const body = manualTextResponseFromClassification(classification, row, extra)
  if (classification.ok === true) {
    return { httpStatus: 200, body, classification }
  }
  return {
    httpStatus: specialtyOutboundFailureHttpStatus(classification),
    body: {
      ...body,
      ok: false,
      status: body.status === 'blocked' ? 'blocked' : 'erro',
    },
    classification,
  }
}

/**
 * Deduplicação de link por client_temp_id: se a tentativa anterior falhou,
 * não devolver ok:true (evita toast verde e esconde a falha).
 * @returns {{ httpStatus: number, body: object } | null}
 */
function resolveSpecialtyClientTempDedup(persistedResponse) {
  if (!persistedResponse?.id) return null
  if (isFailedOutboundStatus(persistedResponse.status)) {
    const error =
      persistedResponse.error ||
      persistedResponse.motivo ||
      'O envio anterior falhou e ainda não foi confirmado pelo WhatsApp.'
    return {
      httpStatus: 502,
      body: {
        ...persistedResponse,
        ok: false,
        status: 'erro',
        status_mensagem: persistedResponse.status_mensagem || 'failed',
        accepted: false,
        retryable: true,
        error,
        motivo: error,
      },
    }
  }
  return {
    httpStatus: 200,
    body: {
      ...persistedResponse,
      ok: true,
      accepted: true,
    },
  }
}

module.exports = {
  isFailedOutboundStatus,
  specialtyOutboundFailureHttpStatus,
  buildSpecialtyOutboundHttpResult,
  resolveSpecialtyClientTempDedup,
  classifySpecialtyProviderResult: classifyManualTextProviderResult,
}
