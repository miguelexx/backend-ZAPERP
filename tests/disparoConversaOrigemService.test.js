/**
 * marcar / consumir origem de campanha na conversa — idempotência e isolamento.
 */

jest.mock('../config/supabase', () => ({
  from: jest.fn(),
}))

jest.mock('../services/atendimentosRegistroService', () => ({
  registrarAtendimento: jest.fn().mockResolvedValue({ error: null, atendimento: { id: 1 } }),
}))

const supabase = require('../config/supabase')
const { registrarAtendimento } = require('../services/atendimentosRegistroService')
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
    const filaChain = mockChain({ data: [], error: null })
    const updateChain = mockChain({ data: null, error: null })

    supabase.from
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(filaChain)
      .mockReturnValueOnce(updateChain)

    const result = await consumirPrimeiraRespostaCampanha({
      companyId: 10,
      conversaId: 55,
      instanciaId: 3,
    })

    expect(result).toMatchObject({ ok: true, consumed: false, idempotent: true, conversa_id: 55 })
    expect(updateChain.eq).toHaveBeenCalledWith('aguardando_resposta_campanha', true)
    expect(registrarAtendimento).not.toHaveBeenCalled()
  })

  test('consumir: sem responsável da campanha deixa aberta na fila geral', async () => {
    const selectChain = mockChain({
      data: { ...CONV_LIVRE, aguardando_resposta_campanha: true },
      error: null,
    })
    const filaChain = mockChain({ data: [], error: null })
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
      .mockReturnValueOnce(filaChain)
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
    expect(registrarAtendimento).not.toHaveBeenCalled()
  })

  test('consumir: assume o iniciador da campanha em atendimento (Minha fila)', async () => {
    const selectChain = mockChain({
      data: { ...CONV_LIVRE, aguardando_resposta_campanha: true },
      error: null,
    })
    const filaChain = mockChain({
      data: [{
        id: 9,
        execucao_id: 70,
        campanha_id: 2,
        instancia_id: 3,
        destinatario_id: 1,
        enviado_em: '2026-09-01T12:00:00Z',
      }],
      error: null,
    })
    const execChain = mockChain({
      data: { iniciado_por: 84, campanha_id: 2 },
      error: null,
    })
    const userChain = mockChain({
      data: { id: 84, ativo: true, company_id: 10 },
      error: null,
    })
    const updateChain = mockChain({
      data: {
        id: 55,
        atendente_id: 84,
        status_atendimento: 'em_atendimento',
        aguardando_resposta_campanha: false,
      },
      error: null,
    })

    supabase.from
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(filaChain)
      .mockReturnValueOnce(execChain)
      .mockReturnValueOnce(userChain)
      .mockReturnValueOnce(updateChain)

    const result = await consumirPrimeiraRespostaCampanha({
      companyId: 10,
      conversaId: 55,
      instanciaId: 3,
    })

    expect(result).toMatchObject({
      ok: true,
      consumed: true,
      atendente_id: 84,
      status_atendimento: 'em_atendimento',
    })
    expect(filaChain.eq).toHaveBeenCalledWith('company_id', 10)
    expect(filaChain.eq).toHaveBeenCalledWith('conversa_id', 55)
    expect(execChain.eq).toHaveBeenCalledWith('company_id', 10)
    expect(userChain.eq).toHaveBeenCalledWith('company_id', 10)
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        aguardando_resposta_campanha: false,
        atendente_id: 84,
        status_atendimento: 'em_atendimento',
      }),
    )
    expect(registrarAtendimento).toHaveBeenCalledWith(
      expect.objectContaining({
        conversa_id: 55,
        company_id: 10,
        acao: 'assumiu',
        para_usuario_id: 84,
        observacao: 'campanha_respondida',
      }),
    )
  })

  test('consumir: criado_por da campanha assume se execução não tem iniciado_por', async () => {
    const selectChain = mockChain({
      data: { ...CONV_LIVRE, aguardando_resposta_campanha: true },
      error: null,
    })
    const filaChain = mockChain({
      data: [{
        id: 9,
        execucao_id: 70,
        campanha_id: 2,
        instancia_id: 3,
        destinatario_id: 1,
        enviado_em: '2026-09-01T12:00:00Z',
      }],
      error: null,
    })
    const execChain = mockChain({
      data: { iniciado_por: null, campanha_id: 2 },
      error: null,
    })
    const campChain = mockChain({
      data: { criado_por: 91 },
      error: null,
    })
    const userChain = mockChain({
      data: { id: 91, ativo: true, company_id: 10 },
      error: null,
    })
    const updateChain = mockChain({
      data: {
        id: 55,
        atendente_id: 91,
        status_atendimento: 'em_atendimento',
        aguardando_resposta_campanha: false,
      },
      error: null,
    })

    supabase.from
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(filaChain)
      .mockReturnValueOnce(execChain)
      .mockReturnValueOnce(campChain)
      .mockReturnValueOnce(userChain)
      .mockReturnValueOnce(updateChain)

    const result = await consumirPrimeiraRespostaCampanha({
      companyId: 10,
      conversaId: 55,
      instanciaId: 3,
    })

    expect(result).toMatchObject({
      ok: true,
      consumed: true,
      atendente_id: 91,
      status_atendimento: 'em_atendimento',
    })
    expect(supabase.from).toHaveBeenCalledWith('disparo_campanhas')
    expect(registrarAtendimento).toHaveBeenCalledWith(
      expect.objectContaining({ para_usuario_id: 91, observacao: 'campanha_respondida' }),
    )
  })

  test('consumir: responsável inativo não assume (fica aberta na fila geral)', async () => {
    const selectChain = mockChain({
      data: { ...CONV_LIVRE, aguardando_resposta_campanha: true },
      error: null,
    })
    const filaChain = mockChain({
      data: [{
        id: 9,
        execucao_id: 70,
        campanha_id: 2,
        instancia_id: 3,
        destinatario_id: 1,
        enviado_em: '2026-09-01T12:00:00Z',
      }],
      error: null,
    })
    const execChain = mockChain({
      data: { iniciado_por: 84, campanha_id: 2 },
      error: null,
    })
    const userChain = mockChain({
      data: { id: 84, ativo: false, company_id: 10 },
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
      .mockReturnValueOnce(filaChain)
      .mockReturnValueOnce(execChain)
      .mockReturnValueOnce(userChain)
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
    expect(registrarAtendimento).not.toHaveBeenCalled()
  })

  test('consumir: sem responsável limpa atendente leftover e deixa aberta', async () => {
    const selectChain = mockChain({
      data: {
        ...CONV_LIVRE,
        aguardando_resposta_campanha: true,
        atendente_id: 22,
        status_atendimento: 'aberta',
      },
      error: null,
    })
    const filaChain = mockChain({ data: [], error: null })
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
      .mockReturnValueOnce(filaChain)
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
    expect(registrarAtendimento).not.toHaveBeenCalled()
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
