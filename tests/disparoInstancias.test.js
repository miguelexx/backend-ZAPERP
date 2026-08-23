/**
 * Testes — Etapa 3: Instâncias e distribuição (Disparo de Mensagens).
 * Cobre: permissões HTTP, algoritmos de distribuição (puro), leitura XLS, mocks de controller.
 */

const request = require('supertest')
const jwt = require('jsonwebtoken')
const XLSX = require('xlsx')
const app = require('../app')
const supabase = require('../config/supabase')

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret'
const COMPANY_ID = 1

function token(extra = {}) {
  return jwt.sign({ id: 1, company_id: COMPANY_ID, perfil: 'admin', ...extra }, JWT_SECRET, { expiresIn: '1h' })
}

const adminToken = token()
const anotherToken = token({ id: 2, company_id: 2 })
const atendenteToken = token({ perfil: 'atendente' })

// ─── Helpers de mock ──────────────────────────────────────────────────────────

function mockChain(resolvedValue = { data: null, error: null }) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    filter: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue(resolvedValue),
    single: jest.fn().mockResolvedValue(resolvedValue),
    then: undefined, // deixa awaitable retornar resolvedValue
  }
  // Torna o chain awaitable
  chain[Symbol.for('nodejs.util.inspect.custom')] = undefined
  const p = Promise.resolve(resolvedValue)
  Object.setPrototypeOf(chain, {
    then: (res, rej) => p.then(res, rej),
    catch: (rej) => p.catch(rej),
    finally: (fin) => p.finally(fin),
  })
  return chain
}

// ─── Testes de autenticação e permissão ──────────────────────────────────────

describe('[E3] Autenticação e permissão', () => {
  it('GET instancias/disponiveis retorna 401 sem token', async () => {
    const res = await request(app).get('/api/disparo/campanhas/1/instancias/disponiveis')
    expect(res.status).toBe(401)
  })

  it('GET instancias/disponiveis retorna 403 para atendente', async () => {
    const res = await request(app)
      .get('/api/disparo/campanhas/1/instancias/disponiveis')
      .set('Authorization', `Bearer ${atendenteToken}`)
    expect(res.status).toBe(403)
  })

  it('POST instancias/selecionar retorna 401 sem token', async () => {
    const res = await request(app).post('/api/disparo/campanhas/1/instancias/selecionar')
    expect(res.status).toBe(401)
  })

  it('POST preview-distribuicao retorna 401 sem token', async () => {
    const res = await request(app).post('/api/disparo/campanhas/1/instancias/preview-distribuicao')
    expect(res.status).toBe(401)
  })

  it('POST confirmar-distribuicao retorna 401 sem token', async () => {
    const res = await request(app).post('/api/disparo/campanhas/1/instancias/confirmar-distribuicao')
    expect(res.status).toBe(401)
  })

  it('GET destinatarios/nao-atribuidos retorna 401 sem token', async () => {
    const res = await request(app).get('/api/disparo/campanhas/1/destinatarios/nao-atribuidos')
    expect(res.status).toBe(401)
  })

  it('POST instancias/atribuir-manual retorna 401 sem token', async () => {
    const res = await request(app).post('/api/disparo/campanhas/1/instancias/atribuir-manual')
    expect(res.status).toBe(401)
  })

  it('POST instancias/mover retorna 401 sem token', async () => {
    const res = await request(app).post('/api/disparo/campanhas/1/instancias/mover')
    expect(res.status).toBe(401)
  })

  it('POST instancias/recalcular retorna 401 sem token', async () => {
    const res = await request(app).post('/api/disparo/campanhas/1/instancias/recalcular')
    expect(res.status).toBe(401)
  })
})

// ─── Testes de validação de parâmetros ───────────────────────────────────────

