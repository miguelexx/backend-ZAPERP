/**
 * "Novo grupo" — auditoria de 24/11/2026.
 *
 * 1) GRUPO FANTASMA. Empresa com 2+ números: o front não mandava `whatsapp_instance_id`, a
 *    instância vinha nula, o provider também, e `criarGrupo` caía num insert local
 *    (`telefone: grupo_<ts>`) — o "grupo" só existia no banco. Idem número UltraMSG e sem número.
 * 2) 9º DÍGITO. Os participantes iam crus: `toWhapiRecipient` reinsere o 9º e o WhatsApp não
 *    acha o contato (mesmo defeito do "adicionar ao grupo", 10-11/11).
 * 3) "ADICIONADOS" QUE NÃO ENTRARAM. 200 da Whapi com parte recusada era reportado como sucesso.
 */

const mockInsert = jest.fn()
jest.mock('../config/supabase', () => ({
  from: () => ({ insert: (...a) => { mockInsert(...a); return { select: () => ({ single: async () => ({ data: { id: 999 }, error: null }) }) } } }),
}))

const mockResolveInstance = jest.fn()
jest.mock('../services/whatsappInstanceService', () => ({
  resolveWhatsappInstanceForManualAction: (...a) => mockResolveInstance(...a),
}))

const mockProvider = { createGroup: jest.fn(), checkPhones: jest.fn() }
const mockGetProvider = jest.fn(() => mockProvider)
jest.mock('../services/providers', () => ({ getProvider: (...a) => mockGetProvider(...a) }))

const mockFindOrCreate = jest.fn()
jest.mock('../helpers/conversationSync', () => ({
  getCanonicalPhone: jest.fn(), getCanonicalPhoneAnyIntl: jest.fn(), getOrCreateCliente: jest.fn(),
  findOrCreateConversation: (...a) => mockFindOrCreate(...a),
}))

const mockEmitir = jest.fn()
jest.mock('../services/chat/realtime/chatRealtimeGateway', () => ({
  emitirEventoEmpresaConversa: (...a) => mockEmitir(...a), emitirConversaAtualizada: jest.fn(),
}))

const mockPermitidas = jest.fn()
jest.mock('../services/chat/access/usuarioWhatsappInstanceAccess', () => ({
  instanciasPermitidasDoUsuario: (...a) => mockPermitidas(...a),
  atendentePodeVerNumero: jest.requireActual('../services/chat/access/usuarioWhatsappInstanceAccessRules').atendentePodeVerNumero,
}))

const { criarGrupo } = require('../controllers/chat/contactController')
const { participantesNaoAdicionados } = require('../services/chat/identity/resultadoCriacaoGrupo')

