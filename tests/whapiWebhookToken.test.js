/**
 * Auth do webhook Whapi — middleware dedicado requireWhapiWebhookToken.
 * Garante: só header/Bearer, NUNCA ?token= na query, sem fallback UltraMSG, fail-closed.
 * Ver docs/ai-handoff/25-WHAPI-SEGUNDA-INTEGRACAO.md
 */

const requireWhapiWebhookToken = require('../middleware/requireWhapiWebhookToken')

const TOKEN = 'segredo-whapi-123'

function fakeReq({ headers = {}, query = {}, method = 'POST', body = {} } = {}) {
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    method,
    path: '/webhooks/whapi',
    ip: '1.2.3.4',
    query,
    body,
    get(name) { return lower[String(name).toLowerCase()] },
  }
}

function fakeRes() {
  const r = { statusCode: 200, body: null }
  r.status = (c) => { r.statusCode = c; return r }
  r.json = (o) => { r.body = o; return r }
  return r
}

describe('requireWhapiWebhookToken — auth dedicada do webhook Whapi', () => {
  const OLD_ENV = process.env.WHATSAPP_WEBHOOK_TOKEN

  beforeEach(() => { process.env.WHATSAPP_WEBHOOK_TOKEN = TOKEN })
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.WHATSAPP_WEBHOOK_TOKEN
    else process.env.WHATSAPP_WEBHOOK_TOKEN = OLD_ENV
  })

  test('aceita token válido no header X-Webhook-Token', () => {
    const req = fakeReq({ headers: { 'X-Webhook-Token': TOKEN } })
    const res = fakeRes()
    const next = jest.fn()
    requireWhapiWebhookToken(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
  })

  test('aceita token válido via Authorization: Bearer', () => {
    const req = fakeReq({ headers: { Authorization: `Bearer ${TOKEN}` } })
    const res = fakeRes()
    const next = jest.fn()
    requireWhapiWebhookToken(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('X-Webhook-Token tem prioridade sobre Authorization', () => {
    const req = fakeReq({ headers: { 'X-Webhook-Token': TOKEN, Authorization: 'Bearer errado' } })
    const res = fakeRes()
    const next = jest.fn()
    requireWhapiWebhookToken(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('token ausente → 401 e não chama next', () => {
    const req = fakeReq({ headers: {} })
    const res = fakeRes()
    const next = jest.fn()
    requireWhapiWebhookToken(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
    expect(req.webhookLogData).toEqual({ status: 'rejected_token', error: 'token_ausente' })
  })

  test('token inválido → 401 e marca token_invalido', () => {
    const req = fakeReq({ headers: { 'X-Webhook-Token': 'errado' } })
    const res = fakeRes()
    const next = jest.fn()
    requireWhapiWebhookToken(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
    expect(req.webhookLogData).toEqual({ status: 'rejected_token', error: 'token_invalido' })
  })

  test('token na QUERY é IGNORADO (nunca aceita ?token=) → 401', () => {
    const req = fakeReq({ headers: {}, query: { token: TOKEN } })
    const res = fakeRes()
    const next = jest.fn()
    requireWhapiWebhookToken(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })

  test('NÃO faz fallback por instanceId no corpo → 401 mesmo com instance_id mapeável', () => {
    const req = fakeReq({ headers: {}, body: { instance_id: 'qualquer', channel_id: 'NEBULA-AER3B' } })
    const res = fakeRes()
    const next = jest.fn()
    requireWhapiWebhookToken(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })

  test('fail-closed: WHATSAPP_WEBHOOK_TOKEN ausente → 500 e não chama next', () => {
    delete process.env.WHATSAPP_WEBHOOK_TOKEN
    const req = fakeReq({ headers: { 'X-Webhook-Token': TOKEN } })
    const res = fakeRes()
    const next = jest.fn()
    requireWhapiWebhookToken(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(500)
  })

  test('timingSafeEqual: iguais true, diferentes/vazios false', () => {
    const { timingSafeEqual } = requireWhapiWebhookToken
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('abc', 'abx')).toBe(false)
    expect(timingSafeEqual('', 'abc')).toBe(false)
    expect(timingSafeEqual('abc', '')).toBe(false)
  })
})
