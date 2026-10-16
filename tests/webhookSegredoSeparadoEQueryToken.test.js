/**
 * F1 da auditoria das setas (doc 33): o segredo do webhook ia para o log pela rota UltraMSG.
 *
 * Cobre as três pernas da correção:
 *   1. `helpers/redactUrlSecrets` — token/JWT nunca em claro na URL logada.
 *   2. `requireWhapiWebhookToken` — segredo PRÓPRIO da Whapi + fallback de transição controlável.
 *   3. `requireWebhookToken` (UltraMSG) — `?token=` recusado por padrão, religável por env.
 */

const { redactUrlSecrets, redactedRequestUrl } = require('../helpers/redactUrlSecrets')
const requireWhapiWebhookToken = require('../middleware/requireWhapiWebhookToken')
const requireWebhookToken = require('../middleware/requireWebhookToken')

const SHARED = 'segredo-compartilhado-antigo'
const WHAPI_ONLY = 'segredo-exclusivo-whapi'

function fakeReq({ headers = {}, query = {}, method = 'POST', body = {}, path = '/webhooks/whapi' } = {}) {
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    method,
    path,
    originalUrl: path,
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

const ENV_KEYS = [
  'WHATSAPP_WEBHOOK_TOKEN',
  'WHAPI_WEBHOOK_TOKEN',
  'WHAPI_WEBHOOK_TOKEN_ACCEPT_LEGACY',
  'WEBHOOK_QUERY_TOKEN_ENABLED',
  'ALLOW_INSTANCEID_WEBHOOK_FALLBACK',
]

describe('F1 — redação de segredo na URL logada', () => {
  test('redige ?token= mantendo a chave visível', () => {
    expect(redactUrlSecrets('/webhooks/ultramsg?token=abc123')).toBe('/webhooks/ultramsg?token=[REDACTED]')
  })

  test('redige JWT do /media/proxy e preserva os outros parâmetros', () => {
    expect(redactUrlSecrets('/media/proxy?url=https%3A%2F%2Fx.com%2Fa.ogg&token=eyJhbGciOi.J9.sig'))
      .toBe('/media/proxy?url=https%3A%2F%2Fx.com%2Fa.ogg&token=[REDACTED]')
  })

  test('cobre as variações de nome de segredo, sem distinguir maiúsculas', () => {
    const red = redactUrlSecrets('/x?Token=a&access_token=b&apikey=c&secret=d&signature=e&sig=f&jwt=g')
    expect(red).not.toMatch(/=(a|b|c|d|e|f|g)(&|$)/)
    expect(red.match(/\[REDACTED\]/g)).toHaveLength(7)
  })

  test('não mexe no que não é segredo nem na URL sem query', () => {
    expect(redactUrlSecrets('/chats?limit=20&cursor=abc')).toBe('/chats?limit=20&cursor=abc')
    expect(redactUrlSecrets('/webhooks/whapi')).toBe('/webhooks/whapi')
  })

  test('tolera entrada vazia, nula e query degenerada (não lança)', () => {
    expect(redactUrlSecrets(null)).toBe('')
    expect(redactUrlSecrets('')).toBe('')
    expect(redactUrlSecrets('/x?')).toBe('/x?')
    expect(redactUrlSecrets('/x?token')).toBe('/x?token')
    expect(redactUrlSecrets('/x?token=a#frag')).toBe('/x?token=[REDACTED]#frag')
  })

  test('redactedRequestUrl usa originalUrl e cai em url', () => {
    expect(redactedRequestUrl({ originalUrl: '/a?token=x' })).toBe('/a?token=[REDACTED]')
    expect(redactedRequestUrl({ url: '/b?secret=y' })).toBe('/b?secret=[REDACTED]')
    expect(redactedRequestUrl({})).toBe('')
  })
})

describe('F1 — webhook Whapi com segredo próprio', () => {
  const SAVED = {}
  beforeAll(() => { for (const k of ENV_KEYS) SAVED[k] = process.env[k] })
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    requireWhapiWebhookToken._test.resetLegacyWarn()
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { jest.restoreAllMocks() })
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (SAVED[k] === undefined) delete process.env[k]
      else process.env[k] = SAVED[k]
    }
  })

  function chamar(headerToken) {
    const req = fakeReq({ headers: headerToken ? { 'X-Webhook-Token': headerToken } : {} })
    const res = fakeRes()
    const next = jest.fn()
    requireWhapiWebhookToken(req, res, next)
    return { req, res, next }
  }

  test('sem WHAPI_WEBHOOK_TOKEN o comportamento é o antigo (só o compartilhado)', () => {
    process.env.WHATSAPP_WEBHOOK_TOKEN = SHARED
    expect(requireWhapiWebhookToken.resolveExpectedTokens()).toEqual({
      tokens: [SHARED], usingDedicated: false, legacyAccepted: true,
    })
    expect(chamar(SHARED).next).toHaveBeenCalledTimes(1)
  })

  test('com o dedicado definido, o segredo próprio é aceito', () => {
    process.env.WHATSAPP_WEBHOOK_TOKEN = SHARED
    process.env.WHAPI_WEBHOOK_TOKEN = WHAPI_ONLY
    expect(chamar(WHAPI_ONLY).next).toHaveBeenCalledTimes(1)
  })

  test('transição ligada (padrão): o segredo legado ainda passa, com aviso', () => {
    process.env.WHATSAPP_WEBHOOK_TOKEN = SHARED
    process.env.WHAPI_WEBHOOK_TOKEN = WHAPI_ONLY
    const { next } = chamar(SHARED)
    expect(next).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('LEGADO'))
  })

  test('transição FECHADA: o segredo legado é recusado e só o dedicado passa', () => {
    process.env.WHATSAPP_WEBHOOK_TOKEN = SHARED
    process.env.WHAPI_WEBHOOK_TOKEN = WHAPI_ONLY
    process.env.WHAPI_WEBHOOK_TOKEN_ACCEPT_LEGACY = 'false'
    expect(requireWhapiWebhookToken.resolveExpectedTokens().tokens).toEqual([WHAPI_ONLY])
    const legado = chamar(SHARED)
    expect(legado.next).not.toHaveBeenCalled()
    expect(legado.res.statusCode).toBe(401)
    expect(chamar(WHAPI_ONLY).next).toHaveBeenCalledTimes(1)
  })

  test('legado igual ao dedicado não duplica candidato nem avisa transição', () => {
    process.env.WHATSAPP_WEBHOOK_TOKEN = WHAPI_ONLY
    process.env.WHAPI_WEBHOOK_TOKEN = WHAPI_ONLY
    expect(requireWhapiWebhookToken.resolveExpectedTokens()).toEqual({
      tokens: [WHAPI_ONLY], usingDedicated: true, legacyAccepted: false,
    })
    chamar(WHAPI_ONLY)
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('LEGADO'))
  })

  test('segue fail-closed: nenhum segredo no ambiente → 500, nunca next()', () => {
    const { res, next } = chamar('qualquer')
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(500)
  })

  test('query NUNCA autentica a Whapi, nem com o segredo certo', () => {
    process.env.WHAPI_WEBHOOK_TOKEN = WHAPI_ONLY
    const req = fakeReq({ query: { token: WHAPI_ONLY } })
    const res = fakeRes()
    const next = jest.fn()
    requireWhapiWebhookToken(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })
})

