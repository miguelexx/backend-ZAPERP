/**
 * Bucket de rate limit por usuário: garante que requisições autenticadas ganham
 * chave própria (company_id + user_id) e que anônimas/malformadas caem no IP.
 */
const { _test } = require('../middleware/rateLimit')

const { extractJwtBucketKey } = _test

function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.assinatura-falsa`
}

function reqWithAuth(authorization) {
  return { headers: authorization ? { authorization } : {} }
}

describe('extractJwtBucketKey', () => {
  test('JWT com id e company_id gera bucket por usuário', () => {
    const token = fakeJwt({ id: 42, company_id: 7 })
    expect(extractJwtBucketKey(reqWithAuth(`Bearer ${token}`))).toBe('u_7_42')
  })

  test('usuários diferentes no mesmo IP ganham buckets diferentes', () => {
    const a = extractJwtBucketKey(reqWithAuth(`Bearer ${fakeJwt({ id: 1, company_id: 7 })}`))
    const b = extractJwtBucketKey(reqWithAuth(`Bearer ${fakeJwt({ id: 2, company_id: 7 })}`))
    expect(a).not.toBe(b)
  })

  test('empresas diferentes com mesmo user id ganham buckets diferentes', () => {
    const a = extractJwtBucketKey(reqWithAuth(`Bearer ${fakeJwt({ id: 5, company_id: 1 })}`))
    const b = extractJwtBucketKey(reqWithAuth(`Bearer ${fakeJwt({ id: 5, company_id: 2 })}`))
    expect(a).not.toBe(b)
  })

  test('sem Authorization retorna null (fallback por IP)', () => {
    expect(extractJwtBucketKey(reqWithAuth(null))).toBeNull()
  })

  test('token malformado retorna null sem lançar', () => {
    expect(extractJwtBucketKey(reqWithAuth('Bearer nao-e-um-jwt'))).toBeNull()
    expect(extractJwtBucketKey(reqWithAuth('Bearer a.b'))).toBeNull()
    expect(extractJwtBucketKey(reqWithAuth('Basic dXNlcjpwYXNz'))).toBeNull()
  })

  test('JWT sem company_id retorna null (fallback por IP)', () => {
    expect(extractJwtBucketKey(reqWithAuth(`Bearer ${fakeJwt({ id: 42 })}`))).toBeNull()
  })

  test('JWT sem id/sub retorna null (fallback por IP)', () => {
    expect(extractJwtBucketKey(reqWithAuth(`Bearer ${fakeJwt({ company_id: 7 })}`))).toBeNull()
  })

  test('aceita sub como identificador de usuário', () => {
    expect(extractJwtBucketKey(reqWithAuth(`Bearer ${fakeJwt({ sub: 9, company_id: 3 })}`))).toBe('u_3_9')
  })
})