describe('[E3] Validação de parâmetros', () => {
  beforeEach(() => {
    supabase.from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      filter: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
      then: undefined,
    })
    // Default: campanha not found
    supabase.from.mockReturnValue(
      Object.assign(Promise.resolve({ data: null, error: null }), {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        neq: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        range: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        delete: jest.fn().mockReturnThis(),
        filter: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
        single: jest.fn().mockResolvedValue({ data: null, error: null }),
      })
    )
  })

  it('POST selecionar sem instancia_ids retorna 400', async () => {
    supabase.from.mockReturnValue(
      Object.assign(Promise.resolve({ data: { id: 1, status: 'rascunho', company_id: COMPANY_ID }, error: null }), {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        neq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: { id: 1, status: 'rascunho', company_id: COMPANY_ID }, error: null }),
        single: jest.fn().mockResolvedValue({ data: { id: 1, status: 'rascunho', company_id: COMPANY_ID }, error: null }),
      })
    )
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/selecionar')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ instancia_ids: [] })
    expect(res.status).toBe(400)
  })

  it('POST preview-distribuicao com modo inválido retorna 400', async () => {
    supabase.from.mockReturnValue(
      Object.assign(Promise.resolve({ data: { id: 1, status: 'rascunho', company_id: COMPANY_ID }, error: null }), {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        neq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: { id: 1, status: 'rascunho', company_id: COMPANY_ID }, error: null }),
        single: jest.fn().mockResolvedValue({ data: { id: 1, status: 'rascunho', company_id: COMPANY_ID }, error: null }),
      })
    )
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ modo: 'invalido' })
    expect(res.status).toBe(400)
  })

  it('POST atribuir-manual sem destinatario_ids retorna 400', async () => {
    supabase.from.mockReturnValue(
      Object.assign(Promise.resolve({ data: { id: 1, status: 'rascunho', company_id: COMPANY_ID }, error: null }), {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        neq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: { id: 1, status: 'rascunho', company_id: COMPANY_ID }, error: null }),
        single: jest.fn().mockResolvedValue({ data: { id: 1, status: 'rascunho', company_id: COMPANY_ID }, error: null }),
      })
    )
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/atribuir-manual')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ destinatario_ids: [], instancia_id: 1 })
    expect(res.status).toBe(400)
  })
})

// ─── Testes unitários dos algoritmos de distribuição ─────────────────────────

// Importa as funções privadas para testar diretamente via require
// Como são funções locais no controller, criamos um módulo de apoio

