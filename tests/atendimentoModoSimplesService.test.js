const supabase = require('../config/supabase')

jest.mock('../helpers/empresaModoSimplesFlag', () => ({
  empresaModoSimplesAtivo: jest.fn(),
}))

jest.mock('../services/absenceFinalizationService', () => ({
  loadChatbotTriageMergeAndAbsence: jest.fn().mockResolvedValue({
    triageMerged: {},
    absence: {},
  }),
  outboundQualificaParaAguardandoCliente: jest.fn((texto, autorUsuarioId) => {
    const uid = autorUsuarioId != null ? Number(autorUsuarioId) : NaN
    if (Number.isFinite(uid) && uid > 0) return String(texto || '').trim().length > 0
    return String(texto || '').trim().length > 0
  }),
}))

const { empresaModoSimplesAtivo } = require('../helpers/empresaModoSimplesFlag')
const {
  resolverModoSimplesAguardando,
  mensagemQualificaParaModoSimples,
  recalcularStatusPorUltimaMensagem,
  limparAguardandoAtendenteModoSimples,
} = require('../services/atendimentoModoSimplesService')

describe('atendimentoModoSimplesService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    empresaModoSimplesAtivo.mockReset()
    const chain = supabase.from()
    chain.maybeSingle.mockReset()
    chain.maybeSingle.mockResolvedValue({ data: null, error: null })
    chain.update.mockReset()
    chain.update.mockReturnValue(chain)
    chain.eq.mockReturnValue(chain)
    if (!chain.in) chain.in = jest.fn().mockReturnThis()
    if (!chain.order) chain.order = jest.fn().mockReturnThis()
    if (!chain.limit) chain.limit = jest.fn().mockReturnThis()
    chain.limit.mockResolvedValue({ data: [], error: null })
  })

  describe('resolverModoSimplesAguardando', () => {
    it('última inbound → aguardando atendente', () => {
      expect(resolverModoSimplesAguardando({ direcao: 'in' })).toBe('atendente')
    })

    it('última outbound qualificada → aguardando cliente', () => {
      expect(resolverModoSimplesAguardando({ direcao: 'out' })).toBe('cliente')
    })

    it('sem mensagem → null', () => {
      expect(resolverModoSimplesAguardando(null)).toBeNull()
    })
  })

  describe('mensagemQualificaParaModoSimples', () => {
    it('ignora mensagens system', async () => {
      const ok = await mensagemQualificaParaModoSimples({ direcao: 'system', texto: 'transferiu' }, 1)
      expect(ok).toBe(false)
    })

    it('aceita inbound do cliente', async () => {
      const ok = await mensagemQualificaParaModoSimples({ direcao: 'in', texto: 'oi' }, 1)
      expect(ok).toBe(true)
    })
  })

  describe('recalcularStatusPorUltimaMensagem', () => {
    it('empresa com módulo desligado não altera conversa', async () => {
      empresaModoSimplesAtivo.mockResolvedValue(false)
      const result = await recalcularStatusPorUltimaMensagem({ company_id: 1, conversa_id: 10 })
      expect(result.skipped).toBe(true)
      expect(result.reason).toBe('modo_simples_desligado')
    })

    it('cliente envia WhatsApp → aguardando atendente', async () => {
      empresaModoSimplesAtivo.mockResolvedValue(true)
      const chain = supabase.from()
      chain.maybeSingle.mockResolvedValueOnce({
        data: {
          id: 10,
          tipo: 'individual',
          telefone: '5511999999999',
          status_atendimento: 'aberta',
          atendente_id: null,
          modo_simples_aguardando: null,
        },
        error: null,
      })
      chain.update.mockReturnValue(chain)
      chain.eq.mockReturnValue(chain)

      const result = await recalcularStatusPorUltimaMensagem({
        company_id: 1,
        conversa_id: 10,
        mensagemNova: { id: 1, conversa_id: 10, direcao: 'in', texto: 'Olá', criado_em: '2026-07-06T12:00:00.000Z' },
      })

      expect(result.changed).toBe(true)
      expect(result.modo_simples_aguardando).toBe('atendente')
      expect(chain.update).toHaveBeenCalled()
    })

    it('atendente responde sem assumir → aguardando cliente', async () => {
      empresaModoSimplesAtivo.mockResolvedValue(true)
      const chain = supabase.from()
      chain.maybeSingle.mockResolvedValueOnce({
        data: {
          id: 10,
          tipo: 'individual',
          telefone: '5511999999999',
          status_atendimento: 'aberta',
          atendente_id: null,
          modo_simples_aguardando: 'atendente',
        },
        error: null,
      })
      chain.update.mockReturnValue(chain)
      chain.eq.mockReturnValue(chain)

      const result = await recalcularStatusPorUltimaMensagem({
        company_id: 1,
        conversa_id: 10,
        mensagemNova: {
          id: 2,
          conversa_id: 10,
          direcao: 'out',
          texto: 'Bom dia',
          autor_usuario_id: 5,
          criado_em: '2026-07-06T12:01:00.000Z',
        },
      })

      expect(result.changed).toBe(true)
      expect(result.modo_simples_aguardando).toBe('cliente')
    })

    it('cliente responde novamente → volta para aguardando atendente', async () => {
      empresaModoSimplesAtivo.mockResolvedValue(true)
      const chain = supabase.from()
      chain.maybeSingle.mockResolvedValueOnce({
        data: {
          id: 10,
          tipo: 'individual',
          telefone: '5511999999999',
          status_atendimento: 'aberta',
          atendente_id: null,
          modo_simples_aguardando: 'cliente',
        },
        error: null,
      })
      chain.update.mockReturnValue(chain)
      chain.eq.mockReturnValue(chain)

      const result = await recalcularStatusPorUltimaMensagem({
        company_id: 1,
        conversa_id: 10,
        mensagemNova: {
          id: 3,
          conversa_id: 10,
          direcao: 'in',
          texto: 'Obrigado',
          criado_em: '2026-07-06T12:02:00.000Z',
        },
      })

      expect(result.modo_simples_aguardando).toBe('atendente')
    })

    it('não altera status quando valor já é o mesmo (evita flicker)', async () => {
      empresaModoSimplesAtivo.mockResolvedValue(true)
      const chain = supabase.from()
      chain.maybeSingle.mockResolvedValueOnce({
        data: {
          id: 10,
          tipo: 'individual',
          telefone: '5511999999999',
          status_atendimento: 'aberta',
          atendente_id: null,
          modo_simples_aguardando: 'atendente',
        },
        error: null,
      })

      const result = await recalcularStatusPorUltimaMensagem({
        company_id: 1,
        conversa_id: 10,
        mensagemNova: { id: 1, conversa_id: 10, direcao: 'in', texto: 'Oi', criado_em: '2026-07-06T12:00:00.000Z' },
      })

      expect(result.changed).toBe(false)
      expect(result.modo_simples_aguardando).toBe('atendente')
      expect(chain.update).not.toHaveBeenCalled()
    })

    it('marcada como lida (null) não reativa aguardando sem mensagem nova', async () => {
      empresaModoSimplesAtivo.mockResolvedValue(true)
      const chain = supabase.from()
      chain.maybeSingle.mockResolvedValueOnce({
        data: {
          id: 10,
          tipo: 'individual',
          telefone: '5511999999999',
          status_atendimento: 'aberta',
          atendente_id: null,
          modo_simples_aguardando: null,
        },
        error: null,
      })
      chain.limit.mockResolvedValueOnce({
        data: [{ id: 1, conversa_id: 10, direcao: 'in', texto: 'Oi', criado_em: '2026-07-06T12:00:00.000Z' }],
        error: null,
      })

      const result = await recalcularStatusPorUltimaMensagem({
        company_id: 1,
        conversa_id: 10,
      })

      expect(result.changed).toBe(false)
      expect(result.modo_simples_aguardando).toBe(null)
      expect(chain.update).not.toHaveBeenCalled()
    })

    it('nova inbound após marcar como lida volta para aguardando atendente', async () => {
      empresaModoSimplesAtivo.mockResolvedValue(true)
      const chain = supabase.from()
      chain.maybeSingle.mockResolvedValueOnce({
        data: {
          id: 10,
          tipo: 'individual',
          telefone: '5511999999999',
          status_atendimento: 'aberta',
          atendente_id: null,
          modo_simples_aguardando: null,
        },
        error: null,
      })
      chain.update.mockReturnValue(chain)
      chain.eq.mockReturnValue(chain)

      const result = await recalcularStatusPorUltimaMensagem({
        company_id: 1,
        conversa_id: 10,
        mensagemNova: {
          id: 4,
          conversa_id: 10,
          direcao: 'in',
          texto: 'Nova mensagem',
          criado_em: '2026-07-06T13:00:00.000Z',
        },
      })

      expect(result.changed).toBe(true)
      expect(result.modo_simples_aguardando).toBe('atendente')
    })
  })

  describe('limparAguardandoAtendenteModoSimples', () => {
    it('grupo não altera modo_simples_aguardando', async () => {
      const result = await limparAguardandoAtendenteModoSimples({
        company_id: 1,
        conversa_id: 5,
        isGroup: true,
      })
      expect(result.ok).toBe(true)
      expect(result.grupo).toBe(true)
      expect(result.modo_simples_aguardando).toBe(null)
    })

    it('individual zera modo_simples_aguardando', async () => {
      const chain = supabase.from()
      chain.eq.mockReturnThis()
      chain.update.mockReturnValue({ eq: chain.eq })

      const result = await limparAguardandoAtendenteModoSimples({
        company_id: 1,
        conversa_id: 10,
        isGroup: false,
      })
      expect(result.ok).toBe(true)
      expect(result.modo_simples_aguardando).toBe(null)
      expect(chain.update).toHaveBeenCalledWith({ modo_simples_aguardando: null })
    })
  })
})

describe('assertPodeEnviarMensagem — modo simples', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    empresaModoSimplesAtivo.mockReset()
    empresaModoSimplesAtivo.mockResolvedValue(true)
    const chain = supabase.from()
    chain.maybeSingle.mockReset()
    chain.maybeSingle.mockResolvedValue({ data: null, error: null })
  })

  it('permite enviar sem atendente quando modo simples está ativo', async () => {
    empresaModoSimplesAtivo.mockResolvedValue(true)
    const { _test } = require('../controllers/chatController')
    const chain = supabase.from()

    chain.maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: 10,
          atendente_id: null,
          departamento_id: null,
          tipo: 'individual',
          telefone: '5511999999999',
          status_atendimento: 'aberta',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: 10,
          atendente_id: null,
          departamento_id: null,
          tipo: 'individual',
          telefone: '5511999999999',
          status_atendimento: 'aberta',
        },
        error: null,
      })

    const result = await _test.assertPodeEnviarMensagem({
      company_id: 1,
      conversa_id: 10,
      user_id: 2,
      role: 'admin',
      user_dep_ids: [],
      autoAssumirAoEnviar: false,
    })

    expect(result.ok).toBe(true)
    expect(result.reason).toBe('modo_simples_sem_assumir')
  })
})
