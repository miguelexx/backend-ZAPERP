/**
 * Rotas do ranking gamificado: permissões (adminOnly existente) e tenant vindo do JWT.
 */
const express = require('express')
const request = require('supertest')
const jwt = require('jsonwebtoken')

jest.mock('../services/rankingGamificado/rankingGamificadoService', () => ({
  getRankingAtual: jest.fn(async () => ({ ativo: true })),
  getPainelAdmin: jest.fn(async () => ({ config: { ativo: false } })),
  salvarConfig: jest.fn(async () => ({ config: { ativo: true } })),
  listarHistorico: jest.fn(async () => ({ itens: [] })),
}))

const service = require('../services/rankingGamificado/rankingGamificadoService')
const OLD_ENV = process.env
let app

beforeAll(() => {
  process.env = { ...OLD_ENV, JWT_SECRET: 'ranking-test-secret' }
  app = express()
  app.use(express.json())
  app.use('/api/ranking', require('../routes/rankingRoutes'))
})
afterAll(() => { process.env = OLD_ENV })
beforeEach(() => jest.clearAllMocks())

const token = (perfil, extra = {}) =>
  jwt.sign({ id: 5, company_id: 7, perfil, ...extra }, process.env.JWT_SECRET)

describe('GET /api/ranking/atual', () => {
  test('401 sem token', async () => {
    expect((await request(app).get('/api/ranking/atual')).status).toBe(401)
  })

  test('atendente vê o ranking da própria empresa (company_id do JWT, não da query)', async () => {
    const res = await request(app)
      .get('/api/ranking/atual?company_id=99')
      .set('Authorization', `Bearer ${token('atendente')}`)
    expect(res.status).toBe(200)
    expect(service.getRankingAtual).toHaveBeenCalledWith(7, 5, expect.objectContaining({ resumo: false }))
  })

  test('?resumo=1 pede a versão leve', async () => {
    await request(app).get('/api/ranking/atual?resumo=1').set('Authorization', `Bearer ${token('atendente')}`)
    expect(service.getRankingAtual).toHaveBeenCalledWith(7, 5, expect.objectContaining({ resumo: true }))
  })
})

describe('configuração e histórico: só administrador', () => {
  test.each(['atendente', 'supervisor'])('%s recebe 403 em GET/PUT config e histórico', async (perfil) => {
    const auth = `Bearer ${token(perfil)}`
    expect((await request(app).get('/api/ranking/config').set('Authorization', auth)).status).toBe(403)
    expect((await request(app).put('/api/ranking/config').set('Authorization', auth).send({ ativo: true })).status).toBe(403)
    expect((await request(app).get('/api/ranking/historico').set('Authorization', auth)).status).toBe(403)
    expect(service.salvarConfig).not.toHaveBeenCalled()
  })

  test('admin salva; company_id do body é ignorado', async () => {
    const res = await request(app)
      .put('/api/ranking/config')
      .set('Authorization', `Bearer ${token('admin')}`)
      .send({ ativo: true, dia_semana: 5, horario: '18:00', company_id: 99 })
    expect(res.status).toBe(200)
    expect(service.salvarConfig).toHaveBeenCalledWith(7, 5, expect.any(Object), expect.any(Object))
  })

  test('erro de validação vira 400 com a mensagem', async () => {
    const err = new Error('Horário inválido. Use o formato HH:MM.')
    err.statusCode = 400
    service.salvarConfig.mockRejectedValueOnce(err)
    const res = await request(app)
      .put('/api/ranking/config')
      .set('Authorization', `Bearer ${token('admin')}`)
      .send({ ativo: true, dia_semana: 5, horario: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Horário inválido/)
  })

  test('falha interna não vaza detalhes', async () => {
    const err = new Error('relation xyz detalhe interno')
    service.listarHistorico.mockRejectedValueOnce(err)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await request(app).get('/api/ranking/historico').set('Authorization', `Bearer ${token('admin')}`)
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Erro ao processar o ranking')
  })
})
