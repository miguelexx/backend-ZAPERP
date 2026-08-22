const request = require('supertest')
const jwt = require('jsonwebtoken')
const supabase = require('../config/supabase')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'disparo-test-secret'
const app = require('../app')

function token(payload = {}) {
  return jwt.sign(
    { id: 5, company_id: 10, perfil: 'admin', ...payload },
    process.env.JWT_SECRET,
  )
}

/**
 * Cria uma chain fluente de mock do supabase que aceita qualquer combinação
 * de `.select().eq().eq().order().range()` etc. e resolve com `result`.
 */
function mockChain(result) {
  const chain = {}
  const methods = [
    'select', 'eq', 'neq', 'is', 'in', 'ilike', 'or',
    'gte', 'lte', 'limit', 'order', 'range',
    'insert', 'update',
  ]
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Disparo de Mensagens — segurança e isolamento', () => {
  beforeEach(() => jest.clearAllMocks())
  afterEach(() => jest.restoreAllMocks())

  // ── Autenticação ────────────────────────────────────────────────────────────

  it('rejeita GET /disparo/campanhas sem token (401)', async () => {
    const res = await request(app).get('/api/disparo/campanhas')
    expect(res.status).toBe(401)
  })

  it('rejeita POST /disparo/campanhas sem token (401)', async () => {
    const res = await request(app).post('/api/disparo/campanhas').send({ nome: 'Teste' })
    expect(res.status).toBe(401)
  })

  // ── Autorização: somente admin ──────────────────────────────────────────────

  it('bloqueia atendente em GET /disparo/campanhas (403)', async () => {
    const res = await request(app)
      .get('/api/disparo/campanhas')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
    expect(res.status).toBe(403)
  })

  it('bloqueia supervisor em POST /disparo/campanhas (403)', async () => {
    const res = await request(app)
      .post('/api/disparo/campanhas')
      .set('Authorization', `Bearer ${token({ perfil: 'supervisor' })}`)
      .send({ nome: 'Campanha Supervisor' })
    expect(res.status).toBe(403)
  })

  it('bloqueia atendente em PATCH /disparo/campanhas/:id (403)', async () => {
    const res = await request(app)
      .patch('/api/disparo/campanhas/1')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
      .send({ nome: 'Hackeado' })
    expect(res.status).toBe(403)
  })

  it('bloqueia supervisor em POST /disparo/campanhas/:id/arquivar (403)', async () => {
    const res = await request(app)
      .post('/api/disparo/campanhas/1/arquivar')
      .set('Authorization', `Bearer ${token({ perfil: 'supervisor' })}`)
    expect(res.status).toBe(403)
  })

  // ── Isolamento por company_id ───────────────────────────────────────────────

  it('lista campanhas sempre filtrando pelo company_id do token, não do body', async () => {
    const listQuery = mockChain({
      data: [{ id: 1, company_id: 10, nome: 'Campanha A', status: 'rascunho' }],
      error: null,
      count: 1,
    })
    supabase.from.mockReturnValueOnce(listQuery)

    const res = await request(app)
      .get('/api/disparo/campanhas?company_id=999')
      .set('Authorization', `Bearer ${token({ company_id: 10 })}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ total: 1, page: 1 })
    // Garante que o filtro usou o company_id do token (10), não o query param (999)
    expect(listQuery.eq).toHaveBeenCalledWith('company_id', 10)
  })

  it('admin cria campanha com company_id extraído do token', async () => {
    const insertQuery = mockChain({
      data: { id: 42, company_id: 10, nome: 'Nova', status: 'rascunho' },
      error: null,
    })
    supabase.from.mockReturnValueOnce(insertQuery)

    const res = await request(app)
      .post('/api/disparo/campanhas')
      .set('Authorization', `Bearer ${token({ company_id: 10 })}`)
      .send({ nome: 'Nova', descricao: '' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ id: 42, company_id: 10 })
    expect(insertQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: 10 }),
    )
  })

  it('não permite criar campanha sem nome (400)', async () => {
    const res = await request(app)
      .post('/api/disparo/campanhas')
      .set('Authorization', `Bearer ${token()}`)
      .send({ nome: '' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/nome/i)
  })

  // ── Obter campanha: 404 para outra empresa ──────────────────────────────────

  it('retorna 404 ao tentar obter campanha de outra empresa', async () => {
    const fetchQuery = mockChain({ data: null, error: null })
    supabase.from.mockReturnValueOnce(fetchQuery)

    const res = await request(app)
      .get('/api/disparo/campanhas/99')
      .set('Authorization', `Bearer ${token({ company_id: 10 })}`)

    expect(res.status).toBe(404)
    // Verifica que a query usou company_id do token
    expect(fetchQuery.eq).toHaveBeenCalledWith('company_id', 10)
  })

  // ── Editar: somente rascunho ────────────────────────────────────────────────

  it('bloqueia edição de campanha que não é rascunho (422)', async () => {
    const fetchQuery = mockChain({ data: { id: 5, status: 'agendada' }, error: null })
    supabase.from.mockReturnValueOnce(fetchQuery)

    const res = await request(app)
      .patch('/api/disparo/campanhas/5')
      .set('Authorization', `Bearer ${token()}`)
      .send({ nome: 'Alterado' })

    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/rascunho|congelada|alterar|configurando/i)
  })

  // ── Arquivar ────────────────────────────────────────────────────────────────

  it('bloqueia arquivar campanha em execução (422)', async () => {
    const fetchQuery = mockChain({ data: { id: 7, status: 'em_execucao' }, error: null })
    supabase.from.mockReturnValueOnce(fetchQuery)

    const res = await request(app)
      .post('/api/disparo/campanhas/7/arquivar')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/execu/i)
  })

  it('bloqueia arquivar campanha já arquivada (422)', async () => {
    const fetchQuery = mockChain({ data: { id: 8, status: 'arquivada' }, error: null })
    supabase.from.mockReturnValueOnce(fetchQuery)

    const res = await request(app)
      .post('/api/disparo/campanhas/8/arquivar')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/arquivada/i)
  })

  // ── Restaurar ───────────────────────────────────────────────────────────────

  it('bloqueia restaurar campanha que não está arquivada (422)', async () => {
    const fetchQuery = mockChain({ data: { id: 9, status: 'rascunho' }, error: null })
    supabase.from.mockReturnValueOnce(fetchQuery)

    const res = await request(app)
      .post('/api/disparo/campanhas/9/restaurar')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/arquivada/i)
  })

  // ── Resumo ──────────────────────────────────────────────────────────────────

  it('retorna resumo de campanhas para admin', async () => {
    const resumoQuery = mockChain({
      data: [
        { status: 'rascunho' },
        { status: 'rascunho' },
        { status: 'agendada' },
        { status: 'concluida' },
      ],
      error: null,
    })
    supabase.from.mockReturnValueOnce(resumoQuery)

    const res = await request(app)
      .get('/api/disparo/campanhas/resumo')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      total: 4,
      rascunho: 2,
      agendada: 1,
      concluida: 1,
    })
    expect(resumoQuery.eq).toHaveBeenCalledWith('company_id', 10)
  })
})
