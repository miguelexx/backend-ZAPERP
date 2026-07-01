const supabase = require('../config/supabase')
const { transferirChat, reabrirChat } = require('../controllers/chatController')

function buildRes() {
  const res = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

function buildReq(overrides = {}) {
  return {
    user: { company_id: 1, id: 2, perfil: 'admin', departamento_ids: [] },
    params: { id: 10 },
    body: {},
    app: { get: () => undefined },
    ...overrides,
  }
}

// Modela a corrida sem depender de concorrência real do Node: cada teste
// controla diretamente o que o UPDATE de lock "vê" no banco no momento do
// commit, que é exatamente o que o Postgres faria com .eq()/.is() na cláusula
// WHERE quando duas requisições tentam mexer na mesma linha ao mesmo tempo.
describe('Lock otimista: transferirChat e reabrirChat', () => {
  let chain

  beforeEach(() => {
    jest.clearAllMocks()
    chain = supabase.from()
    chain.is = jest.fn().mockReturnThis()
  })

  describe('transferirChat', () => {
    const convAberta = {
      id: 10, atendente_id: null, status_atendimento: 'aberta',
      tipo: null, telefone: '5534999999999', departamento_id: null,
    }
    const targetUser = { id: 5, nome: 'Fulano', ativo: true, departamento_id: null }

    test('aplica o lock por atendente_id (.is quando observado null) e responde 200 quando ninguém mais mexeu na conversa', async () => {
      chain.maybeSingle
        .mockResolvedValueOnce({ data: convAberta, error: null }) // assertPermissaoConversa
        .mockResolvedValueOnce({ data: targetUser, error: null }) // validação do usuário destino
        .mockResolvedValueOnce({ data: { ...convAberta, atendente_id: 5, status_atendimento: 'em_atendimento' }, error: null }) // update com lock

      const req = buildReq({ body: { para_usuario_id: 5 } })
      const res = buildRes()
      await transferirChat(req, res)

      expect(chain.is).toHaveBeenCalledWith('atendente_id', null)
      expect(res.status).not.toHaveBeenCalledWith(409)
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        conversa: expect.objectContaining({
          atendente_id: 5,
          status_atendimento: 'em_atendimento',
        }),
      }))
    })

    test('responde 409 quando outra pessoa já assumiu/transferiu a conversa entre a leitura e a escrita', async () => {
      chain.maybeSingle
        .mockResolvedValueOnce({ data: convAberta, error: null }) // assertPermissaoConversa ainda viu atendente_id: null
        .mockResolvedValueOnce({ data: targetUser, error: null }) // validação do usuário destino
        .mockResolvedValueOnce({ data: null, error: null }) // UPDATE não bate mais no WHERE: outra requisição já mudou atendente_id

      const req = buildReq({ body: { para_usuario_id: 5 } })
      const res = buildRes()
      await transferirChat(req, res)

      expect(chain.is).toHaveBeenCalledWith('atendente_id', null)
      expect(res.status).toHaveBeenCalledWith(409)
      expect(res.json).toHaveBeenCalledWith({ error: 'Esta conversa já foi transferida ou assumida por outra pessoa' })
    })
  })

  describe('reabrirChat', () => {
    const convFinalizada = {
      id: 10, atendente_id: null, status_atendimento: 'finalizada',
      tipo: null, telefone: '5534999999999', departamento_id: null,
      reaberta_falta_interacao_em: null,
    }

    test('aplica o lock por status_atendimento e responde 200 quando a conversa ainda está no estado observado', async () => {
      chain.maybeSingle.mockImplementation(() => {
        // 1ª leitura: assertPermissaoConversa. Update de lock: identificado pelo
        // payload conter atendente_id (reabrirChat sempre seta isso no patch).
        if (chain.update.mock.calls.length > 0) {
          return Promise.resolve({ data: { ...convFinalizada, atendente_id: 2, status_atendimento: 'em_atendimento' }, error: null })
        }
        return Promise.resolve({ data: convFinalizada, error: null })
      })

      const req = buildReq()
      const res = buildRes()
      await reabrirChat(req, res)

      expect(chain.eq).toHaveBeenCalledWith('status_atendimento', 'finalizada')
      expect(res.status).not.toHaveBeenCalledWith(409)
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
    })

    test('responde 409 quando outra pessoa já reabriu a conversa entre a leitura e a escrita', async () => {
      chain.maybeSingle.mockImplementation(() => {
        if (chain.update.mock.calls.length > 0) {
          // UPDATE não bate mais no WHERE: status já não é mais 'finalizada'
          return Promise.resolve({ data: null, error: null })
        }
        return Promise.resolve({ data: convFinalizada, error: null })
      })

      const req = buildReq()
      const res = buildRes()
      await reabrirChat(req, res)

      expect(chain.eq).toHaveBeenCalledWith('status_atendimento', 'finalizada')
      expect(res.status).toHaveBeenCalledWith(409)
      expect(res.json).toHaveBeenCalledWith({ error: 'Esta conversa já foi reaberta por outra pessoa' })
    })
  })
})