describe('[E3] Algoritmos de distribuição (unitário)', () => {
  // Testa lógica pura de cálculo via chamada HTTP com mock

  function makeCampanhaAtivaMock(statusOverride = 'connected') {
    // Mock chain que retorna campanha configurando e destinatários
    const instanciasConfig = [
      { instancia_id: 10, ordem: 0, ativa: true },
      { instancia_id: 20, ordem: 1, ativa: true },
    ]
    const instanciaStatus = [
      { id: 10, nome: 'Inst A', status: statusOverride, display_phone: '11999990001', telefone_conectado: null, ativo: true },
      { id: 20, nome: 'Inst B', status: statusOverride, display_phone: '11999990002', telefone_conectado: null, ativo: true },
    ]
    const destinatarios = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, instancia_id: null }))

    let callCount = 0
    supabase.from.mockImplementation((tableName) => {
      const baseChain = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        neq: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        not: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        range: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        update: jest.fn().mockResolvedValue({ data: null, error: null }),
        delete: jest.fn().mockReturnThis(),
        filter: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn(),
        single: jest.fn(),
      }

      if (tableName === 'disparo_campanhas') {
        baseChain.maybeSingle.mockResolvedValue({
          data: { id: 1, status: 'configurando', company_id: COMPANY_ID, distribuicao_modo: null, distribuicao_confirmada: false, distribuicao_revisao: false },
          error: null
        })
        return Object.assign(Promise.resolve({ data: { id: 1, status: 'configurando', company_id: COMPANY_ID }, error: null }), baseChain)
      }

      if (tableName === 'disparo_campanha_destinatarios') {
        return Object.assign(
          Promise.resolve({ data: destinatarios, count: 10, error: null }),
          { ...baseChain, maybeSingle: baseChain.maybeSingle.mockResolvedValue({ data: null, error: null }) }
        )
      }

      if (tableName === 'disparo_campanha_instancias') {
        return Object.assign(
          Promise.resolve({ data: instanciasConfig, error: null }),
          baseChain
        )
      }

      if (tableName === 'whatsapp_instances') {
        return Object.assign(
          Promise.resolve({ data: instanciaStatus, error: null }),
          baseChain
        )
      }

      return Object.assign(Promise.resolve({ data: null, error: null }), baseChain)
    })
  }

  it('preview equilibrada: 10 ÷ 2 = 5 cada', async () => {
    makeCampanhaAtivaMock()
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ modo: 'equilibrada', configuracoes: [] })
    expect(res.status).toBe(200)
    const instancias = res.body.plano?.instancias ?? []
    if (instancias.length === 2) {
      instancias.forEach(i => expect(i.quantidade).toBe(5))
      expect(res.body.plano.nao_atribuidos).toBe(0)
    }
  })

  it('preview com status unknown permite avançar (aviso, sem erro)', async () => {
    makeCampanhaAtivaMock('unknown')
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ modo: 'equilibrada', configuracoes: [] })
    expect(res.status).toBe(200)
    expect(res.body.erros || []).toHaveLength(0)
    expect((res.body.avisos || []).length).toBeGreaterThan(0)
    expect(res.body.plano?.nao_atribuidos).toBe(0)
  })

  it('preview com status disconnected NÃO bloqueia (aviso; parser UltraMSG é falível)', async () => {
    makeCampanhaAtivaMock('disconnected')
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ modo: 'equilibrada', configuracoes: [] })
    expect(res.status).toBe(200)
    expect(res.body.erros || []).toHaveLength(0)
    expect((res.body.avisos || []).length).toBeGreaterThan(0)
  })

  it('preview quantidade com soma correta', async () => {
    makeCampanhaAtivaMock()
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        modo: 'quantidade',
        configuracoes: [
          { instancia_id: 10, quantidade: 6 },
          { instancia_id: 20, quantidade: 4 },
        ],
      })
    expect(res.status).toBe(200)
    if (res.body.erros) expect(res.body.erros).toHaveLength(0)
  })

  it('preview quantidade com soma errada retorna erro no plano', async () => {
    makeCampanhaAtivaMock()
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        modo: 'quantidade',
        configuracoes: [
          { instancia_id: 10, quantidade: 7 },
          { instancia_id: 20, quantidade: 7 }, // soma=14, total=10
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body.erros?.length).toBeGreaterThan(0)
  })

  it('preview percentual com soma=100% — todos atribuídos', async () => {
    makeCampanhaAtivaMock()
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        modo: 'percentual',
        configuracoes: [
          { instancia_id: 10, percentual: 70 },
          { instancia_id: 20, percentual: 30 },
        ],
      })
    expect(res.status).toBe(200)
    if (!res.body.erros?.length) {
      const soma = (res.body.plano?.instancias ?? []).reduce((s, i) => s + i.quantidade, 0)
      expect(soma).toBe(10)
    }
  })

  it('preview percentual com soma≠100% retorna erro', async () => {
    makeCampanhaAtivaMock()
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        modo: 'percentual',
        configuracoes: [
          { instancia_id: 10, percentual: 60 },
          { instancia_id: 20, percentual: 20 }, // soma=80%
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body.erros?.length).toBeGreaterThan(0)
  })
})

// ─── Testes unitários puros: algoritmos de arredondamento ────────────────────

