/**
 * marcar / consumir origem de campanha na conversa — idempotência e isolamento.
 */

jest.mock('../config/supabase', () => ({
  from: jest.fn(),
}))

const supabase = require('../config/supabase')
const {
  marcarAguardandoRespostaCampanha,
  marcarOrigemCampanhaSeMensagemFila,
  consumirPrimeiraRespostaCampanha,
} = require('../services/disparoConversaOrigemService')

function mockChain(result = { data: null, error: null }) {
  const chain = {}
  const methods = [
    'select', 'eq', 'neq', 'is', 'in', 'not', 'or', 'order', 'limit',
    'insert', 'update',
  ]
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

const CONV_LIVRE = {
  id: 55,
  company_id: 10,
  status_atendimento: 'aberta',
  atendente_id: null,
  aguardando_resposta_campanha: false,
  tipo: null,
  departamento_id: null,
  whatsapp_instance_id: 3,
}

describe('disparoConversaOrigemService', () => {
  beforeEach(() => jest.clearAllMocks())

  test('marcar: não altera conversa com atendimento humano ativo', async () => {
    const selectChain = mockChain({
      data: {
        ...CONV_LIVRE,
        status_atendimento: 'em_atendimento',
        atendente_id: 84,
      },
      error: null,
    })
    supabase.from.mockReturnValueOnce(selectChain)

    const result = await marcarAguardandoRespostaCampanha({
      companyId: 10,
      conversaId: 55,
    })

    expect(result).toMatchObject({ ok: true, marked: false, ignored: 'atendimento_humano_ativo' })
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('conversas')
  })

  test('marcar: seta flag só na empresa/conversa informadas', async () => {
    const selectChain = mockChain({ data: CONV_LIVRE, error: null })
    const updateChain = mockChain({ data: { id: 55 }, error: null })
    supabase.from
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(updateChain)

    const result = await marcarAguardandoRespostaCampanha({
      companyId: 10,
      conversaId: 55,
    })

    expect(result).toMatchObject({ ok: true, marked: true, conversa_id: 55 })
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        aguardando_resposta_campanha: true,
        status_atendimento: 'aberta',
        atendente_id: null,
      }),
    )
    expect(updateChain.eq).toHaveBeenCalledWith('id', 55)
    expect(updateChain.eq).toHaveBeenCalledWith('company_id', 10)
  })

  test('consumir: idempotente se a flag já foi limpa', async () => {
    const selectChain = mockChain({
      data: { ...CONV_LIVRE, aguardando_resposta_campanha: false, atendente_id: 4 },
      error: null,
    })
    supabase.from.mockReturnValueOnce(selectChain)

    const first = await consumirPrimeiraRespostaCampanha({
      companyId: 10,
      conversaId: 55,
      instanciaId: 3,
    })
    expect(first).toMatchObject({ ok: true, consumed: false, idempotent: true })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  test('consumir: webhook duplicado não reabre (update atômico 0 linhas)', async () => {
    const selectChain = mockChain({
      data: { ...CONV_LIVRE, aguardando_resposta_campanha: true },
      error: null,
    })
    const updateChain = mockChain({ data: null, error: null })

    supabase.from
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(updateChain)

    const result = await consumirPrimeiraRespostaCampanha({
      companyId: 10,
      conversaId: 55,
      instanciaId: 3,
    })

    expect(result).toMatchObject({ ok: true, consumed: false, idempotent: true, conversa_id: 55 })
    expect(updateChain.eq).toHaveBeenCalledWith('aguardando_resposta_campanha', true)
  })

  test('consumir: abre a conversa sem atendente para a fila assumir', async () => {
    const selectChain = mockChain({
      data: { ...CONV_LIVRE, aguardando_resposta_campanha: true },
      error: null,
    })
    const updateChain = mockChain({
      data: {
        id: 55,
        atendente_id: null,
        status_atendimento: 'aberta',
        aguardando_resposta_campanha: false,
      },
      error: null,
    })

    supabase.from
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(updateChain)

    const result = await consumirPrimeiraRespostaCampanha({
      companyId: 10,
      conversaId: 55,
      instanciaId: 3,
    })

    expect(result).toMatchObject({
      ok: true,
      consumed: true,
      atendente_id: null,
      status_atendimento: 'aberta',
    })
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        aguardando_resposta_campanha: false,
        atendente_id: null,
        status_atendimento: 'aberta',
      }),
    )
    expect(updateChain.eq).toHaveBeenCalledWith('aguardando_resposta_campanha', true)
    expect(updateChain.eq).toHaveBeenCalledWith('company_id', 10)
  })

  test('consumir: limpa atendente leftover e deixa aberta', async () => {
    const selectChain = mockChain({
      data: {
        ...CONV_LIVRE,
        aguardando_resposta_campanha: true,
        atendente_id: 22,
        status_atendimento: 'aberta',
      },
      error: null,
    })
    const updateChain = mockChain({
      data: {
        id: 55,
        atendente_id: null,
        status_atendimento: 'aberta',
        aguardando_resposta_campanha: false,
      },
      error: null,
    })

    supabase.from
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(updateChain)

    const result = await consumirPrimeiraRespostaCampanha({
      companyId: 10,
      conversaId: 55,
    })

    expect(result.consumed).toBe(true)
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        aguardando_resposta_campanha: false,
        status_atendimento: 'aberta',
        atendente_id: null,
      }),
    )
  })

  test('marcar: conversa aberta com atendente leftover vai para Campanhas', async () => {
    const selectChain = mockChain({
      data: { ...CONV_LIVRE, atendente_id: 22, status_atendimento: 'aberta' },
      error: null,
    })
    const updateChain = mockChain({
      data: { id: 55, aguardando_resposta_campanha: true, status_atendimento: 'aberta' },
      error: null,
    })
    supabase.from
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(updateChain)

    const result = await marcarAguardandoRespostaCampanha({
      companyId: 10,
      conversaId: 55,
    })

    expect(result).toMatchObject({ ok: true, marked: true })
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        aguardando_resposta_campanha: true,
        atendente_id: null,
        status_atendimento: 'aberta',
      }),
    )
  })

  test('marcarOrigemCampanhaSeMensagemFila: ignora fromMe sem item na fila', async () => {
    const filaChain = mockChain({ data: [], error: null })
    supabase.from.mockReturnValueOnce(filaChain)

    const result = await marcarOrigemCampanhaSeMensagemFila({
      companyId: 10,
      conversaId: 55,
      providerMessageId: 'wamid-outro',
      mensagemId: 999,
    })

    expect(result).toMatchObject({ ok: true, marked: false, ignored: 'sem_fila' })
    expect(filaChain.eq).toHaveBeenCalledWith('company_id', 10)
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })
})
