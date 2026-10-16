/**
 * F4 e F5 da auditoria das setas (doc 33).
 *
 * F4 — falha de INFRA ao aplicar o ACK responde 500 (provedor reentrega). "Mensagem não
 *      encontrada", status não mapeado e `whatsapp_id` ambíguo continuam 200.
 * F5 — `deleted`/code 6 da Whapi é REVOGAÇÃO, não falha de envio: sai do pipeline de status e
 *      marca `apagada_para_todos`, emitindo `mensagem_excluida`.
 */

describe('F4 — ACK com falha de banco pede reentrega', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  function montar({ erroNoUpdate = null, erroNaLeituraDeRank = null, achou = true } = {}) {
    jest.resetModules()
    jest.doMock('../config/supabase', () => ({ from: () => { throw new Error('não deveria usar supabase direto') } }))
    jest.doMock('../services/whatsappConfigService', () => ({ getCompanyIdByInstanceId: jest.fn() }))
    jest.doMock('../services/whatsappInstanceService', () => ({ getWhatsappInstanceByProviderInstanceId: jest.fn() }))
    jest.doMock('../services/disparoWebhookHook', () => ({ aplicarStatusDisparoFromWebhook: jest.fn(async () => {}) }))
    jest.doMock('../services/mediaR2MirrorService', () => ({ scheduleR2MirrorIfNeeded: jest.fn() }))
    jest.doMock('../controllers/webhookInbound/fromMeReconcile', () => ({
      filterRowsForFromMeReconcile: jest.fn(() => []),
      findPendingOutboundByAckPhone: jest.fn(async () => null),
    }))
    // F7: uma leitura só (id+conversa_id+status) e gravação por id.
    jest.doMock('../controllers/webhookInbound/whatsappIdLookup', () => ({
      selectSingleMensagemByWhatsappId: jest.fn(async () => ({
        data: achou ? { id: 9, conversa_id: 2, status: 'sent', whatsapp_id: 'WAMID-1' } : null,
        error: erroNaLeituraDeRank,
      })),
      updateSingleMensagemByWhatsappId: jest.fn(async () => ({ data: null, error: null })),
      selectSingleMensagemByWhatsappIdRelaxed: jest.fn(async () => ({ data: null, error: null })),
      patchMensagemStatusById: jest.fn(async () => ({
        data: erroNoUpdate ? null : { id: 9, conversa_id: 2, company_id: 1, autor_usuario_id: 4, whatsapp_id: 'WAMID-1', status: 'delivered' },
        error: erroNoUpdate,
      })),
      applyWhatsappInstanceFilterOrLegacy: jest.fn((q) => q),
      logAmbiguousWhatsappId: jest.fn(),
    }))

    const { statusZapi } = require('../controllers/webhookInbound/statusZapi')
    const chain = { to: () => chain, emit: jest.fn() }
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this }, json(o) { this.body = o; return this } }
    const req = {
      path: '/webhooks/whapi',
      body: { id: 'WAMID-1', ids: ['WAMID-1'], status: 'delivered' },
      zapiContext: { company_id: 1, whatsapp_instance_id: 5, provider: 'whapi' },
      app: { get: () => ({ to: () => chain }) },
    }
    return { statusZapi, req, res }
  }

  test('ACK aplicado com sucesso → 200', async () => {
    const { statusZapi, req, res } = montar()
    await statusZapi(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  test('erro de banco na GRAVAÇÃO → 500 com o contexto', async () => {
    // Linha ENCONTRADA (senão não há gravação) e o UPDATE falhando.
    const { statusZapi, req, res } = montar({ erroNoUpdate: { message: 'timeout', code: '57014' } })
    jest.spyOn(console, 'error').mockImplementation(() => {})
    await statusZapi(req, res)
    expect(res.statusCode).toBe(500)
    expect(res.body.error).toBe('status_processing_error')
    expect(res.body.contexto).toBe('status.exact')
  })

  test('erro de banco na LEITURA de rank → 500 (a decisão do status ficou cega)', async () => {
    const { statusZapi, req, res } = montar({ erroNaLeituraDeRank: { message: 'connection reset' } })
    jest.spyOn(console, 'error').mockImplementation(() => {})
    await statusZapi(req, res)
    expect(res.statusCode).toBe(500)
  })

  test('mensagem NÃO encontrada continua 200 (tem ACK tardio, não é falha de infra)', async () => {
    const { statusZapi, req, res } = montar({ achou: false })
    jest.spyOn(console, 'log').mockImplementation(() => {})
    await statusZapi(req, res)
    expect(res.statusCode).toBe(200)
  })

  test('whatsapp_id ambíguo NÃO é falha de infra → 200', async () => {
    const { statusZapi, req, res } = montar({
      erroNaLeituraDeRank: { code: 'AMBIGUOUS_WHATSAPP_ID', message: 'ambiguo' },
      achou: false,
    })
    jest.spyOn(console, 'log').mockImplementation(() => {})
    await statusZapi(req, res)
    expect(res.statusCode).toBe(200)
  })

  test('status não mapeado continua 200 sem tocar o banco', async () => {
    const { statusZapi, req, res } = montar()
    req.body = { id: 'WAMID-1', ids: ['WAMID-1'], status: 'coisa-que-nao-existe' }
    await statusZapi(req, res)
    expect(res.statusCode).toBe(200)
  })

  test('exceção inesperada → 500 (antes devolvia 200 e o ACK morria ali)', async () => {
    const { statusZapi, req, res } = montar()
    jest.spyOn(console, 'error').mockImplementation(() => {})
    req.app = { get: () => { throw new Error('io explodiu') } }
    await statusZapi(req, res)
    expect(res.statusCode).toBe(500)
    expect(res.body.error).toBe('status_processing_error')
  })
})

describe('F5 — deleted da Whapi é revogação, não falha de envio', () => {
  const controller = require('../controllers/webhookWhapiController')
  const { isWhapiRevokedStatus, mapWhapiAckToStatus, normalizeWhapiStatusToInternal, STATUS_REVOGADA } = controller._test

  test('deleted (string e code 6) não vira erro', () => {
    expect(mapWhapiAckToStatus('deleted', undefined)).toBe(STATUS_REVOGADA)
    expect(mapWhapiAckToStatus(undefined, 6)).toBe(STATUS_REVOGADA)
    expect(mapWhapiAckToStatus('deleted', 6)).toBe(STATUS_REVOGADA)
    expect(STATUS_REVOGADA).not.toBe('erro')
  })

  test('failed continua erro (revogação não pode mascarar falha real)', () => {
    expect(mapWhapiAckToStatus('failed', undefined)).toBe('erro')
    expect(mapWhapiAckToStatus(undefined, 0)).toBe('erro')
  })

  test('revogação sai do pipeline de status (não grava nada na coluna)', () => {
    expect(isWhapiRevokedStatus({ id: 'X', status: 'deleted' })).toBe(true)
    expect(isWhapiRevokedStatus({ id: 'X', code: 6 })).toBe(true)
    expect(isWhapiRevokedStatus({ id: 'X', status: 'read', code: 4 })).toBe(false)
    expect(normalizeWhapiStatusToInternal({ id: 'X', status: 'deleted' }, { channelId: 'CH' })).toBeNull()
  })

  test('ACK normal segue normalizando (a guarda do deleted não engoliu o resto)', () => {
    const n = normalizeWhapiStatusToInternal({ id: 'X', status: 'read', code: 4 }, { channelId: 'CH' })
    expect(n).toMatchObject({ status: 'read', type: 'MessageStatusCallback', ids: ['X'] })
  })
})

describe('F5 — applyWhapiRevokedOutbound marca apagada_para_todos', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  function montar({ row = { id: 9, conversa_id: 2, apagada_para_todos: false, apagada_pelo_cliente: false }, erroUpdate = null } = {}) {
    jest.resetModules()
    const updates = []
    const fake = {
      from() {
        const api = {
          select: () => api,
          update: (patch) => { updates.push(patch); return api },
          eq: () => api,
          order: () => api,
          limit: () => api,
          async maybeSingle() { return { data: row, error: null } },
          then(resolve) { return Promise.resolve({ data: null, error: erroUpdate }).then(resolve) },
        }
        return api
      },
    }
    // O update roda sem `.maybeSingle()`: o await cai no then acima.
    jest.doMock('../config/supabase', () => fake)
    const emitidos = []
    jest.doMock('../services/chat/realtime/chatRealtimeGateway', () => ({
      emitirEventoEmpresaConversa: (_io, company_id, conversa_id, evento, payload) =>
        emitidos.push({ company_id, conversa_id, evento, payload }),
      emitirConversaAtualizada: jest.fn(),
    }))
    const ctrl = require('../controllers/webhookWhapiController')
    return { aplicar: ctrl._test.applyWhapiRevokedOutbound, updates, emitidos }
  }

  test('marca a linha e emite mensagem_excluida', async () => {
    const { aplicar, updates, emitidos } = montar()
    const ok = await aplicar({ company_id: 1, whatsapp_instance_id: 5 }, { id: 'WAMID-1', status: 'deleted' }, { EVENTS: {} })
    expect(ok).toBe(true)
    expect(updates[0]).toMatchObject({ apagada_para_todos: true })
    expect(updates[0].apagada_em).toBeTruthy()
    // Não inventamos autor: quem apagou pelo celular não é um usuário do sistema.
    expect(updates[0]).not.toHaveProperty('apagada_por_usuario_id')
    expect(emitidos[0]).toMatchObject({ company_id: 1, conversa_id: 2, evento: 'mensagem_excluida' })
    expect(emitidos[0].payload).toMatchObject({ mensagem_id: 9, conversa_id: 2 })
    // Sem ultima_mensagem no payload: a revogação não muda o preview do card.
    expect(emitidos[0].payload).not.toHaveProperty('ultima_mensagem')
  })

  test('linha já revogada não reescreve nem reemite', async () => {
    const { aplicar, updates, emitidos } = montar({ row: { id: 9, conversa_id: 2, apagada_para_todos: true } })
    const ok = await aplicar({ company_id: 1, whatsapp_instance_id: 5 }, { id: 'WAMID-1', status: 'deleted' }, {})
    expect(ok).toBe(true)
    expect(updates).toHaveLength(0)
    expect(emitidos).toHaveLength(0)
  })

  test('mensagem desconhecida: no-op silencioso', async () => {
    const { aplicar, emitidos } = montar({ row: null })
    const ok = await aplicar({ company_id: 1, whatsapp_instance_id: 5 }, { id: 'WAMID-X', status: 'deleted' }, {})
    expect(ok).toBe(false)
    expect(emitidos).toHaveLength(0)
  })

  test('sem id na revogação ou sem tenant: no-op', async () => {
    const { aplicar } = montar()
    expect(await aplicar({ company_id: 1 }, { status: 'deleted' }, {})).toBe(false)
    expect(await aplicar({ company_id: null }, { id: 'X', status: 'deleted' }, {})).toBe(false)
  })

  test('coluna ausente avisa a migration e não derruba o webhook', async () => {
    const { aplicar, emitidos } = montar({ erroUpdate: { message: 'column "apagada_para_todos" does not exist' } })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = await aplicar({ company_id: 1, whatsapp_instance_id: 5 }, { id: 'WAMID-1', status: 'deleted' }, {})
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('migration'))
    expect(emitidos).toHaveLength(0)
  })
})