function reqRes(body) {
  const res = { statusCode: 200, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  const req = { body, user: { company_id: 4, id: 7 }, app: { get: () => null } }
  return { req, res }
}

const INST_WHAPI = { id: 11, provider: 'whapi' }

beforeEach(() => {
  jest.clearAllMocks()
  mockGetProvider.mockImplementation(() => mockProvider)
  mockResolveInstance.mockResolvedValue({ error: null, code: null, instanceId: 11, instance: INST_WHAPI, instances: [INST_WHAPI] })
  mockProvider.checkPhones.mockResolvedValue([])
  mockPermitidas.mockResolvedValue(null)
  mockFindOrCreate.mockResolvedValue({ conversa: { id: 321, tipo: 'grupo', telefone: '120363@g.us' }, created: true })
})

describe('criarGrupo — nunca cria grupo só no banco', () => {
  test('2+ números sem escolha → 400 SELECIONE_WHATSAPP_INSTANCE, sem insert', async () => {
    mockResolveInstance.mockResolvedValue({ error: 'Selecione…', code: 'SELECIONE_WHATSAPP_INSTANCE', instance: null, instances: [{ id: 1 }, { id: 2 }] })
    const { req, res } = reqRes({ nome: 'Time', participantes: ['5534999911246'] })
    await criarGrupo(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.codigo).toBe('SELECIONE_WHATSAPP_INSTANCE')
    expect(res.body.instances).toHaveLength(2)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  test('sem número conectado → 409, sem insert', async () => {
    mockResolveInstance.mockResolvedValue({ error: 'Nenhuma', code: 'NO_ACTIVE_INSTANCE', instance: null, instances: [] })
    const { req, res } = reqRes({ nome: 'Time', participantes: ['5534999911246'] })
    await criarGrupo(req, res)
    expect(res.statusCode).toBe(409)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  test('provider sem createGroup (UltraMSG) → 422 CRIAR_GRUPO_NAO_SUPORTADO, sem insert', async () => {
    mockGetProvider.mockImplementation(() => ({}))
    const { req, res } = reqRes({ nome: 'Time', participantes: ['5534999911246'] })
    await criarGrupo(req, res)
    expect(res.statusCode).toBe(422)
    expect(res.body.codigo).toBe('CRIAR_GRUPO_NAO_SUPORTADO')
    expect(mockInsert).not.toHaveBeenCalled()
  })

  test('valida nome e participantes antes de tocar no WhatsApp', async () => {
    let r = reqRes({ nome: '   ', participantes: ['5534999911246'] })
    await criarGrupo(r.req, r.res)
    expect(r.res.statusCode).toBe(400)
    r = reqRes({ nome: 'x'.repeat(101), participantes: ['5534999911246'] })
    await criarGrupo(r.req, r.res)
    expect(r.res.body.codigo).toBe('NOME_LONGO')
    r = reqRes({ nome: 'Time', participantes: [] })
    await criarGrupo(r.req, r.res)
    expect(r.res.body.codigo).toBe('SEM_PARTICIPANTES')
    expect(mockProvider.createGroup).not.toHaveBeenCalled()
  })

  test('repassa o número escolhido ao resolvedor de instância', async () => {
    mockProvider.createGroup.mockResolvedValue({ ok: true, data: { id: '120363@g.us' } })
    const { req, res } = reqRes({ nome: 'Time', participantes: ['5534999911246'], whatsapp_instance_id: 11 })
    await criarGrupo(req, res)
    expect(mockResolveInstance).toHaveBeenCalledWith(4, 11)
    expect(res.statusCode).toBe(200)
  })
})

describe('criarGrupo — endereço real e quem não entrou', () => {
  test('usa o wa_id verificado como JID (o adapter não reinsere o 9º dígito)', async () => {
    mockProvider.checkPhones.mockResolvedValue([{ input: '5534999911246', exists: true, waId: '553499911246@s.whatsapp.net' }])
    mockProvider.createGroup.mockResolvedValue({ ok: true, data: { id: '120363@g.us', participants: [{ id: '553499911246@s.whatsapp.net' }] } })
    const { req, res } = reqRes({ nome: 'Time', participantes: ['5534999911246', '5534999911246'] })
    await criarGrupo(req, res)
    expect(mockProvider.createGroup).toHaveBeenCalledWith('Time', ['553499911246@s.whatsapp.net'], { companyId: 4, whatsappInstanceId: 11 })
    expect(res.body.id).toBe(321)
    expect(res.body.participantes_resultado).toEqual({ enviados: 1, adicionados: 1, nao_adicionados: [], sem_whatsapp: [] })
    expect(mockEmitir).toHaveBeenCalledWith(null, 4, 321, 'nova_conversa', expect.objectContaining({ id: 321 }))
  })

  test('número sem WhatsApp fica de fora e é reportado; todos sem → 422', async () => {
    mockProvider.checkPhones.mockResolvedValue([{ input: '5511900000000', exists: false }])
    const { req, res } = reqRes({ nome: 'Time', participantes: ['5511900000000'] })
    await criarGrupo(req, res)
    expect(res.statusCode).toBe(422)
    expect(res.body.codigo).toBe('SEM_WHATSAPP')
    expect(mockProvider.createGroup).not.toHaveBeenCalled()
  })

  test('failed[] da Whapi vira nao_adicionados com o número ORIGINAL', async () => {
    mockProvider.createGroup.mockResolvedValue({ ok: true, data: { id: '120363@g.us', failed: ['5534988887777@s.whatsapp.net'] } })
    const { req, res } = reqRes({ nome: 'Time', participantes: ['5534999911246', '5534988887777'] })
    await criarGrupo(req, res)
    expect(res.body.participantes_resultado.nao_adicionados).toEqual(['5534988887777'])
    expect(res.body.participantes_resultado.adicionados).toBe(1)
  })

  test('401 da Whapi vira 409 (não desloga o usuário)', async () => {
    mockProvider.createGroup.mockResolvedValue({ ok: false, httpStatus: 401, error: 'unauthorized' })
    const { req, res } = reqRes({ nome: 'Time', participantes: ['5534999911246'] })
    await criarGrupo(req, res)
    expect(res.statusCode).toBe(409)
    expect(res.body.codigo).toBe('WHATSAPP_DESCONECTADO')
  })
})

describe('criarGrupo — trava de visão por número', () => {
  test('número escolhido fora da trava → 403 NUMERO_SEM_ACESSO, nada criado', async () => {
    mockPermitidas.mockResolvedValue(new Set([12]))
    const { req, res } = reqRes({ nome: 'Time', participantes: ['5534999911246'], whatsapp_instance_id: 11 })
    await criarGrupo(req, res)
    expect(res.statusCode).toBe(403)
    expect(res.body.codigo).toBe('NUMERO_SEM_ACESSO')
    expect(mockProvider.createGroup).not.toHaveBeenCalled()
  })

  test('sem escolha e liberado para 1 número só → usa esse número', async () => {
    mockPermitidas.mockResolvedValue(new Set([11]))
    mockProvider.createGroup.mockResolvedValue({ ok: true, data: { id: '120363@g.us' } })
    const { req, res } = reqRes({ nome: 'Time', participantes: ['5534999911246'] })
    await criarGrupo(req, res)
    expect(mockResolveInstance).toHaveBeenCalledWith(4, 11)
    expect(res.statusCode).toBe(200)
  })

  test('pedido de escolha só lista os números que a pessoa pode usar', async () => {
    mockPermitidas.mockResolvedValue(new Set([2, 3]))
    mockResolveInstance.mockResolvedValue({ error: 'x', code: 'SELECIONE_WHATSAPP_INSTANCE', instance: null, instances: [{ id: 1 }, { id: 2 }, { id: 3 }] })
    const { req, res } = reqRes({ nome: 'Time', participantes: ['5534999911246'] })
    await criarGrupo(req, res)
    expect(res.body.instances.map((i) => i.id)).toEqual([2, 3])
  })

  test('número escolhido que saiu do ar → pede outro (não diz "nenhum número")', async () => {
    mockResolveInstance.mockResolvedValue({ error: 'x', code: 'INSTANCE_NOT_FOUND', instance: null, instances: [{ id: 2 }] })
    const { req, res } = reqRes({ nome: 'Time', participantes: ['5534999911246'], whatsapp_instance_id: 99 })
    await criarGrupo(req, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.codigo).toBe('SELECIONE_WHATSAPP_INSTANCE')
    expect(res.body.instances).toEqual([{ id: 2 }])
  })
})

describe('participantesNaoAdicionados', () => {
  const alvo = (original, extra = {}) => ({ original, jid: original, chatId: '', candidatos: [], ...extra })

  test('casa failed com e sem 9º dígito', () => {
    expect(participantesNaoAdicionados({ failed: ['553499911246@s.whatsapp.net'] }, [alvo('5534999911246')])).toEqual(['5534999911246'])
  })

  test('deduz pela ausência em participants', () => {
    const data = { participants: [{ id: '5534999911246@s.whatsapp.net' }, { id: '5534000000000@s.whatsapp.net' }] }
    expect(participantesNaoAdicionados(data, [alvo('5534999911246'), alvo('5534988887777')])).toEqual(['5534988887777'])
  })

  test('com @lid em participants não acusa ninguém (não dá para casar)', () => {
    const data = { participants: [{ id: '123456789@lid' }] }
    expect(participantesNaoAdicionados(data, [alvo('5534999911246')])).toEqual([])
  })

  test('sem failed nem participants não afirma nada', () => {
    expect(participantesNaoAdicionados({ id: 'x@g.us' }, [alvo('5534999911246')])).toEqual([])
    expect(participantesNaoAdicionados({ failed: [] }, [alvo('5534999911246')])).toEqual([])
  })
})