describe('F1 — ?token= na rota UltraMSG virou chave (default LIGADO, por medição)', () => {
  const SAVED = {}
  beforeAll(() => { for (const k of ENV_KEYS) SAVED[k] = process.env[k] })
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.WHATSAPP_WEBHOOK_TOKEN = SHARED
    // Fallback por instanceId fora do caminho: aqui o assunto é só o token.
    process.env.ALLOW_INSTANCEID_WEBHOOK_FALLBACK = '0'
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { jest.restoreAllMocks() })
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (SAVED[k] === undefined) delete process.env[k]
      else process.env[k] = SAVED[k]
    }
  })

  function chamar({ query = {}, headers = {} } = {}) {
    const req = fakeReq({ query, headers, path: '/webhooks/ultramsg' })
    const res = fakeRes()
    const next = jest.fn()
    requireWebhookToken(req, res, next)
    return { req, res, next }
  }

  // DEFAULT LIGADO de propósito: a API do UltraMSG não manda header e há 4 canais UltraMSG
  // ativos em produção (medição no doc 33 §6.3) — desligar por padrão derrubaria o inbound deles.
  test('padrão: token na query é ACEITO (canal UltraMSG não tem outro jeito)', () => {
    expect(requireWebhookToken.queryTokenNaQueryHabilitado()).toBe(true)
    expect(chamar({ query: { token: SHARED } }).next).toHaveBeenCalledTimes(1)
  })

  test('query aceita não transforma token ERRADO em válido', () => {
    const { res, next } = chamar({ query: { token: 'errado' } })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
  })

  test('header continua funcionando (caminho preferido)', () => {
    expect(chamar({ headers: { 'X-Webhook-Token': SHARED } }).next).toHaveBeenCalledTimes(1)
    expect(chamar({ headers: { Authorization: `Bearer ${SHARED}` } }).next).toHaveBeenCalledTimes(1)
  })

  test('=false fecha a query e marca o motivo próprio', () => {
    process.env.WEBHOOK_QUERY_TOKEN_ENABLED = 'false'
    const { res, next, req } = chamar({ query: { token: SHARED } })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
    expect(req.webhookLogData.error).toBe('token_na_query_desabilitado')
  })

  test('=false: a recusa explica no log a armadilha do UltraMSG (sem header)', () => {
    process.env.WEBHOOK_QUERY_TOKEN_ENABLED = 'false'
    chamar({ query: { token: SHARED } })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_QUERY_TOKEN_ENABLED=true'))
  })

  test('=false não afeta o header', () => {
    process.env.WEBHOOK_QUERY_TOKEN_ENABLED = 'false'
    expect(chamar({ headers: { 'X-Webhook-Token': SHARED } }).next).toHaveBeenCalledTimes(1)
  })
})
