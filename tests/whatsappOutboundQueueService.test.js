const fs = require('fs')
const path = require('path')

function createSupabaseMock() {
  const updates = []
  const inserts = []
  const maybeSingleQueue = []
  const rpcCalls = []
  const supabase = {
    updates,
    inserts,
    maybeSingleQueue,
    rpcCalls,
    rpc: jest.fn((name, args) => {
      rpcCalls.push({ name, args })
      return Promise.resolve({ data: [], error: null })
    }),
    from: jest.fn((table) => {
      const builder = {
        table,
        filters: [],
        payload: null,
        insert(payload) {
          this.payload = payload
          inserts.push({ table: this.table, payload })
          return this
        },
        update(payload) {
          this.payload = payload
          return this
        },
        eq(field, value) {
          this.filters.push({ op: 'eq', field, value })
          return this
        },
        select() {
          return this
        },
        single() {
          updates.push({ table: this.table, payload: this.payload, filters: this.filters })
          return Promise.resolve({
            data: {
              id: this.filters.find((f) => f.field === 'id')?.value || 1,
              company_id: this.filters.find((f) => f.field === 'company_id')?.value || 10,
              conversa_id: this.filters.find((f) => f.field === 'conversa_id')?.value || this.payload?.conversa_id || 20,
              autor_usuario_id: 30,
              ...this.payload,
            },
            error: null,
          })
        },
        maybeSingle() {
          if (maybeSingleQueue.length) {
            return Promise.resolve({ data: maybeSingleQueue.shift(), error: null })
          }
          return Promise.resolve({ data: null, error: null })
        },
        not() {
          return this
        },
        is() {
          return this
        },
        in() {
          return this
        },
        lt() {
          return this
        },
        then(resolve, reject) {
          return Promise.resolve({ data: [], error: null }).then(resolve, reject)
        },
      }
      return builder
    }),
  }
  return supabase
}

function loadService({ provider, supabase }) {
  jest.resetModules()
  jest.doMock('../config/supabase', () => supabase)
  jest.doMock('../services/providers', () => ({
    getProvider: () => provider,
  }))
  jest.doMock('../services/whatsappInstanceService', () => ({
    getDefaultWhatsappInstance: jest.fn().mockResolvedValue({ instance: null }),
  }))
  return require('../services/whatsappOutboundQueueService')
}

function baseRow(overrides = {}) {
  return {
    id: 123,
    company_id: 10,
    conversa_id: 20,
    autor_usuario_id: 30,
    whatsapp_instance_id: 40,
    tentativas_envio: 1,
    max_tentativas_envio: 5,
    whatsapp_id: null,
    provider_message_id: null,
    send_payload: {
      kind: 'text',
      phone: '5534999999999',
      content: { text: 'Ola' },
      opts: { sendOrigin: 'test' },
    },
    ...overrides,
  }
}

