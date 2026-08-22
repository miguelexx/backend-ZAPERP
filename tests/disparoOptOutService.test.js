/**
 * Testes — opt-out inbound e reativação (Etapa 8).
 * Mock Supabase + UltraMSG — NUNCA HTTP real.
 */

jest.mock('../services/providers/ultramsg', () => ({
  sendText: jest.fn(),
}))

jest.mock('../services/disparoFilaService', () => ({
  recalcularContadores: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../services/disparoSocketService', () => ({
  emitDisparo: jest.fn(),
  EVENTS: {
    OPTOUT_REGISTRADO: 'disparo:optout_registrado',
    OPTOUT_REATIVADO: 'disparo:optout_reativado',
    ITEM_ATUALIZADO: 'disparo:item_atualizado',
  },
}))

const supabase = require('../config/supabase')
const ultramsg = require('../services/providers/ultramsg')
const { recalcularContadores } = require('../services/disparoFilaService')
const { emitDisparo } = require('../services/disparoSocketService')
const { processInboundOptOut, reativar } = require('../services/disparoOptOutService')

const COMPANY_ID = 10
const TELEFONE = '5534999887766'

function mockChain(result = { data: null, error: null }) {
  const chain = {}
  const methods = [
    'select', 'eq', 'neq', 'is', 'in', 'not', 'order', 'limit',
    'insert', 'update', 'upsert',
  ]
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

describe('disparoOptOutService — processInboundOptOut', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.DISPARO_WORKER_ENABLED = '0'
    process.env.DISPARO_LIVE_ENABLED = '0'
    process.env.DISPARO_DRY_RUN = '1'
  })

  it('ignora texto que não é comando exato', async () => {
    const configChain = mockChain({ data: null, error: null })
    supabase.from.mockReturnValueOnce(configChain)

    const result = await processInboundOptOut({
      companyId: COMPANY_ID,
      telefone: TELEFONE,
      texto: 'quero sair por favor',
    })
    expect(result).toEqual({ matched: false })
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('disparo_empresa_config')
  })

  it('processa opt-out: exclusão idempotente quando já ativa', async () => {
    const configChain = mockChain({ data: null, error: null })
    const exclusaoChain = mockChain({ data: { id: 99, ativo: true }, error: null })
    const destChain = mockChain({ data: [{ id: 200 }], error: null })
    const filaSelectChain = mockChain({
      data: [
        { id: 501, campanha_id: 1, execucao_id: 50, status: 'pendente' },
        { id: 502, campanha_id: 1, execucao_id: 50, status: 'reservada' },
      ],
      error: null,
    })
    const filaUpdateChain = mockChain({ data: null, error: null })
    const eventoChain = mockChain({ data: { id: 1001 }, error: null })

    supabase.from
      .mockReturnValueOnce(configChain)
      .mockReturnValueOnce(exclusaoChain)
      .mockReturnValueOnce(destChain)
      .mockReturnValueOnce(filaSelectChain)
      .mockReturnValueOnce(filaUpdateChain)
      .mockReturnValueOnce(eventoChain)

    const result = await processInboundOptOut({
      companyId: COMPANY_ID,
      telefone: TELEFONE,
      texto: 'SAIR',
      mensagemId: 777,
      conversaId: 55,
    })

    expect(result.matched).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.exclusao_id).toBe(99)
    expect(result.itens_ignorados).toBe(2)
    expect(filaSelectChain.in).toHaveBeenCalledWith('status', ['pendente', 'reservada', 'enviando'])
    expect(filaUpdateChain.in).toHaveBeenCalledWith('id', [501, 502])
    expect(recalcularContadores).toHaveBeenCalledWith(50, COMPANY_ID)
    expect(emitDisparo).toHaveBeenCalled()
    expect(ultramsg.sendText).not.toHaveBeenCalled()
  })

  it('marca fila apenas com status pendente/reservada/enviando', async () => {
    const configChain = mockChain({ data: null, error: null })
    const exclusaoSelectChain = mockChain({ data: null, error: null })
    const exclusaoInsertChain = mockChain({ data: { id: 10 }, error: null })
    const destChain = mockChain({ data: [{ id: 200 }], error: null })
    const filaSelectChain = mockChain({
      data: [{ id: 601, campanha_id: 1, execucao_id: 50, status: 'enviando' }],
      error: null,
    })
    const filaUpdateChain = mockChain({ data: null, error: null })
    const eventoChain = mockChain({ data: { id: 1002 }, error: null })

    supabase.from
      .mockReturnValueOnce(configChain)
      .mockReturnValueOnce(exclusaoSelectChain)
      .mockReturnValueOnce(exclusaoInsertChain)
      .mockReturnValueOnce(destChain)
      .mockReturnValueOnce(filaSelectChain)
      .mockReturnValueOnce(filaUpdateChain)
      .mockReturnValueOnce(eventoChain)

    const result = await processInboundOptOut({
      companyId: COMPANY_ID,
      telefone: TELEFONE,
      texto: 'PARAR',
    })

    expect(result.itens_ignorados).toBe(1)
    expect(filaSelectChain.in).toHaveBeenCalledWith('status', ['pendente', 'reservada', 'enviando'])
  })
})

describe('disparoOptOutService — reativar', () => {
  beforeEach(() => jest.clearAllMocks())

  it('exige motivo obrigatório', async () => {
    await expect(reativar({
      companyId: COMPANY_ID,
      telefone: TELEFONE,
      motivo: '',
      userId: 5,
    })).rejects.toMatchObject({ code: 'MOTIVO_OBRIGATORIO' })

    await expect(reativar({
      companyId: COMPANY_ID,
      telefone: TELEFONE,
      motivo: '   ',
      userId: 5,
    })).rejects.toMatchObject({ code: 'MOTIVO_OBRIGATORIO' })
  })

  it('reativa telefone com motivo válido', async () => {
    const configChain = mockChain({ data: null, error: null })
    const findChain = mockChain({ data: { id: 88, ativo: true }, error: null })
    const updateChain = mockChain({ data: null, error: null })
    const eventoChain = mockChain({ data: { id: 2001 }, error: null })

    supabase.from
      .mockReturnValueOnce(configChain)
      .mockReturnValueOnce(findChain)
      .mockReturnValueOnce(updateChain)
      .mockReturnValueOnce(eventoChain)

    const result = await reativar({
      companyId: COMPANY_ID,
      telefone: TELEFONE,
      motivo: 'Cliente solicitou retorno',
      userId: 5,
    })

    expect(result.ok).toBe(true)
    expect(result.exclusao_id).toBe(88)
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ ativo: false, removido_por: 5 }),
    )
    expect(emitDisparo).toHaveBeenCalled()
  })
})
