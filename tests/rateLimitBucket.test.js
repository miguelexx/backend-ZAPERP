/**
 * Bucket de rate limit por usuário: garante que requisições autenticadas ganham
 * chave própria (company_id + user_id) e que anônimas/malformadas caem no IP.
 * Segurança: a assinatura do JWT é verificada — token forjado NÃO ganha bucket
 * próprio (senão qualquer cliente anularia o limite por IP criando tokens falsos).
 */
const jwt = require('jsonwebtoken')

const OLD_ENV = process.env

beforeAll(() => {
  process.env = { ...OLD_ENV, JWT_SECRET: 'test-secret' }
})

afterAll(() => {
  process.env = OLD_ENV
})

const { _test } = require('../middleware/rateLimit')

const { extractJwtBucketKey } = _test

function signedJwt(payload) {
  return jwt.sign(payload, 'test-secret')
}

function forgedJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.assinatura-falsa`
}

function reqWithAuth(authorization) {
  return { headers: authorization ? { authorization } : {} }
}

describe('extractJwtBucketKey', () => {
  test('JWT assinado com id e company_id gera bucket por usuário', () => {
    const token = signedJwt({ id: 42, company_id: 7 })
    expect(extractJwtBucketKey(reqWithAuth(`Bearer ${token}`))).toBe('u_7_42')
  })

  test('usuários diferentes no mesmo IP ganham buckets diferentes', () => {
    const a = extractJwtBucketKey(reqWithAuth(`Bearer ${signedJwt({ id: 1, company_id: 7 })}`))
    const b = extractJwtBucketKey(reqWithAuth(`Bearer ${signedJwt({ id: 2, company_id: 7 })}`))
    expect(a).not.toBe(b)
  })

  test('empresas diferentes com mesmo user id ganham buckets diferentes', () => {
    const a = extractJwtBucketKey(reqWithAuth(`Bearer ${signedJwt({ id: 5, company_id: 1 })}`))
    const b = extractJwtBucketKey(reqWithAuth(`Bearer ${signedJwt({ id: 5, company_id: 2 })}`))
    expect(a).not.toBe(b)
  })

  test('sem Authorization retorna null (fallback por IP)', () => {
    expect(extractJwtBucketKey(reqWithAuth(null))).toBeNull()
  })

  test('token com assinatura forjada retorna null (fallback por IP)', () => {
    const token = forgedJwt({ id: 42, company_id: 7 })
    expect(extractJwtBucketKey(reqWithAuth(`Bearer ${token}`))).toBeNull()
  })

  test('token expirado retorna null (fallback por IP)', () => {
    const token = jwt.sign({ id: 42, company_id: 7 }, 'test-secret', { expiresIn: -60 })
    expect(extractJwtBucketKey(reqWithAuth(`Bearer ${token}`))).toBeNull()
  })

  test('token malformado retorna null sem lançar', () => {
    expect(extractJwtBucketKey(reqWithAuth('Bearer nao-e-um-jwt'))).toBeNull()
    expect(extractJwtBucketKey(reqWithAuth('Bearer a.b'))).toBeNull()
    expect(extractJwtBucketKey(reqWithAuth('Basic dXNlcjpwYXNz'))).toBeNull()
  })

  test('JWT sem company_id retorna null (fallback por IP)', () => {
    expect(extractJwtBucketKey(reqWithAuth(`Bearer ${signedJwt({ id: 42 })}`))).toBeNull()
  })

  test('JWT sem id/sub retorna null (fallback por IP)', () => {
    expect(extractJwtBucketKey(reqWithAuth(`Bearer ${signedJwt({ company_id: 7 })}`))).toBeNull()
  })

  test('aceita sub como identificador de usuário', () => {
    expect(extractJwtBucketKey(reqWithAuth(`Bearer ${signedJwt({ sub: 9, company_id: 3 })}`))).toBe('u_3_9')
  })

  test('sem JWT_SECRET configurado retorna null (fallback por IP)', () => {
    const prev = process.env.JWT_SECRET
    delete process.env.JWT_SECRET
    try {
      const token = forgedJwt({ id: 42, company_id: 7 })
      expect(extractJwtBucketKey(reqWithAuth(`Bearer ${token}`))).toBeNull()
    } finally {
      process.env.JWT_SECRET = prev
    }
  })
})

/**
 * O <audio>/<video>/<img> não consegue mandar header Authorization: o JWT vai em
 * ?access_token= (middleware/authBearerOrQuery). Sem ler a query, TODA reprodução de
 * mídia caía no bucket por IP — um escritório inteiro dividindo uma cota só, e o
 * sintoma de estouro é o áudio simplesmente não tocar (429 silencioso no <audio>).
 */
describe('extractJwtBucketKey — token na query (mídia em <audio>/<video>)', () => {
  const reqWithQuery = (query, headers = {}) => ({ headers, query })

  test('access_token assinado gera bucket por usuário, igual ao header', () => {
    const token = signedJwt({ id: 42, company_id: 7 })
    expect(extractJwtBucketKey(reqWithQuery({ access_token: token }))).toBe('u_7_42')
    expect(extractJwtBucketKey(reqWithQuery({ access_token: token }))).toBe(
      extractJwtBucketKey(reqWithAuth(`Bearer ${token}`))
    )
  })

  test('aceita também ?token= (mesma tolerância do authBearerOrQuery)', () => {
    expect(extractJwtBucketKey(reqWithQuery({ token: signedJwt({ id: 8, company_id: 4 }) }))).toBe('u_4_8')
  })

  test('atendentes distintos no mesmo IP não dividem cota ao ouvir áudio', () => {
    const a = extractJwtBucketKey(reqWithQuery({ access_token: signedJwt({ id: 1, company_id: 7 }) }))
    const b = extractJwtBucketKey(reqWithQuery({ access_token: signedJwt({ id: 2, company_id: 7 }) }))
    expect(a).toBe('u_7_1')
    expect(b).toBe('u_7_2')
  })

  test('header tem prioridade sobre a query', () => {
    const req = reqWithQuery(
      { access_token: signedJwt({ id: 99, company_id: 9 }) },
      { authorization: `Bearer ${signedJwt({ id: 42, company_id: 7 })}` }
    )
    expect(extractJwtBucketKey(req)).toBe('u_7_42')
  })

  test('access_token forjado continua caindo no bucket por IP', () => {
    expect(extractJwtBucketKey(reqWithQuery({ access_token: forgedJwt({ id: 42, company_id: 7 }) }))).toBeNull()
  })

  test('query ausente ou com tipo errado não lança', () => {
    expect(extractJwtBucketKey({ headers: {} })).toBeNull()
    expect(extractJwtBucketKey(reqWithQuery({ access_token: ['a', 'b'] }))).toBeNull()
    expect(extractJwtBucketKey(reqWithQuery({ access_token: '' }))).toBeNull()
  })
})