describe('whatsappOutboundQueueService', () => {
  afterEach(() => {
    jest.dontMock('../config/supabase')
    jest.dontMock('../services/providers')
    jest.dontMock('../services/whatsappInstanceService')
    jest.restoreAllMocks()
  })

  test('marca sent somente quando provider retorna ID rastreavel', async () => {
    const supabase = createSupabaseMock()
    const provider = {
      sendText: jest.fn().mockResolvedValue({ ok: true, messageId: 'BAE543FE1CE17AFA', httpStatus: 200 }),
    }
    const service = loadService({ provider, supabase })

    await service.processOutboundMessage(baseRow())

    expect(provider.sendText).toHaveBeenCalledTimes(1)
    expect(supabase.updates.at(-1).payload).toMatchObject({
      status: 'sent',
      status_mensagem: 'sent',
      send_status: 'sent',
      whatsapp_id: 'BAE543FE1CE17AFA',
    })
  })

  test('nao reenvia mensagem que ja possui whatsapp_id ou provider_message_id', async () => {
    const supabase = createSupabaseMock()
    const provider = { sendText: jest.fn() }
    const service = loadService({ provider, supabase })

    await service.processOutboundMessage(baseRow({ whatsapp_id: 'BAE543FE1CE17AFA' }))

    expect(provider.sendText).not.toHaveBeenCalled()
    expect(supabase.updates.at(-1).payload).toMatchObject({ send_status: 'sent' })
  })

  test('agenda retry para erro temporario 429', async () => {
    const supabase = createSupabaseMock()
    const provider = {
      sendText: jest.fn().mockResolvedValue({ ok: false, httpStatus: 429, error: 'rate limit' }),
    }
    const service = loadService({ provider, supabase })

    await service.processOutboundMessage(baseRow({ tentativas_envio: 2 }))

    expect(supabase.updates.at(-1).payload).toMatchObject({
      status: 'pending',
      status_mensagem: 'sending',
      send_status: 'retry',
      ultimo_codigo_erro: '429',
    })
    expect(supabase.updates.at(-1).payload.next_attempt_at).toBeTruthy()
  })

  test('falha definitiva para erro 401 sem retry automatico', async () => {
    const supabase = createSupabaseMock()
    const provider = {
      sendText: jest.fn().mockResolvedValue({ ok: false, httpStatus: 401, error: 'invalid token' }),
    }
    const service = loadService({ provider, supabase })

    await service.processOutboundMessage(baseRow())

    expect(supabase.updates.at(-1).payload).toMatchObject({
      status: 'erro',
      status_mensagem: 'failed',
      send_status: 'failed',
      ultimo_codigo_erro: '401',
    })
  })

  test('claim usa RPC atomica da migration', async () => {
    const supabase = createSupabaseMock()
    const service = loadService({ provider: {}, supabase })

    await service.claimOutboundMessages({ workerId: 'w1', limit: 3, lockSeconds: 90, maxPerQueue: 1, sendDelayMs: 1200 })

    expect(supabase.rpc).toHaveBeenCalledWith('claim_whatsapp_outbound_messages', {
      p_worker_id: 'w1',
      p_limit: 3,
      p_lock_seconds: 90,
      p_max_per_queue: 1,
      p_send_delay_ms: 1200,
    })
  })

  test('claim de jobs usa mesmo gate de concorrencia e delay', async () => {
    const supabase = createSupabaseMock()
    const service = loadService({ provider: {}, supabase })

    await service.claimOutboundJobs({ workerId: 'w2', limit: 7, lockSeconds: 120, maxPerQueue: 2, sendDelayMs: 900 })

    expect(supabase.rpc).toHaveBeenCalledWith('claim_whatsapp_outbound_jobs', {
      p_worker_id: 'w2',
      p_limit: 7,
      p_lock_seconds: 120,
      p_max_per_queue: 2,
      p_send_delay_ms: 900,
    })
  })

  test('enfileira job persistente para alerta automatico sem chamar provider', async () => {
    const supabase = createSupabaseMock()
    const provider = { sendText: jest.fn() }
    const service = loadService({ provider, supabase })

    const payload = service.buildQueuePayload({
      kind: 'text',
      phone: '5534999999999',
      content: { text: 'Alerta' },
      opts: { sendOrigin: 'admin_atendimento_alerta' },
    })
    const job = await service.enqueueOutboundJob({ companyId: 10, phone: '5534999999999', payload, metadata: { origin: 'test' } })

    expect(job.id).toBeTruthy()
    expect(provider.sendText).not.toHaveBeenCalled()
    expect(supabase.inserts.at(-1)).toMatchObject({
      table: 'whatsapp_outbound_jobs',
      payload: {
        company_id: 10,
        destination_phone: '5534999999999',
        kind: 'text',
        send_status: 'queued',
      },
    })
  })

  test('processa job com 5xx como retry rastreavel', async () => {
    const supabase = createSupabaseMock()
    const provider = {
      sendText: jest.fn().mockResolvedValue({ ok: false, httpStatus: 500, error: 'server error' }),
    }
    const service = loadService({ provider, supabase })

    await service.processOutboundJob({
      ...baseRow({ conversa_id: null }),
      id: 88,
      destination_phone: '5534999999999',
      kind: 'text',
    })

    expect(provider.sendText).toHaveBeenCalledTimes(1)
    expect(supabase.updates.at(-1)).toMatchObject({
      table: 'whatsapp_outbound_jobs',
      payload: {
        send_status: 'retry',
        ultimo_codigo_erro: '500',
      },
    })
  })

  test('reenvio manual recusa mensagem que ja tem provider id', async () => {
    const supabase = createSupabaseMock()
    supabase.maybeSingleQueue.push(baseRow({ provider_message_id: 'BAE543FE1CE17AFA' }))
    const service = loadService({ provider: {}, supabase })

    const result = await service.requeueOutboundMessage({ companyId: 10, conversaId: 20, messageId: 123 })

    expect(result).toMatchObject({ ok: false, status: 409 })
    expect(supabase.updates).toHaveLength(0)
  })

  test('reenvio manual recoloca failed_retryable na fila sem duplicar id do provider', async () => {
    const supabase = createSupabaseMock()
    supabase.maybeSingleQueue.push(baseRow({
      send_status: 'failed_retryable',
      status: 'erro',
      send_payload: baseRow().send_payload,
    }))
    const service = loadService({ provider: {}, supabase })

    const result = await service.requeueOutboundMessage({ companyId: 10, conversaId: 20, messageId: 123 })

    expect(result.ok).toBe(true)
    expect(supabase.updates.at(-1).payload).toMatchObject({
      status: 'pending',
      status_mensagem: 'pending',
      send_status: 'queued',
      tentativas_envio: 0,
      locked_at: null,
      enviando_ate: null,
      locked_by: null,
    })
  })

  test('migration contem gate por company_id e whatsapp_instance_id cruzando mensagens e jobs', () => {
    const migrationPath = path.resolve(__dirname, '../supabase/migrations/20260701000000_whatsapp_outbound_send_queue.sql')
    const sql = fs.readFileSync(migrationPath, 'utf8')

    expect(sql).toContain('public.whatsapp_outbound_jobs')
    expect(sql).toContain("m.company_id::text || ':' || COALESCE(m.whatsapp_instance_id::text, 'company')")
    expect(sql).toContain("j.company_id::text || ':' || COALESCE(j.whatsapp_instance_id::text, 'company')")
    expect(sql).toContain('p_max_per_queue')
    expect(sql).toContain('p_send_delay_ms')
    expect(sql).toContain('active_sends')
    expect(sql).toContain('wa_outbound_instance:')
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
  })

  test('600 mensagens podem ser persistidas como payloads rastreaveis antes de qualquer provider send', async () => {
    const supabase = createSupabaseMock()
    const provider = { sendText: jest.fn() }
    const service = loadService({ provider, supabase })

    for (let i = 1; i <= 600; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await service.enqueueOutboundMessage({
        messageId: i,
        companyId: 10,
        payload: service.buildQueuePayload({
          kind: 'text',
          phone: `55349999${String(i).padStart(4, '0')}`,
          content: { text: `Mensagem ${i}` },
          opts: { sendOrigin: 'load_test' },
        }),
      })
    }

    expect(provider.sendText).not.toHaveBeenCalled()
    expect(supabase.updates).toHaveLength(600)
    expect(supabase.updates.every((u) => u.payload.send_status === 'queued')).toBe(true)
  })
})