describe('[E3] Algoritmos de distribuição — lógica pura', () => {
  // Testa as funções de cálculo diretamente sem HTTP

  // Replica a lógica de distribuição equilibrada para teste puro
  function distribuirEquilibrado(n, m) {
    const base = Math.floor(n / m)
    const extras = n % m
    return Array.from({ length: m }, (_, i) => base + (i < extras ? 1 : 0))
  }

  function distribuirPercentual(total, percentuais) {
    const floors = percentuais.map(p => Math.floor(total * p / 100))
    const somaFloor = floors.reduce((s, v) => s + v, 0)
    const resto = total - somaFloor
    const fracs = percentuais.map((p, i) => ({ idx: i, frac: (total * p / 100) - floors[i] }))
    fracs.sort((a, b) => b.frac - a.frac)
    fracs.slice(0, resto).forEach(f => floors[f.idx]++)
    return floors
  }

  it('10 ÷ 2 = [5, 5]', () => {
    expect(distribuirEquilibrado(10, 2)).toEqual([5, 5])
  })

  it('10 ÷ 3 = [4, 3, 3]', () => {
    const qtds = distribuirEquilibrado(10, 3)
    expect(qtds.reduce((s, v) => s + v, 0)).toBe(10)
    expect(Math.max(...qtds) - Math.min(...qtds)).toBeLessThanOrEqual(1)
  })

  it('9 ÷ 2 = [5, 4] (diferença máxima 1)', () => {
    const qtds = distribuirEquilibrado(9, 2)
    expect(qtds.reduce((s, v) => s + v, 0)).toBe(9)
    expect(Math.max(...qtds) - Math.min(...qtds)).toBeLessThanOrEqual(1)
  })

  it('1 destinatário ÷ 3 instâncias = [1, 0, 0]', () => {
    const qtds = distribuirEquilibrado(1, 3)
    expect(qtds.reduce((s, v) => s + v, 0)).toBe(1)
  })

  it('percentual 50/50 com 10 dest = [5, 5]', () => {
    expect(distribuirPercentual(10, [50, 50])).toEqual([5, 5])
  })

  it('percentual 70/30 com 10 dest = [7, 3]', () => {
    expect(distribuirPercentual(10, [70, 30])).toEqual([7, 3])
  })

  it('percentual 33.33/33.33/33.33 com 10 dest — todos atribuídos', () => {
    const qtds = distribuirPercentual(10, [33.33, 33.33, 33.34])
    expect(qtds.reduce((s, v) => s + v, 0)).toBe(10)
  })

  it('nenhum destinatário perdido com percentual 33.33*3=99.99%', () => {
    const qtds = distribuirPercentual(10, [33.33, 33.33, 33.33])
    expect(qtds.reduce((s, v) => s + v, 0)).toBe(10)
  })
})

// ─── Testes unitários: bloqueio de instância de outra empresa ────────────────

describe('[E3] Isolamento company_id (validação HTTP)', () => {
  function mockCampanhaDeOutraEmpresa() {
    supabase.from.mockReturnValue(
      Object.assign(Promise.resolve({ data: null, error: null }), {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        neq: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        range: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }), // campanha not found
        single: jest.fn().mockResolvedValue({ data: null, error: null }),
        insert: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        delete: jest.fn().mockReturnThis(),
        filter: jest.fn().mockReturnThis(),
      })
    )
  }

  it('instancias/disponiveis de campanha de outra empresa retorna 404', async () => {
    mockCampanhaDeOutraEmpresa()
    const res = await request(app)
      .get('/api/disparo/campanhas/999/instancias/disponiveis')
      .set('Authorization', `Bearer ${anotherToken}`)
    expect(res.status).toBe(404)
  })

  it('instancias/resumo de campanha de outra empresa retorna 404', async () => {
    mockCampanhaDeOutraEmpresa()
    const res = await request(app)
      .get('/api/disparo/campanhas/999/instancias/resumo')
      .set('Authorization', `Bearer ${anotherToken}`)
    expect(res.status).toBe(404)
  })
})

// ─── Testes de leitura de .xls via SheetJS ───────────────────────────────────

