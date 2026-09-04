/**
 * Testes unitários — geração idempotente da fila (Etapa 7).
 */

jest.mock('../controllers/disparoLimitesController', () => ({
  revalidarInstanciasConectadas: jest.fn(),
}))

const supabase = require('../config/supabase')
const { revalidarInstanciasConectadas } = require('../controllers/disparoLimitesController')
const {
  chaveIdempotencia,
  gerarFilaParaCampanha,
  recalcularContadores,
  montarHorariosFila,
  DisparoFilaError,
} = require('../services/disparoFilaService')
const { PERFIS } = require('../helpers/disparoLimitesHelper')

function mockChain(result = { data: null, error: null, count: 0 }) {
  const chain = {}
  const methods = [
    'select', 'eq', 'neq', 'is', 'not', 'in', 'order', 'limit',
    'insert', 'update', 'upsert',
  ]
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

const campanhaPronta = {
  id: 1,
  company_id: 10,
  status: 'pronta',
  versao_atual: 2,
  config_hash: 'abc123',
  distribuicao_confirmada: true,
  distribuicao_revisao: false,
  variacao_confirmada: true,
  variacao_revisao: false,
  limites_confirmados: true,
  limites_revisao: false,
}

const destinatarios = [
  {
    id: 10,
    nome: 'A',
    telefone_normalizado: '5511999887766',
    instancia_id: 5,
    variacao_id: 30,
    status: 'ativo',
    cliente_id: null,
  },
  {
    id: 11,
    nome: 'B',
    telefone_normalizado: '5511888776655',
    instancia_id: 5,
    variacao_id: 30,
    status: 'ativo',
    cliente_id: null,
  },
]

describe('disparoFilaService — montarHorariosFila', () => {
  const limites = {
    ...PERFIS.moderado,
    intervalo_min_sec: 8,
    intervalo_max_sec: 8,
    lote_tamanho: 100,
    pausa_lote_min_sec: 0,
    pausa_lote_max_sec: 0,
    limite_por_hora: 200,
    limite_por_dia: 2000,
    fuso_horario: 'America/Sao_Paulo',
    inicio_modo: 'imediato',
  }

  it('espaça dois pendentes da mesma instância', () => {
    const map = montarHorariosFila({
      campanha: { status: 'pronta' },
      destinatarios,
      exclusoes: new Set(),
      limites,
      janelas: [],
      overrides: [],
    })
    const t0 = Date.parse(map.get(10))
    const t1 = Date.parse(map.get(11))
    expect(Number.isFinite(t0)).toBe(true)
    expect(Number.isFinite(t1)).toBe(true)
    expect(t0).not.toBe(t1)
    expect(Math.abs(t1 - t0)).toBeGreaterThanOrEqual(8000)
  })

  it('respeita o intervalo mínimo configurado na fila (15s)', () => {
    const map = montarHorariosFila({
      campanha: { status: 'pronta' },
      destinatarios,
      exclusoes: new Set(),
      limites: { ...limites, intervalo_min_sec: 15, intervalo_max_sec: 15 },
      janelas: [],
      overrides: [],
    })
    const gap = Math.abs(Date.parse(map.get(11)) - Date.parse(map.get(10))) / 1000
    expect(gap).toBeGreaterThanOrEqual(15)
  })

  it('excluído não consome o ritmo da instância', () => {
    const map = montarHorariosFila({
      campanha: { status: 'pronta' },
      destinatarios,
      exclusoes: new Set(['5511888776655']),
      limites,
      janelas: [],
      overrides: [],
    })
    expect(map.get(10)).toBeTruthy()
    expect(map.get(11)).toBe(map.get(10))
  })
})

describe('disparoFilaService — chaveIdempotencia', () => {
  it('gera chave determinística campanha+versão+destinatário', () => {
    expect(chaveIdempotencia(1, 2, 10)).toBe('campanha:1:v2:dest:10')
    expect(chaveIdempotencia(99, 1, 500)).toBe('campanha:99:v1:dest:500')
  })
})

describe('disparoFilaService — DisparoFilaError', () => {
  it('campanha não encontrada', async () => {
    supabase.from.mockImplementation(() =>
      mockChain({ data: null, error: null }),
    )

    await expect(
      gerarFilaParaCampanha({ companyId: 10, campanhaId: 999 }),
    ).rejects.toThrow(DisparoFilaError)
  })

  it('campanha com status inválido', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: { ...campanhaPronta, status: 'rascunho' }, error: null })
      }
      return mockChain({ data: null, error: null })
    })

    await expect(
      gerarFilaParaCampanha({ companyId: 10, campanhaId: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('confirmações pendentes geram erro', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({
          data: { ...campanhaPronta, limites_confirmados: false },
          error: null,
        })
      }
      return mockChain({ data: null, error: null })
    })

    await expect(
      gerarFilaParaCampanha({ companyId: 10, campanhaId: 1 }),
    ).rejects.toThrow(/Limites não confirmados/)
  })

  it('instâncias desconectadas bloqueiam geração', async () => {
    revalidarInstanciasConectadas.mockResolvedValue({
      ok: false,
      mensagem: 'Instância X desconectada',
      desconectadas: [{ id: 5, nome: 'X' }],
    })

    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: campanhaPronta, error: null })
      }
      if (table === 'disparo_campanha_revisoes') {
        return mockChain({ data: { id: 7, versao: 2, hash: 'abc', status: 'ativa' }, error: null })
      }
      return mockChain({ data: null, error: null })
    })

    await expect(
      gerarFilaParaCampanha({ companyId: 10, campanhaId: 1 }),
    ).rejects.toThrow(/desconectada/i)
  })
})

