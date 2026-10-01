/**
 * executarAssumirConversa — guarda de conversa encerrada.
 * Rota HTTP (Assumir) bloqueia conversa finalizada (409); fluxos internos (ex.: "Conversar"
 * no cartão do cliente) continuam podendo retomar a conversa encerrada.
 */

jest.mock('../config/supabase', () => ({
  from: jest.fn(),
}))

jest.mock('../services/atendimentosRegistroService', () => ({
  registrarAtendimento: jest.fn().mockResolvedValue({ error: null, atendimento: { id: 9 } }),
}))

jest.mock('../helpers/reabertaFaltaInteracaoHelper', () => ({
  clearReabertaFaltaInteracao: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../services/atendimentoSemRespostaService', () => ({
  resetAlertaSemRespostaAoAssumirReaberta: jest.fn().mockResolvedValue(undefined),
}))

const supabase = require('../config/supabase')
const { executarAssumirConversa } = require('../services/conversaAssumirInternoService')

function mockChain(result = { data: null, error: null }) {
  const chain = {}
  const methods = ['select', 'eq', 'neq', 'is', 'in', 'not', 'or', 'order', 'limit', 'insert', 'update']
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

const CONV_FECHADA = {
  id: 77,
  atendente_id: null,
  departamento_id: null,
  tipo: null,
  telefone: '5531999990000',
  status_atendimento: 'fechada',
  reaberta_falta_interacao_em: null,
}

describe('executarAssumirConversa — conversa encerrada', () => {
  beforeEach(() => jest.clearAllMocks())

  test('bloquearEncerrada: conversa fechada responde 409 e nada é atualizado', async () => {
    const selectChain = mockChain({ data: CONV_FECHADA, error: null })
    supabase.from.mockReturnValueOnce(selectChain)

    const result = await executarAssumirConversa({
      company_id: 10,
      conversa_id: 77,
      user_id: 4,
      perfil: 'atendente',
      departamento_ids: [],
      bloquearEncerrada: true,
    })

    expect(result).toMatchObject({ ok: false, status: 409 })
    expect(result.error).toMatch(/Reabrir/i)
    // Só o SELECT inicial — nenhum UPDATE em conversa finalizada.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  test('bloquearEncerrada cobre também status "finalizada"', async () => {
    const selectChain = mockChain({
      data: { ...CONV_FECHADA, status_atendimento: 'finalizada' },
      error: null,
    })
    supabase.from.mockReturnValueOnce(selectChain)

    const result = await executarAssumirConversa({
      company_id: 10,
      conversa_id: 77,
      user_id: 4,
      perfil: 'admin',
      bloquearEncerrada: true,
    })

    expect(result).toMatchObject({ ok: false, status: 409 })
  })

  test('sem bloquearEncerrada (fluxo interno) a conversa fechada ainda pode ser retomada', async () => {
    const selectChain = mockChain({ data: CONV_FECHADA, error: null })
    const empresaChain = mockChain({ data: { limite_chats_por_atendente: 0 }, error: null })
    const updateChain = mockChain({
      data: { ...CONV_FECHADA, status_atendimento: 'em_atendimento', atendente_id: 4 },
      error: null,
    })
    supabase.from
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(empresaChain)
      .mockReturnValueOnce(updateChain)

    const result = await executarAssumirConversa({
      company_id: 10,
      conversa_id: 77,
      user_id: 4,
      perfil: 'admin',
    })

    expect(result).toMatchObject({ ok: true, status: 200 })
    expect(result.conversa).toMatchObject({ status_atendimento: 'em_atendimento', atendente_id: 4 })
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status_atendimento: 'em_atendimento', atendente_id: 4 }),
    )
  })

  test('conversa ativa segue assumível com bloquearEncerrada', async () => {
    const selectChain = mockChain({
      data: { ...CONV_FECHADA, status_atendimento: 'aberta' },
      error: null,
    })
    const empresaChain = mockChain({ data: { limite_chats_por_atendente: 0 }, error: null })
    const updateChain = mockChain({
      data: { ...CONV_FECHADA, status_atendimento: 'em_atendimento', atendente_id: 4 },
      error: null,
    })
    supabase.from
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(empresaChain)
      .mockReturnValueOnce(updateChain)

    const result = await executarAssumirConversa({
      company_id: 10,
      conversa_id: 77,
      user_id: 4,
      perfil: 'admin',
      bloquearEncerrada: true,
    })

    expect(result).toMatchObject({ ok: true, status: 200 })
  })
})