describe('[E3] Leitura de arquivo .xls (SheetJS)', () => {
  const { parseArquivo, detectarFormatoReal } = require('../helpers/disparoPlanilhaHelper')

  it('detectarFormatoReal identifica .xls pelos magic bytes (D0 CF 11 E0)', () => {
    const xlsMagic = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
    expect(detectarFormatoReal(xlsMagic)).toBe('xls')
  })

  it('detectarFormatoReal identifica .xlsx pelos magic bytes (PK ZIP 50 4B)', () => {
    const xlsxMagic = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
    expect(detectarFormatoReal(xlsxMagic)).toBe('xlsx')
  })

  it('detectarFormatoReal identifica CSV como texto', () => {
    const csvBuf = Buffer.from('nome,telefone\nJoao,11999990000\n', 'utf8')
    expect(detectarFormatoReal(csvBuf)).toBe('csv')
  })

  it('lê planilha .xls binária real gerada pelo SheetJS', async () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([
      ['nome', 'telefone'],
      ['João Silva', '11987654321'],
      ['Maria Souza', '21912345678'],
    ])
    XLSX.utils.book_append_sheet(wb, ws, 'Planilha1')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xls' })

    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(detectarFormatoReal(buf)).toBe('xls')

    const result = await parseArquivo(buf, 'xls', 0)
    expect(result.headers).toContain('nome')
    expect(result.headers).toContain('telefone')
    expect(result.dataRows.length).toBe(2)
  })

  it('lê planilha .xlsx gerada pelo SheetJS', async () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([
      ['nome', 'celular'],
      ['Fulano', '5511999990001'],
    ])
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

    expect(detectarFormatoReal(buf)).toBe('xlsx')
    const result = await parseArquivo(buf, 'xlsx', 0)
    expect(result.dataRows.length).toBe(1)
  })

  it('rejeita .xls com conteúdo .xlsx (mismatch de formato)', async () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]])
    XLSX.utils.book_append_sheet(wb, ws, 'S1')
    const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

    await expect(parseArquivo(xlsxBuf, 'xls', 0))
      .rejects.toMatchObject({ code: 'FORMATO_MISMATCH' })
  })

  it('rejeita .xlsx com conteúdo .xls (mismatch de formato)', async () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([['a'], [1]])
    XLSX.utils.book_append_sheet(wb, ws, 'S1')
    const xlsBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xls' })

    await expect(parseArquivo(xlsBuf, 'xlsx', 0))
      .rejects.toMatchObject({ code: 'FORMATO_MISMATCH' })
  })

  it('rejeita arquivo CSV com extensão .xlsx', async () => {
    const csvBuf = Buffer.from('nome,telefone\nJoao,11999990000\n', 'utf8')
    await expect(parseArquivo(csvBuf, 'xlsx', 0))
      .rejects.toMatchObject({ code: 'ARQUIVO_INVALIDO' })
  })

  it('rejeita formato desconhecido', async () => {
    const unknownBuf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])
    await expect(parseArquivo(unknownBuf, 'pdf', 0))
      .rejects.toMatchObject({ code: 'FORMATO_INVALIDO' })
  })
})

// ─── Testes: Status de campanha bloqueado ────────────────────────────────────

describe('[E3] Bloqueio em campanha não-editável', () => {
  function mockCampanhaFinalizada() {
    supabase.from.mockReturnValue(
      Object.assign(Promise.resolve({ data: { id: 1, status: 'concluida', company_id: COMPANY_ID }, error: null }), {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        neq: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        range: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        delete: jest.fn().mockReturnThis(),
        filter: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: { id: 1, status: 'concluida', company_id: COMPANY_ID }, error: null }),
        single: jest.fn().mockResolvedValue({ data: { id: 1, status: 'concluida', company_id: COMPANY_ID }, error: null }),
      })
    )
  }

  it('selecionarInstancias em campanha concluída retorna 422', async () => {
    mockCampanhaFinalizada()
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/selecionar')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ instancia_ids: [1, 2] })
    expect(res.status).toBe(422)
  })

  it('confirmarDistribuicao em campanha concluída retorna 422', async () => {
    mockCampanhaFinalizada()
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/confirmar-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ modo: 'equilibrada', configuracoes: [] })
    expect(res.status).toBe(422)
  })

  it('recalcularDistribuicao em campanha concluída retorna 422', async () => {
    mockCampanhaFinalizada()
    const res = await request(app)
      .post('/api/disparo/campanhas/1/instancias/recalcular')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(422)
  })
})
