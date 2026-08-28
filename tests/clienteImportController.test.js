/**
 * Testa o controller de importação com um .xlsx REAL gerado em memória (exceljs),
 * cobrindo: parsing, detecção de colunas, ignorar colunas irrelevantes, e o
 * isolamento por empresa (company_id vem SEMPRE de req.user, nunca do body).
 */

// config/supabase é mockado pelo tests/setup.js. Mockamos o service para inspecionar args.
jest.mock('../services/clienteImportService', () => ({
  executarImportacao: jest.fn(),
  enriquecerPlanoComExistentes: jest.fn(async (_sb, _cid, plano) => ({
    ...plano,
    nomeSeraAlterado: [],
    nomesManuaisProtegidos: [],
    jaExistentesIguais: [],
  })),
}))

const ExcelJS = require('exceljs')
const { executarImportacao } = require('../services/clienteImportService')
const controller = require('../controllers/clienteImportController')

async function montarXlsx(rows, headers) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Plan1')
  ws.addRow(headers)
  rows.forEach((r) => ws.addRow(r))
  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf)
}

// Cabeçalhos do modelo, com colunas irrelevantes que devem ser ignoradas.
const HEADERS = [
  'Data',
  'Nome do(a) Aluno(a)',
  'Objetivo da Contratação',
  'Série (Ano)',
  'Turno',
  'Celular do(a) Responsável Pedagógico',
  'E-mail do (a) Responsável Pedagógico',
]

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

function linha({ data = '2025-10-07', nome, objetivo = 'Matrícula', serie, turno = 'Vespertino', cel, email = 'x@y.com' }) {
  return [data, nome, objetivo, serie, turno, cel, email]
}

describe('clienteImportController — preview', () => {
  beforeEach(() => executarImportacao.mockReset())

  it('rejeita quando não há arquivo', async () => {
    const res = makeRes()
    await controller.previewImportacao({ body: {}, user: { company_id: 7 } }, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.codigo).toBe('ARQUIVO_OBRIGATORIO')
  })

  it('detecta as 3 colunas, ignora as demais e devolve prévia', async () => {
    const buffer = await montarXlsx(
      [
        linha({ nome: 'João Silva', serie: '6º Ano do Ensino Fundamental II', cel: '(34) 99999-1234' }),
        linha({ nome: 'Maria Souza', serie: '5º Ano do Ensino Fundamental I', cel: '5534988887777' }),
      ],
      HEADERS
    )
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body.mapping).toEqual({ nome: 1, telefone: 5, serie: 3 })
    expect(res.body.colunas_faltando).toEqual([])
    expect(res.body.stats.telefonesUnicos).toBe(2)
    expect(res.body.amostra[0]).toMatchObject({
      nome: 'João Silva',
      telefone: '5534999991234',
      tags: ['6º Ano do Ensino Fundamental II'],
    })
  })

  it('respeita "não usar" (null) para a série mesmo que a detecção automática a encontre', async () => {
    const buffer = await montarXlsx(
      [linha({ nome: 'João Silva', serie: '6º Ano', cel: '34999991234' })],
      HEADERS
    )
    const res = makeRes()
    // usuário mapeou nome/telefone mas escolheu NÃO usar a coluna de série
    await controller.previewImportacao(
      { file: { buffer, size: buffer.length }, body: { mapping: JSON.stringify({ nome: 1, telefone: 5, serie: null }) }, user: { company_id: 7 } },
      res
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.mapping.serie).toBeNull() // NÃO re-detecta a coluna 3
    expect(res.body.amostra[0].tags).toEqual([])
  })

  it('detecta as 3 colunas Nome/Telefone/Tags', async () => {
    const buffer = await montarXlsx(
      [['ALEXIA CRISTINA MARCHEZAN DOS SANTOS', '5534999514579', '6º Ano do Ensino Fundamental II']],
      ['Nome', 'Telefone', 'Tags']
    )
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.mapping).toEqual({ nome: 0, telefone: 1, serie: 2 })
    expect(res.body.amostra[0]).toMatchObject({
      nome: 'ALEXIA CRISTINA MARCHEZAN DOS SANTOS',
      telefone: '5534999514579',
      tags: ['6º Ano do Ensino Fundamental II'],
    })
  })

  it('arquivo vazio retorna erro controlado', async () => {
    const res = makeRes()
    await controller.previewImportacao(
      { file: { buffer: Buffer.alloc(0), size: 0 }, body: {}, user: { company_id: 7 } },
      res
    )
    expect(res.statusCode).toBe(400)
    expect(['ARQUIVO_OBRIGATORIO', 'ARQUIVO_CORROMPIDO']).toContain(res.body.codigo)
  })

  it('arquivo corrompido retorna erro controlado', async () => {
    const res = makeRes()
    await controller.previewImportacao(
      { file: { buffer: Buffer.from('isto nao e xlsx'), size: 16 }, body: {}, user: { company_id: 7 } },
      res
    )
    expect(res.statusCode).toBe(400)
    expect(res.body.codigo).toBe('ARQUIVO_CORROMPIDO')
  })

  it('respeita override de mapeamento vindo do body', async () => {
    // Cabeçalhos genéricos que a detecção automática não reconhece.
    const buffer = await montarXlsx(
      [['Contato XPTO', '34999990000', 'Turma A']],
      ['Aluno XPTO', 'Fone XPTO', 'Turma XPTO']
    )
    const res = makeRes()
    await controller.previewImportacao(
      { file: { buffer, size: buffer.length }, body: { mapping: JSON.stringify({ nome: 0, telefone: 1, serie: 2 }) }, user: { company_id: 7 } },
      res
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.mapping).toEqual({ nome: 0, telefone: 1, serie: 2 })
    expect(res.body.amostra[0].telefone).toBe('5534999990000')
  })
})

