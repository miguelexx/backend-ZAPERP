/**
 * POST /chats/:id/notas-internas — comportamento do handler.
 *
 * Cobre os cenários de segurança exigidos: chamada direta com dados manipulados,
 * conversa de outra empresa, usuário sem permissão, conteúdo vazio/acima do limite,
 * e falha de banco (nada pode aparecer como salvo nem ser emitido).
 */

const supabase = require('../config/supabase')
const { criarNotaInterna } = require('../controllers/chatController')
const { INTERNAL_NOTE_MAX_LEN } = require('../helpers/internalNote')

function buildRes() {
  const res = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

function buildReq(overrides = {}) {
  return {
    user: { company_id: 1, id: 2, perfil: 'admin', departamento_ids: [] },
    params: { id: '10' },
    body: { texto: 'combinar desconto com o financeiro' },
    app: { get: () => undefined },
    ...overrides,
  }
}

/** Conversa já assumida pelo autor: assertPermissaoConversa libera no primeiro ramo. */
const conversaDoAutor = {
  id: 10,
  atendente_id: 2,
  departamento_id: null,
  tipo: null,
  telefone: '5534999999999',
  status_atendimento: 'em_atendimento',
}

describe('criarNotaInterna', () => {
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

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // ── Conteúdo ──────────────────────────────────────────────────────────────

  test('recusa conteúdo vazio antes de qualquer acesso ao banco', async () => {
    const res = buildRes()
    await criarNotaInterna(buildReq({ body: { texto: '   ' } }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json.mock.calls[0][0].code).toBe('conteudo_vazio')
    expect(chain.insert).not.toHaveBeenCalled()
  })

  test('recusa conteúdo acima do limite', async () => {
    const res = buildRes()
    await criarNotaInterna(buildReq({ body: { texto: 'a'.repeat(INTERNAL_NOTE_MAX_LEN + 1) } }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json.mock.calls[0][0].code).toBe('conteudo_muito_longo')
    expect(chain.insert).not.toHaveBeenCalled()
  })

  test('recusa conversa inválida na URL', async () => {
    const res = buildRes()
    await criarNotaInterna(buildReq({ params: { id: 'abc' } }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(chain.insert).not.toHaveBeenCalled()
  })

  // ── Permissão / isolamento ────────────────────────────────────────────────

  test('nega perfil sem permissão para nota interna (deny-by-default do catálogo)', async () => {
    const res = buildRes()
    await criarNotaInterna(buildReq({ user: { company_id: 1, id: 2, perfil: 'perfil_legado', departamento_ids: [] } }), res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(chain.insert).not.toHaveBeenCalled()
  })

  test('404 quando a conversa não é da empresa do token (isolamento multi-tenant)', async () => {
    // assertPermissaoConversa filtra por company_id: conversa de outra empresa "não existe".
    chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    const res = buildRes()
    await criarNotaInterna(buildReq(), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(chain.insert).not.toHaveBeenCalled()
  })

  test('403 quando o usuário não tem acesso à conversa (outro setor)', async () => {
    chain.maybeSingle
      // conversa de outro setor, sem atendente
      .mockResolvedValueOnce({
        data: { id: 10, atendente_id: null, departamento_id: 99, tipo: null, telefone: '5534999999999', status_atendimento: 'aberta' },
        error: null,
      })
      // atendimentos: usuário não transferiu esta conversa
      .mockResolvedValueOnce({ data: null, error: null })

    const res = buildRes()
    await criarNotaInterna(
      buildReq({ user: { company_id: 1, id: 2, perfil: 'atendente', departamento_ids: [3] } }),
      res
    )

    expect(res.status).toHaveBeenCalledWith(403)
    expect(chain.insert).not.toHaveBeenCalled()
  })

  test('403 quando a conversa está assumida por outro atendente (não pode ler, não pode anotar)', async () => {
    chain.maybeSingle
      // conversa do mesmo setor, mas assumida por outro atendente
      .mockResolvedValueOnce({
        data: { id: 10, atendente_id: 55, departamento_id: 3, tipo: null, telefone: '5534999999999', status_atendimento: 'em_atendimento' },
        error: null,
      })
      // conversa_atendentes: não é participante ativo
      .mockResolvedValueOnce({ data: null, error: null })
      // atendimentos: não transferiu
      .mockResolvedValueOnce({ data: null, error: null })

    const res = buildRes()
    await criarNotaInterna(
      buildReq({ user: { company_id: 1, id: 2, perfil: 'atendente', departamento_ids: [3] } }),
      res
    )

    expect(res.status).toHaveBeenCalledWith(403)
    expect(chain.insert).not.toHaveBeenCalled()
  })

  test('ignora company_id/autor vindos do corpo — usa apenas o token', async () => {
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversaDoAutor, error: null })
      .mockResolvedValueOnce({ data: { id: 2, nome: 'Ana' }, error: null })
    chain.single.mockResolvedValueOnce({
      data: { id: 500, conversa_id: 10, company_id: 1, texto: 'nota', tipo: 'internal_note', direcao: 'interna', status: 'interna', criado_em: '2026-07-28T12:00:00.000Z', autor_usuario_id: 2 },
      error: null,
    })

    const res = buildRes()
    await criarNotaInterna(
      buildReq({
        body: {
          texto: 'nota',
          company_id: 999,
          autor_usuario_id: 777,
          conversa_id: 888,
          status: 'sent',
          whatsapp_id: 'BAE543FE1CE17AFA',
        },
      }),
      res
    )

    expect(res.status).toHaveBeenCalledWith(201)
    const payloadInserido = chain.insert.mock.calls[0][0]
    expect(payloadInserido.company_id).toBe(1)
    expect(payloadInserido.autor_usuario_id).toBe(2)
    expect(payloadInserido.conversa_id).toBe(10)
    expect(payloadInserido.status).toBe('interna')
    expect(payloadInserido.whatsapp_id).toBeNull()
  })

  // ── Persistência ──────────────────────────────────────────────────────────

  test('grava a nota sem whatsapp_id, sem status de envio e sem mexer em conversas', async () => {
    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversaDoAutor, error: null })
      .mockResolvedValueOnce({ data: { id: 2, nome: 'Ana' }, error: null })
    chain.single.mockResolvedValueOnce({
      data: { id: 501, conversa_id: 10, company_id: 1, texto: 'combinar desconto com o financeiro', tipo: 'internal_note', direcao: 'interna', status: 'interna', criado_em: '2026-07-28T12:00:00.000Z', autor_usuario_id: 2 },
      error: null,
    })

    const res = buildRes()
    await criarNotaInterna(buildReq(), res)

    expect(res.status).toHaveBeenCalledWith(201)
    const body = res.json.mock.calls[0][0]
    expect(body.ok).toBe(true)
    expect(body.nota.tipo).toBe('internal_note')
    expect(body.nota.direcao).toBe('interna')
    expect(body.nota.whatsapp_id).toBeUndefined()
    expect(body.nota.fromMe).toBe(false)
    expect(body.nota.enviado_por_usuario).toBe(false)
    expect(body.nota.usuario_nome).toBe('Ana')

    // Nenhum UPDATE: status, responsável, fila, unread e ultima_atividade ficam intactos.
    expect(chain.update).not.toHaveBeenCalled()
    // Só a tabela mensagens (e a leitura de usuarios/conversas) — nada de conversa_unreads.
    const tabelas = supabase.from.mock.calls.map((c) => c[0])
    expect(tabelas).not.toContain('conversa_unreads')
  })

  // ── Falha de banco ────────────────────────────────────────────────────────

  test('falha de banco: responde 500, não devolve nota e não emite nada em tempo real', async () => {
    const emit = jest.fn()
    const io = { to: jest.fn(() => ({ emit })), emit, EVENTS: {} }

    chain.maybeSingle.mockResolvedValueOnce({ data: conversaDoAutor, error: null })
    chain.single.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } })

    const res = buildRes()
    await criarNotaInterna(buildReq({ app: { get: () => io } }), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('nota')
    expect(emit).not.toHaveBeenCalled()
  })

  test('insert sem retorno de linha também é tratado como falha', async () => {
    chain.maybeSingle.mockResolvedValueOnce({ data: conversaDoAutor, error: null })
    chain.single.mockResolvedValueOnce({ data: null, error: null })

    const res = buildRes()
    await criarNotaInterna(buildReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
  })
})
