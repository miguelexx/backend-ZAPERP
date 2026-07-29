/**
 * Múltiplos atendentes na conversa — remoção de co-atendente.
 *
 * A adição, a listagem e as regras de visibilidade já existiam (migration
 * 20260619100000 + assertPermissaoConversa/assertPodeEnviarMensagem) e são
 * cobertas por assertPermissaoConversa.test.js. Aqui cobrimos o que é novo:
 * DELETE /chats/:id/atendentes/:usuario_id e suas garantias.
 */

const supabase = require('../config/supabase')
const { removerAtendenteConversa } = require('../controllers/chatController')

function buildRes() {
  const res = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

function buildReq(overrides = {}) {
  return {
    user: { company_id: 1, id: 2, perfil: 'admin', departamento_ids: [] },
    params: { id: '10', usuario_id: '55' },
    body: {},
    app: { get: () => undefined },
    ...overrides,
  }
}

/** Conversa em atendimento, principal = usuário 2. */
const conversaComPrincipal = {
  id: 10,
  atendente_id: 2,
  departamento_id: null,
  tipo: null,
  telefone: '5534999999999',
  status_atendimento: 'em_atendimento',
}

describe('removerAtendenteConversa', () => {
  let chain

  beforeEach(() => {
    jest.clearAllMocks()
    chain = supabase.from()
    chain.maybeSingle.mockReset()
    chain.single.mockReset()
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => jest.restoreAllMocks())

  // ── Regra central: o principal não sai por aqui ───────────────────────────

  test('recusa remover o responsável principal — exige transferência', async () => {
    chain.maybeSingle.mockResolvedValueOnce({ data: conversaComPrincipal, error: null })

    const res = buildRes()
    // usuario_id 2 é o próprio atendente_id da conversa
    await removerAtendenteConversa(buildReq({ params: { id: '10', usuario_id: '2' } }), res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json.mock.calls[0][0].code).toBe('PRINCIPAL_EXIGE_TRANSFERENCIA')
    expect(chain.update).not.toHaveBeenCalled()
  })

  // ── Validação de entrada ──────────────────────────────────────────────────

  test('recusa usuario_id inválido antes de tocar o banco', async () => {
    const res = buildRes()
    await removerAtendenteConversa(buildReq({ params: { id: '10', usuario_id: 'abc' } }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(chain.update).not.toHaveBeenCalled()
  })

  // ── Isolamento entre empresas ─────────────────────────────────────────────

  test('404 quando a conversa não é da empresa do token', async () => {
    // assertPermissaoConversa filtra por company_id: conversa de outra empresa não existe.
    chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const res = buildRes()
    await removerAtendenteConversa(buildReq(), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(chain.update).not.toHaveBeenCalled()
  })

  // ── Quem pode remover ─────────────────────────────────────────────────────

  test('atendente comum não remove participante de outra pessoa', async () => {
    chain.maybeSingle
      // conversa assumida por outro (id 9), mesmo setor do usuário 2
      .mockResolvedValueOnce({
        data: { ...conversaComPrincipal, atendente_id: 9, departamento_id: 3 },
        error: null,
      })
      // conversa_atendentes: usuário 2 É participante ativo (por isso tem acesso)
      .mockResolvedValueOnce({ data: { id: 1 }, error: null })

    const res = buildRes()
    await removerAtendenteConversa(
      buildReq({ user: { company_id: 1, id: 2, perfil: 'atendente', departamento_ids: [3] } }),
      res
    )

    expect(res.status).toHaveBeenCalledWith(403)
    expect(chain.update).not.toHaveBeenCalled()
  })

  test('participante pode sair sozinho do atendimento', async () => {
    chain.maybeSingle
      // conversa de outro principal (9); quem chama é o próprio 55
      .mockResolvedValueOnce({ data: { ...conversaComPrincipal, atendente_id: 9 }, error: null })
      // usuarioParticipaAtivamenteDaConversa → é participante
      .mockResolvedValueOnce({ data: { id: 1 }, error: null })
      // busca do participante ativo alvo
      .mockResolvedValueOnce({ data: { id: 77, usuario_id: 55, ativo: true }, error: null })
      // update .maybeSingle()
      .mockResolvedValueOnce({ data: { id: 77, usuario_id: 55, ativo: false }, error: null })
      // usuarios (fromUser)
      .mockResolvedValueOnce({ data: { nome: 'Bruno' }, error: null })
      // usuarios (targetUser)
      .mockResolvedValueOnce({ data: { id: 55, nome: 'Bruno', email: 'b@x.com', perfil: 'atendente' }, error: null })

    const res = buildRes()
    await removerAtendenteConversa(
      buildReq({ user: { company_id: 1, id: 55, perfil: 'atendente', departamento_ids: [] } }),
      res
    )

    expect(res.json).toHaveBeenCalled()
    expect(res.json.mock.calls[0][0].ok).toBe(true)
    expect(chain.update).toHaveBeenCalled()
  })

  // ── Não altera a conversa ─────────────────────────────────────────────────

  test('remove por soft-delete e não escreve em conversas (status/fila/SLA intactos)', async () => {
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversaComPrincipal, error: null })
      .mockResolvedValueOnce({ data: { id: 77, usuario_id: 55, ativo: true }, error: null })
      .mockResolvedValueOnce({ data: { id: 77, usuario_id: 55, ativo: false }, error: null })
      .mockResolvedValueOnce({ data: { nome: 'Ana' }, error: null })
      .mockResolvedValueOnce({ data: { id: 55, nome: 'Bruno', email: 'b@x.com', perfil: 'atendente' }, error: null })

    const res = buildRes()
    await removerAtendenteConversa(buildReq(), res)

    expect(res.json.mock.calls[0][0].ok).toBe(true)

    // Soft-delete com auditoria de saída — a linha é preservada.
    const patch = chain.update.mock.calls[0][0]
    expect(patch.ativo).toBe(false)
    expect(patch.removido_por).toBe(2)
    expect(typeof patch.removido_em).toBe('string')

    // Exatamente UM update em todo o fluxo: o soft-delete do participante.
    // `conversas` é apenas LIDA (assertPermissaoConversa) — status, fila,
    // responsável, setor e SLA não recebem escrita nenhuma.
    expect(chain.update).toHaveBeenCalledTimes(1)
    expect(chain.delete).not.toHaveBeenCalled()
  })

  test('404 quando o alvo não é participante ativo', async () => {
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversaComPrincipal, error: null })
      .mockResolvedValueOnce({ data: null, error: null })

    const res = buildRes()
    await removerAtendenteConversa(buildReq(), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(chain.update).not.toHaveBeenCalled()
  })

  // ── Dois atendentes simultâneos ───────────────────────────────────────────

  test('corrida: segundo removedor recebe 409 em vez de "sucesso" falso', async () => {
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversaComPrincipal, error: null })
      // ainda enxerga o participante como ativo (leitura antes da corrida)
      .mockResolvedValueOnce({ data: { id: 77, usuario_id: 55, ativo: true }, error: null })
      // UPDATE ... WHERE ativo = true não afeta linha: outro já removeu
      .mockResolvedValueOnce({ data: null, error: null })

    const res = buildRes()
    await removerAtendenteConversa(buildReq(), res)

    expect(res.status).toHaveBeenCalledWith(409)
  })

  // ── Grupos ────────────────────────────────────────────────────────────────

  test('conversa de grupo não tem participantes de atendimento', async () => {
    chain.maybeSingle.mockResolvedValueOnce({
      data: { ...conversaComPrincipal, tipo: 'grupo', telefone: '12036@g.us' },
      error: null,
    })

    const res = buildRes()
    await removerAtendenteConversa(buildReq(), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(chain.update).not.toHaveBeenCalled()
  })

  // ── Rota ──────────────────────────────────────────────────────────────────

  test('rota DELETE registrada e distinta da transferência', () => {
    const chatController = require('../controllers/chatController')
    expect(typeof chatController.removerAtendenteConversa).toBe('function')
    expect(chatController.removerAtendenteConversa).not.toBe(chatController.transferirChat)
    expect(chatController.removerAtendenteConversa).not.toBe(chatController.adicionarAtendenteConversa)
  })
})
