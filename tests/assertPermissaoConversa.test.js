describe('assertPermissaoConversa', () => {
  const supabase = require('../config/supabase')

  beforeEach(() => {
    jest.clearAllMocks()
    // Outras suítes compartilham o mock encadeável do Supabase e podem deixar
    // respostas `mockResolvedValueOnce` pendentes. Limpar a fila torna este
    // teste determinístico também quando executado no conjunto completo.
    supabase.from().maybeSingle.mockReset()
  })

  test('nega acesso a perfil desconhecido (deny-by-default)', async () => {
    const { _test } = require('../controllers/chatController')
    const chain = supabase.from()
    const conv = {
      id: 10,
      atendente_id: 99,
      departamento_id: 1,
      tipo: null,
      telefone: '5534999999999',
      status_atendimento: 'aberta',
    }
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conv, error: null })
      // conversa_atendentes: usuário não é participante ativo
      .mockResolvedValueOnce({ data: null, error: null })
      // atendimentos (transferiu): sem transferência
      .mockResolvedValueOnce({ data: null, error: null })

    const result = await _test.assertPermissaoConversa({
      company_id: 1,
      conversa_id: 10,
      user_id: 2,
      role: 'perfil_legado_invalido',
      user_dep_ids: [1],
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  test('permite atendente do mesmo setor', async () => {
    const { _test } = require('../controllers/chatController')
    const chain = supabase.from()
    const conv = {
      id: 10,
      atendente_id: 99,
      departamento_id: 1,
      tipo: null,
      telefone: '5534999999999',
      status_atendimento: 'aberta',
    }
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conv, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null })

    const result = await _test.assertPermissaoConversa({
      company_id: 1,
      conversa_id: 10,
      user_id: 2,
      role: 'atendente',
      user_dep_ids: [1],
    })

    expect(result.ok).toBe(true)
  })
})
