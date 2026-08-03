/**
 * Contrato HTTP de contato / localização / link / ligação.
 * Garante: nunca ok:true com status erro; HTTP 4xx/5xx em falha do provedor.
 */
const {
  buildSpecialtyOutboundHttpResult,
  resolveSpecialtyClientTempDedup,
  isFailedOutboundStatus,
} = require('../helpers/specialtyOutboundResponse')

const ROW = { id: 501, conversa_id: 10, client_temp_id: 'spec-501' }

function expectNeverOkWithErro(result) {
  if (result.body.status === 'erro' || result.body.status === 'blocked') {
    expect(result.body.ok).toBe(false)
    expect(result.httpStatus).toBeGreaterThanOrEqual(400)
  }
  if (result.body.ok === true) {
    expect(result.body.status).not.toBe('erro')
    expect(result.httpStatus).toBe(200)
  }
}

describe.each([
  ['contact', 'contact'],
  ['location', 'location'],
  ['link', 'link'],
  ['call', 'call'],
])('especialidade %s — contrato de aceite UltraMsg', (label, tipo) => {
  test(`${label}: provedor aceita com ID rastreável → 200 ok=true status=sent`, () => {
    const result = buildSpecialtyOutboundHttpResult(
      {
        ok: true,
        messageId: '3EB0A123456789ABCDEF',
        httpStatus: 200,
        rawResponse: { sent: true, id: '3EB0A123456789ABCDEF' },
      },
      ROW,
      null,
      { tipo }
    )

    expect(result.httpStatus).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      id: 501,
      conversa_id: 10,
      status: 'sent',
      accepted: true,
      whatsapp_id: '3EB0A123456789ABCDEF',
      tipo,
    })
    expectNeverOkWithErro(result)
  })

  test(`${label}: provedor aceita sem ID (fila/untracked) → 200 ok=true status=pending`, () => {
    const result = buildSpecialtyOutboundHttpResult(
      {
        ok: true,
        messageId: '35096',
        httpStatus: 200,
        rawResponse: { sent: true, id: '35096' },
      },
      ROW,
      null,
      { tipo }
    )

    expect(result.httpStatus).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      status: 'pending',
      accepted: true,
      queued: true,
      provider_queue_id: '35096',
    })
    expect(result.body.whatsapp_id).toBeFalsy()
    expectNeverOkWithErro(result)
  })

  test(`${label}: provedor retorna erro explícito → ok=false status=erro HTTP 5xx`, () => {
    const result = buildSpecialtyOutboundHttpResult(
      {
        ok: false,
        httpStatus: 400,
        error: 'invalid phone',
        rawResponse: { sent: false, error: 'invalid phone' },
      },
      ROW,
      null,
      { tipo }
    )

    expect(result.body.ok).toBe(false)
    expect(result.body.status).toBe('erro')
    expect(result.httpStatus).toBeGreaterThanOrEqual(400)
    expect(result.body.error).toMatch(/invalid phone/i)
    expectNeverOkWithErro(result)
  })

  test(`${label}: HTTP 200 com payload de falha (sent=false) → ok=false`, () => {
    // Espelha normalizeUltraMsgSendResult: ok:false mesmo com HTTP 200.
    const result = buildSpecialtyOutboundHttpResult(
      {
        ok: false,
        httpStatus: 200,
        error: 'UltraMsg retornou sent=false',
        rawResponse: { sent: false, message: 'not sent' },
      },
      ROW,
      null,
      { tipo }
    )

    expect(result.body.ok).toBe(false)
    expect(result.body.status).toBe('erro')
    expect(result.httpStatus).toBeGreaterThanOrEqual(400)
    expectNeverOkWithErro(result)
  })

  test(`${label}: timeout / exceção do provedor → ok=false retryable HTTP 5xx`, () => {
    const timeout = new Error('request timeout after 30000ms')
    timeout.name = 'AbortError'
    const result = buildSpecialtyOutboundHttpResult(null, ROW, timeout, { tipo })

    expect(result.body.ok).toBe(false)
    expect(result.body.status).toBe('erro')
    expect(result.body.retryable).toBe(true)
    expect(result.httpStatus).toBe(504)
    expectNeverOkWithErro(result)
  })

  test(`${label}: mensagem persistida mas provedor recusa → corpo traz id e ok=false`, () => {
    const result = buildSpecialtyOutboundHttpResult(
      { ok: false, error: 'instance disconnected', httpStatus: 500 },
      { ...ROW, status: 'erro' },
      null,
      { tipo }
    )

    expect(result.body).toMatchObject({
      ok: false,
      id: 501,
      conversa_id: 10,
      status: 'erro',
    })
    expect(result.httpStatus).toBeGreaterThanOrEqual(500)
    expectNeverOkWithErro(result)
  })
})

describe('deduplicação de link / client_temp_id', () => {
  test('repetição com status erro anterior → ok=false (não toast verde)', () => {
    const dedup = resolveSpecialtyClientTempDedup({
      ok: true,
      id: 501,
      conversa_id: 10,
      client_temp_id: 'link-1',
      status: 'erro',
      deduplicated: true,
    })

    expect(dedup.httpStatus).toBe(502)
    expect(dedup.body.ok).toBe(false)
    expect(dedup.body.status).toBe('erro')
    expect(dedup.body.deduplicated).toBe(true)
    expect(dedup.body.id).toBe(501)
  })

  test('repetição com status sent → ok=true sem criar novo envio', () => {
    const dedup = resolveSpecialtyClientTempDedup({
      ok: true,
      id: 501,
      conversa_id: 10,
      client_temp_id: 'link-1',
      status: 'sent',
      whatsapp_id: '3EB0A123456789ABCDEF',
      deduplicated: true,
    })

    expect(dedup.httpStatus).toBe(200)
    expect(dedup.body.ok).toBe(true)
    expect(dedup.body.status).toBe('sent')
    expect(dedup.body.deduplicated).toBe(true)
  })

  test('repetição pending (ainda processando) → ok=true pending', () => {
    const dedup = resolveSpecialtyClientTempDedup({
      id: 502,
      conversa_id: 10,
      client_temp_id: 'link-2',
      status: 'pending',
      deduplicated: true,
    })

    expect(dedup.httpStatus).toBe(200)
    expect(dedup.body.ok).toBe(true)
    expect(dedup.body.status).toBe('pending')
  })
})

describe('invariantes do contrato', () => {
  test('isFailedOutboundStatus cobre aliases de erro', () => {
    expect(isFailedOutboundStatus('erro')).toBe(true)
    expect(isFailedOutboundStatus('failed')).toBe(true)
    expect(isFailedOutboundStatus('blocked')).toBe(true)
    expect(isFailedOutboundStatus('sent')).toBe(false)
    expect(isFailedOutboundStatus('pending')).toBe(false)
  })

  test('nenhum cenário de falha devolve ok:true com status erro', () => {
    const cases = [
      { ok: false, error: 'x' },
      { ok: false, httpStatus: 200, error: 'sent=false' },
      { ok: false, httpStatus: 500, error: 'boom' },
    ]
    for (const providerResult of cases) {
      for (const tipo of ['contact', 'location', 'link', 'call']) {
        const result = buildSpecialtyOutboundHttpResult(providerResult, ROW, null, { tipo })
        expectNeverOkWithErro(result)
      }
    }
  })
})
