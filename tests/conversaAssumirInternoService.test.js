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

jest.mock('../services/chat/access/conversationVisibilityService', () => ({
  encerrarCoAtendimentoDaConversa: jest.fn().mockResolvedValue(0),
}))

const supabase = require('../config/supabase')
const { executarAssumirConversa } = require('../services/conversaAssumirInternoService')
const { encerrarCoAtendimentoDaConversa } = require('../services/chat/access/conversationVisibilityService')

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

  test.each(['fechada', 'encerrada', 'finalizada', 'finalizado'])('encaminhamento reabre %s e substitui o antigo responsável', async (status) => {
    const atual = { ...CONV_FECHADA, status_atendimento: status, atendente_id: 8, departamento_id: 99 }
    const update = mockChain({ data: { ...atual, atendente_id: 4, status_atendimento: 'em_atendimento' }, error: null })
    supabase.from
      .mockReturnValueOnce(mockChain({ data: atual, error: null }))
      .mockReturnValueOnce(mockChain({ data: { limite_chats_por_atendente: 0 }, error: null }))
      .mockReturnValueOnce(update)
    const result = await executarAssumirConversa({ company_id: 10, conversa_id: 77, user_id: 4, perfil: 'atendente', reabrirAoEncaminhar: true })
    expect(result.ok).toBe(true)
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ atendente_id: 4, status_atendimento: 'em_atendimento', departamento_id: null, finalizacao_motivo: null, finalizada_automaticamente: false }))
    expect(update.eq).toHaveBeenCalledWith('status_atendimento', status)
    expect(require('../services/atendimentosRegistroService').registrarAtendimento).toHaveBeenCalledWith(expect.objectContaining({ acao: 'reabriu', de_usuario_id: 4 }))
  })

  test('encaminhamento não toma atendimento ativo de outro usuário', async () => {
    supabase.from.mockReturnValueOnce(mockChain({ data: { ...CONV_FECHADA, status_atendimento: 'em_atendimento', atendente_id: 8 }, error: null }))
    const result = await executarAssumirConversa({ company_id: 10, conversa_id: 77, user_id: 4, perfil: 'admin', reabrirAoEncaminhar: true })
    expect(result).toMatchObject({ ok: false, status: 409 })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  test('reabertura concorrente por outro usuário impede envio pelo perdedor', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: CONV_FECHADA, error: null }))
      .mockReturnValueOnce(mockChain({ data: { limite_chats_por_atendente: 0 }, error: null }))
      .mockReturnValueOnce(mockChain())
      .mockReturnValueOnce(mockChain({ data: { ...CONV_FECHADA, atendente_id: 8, status_atendimento: 'em_atendimento' }, error: null }))
    const result = await executarAssumirConversa({ company_id: 10, conversa_id: 77, user_id: 4, perfil: 'admin', reabrirAoEncaminhar: true })
    expect(result).toMatchObject({ ok: false, status: 409 })
    expect(require('../services/atendimentosRegistroService').registrarAtendimento).not.toHaveBeenCalled()
  })

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

