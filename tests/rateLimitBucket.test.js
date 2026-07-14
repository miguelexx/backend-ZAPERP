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
