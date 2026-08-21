/**
 * Testes: módulo Disparo de Mensagens — destinatários e importação de planilha.
 * Cobre: segurança, isolamento multi-tenant, busca de contatos, add,
 *        preview/confirm importação, normalização de telefone, duplicatas,
 *        remoção e persistência.
 */

const request = require('supertest')
const jwt = require('jsonwebtoken')
const ExcelJS = require('exceljs')
const supabase = require('../config/supabase')
const { validarTelefoneDisparo } = require('../helpers/disparoPhoneHelper')
const { planejarImportacao, detectMappingAuto } = require('../helpers/disparoPlanilhaHelper')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'disparo-test-secret'
const app = require('../app')

// ── Helpers ───────────────────────────────────────────────────────────────────

function token(payload = {}) {
  return jwt.sign(
    { id: 5, company_id: 10, perfil: 'admin', ...payload },
    process.env.JWT_SECRET,
  )
}

const ADMIN_TOKEN = token()
const ATENDENTE_TOKEN = token({ perfil: 'atendente' })

function mockChain(result) {
  const chain = {}
  const methods = [
    'select', 'eq', 'neq', 'is', 'in', 'not', 'ilike', 'or',
    'gte', 'lte', 'gt', 'lt', 'limit', 'order', 'range',
    'insert', 'update', 'delete', 'upsert',
  ]
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

/** Gera buffer xlsx a partir de rows (primeiro row = headers). */
async function buildXlsx(rows) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Dados')
  rows.forEach(row => ws.addRow(row))
  return wb.xlsx.writeBuffer()
}

// ── Testes unitários: disparoPhoneHelper ──────────────────────────────────────

describe('disparoPhoneHelper — validarTelefoneDisparo', () => {
  it('aceita número BR 11 dígitos (celular)', () => {
    const r = validarTelefoneDisparo('34999991234')
    expect(r.valido).toBe(true)
    expect(r.normalizado).toBe('5534999991234')
  })

  it('aceita número BR com 55 prefixo já presente', () => {
    const r = validarTelefoneDisparo('5534999991234')
    expect(r.valido).toBe(true)
    expect(r.normalizado).toBe('5534999991234')
  })

  it('aceita número BR 10 dígitos (fixo)', () => {
    const r = validarTelefoneDisparo('3432001234')
    expect(r.valido).toBe(true)
    expect(r.normalizado).toBe('553432001234')
  })

  it('rejeita telefone ausente', () => {
    const r = validarTelefoneDisparo('')
    expect(r.valido).toBe(false)
    expect(r.motivo).toMatch(/ausente/i)
  })

  it('rejeita número muito longo', () => {
    const r = validarTelefoneDisparo('5534999991234567890')
    expect(r.valido).toBe(false)
    expect(r.motivo).toMatch(/longo/i)
  })

  it('rejeita DDD inválido (99 não existe em DDDs brasileiros?)', () => {
    // DDD 99 é válido (Maranhão), então testamos DDD 00
    const r = validarTelefoneDisparo('5500999991234')
    expect(r.valido).toBe(false)
  })

  it('preserva o telefone original', () => {
    const r = validarTelefoneDisparo('(34) 9 9999-1234')
    expect(r.original).toBe('(34) 9 9999-1234')
    expect(r.valido).toBe(true)
  })

  it('rejeita string sem dígitos', () => {
    const r = validarTelefoneDisparo('abc def')
    expect(r.valido).toBe(false)
  })
})

// ── Testes unitários: disparoPlanilhaHelper ───────────────────────────────────

