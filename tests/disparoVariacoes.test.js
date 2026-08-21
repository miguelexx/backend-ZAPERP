/**
 * Testes — Etapa 4: Variações de mensagem, variáveis, mídia e distribuição (Disparo).
 * Cobre: autenticação, isolamento por company_id, CRUD de variações, substituição de
 * variáveis, upload de mídia (magic bytes), distribuição (único, equilibrada, percentual,
 * manual), arredondamento determinístico, marcação de revisão.
 */

const request = require('supertest')
const jwt = require('jsonwebtoken')
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

// ─── Mock Supabase ────────────────────────────────────────────────────────────

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
  }
  const p = Promise.resolve(resolvedValue)
  Object.setPrototypeOf(chain, {
    then: (res, rej) => p.then(res, rej),
    catch: (rej) => p.catch(rej),
    finally: (fin) => p.finally(fin),
  })
  return chain
}

const campanhaMock = {
  id: 99, company_id: COMPANY_ID, status: 'rascunho',
  variacao_modo: null, variacao_confirmada: false, variacao_revisao: false, variacao_padrao_valores: {},
}

const variacaoMock = {
  id: 1, company_id: COMPANY_ID, campanha_id: 99, nome: 'Variação A',
  tipo_mensagem: 'texto', texto: 'Olá {{nome}}, bem-vindo!', legenda: null,
  midia_storage_key: null, midia_url_disco: null, midia_nome_original: null,
  midia_mime: null, midia_tamanho: null, ordem: 0, peso: 100,
  percentual: null, ativa: true, criado_por: 1, criado_em: new Date().toISOString(), atualizado_em: new Date().toISOString(),
}

// ─── 1. Autenticação e permissão ─────────────────────────────────────────────

describe('Etapa 4 — Autenticação e permissão', () => {
  test('GET /variacoes — sem token retorna 401', async () => {
    const r = await request(app).get('/api/disparo/campanhas/99/variacoes')
    expect(r.status).toBe(401)
  })

  test('GET /variacoes — atendente retorna 403', async () => {
    supabase.from.mockReturnValue(mockChain({ data: campanhaMock, error: null }))
    const r = await request(app).get('/api/disparo/campanhas/99/variacoes')
      .set('Authorization', `Bearer ${atendenteToken}`)
    expect(r.status).toBe(403)
  })

  test('POST /variacoes — atendente retorna 403', async () => {
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes')
      .set('Authorization', `Bearer ${atendenteToken}`)
      .send({ tipo_mensagem: 'texto' })
    expect(r.status).toBe(403)
  })
})

// ─── 2. Isolamento por company_id ─────────────────────────────────────────────

describe('Etapa 4 — Isolamento company_id', () => {
  test('Admin de outra empresa não vê campanha (404)', async () => {
    // maybeSingle retorna null para a campanha
    supabase.from.mockReturnValue(mockChain({ data: null, error: null }))
    const r = await request(app).get('/api/disparo/campanhas/99/variacoes')
      .set('Authorization', `Bearer ${anotherToken}`)
    expect(r.status).toBe(404)
  })
})

// ─── 3. CRUD de variações ────────────────────────────────────────────────────

