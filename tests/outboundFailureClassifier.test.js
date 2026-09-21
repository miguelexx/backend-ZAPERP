const { isTransientOutboundFailure } = require('../services/chat/outbound/outboundFailureClassifier')

describe('isTransientOutboundFailure', () => {
  test('exceção de transporte (timeout/rede) é transitória', () => {
    expect(isTransientOutboundFailure({ isException: true })).toBe(true)
    expect(isTransientOutboundFailure({ isException: true, httpStatus: null })).toBe(true)
  })

  test('HTTP 408/425/429 são transitórios', () => {
    expect(isTransientOutboundFailure({ httpStatus: 408 })).toBe(true)
    expect(isTransientOutboundFailure({ httpStatus: 425 })).toBe(true)
    expect(isTransientOutboundFailure({ httpStatus: 429 })).toBe(true)
  })

  test('HTTP 5xx são transitórios', () => {
    expect(isTransientOutboundFailure({ httpStatus: 500 })).toBe(true)
    expect(isTransientOutboundFailure({ httpStatus: 502 })).toBe(true)
    expect(isTransientOutboundFailure({ httpStatus: 503 })).toBe(true)
    expect(isTransientOutboundFailure({ httpStatus: 599 })).toBe(true)
  })

  test('4xx de validação/permissão são definitivos', () => {
    for (const s of [400, 401, 403, 404, 409, 422]) {
      expect(isTransientOutboundFailure({ httpStatus: s })).toBe(false)
    }
  })

  test('HTTP 200 com recusa no corpo (sem httpStatus 5xx) é definitivo', () => {
    // UltraMSG retorna 200 mesmo em token inválido / sent=false
    expect(isTransientOutboundFailure({ httpStatus: 200 })).toBe(false)
  })

  test('ausência de httpStatus (sem instância/config) é definitiva', () => {
    expect(isTransientOutboundFailure({})).toBe(false)
    expect(isTransientOutboundFailure({ httpStatus: null })).toBe(false)
    expect(isTransientOutboundFailure({ httpStatus: undefined })).toBe(false)
    expect(isTransientOutboundFailure()).toBe(false)
  })
})