describe('disparoPlanilhaHelper — planejarImportacao', () => {
  const headers = ['Nome', 'Telefone', 'Cidade']

  it('processa linha válida corretamente', () => {
    const rows = [['João Silva', '5534999991234', 'Uberlândia']]
    const mapping = { nome: 0, telefone: 1 }
    const plano = planejarImportacao(headers, rows, mapping)
    expect(plano.valid).toHaveLength(1)
    expect(plano.valid[0].nome).toBe('João Silva')
    expect(plano.valid[0].telefone_normalizado).toBe('5534999991234')
    expect(plano.invalid).toHaveLength(0)
  })

  it('rejeita linha sem nome', () => {
    const rows = [['', '5534999991234', 'SP']]
    const plano = planejarImportacao(headers, [['', '5534999991234', 'SP']], { nome: 0, telefone: 1 })
    expect(plano.invalid).toHaveLength(1)
    expect(plano.invalid[0].motivo).toMatch(/nome ausente/i)
  })

  it('rejeita linha sem telefone', () => {
    const plano = planejarImportacao(headers, [['Maria', '', 'SP']], { nome: 0, telefone: 1 })
    expect(plano.invalid).toHaveLength(1)
    expect(plano.invalid[0].motivo).toMatch(/ausente/i)
  })

  it('rejeita telefone inválido', () => {
    const plano = planejarImportacao(headers, [['Maria', 'abc123', 'SP']], { nome: 0, telefone: 1 })
    expect(plano.invalid).toHaveLength(1)
    expect(plano.invalid[0].motivo).toMatch(/inválido/i)
  })

  it('detecta duplicata dentro da planilha', () => {
    const rows = [
      ['João', '5534999991234', 'SP'],
      ['João Clone', '5534999991234', 'MG'],
    ]
    const plano = planejarImportacao(headers, rows, { nome: 0, telefone: 1 })
    expect(plano.valid).toHaveLength(1)
    expect(plano.invalid).toHaveLength(1)
    expect(plano.invalid[0].motivo).toMatch(/duplicado/i)
  })

  it('detecta número já na campanha', () => {
    const rows = [['João', '5534999991234', 'SP']]
    const jaExistentes = new Set(['5534999991234'])
    const plano = planejarImportacao(headers, rows, { nome: 0, telefone: 1 }, jaExistentes)
    expect(plano.invalid).toHaveLength(1)
    expect(plano.invalid[0].motivo).toMatch(/já incluído/i)
  })

  it('salva colunas extras como variáveis', () => {
    const rows = [['Maria', '5534999991234', 'Uberlândia']]
    const plano = planejarImportacao(headers, rows, { nome: 0, telefone: 1 })
    expect(plano.valid[0].variaveis).toEqual({ cidade: 'Uberlândia' })
  })

  it('ignora linhas completamente vazias', () => {
    const rows = [['', '', ''], ['Ana', '5511999881234', 'SP']]
    const plano = planejarImportacao(headers, rows, { nome: 0, telefone: 1 })
    expect(plano.valid).toHaveLength(1)
    expect(plano.stats.totalLinhas).toBe(2)
  })
})

describe('disparoPlanilhaHelper — detectMappingAuto', () => {
  it('detecta "Nome" e "Telefone" automaticamente', () => {
    const m = detectMappingAuto(['Nome', 'Telefone', 'Cidade'])
    expect(m.nome).toBe(0)
    expect(m.telefone).toBe(1)
  })

  it('detecta "Cliente" como nome', () => {
    const m = detectMappingAuto(['Cliente', 'Celular'])
    expect(m.nome).toBe(0)
    expect(m.telefone).toBe(1)
  })

  it('detecta "WhatsApp" como telefone', () => {
    const m = detectMappingAuto(['Responsável', 'WhatsApp'])
    expect(m.nome).toBe(0)
    expect(m.telefone).toBe(1)
  })

  it('retorna null quando não encontra coluna', () => {
    const m = detectMappingAuto(['Produto', 'Valor', 'Código'])
    expect(m.nome).toBeNull()
    expect(m.telefone).toBeNull()
  })
})

// ── Testes de integração HTTP ─────────────────────────────────────────────────

describe('Disparo Destinatários — segurança e isolamento', () => {
  beforeEach(() => jest.clearAllMocks())
  afterEach(() => jest.restoreAllMocks())

  it('rejeita GET /destinatarios sem token (401)', async () => {
    const res = await request(app).get('/api/disparo/campanhas/1/destinatarios')
    expect(res.status).toBe(401)
  })

  it('bloqueia atendente em GET /destinatarios (403)', async () => {
    const res = await request(app)
      .get('/api/disparo/campanhas/1/destinatarios')
      .set('Authorization', `Bearer ${ATENDENTE_TOKEN}`)
    expect(res.status).toBe(403)
  })

  it('bloqueia atendente em POST /add-contatos (403)', async () => {
    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/add-contatos')
      .set('Authorization', `Bearer ${ATENDENTE_TOKEN}`)
    expect(res.status).toBe(403)
  })

  it('bloqueia atendente em POST /preview (403)', async () => {
    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/preview')
      .set('Authorization', `Bearer ${ATENDENTE_TOKEN}`)
    expect(res.status).toBe(403)
  })

  it('retorna 404 para campanha de outra empresa', async () => {
    jest.spyOn(supabase, 'from').mockReturnValue(mockChain({ data: null, error: null, count: 0 }))
    const res = await request(app)
      .get('/api/disparo/campanhas/999/destinatarios')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    expect(res.status).toBe(404)
  })

  it('rejeita campanhaId inválido (400)', async () => {
    const res = await request(app)
      .get('/api/disparo/campanhas/abc/destinatarios')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    expect(res.status).toBe(400)
  })
})

