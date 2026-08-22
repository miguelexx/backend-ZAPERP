/**
 * Testes — reconciliação de itens incertos (Etapa 8).
 * Nunca reenvia via UltraMSG.
 */

jest.mock('../services/providers/ultramsg', () => ({
  sendText: jest.fn(),
  sendImage: jest.fn(),
  sendAudio: jest.fn(),
}))

jest.mock('../services/disparoFilaService', () => ({
  recalcularContadores: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../services/disparoSocketService', () => ({
  emitDisparo: jest.fn(),
  EVENTS: {
    RECONCILIADO: 'disparo:reconciliado',
    ITEM_ATUALIZADO: 'disparo:item_atualizado',
  },
}))

const supabase = require('../config/supabase')
const ultramsg = require('../services/providers/ultramsg')
const {
  analisarEvidencias,
  reconciliarItem,
  registrarDecisaoManual,
} = require('../services/disparoReconciliacaoService')

const COMPANY_ID = 10

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

const itemIncerto = {
  id: 100,
  company_id: COMPANY_ID,
  campanha_id: 1,
  execucao_id: 50,
  status: 'incerta',
  reference_id: 'disp-100',
  provider_message_id: 'wamid-abc',
  mensagem_id: 900,
  tentativas: 1,
  max_tentativas: 3,
}

describe('disparoReconciliacaoService — analisarEvidencias', () => {
  it('confirmada_enviada com ACK delivered', () => {
    const analise = analisarEvidencias(itemIncerto, [{
      origem: 'mensagem_id',
      mensagem: { id: 900, status: 'delivered', status_mensagem: 'device' },
    }])
    expect(analise.resultado).toBe('confirmada_enviada')
    expect(analise.status_sugerido).toBe('entregue')
  })

  it('confirmada_falha com ACK erro', () => {
    const analise = analisarEvidencias(itemIncerto, [{
      origem: 'provider_message_id',
      mensagem: { id: 901, status: 'failed', status_mensagem: 'erro' },
    }])
    expect(analise.resultado).toBe('confirmada_falha')
    expect(analise.status_sugerido).toBe('falhou')
  })

  it('ainda_incerta quando mensagem pendente', () => {
    const analise = analisarEvidencias(itemIncerto, [{
      origem: 'mensagem_id',
      mensagem: { id: 900, status: 'pending', status_mensagem: 'pending' },
    }])
    expect(analise.resultado).toBe('ainda_incerta')
    expect(analise.status_sugerido).toBeNull()
  })

  it('exige_manual com evidências conflitantes', () => {
    const analise = analisarEvidencias(itemIncerto, [
      { origem: 'mensagem_id', mensagem: { id: 900, status_mensagem: 'sent' } },
      { origem: 'provider_message_id', mensagem: { id: 901, status_mensagem: 'failed' } },
    ])
    expect(analise.resultado).toBe('exige_manual')
  })
})

describe('disparoReconciliacaoService — reconciliarItem', () => {
  beforeEach(() => jest.clearAllMocks())

  it('analisa item incerto sem chamar UltraMSG', async () => {
    const itemChain = mockChain({ data: itemIncerto, error: null })
    const msgChain = mockChain({
      data: { id: 900, status: 'read', status_mensagem: 'read', whatsapp_id: 'wamid-abc', direcao: 'out' },
      error: null,
    })
    const pidChain = mockChain({ data: [], error: null })
    const refChain = mockChain({ data: [], error: null })

    supabase.from
      .mockReturnValueOnce(itemChain)
      .mockReturnValueOnce(msgChain)
      .mockReturnValueOnce(pidChain)
      .mockReturnValueOnce(refChain)

    const result = await reconciliarItem(100, COMPANY_ID)

    expect(result.resultado).toBe('confirmada_enviada')
    expect(result.status_sugerido).toBe('lida')
    expect(ultramsg.sendText).not.toHaveBeenCalled()
    expect(ultramsg.sendImage).not.toHaveBeenCalled()
  })

  it('ignora item que não está incerta', async () => {
    const itemChain = mockChain({ data: { ...itemIncerto, status: 'enviada' }, error: null })
    supabase.from.mockReturnValueOnce(itemChain)

    const result = await reconciliarItem(100, COMPANY_ID)
    expect(result.resultado).toBe('ignorado')
    expect(ultramsg.sendText).not.toHaveBeenCalled()
  })
})

describe('disparoReconciliacaoService — registrarDecisaoManual', () => {
  beforeEach(() => jest.clearAllMocks())

  it('registra decisão manual enviada', async () => {
    const itemChain = mockChain({ data: itemIncerto, error: null })
    const decisaoChain = mockChain({ data: { id: 77, decisao: 'enviada', criado_em: '2026-08-22T12:00:00.000Z' }, error: null })
    const updateChain = mockChain({ data: null, error: null })

    supabase.from
      .mockReturnValueOnce(itemChain)
      .mockReturnValueOnce(decisaoChain)
      .mockReturnValueOnce(updateChain)

    const result = await registrarDecisaoManual({
      companyId: COMPANY_ID,
      filaItemId: 100,
      decisao: 'enviada',
      justificativa: 'Confirmado manualmente pelo admin',
      usuarioId: 5,
    })

    expect(result.ok).toBe(true)
    expect(result.decisao).toBe('enviada')
    expect(result.status).toBe('enviada')
    expect(ultramsg.sendText).not.toHaveBeenCalled()
  })

  it('reatentar exige evidência ou autorizarRetentativa', async () => {
    const itemChain = mockChain({ data: itemIncerto, error: null })
    supabase.from.mockReturnValueOnce(itemChain)

    await expect(registrarDecisaoManual({
      companyId: COMPANY_ID,
      filaItemId: 100,
      decisao: 'reatentar',
      justificativa: 'Tentar de novo',
      usuarioId: 5,
    })).rejects.toMatchObject({ code: 'EVIDENCIA_REATENTAR' })

    expect(ultramsg.sendText).not.toHaveBeenCalled()
  })

  it('reatentar com autorizarRetentativa não envia UltraMSG', async () => {
    const itemChain = mockChain({ data: itemIncerto, error: null })
    const decisaoChain = mockChain({ data: { id: 78, decisao: 'reatentar' }, error: null })
    const updateChain = mockChain({ data: null, error: null })

    supabase.from
      .mockReturnValueOnce(itemChain)
      .mockReturnValueOnce(decisaoChain)
      .mockReturnValueOnce(updateChain)

    const result = await registrarDecisaoManual({
      companyId: COMPANY_ID,
      filaItemId: 100,
      decisao: 'reatentar',
      justificativa: 'Mensagem não aceita',
      usuarioId: 5,
      autorizarRetentativa: true,
    })

    expect(result.status).toBe('pendente')
    expect(ultramsg.sendText).not.toHaveBeenCalled()
  })
})