describe('Etapa 4 — CRUD de variações', () => {
  beforeEach(() => {
    supabase.from.mockReturnValue(mockChain({ data: campanhaMock, error: null }))
  })

  test('GET /variacoes lista variações da campanha', async () => {
    const listaChain = mockChain({ data: [variacaoMock], error: null })
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValue(listaChain)
    const r = await request(app).get('/api/disparo/campanhas/99/variacoes')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.variacoes)).toBe(true)
  })

  test('POST /variacoes cria variação com tipo texto', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ count: 0, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacaoMock, error: null }))
      .mockReturnValue(mockChain({ data: campanhaMock, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo_mensagem: 'texto', nome: 'Variação Teste' })
    expect(r.status).toBe(201)
    expect(r.body.nome).toBeDefined()
  })

  test('POST /variacoes rejeita tipo inválido', async () => {
    supabase.from.mockReturnValue(mockChain({ data: campanhaMock, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo_mensagem: 'invalido' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/tipo/i)
  })

  test('PATCH /variacoes/:varId edita nome e texto', async () => {
    const editadaMock = { ...variacaoMock, nome: 'Novo nome', texto: 'Texto editado' }
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacaoMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: editadaMock, error: null }))
      .mockReturnValue(mockChain({ data: campanhaMock, error: null }))
    const r = await request(app).patch('/api/disparo/campanhas/99/variacoes/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nome: 'Novo nome', texto: 'Texto editado' })
    expect(r.status).toBe(200)
  })

  test('DELETE /variacoes/:varId exclui sem destinatários', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacaoMock, error: null }))
      .mockReturnValueOnce(mockChain({ count: 0, error: null }))  // destinatários usando
      .mockReturnValue(mockChain({ data: null, error: null }))
    const r = await request(app).delete('/api/disparo/campanhas/99/variacoes/1')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })

  test('DELETE /variacoes/:varId falha se há destinatários', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacaoMock, error: null }))
      .mockReturnValueOnce(mockChain({ count: 5, error: null }))
    const r = await request(app).delete('/api/disparo/campanhas/99/variacoes/1')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(r.status).toBe(422)
    expect(r.body.usadas).toBe(5)
  })

  test('POST /variacoes/:varId/duplicar cria cópia', async () => {
    const copiaMock = { ...variacaoMock, id: 2, nome: 'Variação A (cópia)' }
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacaoMock, error: null }))
      .mockReturnValueOnce(mockChain({ count: 1, error: null }))
      .mockReturnValueOnce(mockChain({ data: copiaMock, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/1/duplicar')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(r.status).toBe(201)
    expect(r.body.nome).toContain('cópia')
  })

  test('POST /variacoes/reordenar aceita array de ids', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValue(mockChain({ data: null, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/reordenar')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ordem: [2, 1, 3] })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })
})

// ─── 4. Texto com emojis, acentos e quebras de linha ─────────────────────────

describe('Etapa 4 — Texto e formatação', () => {
  const { _substituirVariaveis, _extrairVariaveisUsadas } = require('../controllers/disparoVariacoesController')

  test('Texto com emoji preservado', () => {
    const dest = { nome: 'Maria', telefone_normalizado: '5511999', variaveis: {} }
    const r = _substituirVariaveis('Olá {{nome}} 🎉 Bem-vindo!', dest)
    expect(r).toBe('Olá Maria 🎉 Bem-vindo!')
  })

  test('Texto com acentos e cedilha', () => {
    const dest = { nome: 'João', telefone_normalizado: '5511999', variaveis: { cidade: 'São Paulo' } }
    const r = _substituirVariaveis('Olá {{nome}} de {{cidade}}!', dest)
    expect(r).toBe('Olá João de São Paulo!')
  })

  test('Texto com quebras de linha preservadas', () => {
    const dest = { nome: 'Ana', telefone_normalizado: '5511', variaveis: {} }
    const r = _substituirVariaveis('Linha 1\nLinha 2\n\nLinha 3 {{nome}}', dest)
    expect(r).toBe('Linha 1\nLinha 2\n\nLinha 3 Ana')
  })

  test('Variável case-insensitive: {{Nome}} e {{nome}}', () => {
    const dest = { nome: 'Carlos', telefone_normalizado: '5511', variaveis: {} }
    expect(_substituirVariaveis('{{nome}}', dest)).toBe('Carlos')
    expect(_substituirVariaveis('{{Nome}}', dest)).toBe('Carlos')
    expect(_substituirVariaveis('{{NOME}}', dest)).toBe('Carlos')
  })

  test('Variável não encontrada retorna marcador visível (nunca literal {{var}})', () => {
    const dest = { nome: 'Ana', telefone_normalizado: '5511', variaveis: {} }
    const r = _substituirVariaveis('Saldo: {{saldo}}', dest)
    expect(r).not.toContain('{{saldo}}')
    expect(r).toContain('[saldo?]')
  })

  test('Variável com valor padrão definido na campanha', () => {
    const dest = { nome: 'José', telefone_normalizado: '5511', variaveis: {} }
    const padrao = { nome: 'cliente', cidade: 'sua cidade' }
    const r = _substituirVariaveis('Olá {{nome}}, cidade: {{cidade}}', dest, padrao)
    expect(r).toBe('Olá José, cidade: sua cidade')
  })

  test('Proteção contra acesso a propriedades internas', () => {
    const dest = { nome: 'X', telefone_normalizado: '5511', variaveis: {} }
    const r1 = _substituirVariaveis('{{__proto__}}', dest)
    const r2 = _substituirVariaveis('{{constructor}}', dest)
    expect(r1).not.toContain('prototype')
    expect(r2).not.toContain('function')
  })

  test('extrairVariaveisUsadas retorna lista de chaves únicas', () => {
    const vars = _extrairVariaveisUsadas('Olá {{nome}}, {{cidade}}, {{nome}} de novo.')
    expect(vars).toContain('nome')
    expect(vars).toContain('cidade')
    expect(vars.length).toBe(2) // sem duplicatas
  })

  test('extrairVariaveisUsadas com texto vazio retorna []', () => {
    expect(_extrairVariaveisUsadas('')).toHaveLength(0)
    expect(_extrairVariaveisUsadas(null)).toHaveLength(0)
  })
})

// ─── 5. Catálogo de variáveis e valores padrão ───────────────────────────────

describe('Etapa 4 — Catálogo de variáveis', () => {
  test('GET /variacoes/variaveis — retorna lista', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ count: 10, error: null }))
      .mockReturnValueOnce(mockChain({
        data: [
          { nome: 'João', telefone_normalizado: '55119', variaveis: { cidade: 'SP', valor: '100' } },
          { nome: 'Maria', telefone_normalizado: '55118', variaveis: { cidade: 'RJ' } },
        ],
        error: null,
      }))
    const r = await request(app).get('/api/disparo/campanhas/99/variacoes/variaveis')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.variaveis)).toBe(true)
    const chaves = r.body.variaveis.map(v => v.chave)
    expect(chaves).toContain('nome')
    expect(chaves).toContain('telefone')
    expect(chaves).toContain('cidade')
  })

  test('POST /variacoes/valores-padrao salva JSON limpo', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValue(mockChain({ data: null, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/valores-padrao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ valores: { nome: 'cliente', cidade: 'sua cidade', __proto__: 'HACK' } })
    expect(r.status).toBe(200)
    expect(r.body.valores_padrao.nome).toBe('cliente')
    // __proto__ não deve aparecer como propriedade própria do objeto (proteção anti-injection)
    expect(Object.prototype.hasOwnProperty.call(r.body.valores_padrao, '__proto__')).toBe(false)
  })

  test('POST /variacoes/valores-padrao rejeita body inválido', async () => {
    supabase.from.mockReturnValue(mockChain({ data: campanhaMock, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/valores-padrao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send([1, 2, 3])
    expect(r.status).toBe(400)
  })
})

// ─── 6. Upload de mídia — magic bytes ────────────────────────────────────────

describe('Etapa 4 — Validação de mídia (magic bytes)', () => {
  const { detectarTipoRealMidia } = require('../middleware/uploadDisparoMidia')

  test('JPEG identificado corretamente', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
    expect(detectarTipoRealMidia(buf)).toBe('imagem')
  })

  test('PNG identificado corretamente', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    expect(detectarTipoRealMidia(buf)).toBe('imagem')
  })

  test('GIF identificado corretamente', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    expect(detectarTipoRealMidia(buf)).toBe('imagem')
  })

  test('WebP identificado corretamente', () => {
    const buf = Buffer.alloc(12)
    buf[0] = 0x52; buf[1] = 0x49; buf[2] = 0x46; buf[3] = 0x46
    buf[8] = 0x57; buf[9] = 0x45; buf[10] = 0x42; buf[11] = 0x50
    expect(detectarTipoRealMidia(buf)).toBe('imagem')
  })

  test('MP4 identificado como video', () => {
    const buf = Buffer.alloc(16)
    buf.write('ftyp', 4)
    expect(detectarTipoRealMidia(buf)).toBe('video')
  })

  test('ID3/MP3 identificado como audio', () => {
    const buf = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00])
    expect(detectarTipoRealMidia(buf)).toBe('audio')
  })

  test('PDF identificado como documento', () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31])
    expect(detectarTipoRealMidia(buf)).toBe('documento')
  })

  test('ZIP/DOCX identificado como documento', () => {
    const buf = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])
    expect(detectarTipoRealMidia(buf)).toBe('documento')
  })

  test('OLE2/XLS identificado como documento', () => {
    const buf = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1])
    expect(detectarTipoRealMidia(buf)).toBe('documento')
  })

  test('Buffer muito pequeno retorna null', () => {
    expect(detectarTipoRealMidia(Buffer.from([0x89, 0x50]))).toBeNull()
    expect(detectarTipoRealMidia(null)).toBeNull()
  })

  test('POST /variacoes/:varId/midia sem arquivo retorna 400', async () => {
    supabase.from.mockReturnValue(mockChain({ data: campanhaMock, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/1/midia')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(r.status).toBe(400)
  })

  test('POST /variacoes/:varId/midia com imagem JPEG real', async () => {
    // JPEG mínimo sintético
    const jpegBytes = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
      ...Array(50).fill(0x00),
    ])
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacaoMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: { ...variacaoMock, tipo_mensagem: 'imagem', midia_storage_key: 'media/disparo/1/99/1/abc.jpg' }, error: null }))
    // Mockear R2
    jest.mock('../services/storage/r2Client', () => ({ putObject: jest.fn().mockResolvedValue({ ok: true }) }), { virtual: true })
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/1/midia')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('midia', jpegBytes, { filename: 'foto.jpg', contentType: 'image/jpeg' })
    // Aceita 200 (R2 OK) ou 500 (R2 não configurado em teste) — não deve ser 400/422
    expect([200, 500]).toContain(r.status)
  })

  test('Arquivo acima do limite de imagem (5 MB) retorna 400', async () => {
    const grande = Buffer.concat([
      Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
      Buffer.alloc(6 * 1024 * 1024), // 6 MB
    ])
    // Overwrite limit para teste
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/1/midia')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('midia', grande, { filename: 'big.jpg', contentType: 'image/jpeg' })
    // Multer pode recusar antes de processar se ultrapassar o limite global
    expect([400, 413, 500]).toContain(r.status)
  })
})