describe('Disparo Destinatários — busca de contatos ZapERP', () => {
  beforeEach(() => jest.clearAllMocks())
  afterEach(() => jest.restoreAllMocks())

  it('retorna contatos da empresa com isolamento de company_id', async () => {
    let fromCalls = 0
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      fromCalls++
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      if (table === 'clientes') {
        return mockChain({
          data: [{ id: 1, nome: 'Fulano', telefone: '5534999991234', wa_id: null }],
          error: null,
          count: 1,
        })
      }
      if (table === 'disparo_campanha_destinatarios') {
        return mockChain({ data: [], error: null, count: 0 })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const res = await request(app)
      .get('/api/disparo/campanhas/1/contatos?search=Fulano')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)

    expect(res.status).toBe(200)
    expect(res.body.contatos).toBeDefined()
  })

  it('busca contatos sem exigir conversa', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      if (table === 'clientes') {
        // Contato sem conversa
        return mockChain({ data: [{ id: 99, nome: 'Sem Conversa', telefone: '5511999881234', wa_id: null }], error: null, count: 1 })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const res = await request(app)
      .get('/api/disparo/campanhas/1/contatos')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)

    expect(res.status).toBe(200)
    expect(res.body.contatos.length).toBeGreaterThan(0)
  })
})

describe('Disparo Destinatários — add contatos', () => {
  beforeEach(() => jest.clearAllMocks())
  afterEach(() => jest.restoreAllMocks())

  it('adiciona contatos salvos à campanha', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      if (table === 'clientes') {
        return mockChain({ data: [{ id: 1, nome: 'Fulano', telefone: '5534999991234', wa_id: null }], error: null })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/add-contatos')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ cliente_ids: [1] })

    expect(res.status).toBe(200)
    expect(res.body.inseridos).toBeDefined()
  })

  it('ignora contato com telefone inválido', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      if (table === 'clientes') {
        return mockChain({ data: [{ id: 1, nome: 'Inválido', telefone: 'abc', wa_id: null }], error: null })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/add-contatos')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ cliente_ids: [1] })

    expect(res.status).toBe(200)
    expect(res.body.ignorados.length).toBe(1)
  })

  it('bloqueia add-contatos em campanha não editável', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'em_execucao', company_id: 10 }, error: null })
      }
      return mockChain({ data: [], error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/add-contatos')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ cliente_ids: [1] })

    expect(res.status).toBe(422)
  })

  it('retorna 400 quando lista de cliente_ids está vazia', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      return mockChain({ data: [], error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/add-contatos')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ cliente_ids: [] })

    expect(res.status).toBe(400)
  })
})