describe('clienteImportController — confirmar', () => {
  beforeEach(() => executarImportacao.mockReset())

  it('executa a importação usando company_id de req.user (ignora company_id do body)', async () => {
    executarImportacao.mockResolvedValue({ ok: true, resumo: { clientesImportados: 1 } })
    const buffer = await montarXlsx(
      [linha({ nome: 'João Silva', serie: '6º Ano', cel: '34999991234' })],
      HEADERS
    )
    const res = makeRes()
    await controller.confirmarImportacao(
      { file: { buffer, size: buffer.length }, body: { company_id: 999 }, user: { company_id: 7, perfil: 'admin' } },
      res
    )

    expect(res.statusCode).toBe(200)
    expect(executarImportacao).toHaveBeenCalledTimes(1)
    const [, companyIdArg, planoArg] = executarImportacao.mock.calls[0]
    expect(companyIdArg).toBe(7) // NUNCA 999
    expect(planoArg.entries).toHaveLength(1)
    expect(planoArg.entries[0].telefoneNormalizado).toBe('5534999991234')
  })

  it('rejeita quando não há nenhuma linha válida', async () => {
    const buffer = await montarXlsx(
      [linha({ nome: '', serie: 'X', cel: '' })],
      HEADERS
    )
    const res = makeRes()
    await controller.confirmarImportacao(
      { file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7, perfil: 'admin' } },
      res
    )
    expect(res.statusCode).toBe(400)
    expect(res.body.codigo).toBe('NENHUMA_LINHA_VALIDA')
    expect(executarImportacao).not.toHaveBeenCalled()
  })

  it('bloqueia importação simultânea da mesma empresa', async () => {
    controller._test.importLocks.set(7, Date.now())
    try {
      const buffer = await montarXlsx(
        [linha({ nome: 'João Silva', serie: '6º Ano', cel: '34999991234' })],
        HEADERS
      )
      const res = makeRes()
      await controller.confirmarImportacao(
        { file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7, perfil: 'admin' } },
        res
      )
      expect(res.statusCode).toBe(409)
      expect(res.body.codigo).toBe('IMPORTACAO_EM_ANDAMENTO')
      expect(executarImportacao).not.toHaveBeenCalled()
    } finally {
      controller._test.importLocks.delete(7)
    }
  })
})