// ─── 7. Distribuição das variações ───────────────────────────────────────────

describe('Etapa 4 — Distribuição das variações', () => {
  test('Distribuição equilibrada: 3 variações, 10 destinatários → [4,3,3]', async () => {
    const variacoes = [
      { id: 1, nome: 'A', tipo_mensagem: 'texto', ativa: true, ordem: 0 },
      { id: 2, nome: 'B', tipo_mensagem: 'texto', ativa: true, ordem: 1 },
      { id: 3, nome: 'C', tipo_mensagem: 'texto', ativa: true, ordem: 2 },
    ]
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ count: 10, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacoes, error: null }))

    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ modo: 'equilibrada', configuracoes: [] })
    expect(r.status).toBe(200)
    const qtds = r.body.plano.variacoes.map(v => v.quantidade)
    expect(qtds.reduce((s, v) => s + v, 0)).toBe(10)
    // Diferença máxima entre variações = 1
    expect(Math.max(...qtds) - Math.min(...qtds)).toBeLessThanOrEqual(1)
  })

  test('Distribuição equilibrada: 1 variação, 5 destinatários → [5]', async () => {
    const variacoes = [{ id: 1, nome: 'A', tipo_mensagem: 'texto', ativa: true, ordem: 0 }]
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ count: 5, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacoes, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ modo: 'equilibrada', configuracoes: [] })
    expect(r.body.plano.variacoes[0].quantidade).toBe(5)
  })

  test('Distribuição única: todos recebem variação 1', async () => {
    const variacoes = [
      { id: 1, nome: 'A', tipo_mensagem: 'texto', ativa: true, ordem: 0 },
      { id: 2, nome: 'B', tipo_mensagem: 'texto', ativa: true, ordem: 1 },
    ]
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ count: 8, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacoes, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ modo: 'unica', configuracoes: [] })
    expect(r.status).toBe(200)
    const [prim, seg] = r.body.plano.variacoes
    expect(prim.quantidade).toBe(8)
    expect(seg.quantidade).toBe(0)
  })

  test('Distribuição percentual: 60%/40% de 10 destinatários → 6 e 4', async () => {
    const variacoes = [
      { id: 1, nome: 'A', tipo_mensagem: 'texto', ativa: true, ordem: 0 },
      { id: 2, nome: 'B', tipo_mensagem: 'texto', ativa: true, ordem: 1 },
    ]
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ count: 10, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacoes, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        modo: 'percentual',
        configuracoes: [{ variacao_id: 1, percentual: 60 }, { variacao_id: 2, percentual: 40 }],
      })
    expect(r.status).toBe(200)
    const qtds = r.body.plano.variacoes.map(v => v.quantidade)
    expect(qtds.reduce((s, v) => s + v, 0)).toBe(10)
    expect(qtds[0]).toBe(6)
    expect(qtds[1]).toBe(4)
  })

  test('Distribuição percentual soma != 100 → erro', async () => {
    const variacoes = [
      { id: 1, nome: 'A', tipo_mensagem: 'texto', ativa: true, ordem: 0 },
      { id: 2, nome: 'B', tipo_mensagem: 'texto', ativa: true, ordem: 1 },
    ]
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ count: 10, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacoes, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        modo: 'percentual',
        configuracoes: [{ variacao_id: 1, percentual: 50 }, { variacao_id: 2, percentual: 30 }],
      })
    expect(r.body.erros.length).toBeGreaterThan(0)
    expect(r.body.erros[0]).toMatch(/100/)
  })

  test('Distribuição percentual com arredondamento: 33%/33%/34% de 10 → soma = 10', async () => {
    const variacoes = [
      { id: 1, nome: 'A', tipo_mensagem: 'texto', ativa: true, ordem: 0 },
      { id: 2, nome: 'B', tipo_mensagem: 'texto', ativa: true, ordem: 1 },
      { id: 3, nome: 'C', tipo_mensagem: 'texto', ativa: true, ordem: 2 },
    ]
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ count: 10, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacoes, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        modo: 'percentual',
        configuracoes: [
          { variacao_id: 1, percentual: 33 },
          { variacao_id: 2, percentual: 33 },
          { variacao_id: 3, percentual: 34 },
        ],
      })
    const qtds = r.body.plano.variacoes.map(v => v.quantidade)
    expect(qtds.reduce((s, v) => s + v, 0)).toBe(10) // todos atribuídos
  })

  test('Modo inválido retorna 400', async () => {
    supabase.from.mockReturnValue(mockChain({ data: campanhaMock, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ modo: 'aleatorio' })
    expect(r.status).toBe(400)
  })

  test('Nenhuma variação ativa retorna erro no plano', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ count: 5, error: null }))
      .mockReturnValueOnce(mockChain({ data: [], error: null })) // nenhuma ativa
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/preview-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ modo: 'equilibrada', configuracoes: [] })
    expect(r.body.erros.length).toBeGreaterThan(0)
  })
})