describe('disparoFilaService — idempotência', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    revalidarInstanciasConectadas.mockResolvedValue({ ok: true, desconectadas: [] })
  })

  it('retorna execução existente sem gerar novos itens (idempotente)', async () => {
    const execExistente = {
      id: 50,
      company_id: 10,
      campanha_id: 1,
      versao: 2,
      status: 'aguardando',
      total_ignorados: 0,
    }

    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: campanhaPronta, error: null })
      }
      if (table === 'disparo_campanha_revisoes') {
        return mockChain({ data: { id: 7, versao: 2, hash: 'abc', status: 'ativa' }, error: null })
      }
      if (table === 'disparo_execucoes') {
        return mockChain({ data: execExistente, error: null })
      }
      if (table === 'disparo_fila_itens') {
        return mockChain({ data: null, error: null, count: 3 })
      }
      return mockChain({ data: null, error: null })
    })

    const result = await gerarFilaParaCampanha({ companyId: 10, campanhaId: 1, userId: 5 })

    expect(result.idempotente).toBe(true)
    expect(result.gerados).toBe(0)
    expect(result.ja_existentes).toBe(3)
    expect(result.execucao.id).toBe(50)
  })

  it('gera fila nova com dry_run=true por default', async () => {
    let insertRows = null

    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: campanhaPronta, error: null })
      }
      if (table === 'disparo_campanha_revisoes') {
        return mockChain({ data: { id: 7, versao: 2, hash: 'abc', status: 'ativa' }, error: null })
      }
      if (table === 'disparo_execucoes') {
        const chain = mockChain({ data: null, error: null })
        chain.insert = jest.fn(() => {
          insertExecucao = jest.fn().mockReturnThis()
          const insertChain = mockChain({
            data: { id: 60, company_id: 10, campanha_id: 1, versao: 2, status: 'aguardando', dry_run: true },
            error: null,
          })
          insertChain.select = jest.fn(() => insertChain)
          return insertChain
        })
        chain.select = jest.fn(() => chain)
        chain.eq = jest.fn(() => chain)
        chain.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null })
        chain.single = jest.fn().mockResolvedValue({
          data: { id: 60, company_id: 10, dry_run: true, status: 'aguardando' },
          error: null,
        })
        return chain
      }
      if (table === 'disparo_campanha_limites') {
        return mockChain({ data: { inicio_modo: 'imediato', agendado_para: null, fuso_horario: 'America/Sao_Paulo' }, error: null })
      }
      if (table === 'disparo_campanha_destinatarios') {
        return mockChain({ data: destinatarios, error: null })
      }
      if (table === 'whatsapp_instances') {
        return mockChain({ data: [{ id: 5 }], error: null })
      }
      if (table === 'disparo_campanha_variacoes') {
        return mockChain({ data: [{ id: 30 }], error: null })
      }
      if (table === 'disparo_exclusoes') {
        return mockChain({ data: [{ telefone_normalizado: '5511888776655' }], error: null })
      }
      if (table === 'disparo_fila_itens') {
        const chain = mockChain({ data: null, error: null, count: 0 })
        chain.insert = jest.fn((rows) => {
          insertRows = rows
          return chain
        })
        chain.in = jest.fn(() => chain)
        chain.select = jest.fn(() => chain)
        chain.eq = jest.fn(() => chain)
        // contagem e status após insert
        chain.then = (resolve) => {
          if (chain._mode === 'status') {
            return Promise.resolve({
              data: [
                { status: 'pendente' },
                { status: 'ignorada' },
              ],
              error: null,
            }).then(resolve)
          }
          return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve)
        }
        chain._mode = 'count'
        chain.select = jest.fn((cols, opts) => {
          if (opts?.count === 'exact') {
            chain._mode = 'count'
          } else if (cols === 'chave_idempotencia') {
            chain._mode = 'keys'
          } else {
            chain._mode = 'status'
          }
          return chain
        })
        return chain
      }
      if (table === 'disparo_execucao_eventos') {
        return mockChain({ data: null, error: null })
      }
      return mockChain({ data: null, error: null })
    })

    const result = await gerarFilaParaCampanha({ companyId: 10, campanhaId: 1, userId: 5 })

    expect(result.idempotente).toBe(false)
    expect(result.execucao).toBeTruthy()
    expect(insertRows).toBeTruthy()
    expect(insertRows.length).toBe(2)
    const chaves = insertRows.map((r) => r.chave_idempotencia)
    expect(chaves).toContain('campanha:1:v2:dest:10')
    expect(chaves).toContain('campanha:1:v2:dest:11')
    const ignorada = insertRows.find((r) => r.status === 'ignorada')
    expect(ignorada?.erro_codigo).toBe('EXCLUIDO')
    expect(ignorada?.proxima_tentativa_em).toBeTruthy()
  })

  it('reaproveita execução se insert colidir no unique ativo', async () => {
    const execExistente = {
      id: 50,
      company_id: 10,
      campanha_id: 1,
      versao: 2,
      status: 'aguardando',
      total_ignorados: 0,
    }
    let execFromCount = 0

    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        return mockChain({ data: campanhaPronta, error: null })
      }
      if (table === 'disparo_campanha_revisoes') {
        return mockChain({ data: { id: 7, versao: 2, hash: 'abc', status: 'ativa' }, error: null })
      }
      if (table === 'disparo_execucoes') {
        execFromCount += 1
        if (execFromCount === 1) {
          return mockChain({ data: null, error: null })
        }
        if (execFromCount === 2) {
          const chain = mockChain({
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
          })
          chain.insert = jest.fn(() => chain)
          chain.select = jest.fn(() => chain)
          chain.single = jest.fn().mockResolvedValue({
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
          })
          return chain
        }
        return mockChain({ data: execExistente, error: null })
      }
      if (table === 'disparo_campanha_limites') {
        return mockChain({ data: { inicio_modo: 'imediato', agendado_para: null, fuso_horario: 'America/Sao_Paulo' }, error: null })
      }
      if (table === 'disparo_campanha_janelas') {
        return mockChain({ data: [], error: null })
      }
      if (table === 'disparo_campanha_instancia_limites') {
        return mockChain({ data: [], error: null })
      }
      if (table === 'disparo_campanha_destinatarios') {
        return mockChain({ data: destinatarios, error: null })
      }
      if (table === 'whatsapp_instances') {
        return mockChain({ data: [{ id: 5 }], error: null })
      }
      if (table === 'disparo_campanha_variacoes') {
        return mockChain({ data: [{ id: 30 }], error: null })
      }
      if (table === 'disparo_exclusoes') {
        return mockChain({ data: [], error: null })
      }
      if (table === 'disparo_fila_itens') {
        return mockChain({ data: null, error: null, count: 2 })
      }
      return mockChain({ data: null, error: null })
    })

    const result = await gerarFilaParaCampanha({ companyId: 10, campanhaId: 1, userId: 5 })
    expect(result.idempotente).toBe(true)
    expect(result.execucao.id).toBe(50)
  })

  it('converte erro de ON CONFLICT em DisparoFilaError', () => {
    const { mensagemErroFila, isUniqueViolation } = require('../services/disparoFilaService')
    expect(isUniqueViolation({ code: '23505' })).toBe(true)
    expect(mensagemErroFila({
      message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
    })).toMatch(/idempotência da fila/i)
  })
})

describe('disparoFilaService — recalcularContadores', () => {
  beforeEach(() => jest.clearAllMocks())

  it('optout incrementa total_optouts sem inflar total_ignorados', async () => {
    let updatePayload = null
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_fila_itens') {
        return mockChain({
          data: [
            { status: 'optout' },
            { status: 'ignorada' },
            { status: 'enviada' },
            { status: 'falhou' },
          ],
          error: null,
        })
      }
      if (table === 'disparo_execucoes') {
        const chain = mockChain({ data: null, error: null })
        chain.update = jest.fn((payload) => {
          updatePayload = payload
          return chain
        })
        return chain
      }
      return mockChain({ data: null, error: null })
    })

    const counts = await recalcularContadores(50, 10)

    expect(counts.total_optouts).toBe(1)
    expect(counts.total_ignorados).toBe(1)
    expect(counts.total_enviados).toBe(1)
    expect(counts.total_falhas).toBe(1)
    expect(counts.total_itens).toBe(4)
    expect(updatePayload.total_optouts).toBe(1)
    expect(updatePayload.total_ignorados).toBe(1)
  })
})