describe('F4/F5 no handler do webhook Whapi (integração)', () => {
  let statusZapi, receberZapi, controller, revogados

  function montarHandler({ statusCode = 200 } = {}) {
    jest.resetModules()
    revogados = []
    statusZapi = jest.fn(async (req, res) => res.status(statusCode).json({ ok: statusCode < 500 }))
    receberZapi = jest.fn(async (req, res) => res.status(200).json({ ok: true }))
    jest.doMock('../controllers/webhookZapiController', () => ({ receberZapi, statusZapi }))
    jest.doMock('../config/supabase', () => ({
      from() {
        const api = {
          select: () => api, update: () => api, eq: () => api, order: () => api, limit: () => api,
          async maybeSingle() { return { data: { id: 9, conversa_id: 2, apagada_para_todos: false }, error: null } },
          then(resolve) { revogados.push(true); return Promise.resolve({ data: null, error: null }).then(resolve) },
        }
        return api
      },
    }))
    jest.doMock('../services/chat/realtime/chatRealtimeGateway', () => ({
      emitirEventoEmpresaConversa: jest.fn(),
      emitirConversaAtualizada: jest.fn(),
    }))
    controller = require('../controllers/webhookWhapiController')
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this }, json(o) { this.body = o; return this } }
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, whatsapp_instance_id: 9, provider_instance_id: 'CH-1', provider: 'whapi' },
      app: { get: () => null },
    }
    return { controller, req, res }
  }

  afterEach(() => { jest.resetModules(); jest.restoreAllMocks() })

  test('statuses com deleted NÃO vai ao statusZapi — vira revogação', async () => {
    const { controller: c, req, res } = montarHandler()
    req.body = { channel_id: 'CH-1', statuses: [{ id: 'WAMID-1', status: 'deleted', code: 6 }] }
    await c.handleWebhookWhapi(req, res)
    expect(statusZapi).not.toHaveBeenCalled()
    expect(revogados.length).toBeGreaterThan(0)
    expect(res.statusCode).toBe(200)
    expect(req.webhookLogData.counts.revogacoes).toBe(1)
  })

  test('ACK normal continua indo ao statusZapi', async () => {
    const { controller: c, req, res } = montarHandler()
    req.body = { channel_id: 'CH-1', statuses: [{ id: 'WAMID-1', status: 'read', code: 4 }] }
    await c.handleWebhookWhapi(req, res)
    expect(statusZapi).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
  })

  test('500 do statusZapi propaga para a resposta do webhook (Whapi reentrega)', async () => {
    const { controller: c, req, res } = montarHandler({ statusCode: 500 })
    req.body = { channel_id: 'CH-1', statuses: [{ id: 'WAMID-1', status: 'delivered', code: 3 }] }
    await c.handleWebhookWhapi(req, res)
    expect(res.statusCode).toBe(500)
    expect(res.body).toMatchObject({ ok: false })
    expect(req.webhookLogData.counts.status_com_falha).toBe(1)
  })

  test('um ACK com falha entre vários ainda pede reentrega do lote', async () => {
    const { controller: c, req, res } = montarHandler({ statusCode: 500 })
    req.body = { channel_id: 'CH-1', statuses: [
      { id: 'A', status: 'sent', code: 2 },
      { id: 'B', status: 'read', code: 4 },
    ] }
    await c.handleWebhookWhapi(req, res)
    expect(statusZapi).toHaveBeenCalledTimes(2)
    expect(res.statusCode).toBe(500)
    expect(req.webhookLogData.counts.status_com_falha).toBe(2)
  })
})