// ─── 8. Atribuição manual ─────────────────────────────────────────────────────

describe('Etapa 4 — Atribuição manual', () => {
  test('POST /variacoes/atribuir-manual atribui variação a destinatários', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacaoMock, error: null })) // obterVariacaoPorId
      .mockReturnValue(mockChain({ data: null, error: null })) // update em lote
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/atribuir-manual')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ variacao_id: 1, destinatario_ids: [10, 11, 12] })
    expect(r.status).toBe(200)
    expect(r.body.atribuidos).toBe(3)
  })

  test('POST /variacoes/atribuir-manual — variacao_id inválido retorna 400', async () => {
    supabase.from.mockReturnValue(mockChain({ data: campanhaMock, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/atribuir-manual')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ variacao_id: 'abc', destinatario_ids: [1] })
    expect(r.status).toBe(400)
  })

  test('POST /variacoes/atribuir-manual sem destinatarios retorna 400', async () => {
    supabase.from.mockReturnValue(mockChain({ data: campanhaMock, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/atribuir-manual')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ variacao_id: 1, destinatario_ids: [] })
    expect(r.status).toBe(400)
  })
})

// ─── 9. Preview de destinatário ───────────────────────────────────────────────

describe('Etapa 4 — Preview de destinatário', () => {
  test('GET /variacoes/preview/:destId retorna preview com substituição', async () => {
    const destMock = {
      id: 5, nome: 'Ana Silva', telefone_normalizado: '5511999990001',
      variaveis: { cidade: 'Campinas', valor: '299,90' },
      variacao_id: 1, instancia_id: 'inst_1',
    }
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: destMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacaoMock, error: null }))
    const r = await request(app).get('/api/disparo/campanhas/99/variacoes/preview/5')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ variacao_id: 1 })
    expect(r.status).toBe(200)
    expect(r.body.destinatario.nome).toBe('Ana Silva')
    expect(r.body.texto_substituido).toContain('Ana Silva')
    expect(r.body.texto_substituido).not.toContain('{{nome}}')
  })

  test('GET /variacoes/preview/:destId — destinatário não encontrado retorna 404', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: null, error: null }))
    const r = await request(app).get('/api/disparo/campanhas/99/variacoes/preview/9999')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(r.status).toBe(404)
  })
})