describe('Disparo Destinatários — preview e importação de planilha', () => {
  beforeEach(() => jest.clearAllMocks())
  afterEach(() => jest.restoreAllMocks())

  it('preview retorna stats de válidas e inválidas', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const buffer = await buildXlsx([
      ['Nome', 'Telefone'],
      ['João', '5534999991234'],
      ['Sem fone', ''],
      ['Inválido', 'abc'],
    ])

    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/preview')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .attach('arquivo', buffer, 'lista.xlsx')

    expect(res.status).toBe(200)
    expect(res.body.stats.validas).toBe(1)
    expect(res.body.stats.invalidas).toBe(2)
  })

  it('preview sem arquivo retorna 400', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/preview')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)

    expect(res.status).toBe(400)
  })

  it('confirmar importação insere destinatários válidos', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const buffer = await buildXlsx([
      ['Nome', 'Celular'],
      ['Ana Lima', '5511988881234'],
      ['Pedro Costa', '5521977771234'],
    ])

    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/confirmar-importacao')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .attach('arquivo', buffer, 'contatos.xlsx')

    expect(res.status).toBe(200)
    expect(res.body.inseridos).toBe(2)
    expect(res.body.rejeitados).toHaveLength(0)
  })

  it('arquivo inválido (não xlsx/csv) retorna 400', async () => {
    jest.spyOn(supabase, 'from').mockReturnValue(mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null }))

    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/preview')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .attach('arquivo', Buffer.from('not a spreadsheet'), 'foto.jpg')

    expect(res.status).toBe(400)
  })

  it('detecta duplicidade entre planilha e campanha existente', async () => {
    const existente = '5534999991234'
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      if (table === 'disparo_campanha_destinatarios') {
        return mockChain({ data: [{ telefone_normalizado: existente }], error: null, count: 1 })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const buffer = await buildXlsx([
      ['Nome', 'Telefone'],
      ['Duplicado', existente],
      ['Novo', '5511988881234'],
    ])

    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/preview')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .attach('arquivo', buffer, 'lista.xlsx')

    expect(res.status).toBe(200)
    expect(res.body.stats.validas).toBe(1)
    const duplicado = res.body.rejeitados.find(r => r.motivo?.includes('campanha'))
    expect(duplicado).toBeDefined()
  })

  it('colunas extras viram variáveis JSONB', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const buffer = await buildXlsx([
      ['Nome', 'Telefone', 'Cidade', 'Vendedor'],
      ['Maria', '5534999991234', 'Uberlândia', 'João'],
    ])

    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/preview')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .attach('arquivo', buffer, 'lista.xlsx')

    expect(res.status).toBe(200)
    expect(res.body.colunas_extras.map(c => c.chave)).toEqual(expect.arrayContaining(['cidade', 'vendedor']))
  })

  it('bloqueia importação em campanha em execução', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'em_execucao', company_id: 10 }, error: null })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const buffer = await buildXlsx([['Nome', 'Telefone'], ['A', '5534999991234']])

    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/preview')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .attach('arquivo', buffer, 'lista.xlsx')

    expect(res.status).toBe(422)
  })
})

describe('Disparo Destinatários — remoção', () => {
  beforeEach(() => jest.clearAllMocks())
  afterEach(() => jest.restoreAllMocks())

  it('remove destinatário individual (200)', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      return mockChain({ data: { id: 1 }, error: null })
    })

    const res = await request(app)
      .delete('/api/disparo/campanhas/1/destinatarios/7')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('remove vários destinatários de uma vez', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/destinatarios/remover-varios')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ ids: [1, 2, 3] })

    expect(res.status).toBe(200)
    expect(res.body.removidos).toBe(3)
  })

  it('limpa todos com confirmado=true', async () => {
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null })
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .delete('/api/disparo/campanhas/1/destinatarios?confirmado=true')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('bloqueia limpar sem confirmado=true', async () => {
    jest.spyOn(supabase, 'from').mockReturnValue(mockChain({ data: { id: 1, status: 'rascunho', company_id: 10 }, error: null }))

    const res = await request(app)
      .delete('/api/disparo/campanhas/1/destinatarios')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)

    expect(res.status).toBe(400)
  })
})

describe('Disparo Destinatários — persistência ao sair e retornar', () => {
  beforeEach(() => jest.clearAllMocks())
  afterEach(() => jest.restoreAllMocks())

  it('lista destinatários salvos ao retornar ao wizard', async () => {
    const saved = [
      { id: 1, nome: 'Fulano', telefone_normalizado: '5534999991234', origem: 'contato_salvo', status: 'pendente', criado_em: new Date().toISOString() },
      { id: 2, nome: 'Ciclano', telefone_normalizado: '5511999881234', origem: 'importacao_planilha', status: 'pendente', criado_em: new Date().toISOString() },
    ]

    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { id: 1, status: 'configurando', company_id: 10 }, error: null })
      }
      if (table === 'disparo_campanha_destinatarios') {
        return mockChain({ data: saved, error: null, count: 2 })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const res = await request(app)
      .get('/api/disparo/campanhas/1/destinatarios')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)

    expect(res.status).toBe(200)
    expect(res.body.destinatarios).toHaveLength(2)
    expect(res.body.total).toBe(2)
  })
})
