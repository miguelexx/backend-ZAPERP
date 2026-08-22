/**
 * Testes — vinculação de respostas inbound (Etapa 8).
 */

jest.mock('../services/disparoFilaService', () => ({
  recalcularContadores: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../services/disparoSocketService', () => ({
  emitDisparo: jest.fn(),
  EVENTS: {
    RESPOSTA_VINCULADA: 'disparo:resposta_vinculada',
    ITEM_ATUALIZADO: 'disparo:item_atualizado',
  },
}))

jest.mock('../helpers/conversationSync', () => ({
  getOrCreateCliente: jest.fn().mockResolvedValue({ cliente_id: 300 }),
}))

const supabase = require('../config/supabase')
const { recalcularContadores } = require('../services/disparoFilaService')
const { emitDisparo } = require('../services/disparoSocketService')
const { vincularRespostaInbound } = require('../services/disparoRespostaService')

const COMPANY_ID = 10
const TELEFONE = '5534999887766'

function mockChain(result = { data: null, error: null }) {
  const chain = {}
  const methods = [
    'select', 'eq', 'neq', 'is', 'in', 'not', 'order', 'limit',
    'insert', 'update',
  ]
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

const filaItem = {
  id: 100,
  company_id: COMPANY_ID,
  campanha_id: 1,
  execucao_id: 50,
  destinatario_id: 200,
  instancia_id: 3,
  status: 'entregue',
  mensagem_id: 900,
  conversa_id: 55,
  enviado_em: '2026-08-22T10:00:00.000Z',
}

describe('disparoRespostaService — vincularRespostaInbound', () => {
  beforeEach(() => jest.clearAllMocks())

  it('vincula resposta ao último item elegível da fila', async () => {
    const existenteChain = mockChain({ data: null, error: null })
    const destChain = mockChain({ data: [{ id: 200, nome: 'Cliente' }], error: null })
    const filaChain = mockChain({ data: [filaItem], error: null })
    const conversaChain = mockChain({ data: { id: 55, cliente_id: 300, telefone: TELEFONE }, error: null })
    const insertChain = mockChain({
      data: {
        id: 501,
        company_id: COMPANY_ID,
        campanha_id: 1,
        execucao_id: 50,
        fila_item_id: 100,
        mensagem_entrada_id: 777,
      },
      error: null,
    })
    const campanhaChain = mockChain({ data: { id: 1, nome: 'Promo' }, error: null })
    const tagExistChain = mockChain({ data: { id: 9 }, error: null })
    const conversaTagExist = mockChain({ data: { id: 1 }, error: null })
    const updateChain = mockChain({ data: null, error: null })

    supabase.from
      .mockReturnValueOnce(existenteChain)
      .mockReturnValueOnce(destChain)
      .mockReturnValueOnce(filaChain)
      .mockReturnValueOnce(conversaChain)
      .mockReturnValueOnce(insertChain)
      .mockReturnValueOnce(campanhaChain)
      .mockReturnValueOnce(tagExistChain)
      .mockReturnValueOnce(conversaTagExist)
      .mockReturnValueOnce(updateChain)

    const result = await vincularRespostaInbound({
      companyId: COMPANY_ID,
      telefone: TELEFONE,
      mensagemId: 777,
      conversaId: 55,
      instanciaId: 3,
    })

    expect(result.ok).toBe(true)
    expect(result.resposta_id).toBe(501)
    expect(result.fila_item_id).toBe(100)
    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ mensagem_entrada_id: 777, fila_item_id: 100 }),
    )
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'respondida', resposta_mensagem_id: 777 }),
    )
    expect(recalcularContadores).toHaveBeenCalledWith(50, COMPANY_ID)
    expect(emitDisparo).toHaveBeenCalled()
  })

  it('não duplica vínculo para mesma mensagem_entrada_id (idempotente)', async () => {
    const existenteChain = mockChain({
      data: { id: 999, fila_item_id: 100 },
      error: null,
    })
    supabase.from.mockReturnValueOnce(existenteChain)

    const result = await vincularRespostaInbound({
      companyId: COMPANY_ID,
      telefone: TELEFONE,
      mensagemId: 777,
    })

    expect(result).toMatchObject({
      ok: true,
      idempotent: true,
      resposta_id: 999,
      fila_item_id: 100,
    })
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(existenteChain.eq).toHaveBeenCalledWith('mensagem_entrada_id', 777)
  })

  it('trata race condition 23505 sem duplicar', async () => {
    const existenteChain = mockChain({ data: null, error: null })
    const destChain = mockChain({ data: [{ id: 200, nome: 'Cliente' }], error: null })
    const filaChain = mockChain({ data: [filaItem], error: null })
    const conversaChain = mockChain({ data: { id: 55, cliente_id: 300 }, error: null })
    const insertChain = mockChain({ data: null, error: { code: '23505', message: 'duplicate' } })
    const dupChain = mockChain({ data: { id: 888, fila_item_id: 100 }, error: null })

    supabase.from
      .mockReturnValueOnce(existenteChain)
      .mockReturnValueOnce(destChain)
      .mockReturnValueOnce(filaChain)
      .mockReturnValueOnce(conversaChain)
      .mockReturnValueOnce(insertChain)
      .mockReturnValueOnce(dupChain)

    const result = await vincularRespostaInbound({
      companyId: COMPANY_ID,
      telefone: TELEFONE,
      mensagemId: 777,
      conversaId: 55,
    })

    expect(result).toMatchObject({
      ok: true,
      idempotent: true,
      resposta_id: 888,
    })
  })
})
