'use strict'

const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')

const JWT_SECRET = 'test-jwt-secret-for-zaperp'
const ZAP_SSO_SECRET = 'test-sso-shared-secret'
const CRM_AVANCADO_URL = 'https://crm.exemplo.com'

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET
  process.env.ZAP_SSO_SECRET = ZAP_SSO_SECRET
  process.env.CRM_AVANCADO_URL = CRM_AVANCADO_URL
})

function buildApp() {
  const app = express()
  app.use(express.json())
  const auth = require('../middleware/auth')
  const crmSso = require('../controllers/crmSsoController')
  const router = express.Router()
  router.get('/abrir-avancado', auth, crmSso.abrirCrmAvancado)
  app.use('/api/crm', router)
  return app
}

function makeZapToken(payload, secret = JWT_SECRET) {
  return jwt.sign(payload, secret, { expiresIn: '5m' })
}

describe('GET /api/crm/abrir-avancado', () => {
  const app = buildApp()

  it('401 sem Authorization header', async () => {
    const res = await request(app).get('/api/crm/abrir-avancado')
    expect(res.status).toBe(401)
  })

  it('401 token sem company_id', async () => {
    const token = makeZapToken({ id: 7, email: 'u@x.com' })
    const res = await request(app)
      .get('/api/crm/abrir-avancado')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('200 com token válido → retorna { url }', async () => {
    const token = makeZapToken({
      id: 7,
      company_id: 1,
      email: 'ana@empresa.com',
      nome: 'Ana',
    })
    const res = await request(app)
      .get('/api/crm/abrir-avancado')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.url).toBeDefined()
    expect(res.body.url).toMatch(/^https:\/\/crm\.exemplo\.com\/sso\?token=/)

    const ssoToken = decodeURIComponent(res.body.url.split('token=')[1])
    const decoded = jwt.verify(ssoToken, ZAP_SSO_SECRET)
    expect(decoded.idEmpresaZap).toBe('1')
    expect(decoded.idUsuarioZap).toBe('7')
    expect(decoded.email).toBe('ana@empresa.com')
    expect(decoded.nome).toBe('Ana')
  })

  it('anexa ?redirect quando é um caminho interno válido (/leads/<id>)', async () => {
    const token = makeZapToken({ id: 7, company_id: 1, email: 'ana@empresa.com', nome: 'Ana' })
    const res = await request(app)
      .get('/api/crm/abrir-avancado')
      .query({ redirect: '/leads/abc-123-uuid' })
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.url).toContain(`redirect=${encodeURIComponent('/leads/abc-123-uuid')}`)
  })

  it('ignora redirect que aponta para outro host (anti open-redirect)', async () => {
    const token = makeZapToken({ id: 7, company_id: 1, email: 'ana@empresa.com', nome: 'Ana' })
    for (const mau of ['//evil.com', 'https://evil.com', 'javascript:alert(1)', 'leads/1']) {
      const res = await request(app)
        .get('/api/crm/abrir-avancado')
        .query({ redirect: mau })
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body.url).not.toContain('redirect=')
    }
  })

  it('503 quando ZAP_SSO_SECRET não está setado', async () => {
    const orig = process.env.ZAP_SSO_SECRET
    delete process.env.ZAP_SSO_SECRET
    try {
      const token = makeZapToken({ id: 1, company_id: 1, email: 'a@b.com' })
      const res = await request(app)
        .get('/api/crm/abrir-avancado')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(503)
    } finally {
      process.env.ZAP_SSO_SECRET = orig
    }
  })
})