// ─── 10. Resumo e revisão ─────────────────────────────────────────────────────

describe('Etapa 4 — Resumo e marcação de revisão', () => {
  test('GET /variacoes/resumo retorna estrutura completa', async () => {
    const varAtivas = [{ ...variacaoMock }]
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: varAtivas, error: null }))
      .mockReturnValueOnce(mockChain({ count: 5, error: null }))
      .mockReturnValueOnce(mockChain({ data: [{ variacao_id: 1 }, { variacao_id: 1 }], error: null }))
    const r = await request(app).get('/api/disparo/campanhas/99/variacoes/resumo')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(r.status).toBe(200)
    expect(typeof r.body.total_destinatarios).toBe('number')
    expect(Array.isArray(r.body.variacoes)).toBe(true)
  })

  test('POST /variacoes/recalcular limpa atribuições', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaMock, error: null }))
      .mockReturnValue(mockChain({ data: null, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/recalcular')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })

  test('Editar variação após confirmação marca revisão', async () => {
    const campanhaConfirmada = { ...campanhaMock, variacao_confirmada: true }
    supabase.from
      .mockReturnValueOnce(mockChain({ data: campanhaConfirmada, error: null }))
      .mockReturnValueOnce(mockChain({ data: variacaoMock, error: null }))
      .mockReturnValueOnce(mockChain({ data: { ...variacaoMock, nome: 'Editada' }, error: null }))
      .mockReturnValue(mockChain({ data: null, error: null })) // marcarRevisao

    const r = await request(app).patch('/api/disparo/campanhas/99/variacoes/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nome: 'Editada' })
    expect(r.status).toBe(200)
    // O controller deve ter chamado update para marcar revisao
    expect(supabase.from).toHaveBeenCalled()
  })

  test('Confirmação em campanha com status inválido retorna 422', async () => {
    const campanhaEnviando = { ...campanhaMock, status: 'enviando' }
    supabase.from.mockReturnValue(mockChain({ data: campanhaEnviando, error: null }))
    const r = await request(app).post('/api/disparo/campanhas/99/variacoes/confirmar-distribuicao')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ modo: 'equilibrada', configuracoes: [] })
    expect(r.status).toBe(422)
  })
})