describe('executarAssumirConversa — espera de campanha', () => {
  beforeEach(() => jest.clearAllMocks())

  const CONV_CAMPANHA = { ...CONV_FECHADA, status_atendimento: 'aberta' }

  test('assumir conversa que aguardava resposta de campanha encerra a espera', async () => {
    const assumida = { ...CONV_CAMPANHA, atendente_id: 4, status_atendimento: 'em_atendimento', aguardando_resposta_campanha: true }
    const limpar = mockChain({ data: null, error: null })
    supabase.from
      .mockReturnValueOnce(mockChain({ data: CONV_CAMPANHA, error: null }))
      .mockReturnValueOnce(mockChain({ data: { limite_chats_por_atendente: 0 }, error: null }))
      .mockReturnValueOnce(mockChain({ data: assumida, error: null }))
      .mockReturnValueOnce(limpar)
    const result = await executarAssumirConversa({ company_id: 10, conversa_id: 77, user_id: 4, perfil: 'atendente' })
    expect(result.ok).toBe(true)
    expect(limpar.update).toHaveBeenCalledWith({ aguardando_resposta_campanha: false })
    expect(limpar.eq).toHaveBeenCalledWith('aguardando_resposta_campanha', true)
    // O realtime do assumir usa esta linha: ela já sai sem a espera de campanha.
    expect(result.conversa.aguardando_resposta_campanha).toBe(false)
  })

  test('conversa sem campanha não faz UPDATE extra', async () => {
    const assumida = { ...CONV_CAMPANHA, atendente_id: 4, status_atendimento: 'em_atendimento', aguardando_resposta_campanha: false }
    supabase.from
      .mockReturnValueOnce(mockChain({ data: CONV_CAMPANHA, error: null }))
      .mockReturnValueOnce(mockChain({ data: { limite_chats_por_atendente: 0 }, error: null }))
      .mockReturnValueOnce(mockChain({ data: assumida, error: null }))
    const result = await executarAssumirConversa({ company_id: 10, conversa_id: 77, user_id: 4, perfil: 'atendente' })
    expect(result.ok).toBe(true)
    expect(supabase.from).toHaveBeenCalledTimes(3)
  })

  test('instalação sem a coluna de campanha não falha o assumir', async () => {
    const assumida = { ...CONV_CAMPANHA, atendente_id: 4, status_atendimento: 'em_atendimento', aguardando_resposta_campanha: true }
    supabase.from
      .mockReturnValueOnce(mockChain({ data: CONV_CAMPANHA, error: null }))
      .mockReturnValueOnce(mockChain({ data: { limite_chats_por_atendente: 0 }, error: null }))
      .mockReturnValueOnce(mockChain({ data: assumida, error: null }))
      .mockReturnValueOnce(mockChain({ data: null, error: { message: 'column "aguardando_resposta_campanha" does not exist' } }))
    const result = await executarAssumirConversa({ company_id: 10, conversa_id: 77, user_id: 4, perfil: 'atendente' })
    expect(result.ok).toBe(true)
  })
})

describe('executarAssumirConversa — co-atendimento é por atendimento', () => {
  beforeEach(() => jest.clearAllMocks())
  const ABERTA_LIVRE = { ...CONV_FECHADA, status_atendimento: 'aberta', atendente_id: null }

  test('assumir da fila (sem responsável) encerra co-atendentes que sobraram do atendimento anterior', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: ABERTA_LIVRE, error: null }))
      .mockReturnValueOnce(mockChain({ data: { limite_chats_por_atendente: 0 }, error: null }))
      .mockReturnValueOnce(mockChain({ data: { ...ABERTA_LIVRE, atendente_id: 4, status_atendimento: 'em_atendimento' }, error: null }))
    const result = await executarAssumirConversa({ company_id: 10, conversa_id: 77, user_id: 4, perfil: 'atendente' })
    expect(result.ok).toBe(true)
    expect(encerrarCoAtendimentoDaConversa).toHaveBeenCalledWith({ company_id: 10, conversa_id: 77, removido_por: 4 })
  })

  test('responsável que já tinha a conversa (re-assumir) mantém a equipe', async () => {
    const minha = { ...ABERTA_LIVRE, status_atendimento: 'em_atendimento', atendente_id: 4 }
    supabase.from
      .mockReturnValueOnce(mockChain({ data: minha, error: null }))
      .mockReturnValueOnce(mockChain({ data: { limite_chats_por_atendente: 0 }, error: null }))
      .mockReturnValueOnce(mockChain({ data: minha, error: null }))
    const result = await executarAssumirConversa({ company_id: 10, conversa_id: 77, user_id: 4, perfil: 'atendente' })
    expect(result.ok).toBe(true)
    expect(encerrarCoAtendimentoDaConversa).not.toHaveBeenCalled()
  })

  test('assumir que perdeu a corrida não mexe nos co-atendentes', async () => {
    supabase.from
      .mockReturnValueOnce(mockChain({ data: ABERTA_LIVRE, error: null }))
      .mockReturnValueOnce(mockChain({ data: { limite_chats_por_atendente: 0 }, error: null }))
      .mockReturnValueOnce(mockChain())
      .mockReturnValueOnce(mockChain({ data: { ...ABERTA_LIVRE, atendente_id: 8, status_atendimento: 'em_atendimento' }, error: null }))
    const result = await executarAssumirConversa({ company_id: 10, conversa_id: 77, user_id: 4, perfil: 'atendente' })
    expect(result).toMatchObject({ ok: false, status: 409 })
    expect(encerrarCoAtendimentoDaConversa).not.toHaveBeenCalled()
  })
})
