/**
 * Testes — relatório e exportação CSV (Etapa 8).
 */

const supabase = require('../config/supabase')
const { escapeCsvCell, toCsv } = require('../helpers/disparoCsvExportHelper')
const { montarRelatorioCampanha } = require('../services/disparoRelatorioService')

const COMPANY_ID = 10
const CAMPANHA_ID = 1

function mockChain(result = { data: null, error: null, count: null }) {
  const chain = {}
  const methods = [
    'select', 'eq', 'neq', 'is', 'in', 'not', 'order', 'limit', 'range',
    'insert', 'update',
  ]
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

describe('disparoCsvExportHelper', () => {
  it('escapa CSV injection com prefixo perigoso', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1")
    expect(escapeCsvCell('+5511999999999')).toBe("'+5511999999999")
    expect(escapeCsvCell('-formula')).toBe("'-formula")
    expect(escapeCsvCell('@cmd')).toBe("'@cmd")
    expect(escapeCsvCell('\tcmd')).toBe("'\tcmd")
    // \r dispara quoting CSV além do prefixo de injection
    expect(escapeCsvCell('\rcmd')).toBe('"\'\rcmd"')
  })

  it('escapa aspas e quebras de linha', () => {
    expect(escapeCsvCell('texto "com aspas"')).toBe('"texto ""com aspas"""')
    expect(escapeCsvCell('linha1\nlinha2')).toBe('"linha1\nlinha2"')
  })

  it('toCsv inclui BOM UTF-8 e CRLF', () => {
    const csv = toCsv(
      [{ nome: 'Ana', valor: 10 }],
      [{ key: 'nome', label: 'nome' }, { key: 'valor', label: 'valor' }],
    )
    expect(csv.charCodeAt(0)).toBe(0xFEFF)
    expect(csv).toContain('nome,valor')
    expect(csv).toContain('Ana,10')
    expect(csv).toContain('\r\n')
  })

  it('toCsv aplica escape de injection na exportação', () => {
    const csv = toCsv(
      [{ campo: '=SUM(A1:A9)' }],
      [{ key: 'campo', label: 'campo' }],
    )
    expect(csv).toContain("'=SUM(A1:A9)")
  })
})

describe('disparoRelatorioService — taxas', () => {
  beforeEach(() => jest.clearAllMocks())

  it('calcula taxas corretamente a partir dos contadores da fila', async () => {
    const campanhaChain = mockChain({
      data: { id: CAMPANHA_ID, nome: 'Campanha X', status: 'concluida', versao_atual: 1 },
      error: null,
    })
    const execChain = mockChain({
      data: {
        id: 50,
        company_id: COMPANY_ID,
        campanha_id: CAMPANHA_ID,
        status: 'concluida',
        total_itens: 100,
        iniciado_em: '2026-08-22T10:00:00.000Z',
        finalizado_em: '2026-08-22T11:00:00.000Z',
        dry_run: false,
      },
      error: null,
    })
    const filaStatusChain = mockChain({
      data: [
        { status: 'enviada' },
        { status: 'entregue' },
        { status: 'entregue' },
        { status: 'lida' },
        { status: 'respondida' },
        { status: 'falhou' },
        { status: 'incerta' },
        { status: 'ignorada' },
        { status: 'pendente' },
        { status: 'pendente' },
      ],
      error: null,
    })
    const respostasChain = mockChain({ data: null, error: null, count: 1 })
    const optoutsChain = mockChain({ data: null, error: null, count: 0 })
    const origemChain = mockChain({ data: [{ origem: 'planilha' }, { origem: 'manual' }], error: null })
    const errosChain = mockChain({ data: [], error: null })
    const eventosChain = mockChain({ data: [], error: null })
    const pausasChain = mockChain({ data: [], error: null })
    const instFilaChain = mockChain({
      data: [
        { instancia_id: 3, status: 'entregue' },
        { instancia_id: 3, status: 'respondida' },
      ],
      error: null,
    })
    const instChain = mockChain({ data: [{ id: 3, nome: 'Principal', numero: '5534999' }], error: null })
    const varFilaChain = mockChain({ data: [{ variacao_id: 7, status: 'entregue' }], error: null })
    const varChain = mockChain({ data: [{ id: 7, nome: 'Var A', tipo_mensagem: 'texto', ordem: 1 }], error: null })

    supabase.from
      .mockReturnValueOnce(campanhaChain)
      .mockReturnValueOnce(execChain)
      .mockReturnValueOnce(filaStatusChain)
      .mockReturnValueOnce(respostasChain)
      .mockReturnValueOnce(optoutsChain)
      .mockReturnValueOnce(origemChain)
      .mockReturnValueOnce(errosChain)
      .mockReturnValueOnce(eventosChain)
      .mockReturnValueOnce(pausasChain)
      .mockReturnValueOnce(instFilaChain)
      .mockReturnValueOnce(instChain)
      .mockReturnValueOnce(varFilaChain)
      .mockReturnValueOnce(varChain)

    const rel = await montarRelatorioCampanha(CAMPANHA_ID, COMPANY_ID)

    expect(rel.metricas.planejado).toBe(100)
    expect(rel.metricas.enviadas).toBe(5)
    expect(rel.metricas.entregues).toBe(4)
    expect(rel.metricas.lidas).toBe(2)
    expect(rel.metricas.respondidas).toBe(1)
    expect(rel.taxas.entrega).toBe(80)
    expect(rel.taxas.leitura).toBe(40)
    expect(rel.taxas.resposta).toBe(20)
    expect(rel.duracao_segundos).toBe(3600)
  })
})
