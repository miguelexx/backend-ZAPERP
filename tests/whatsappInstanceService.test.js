function createSupabaseMock(seed = {}) {
  const state = {
    whatsapp_instances: [...(seed.whatsapp_instances || [])],
    empresa_zapi: [...(seed.empresa_zapi || [])],
  }
  const calls = []

  function makeBuilder(table) {
    const q = {
      table,
      filters: [],
      orders: [],
      limitValue: null,
      mode: 'select',
      payload: null,
      selectFields: null,
      select(fields) {
        this.selectFields = fields
        return this
      },
      eq(field, value) {
        this.filters.push({ type: 'eq', field, value })
        return this
      },
      in(field, values) {
        this.filters.push({ type: 'in', field, values })
        return this
      },
      order(field, opts = {}) {
        this.orders.push({ field, ascending: opts.ascending !== false })
        return this
      },
      limit(value) {
        this.limitValue = Number(value)
        return this
      },
      insert(payload) {
        this.mode = 'insert'
        this.payload = payload
        return this
      },
      update(payload) {
        this.mode = 'update'
        this.payload = payload
        return this
      },
      maybeSingle() {
        const rows = execute(this)
        return Promise.resolve({ data: rows[0] || null, error: null })
      },
      then(resolve, reject) {
        return Promise.resolve({ data: execute(this), error: null }).then(resolve, reject)
      },
    }
    return q
  }

  function matches(row, filters) {
    return filters.every((f) => {
      if (f.type === 'in') return Array.isArray(f.values) && f.values.includes(row[f.field])
      return row[f.field] === f.value
    })
  }

  function sortRows(rows, orders) {
    return [...rows].sort((a, b) => {
      for (const order of orders) {
        const av = a[order.field]
        const bv = b[order.field]
        if (av === bv) continue
        const res = av > bv ? 1 : -1
        return order.ascending ? res : -res
      }
      return 0
    })
  }

  function execute(q) {
    calls.push({ table: q.table, mode: q.mode, filters: q.filters, payload: q.payload })
    const rows = state[q.table] || []
    if (q.mode === 'insert') {
      const payload = { ...q.payload, id: q.payload.id || rows.length + 1 }
      rows.push(payload)
      state[q.table] = rows
      return [payload]
    }
    if (q.mode === 'update') {
      const updated = []
      for (const row of rows) {
        if (matches(row, q.filters)) {
          Object.assign(row, q.payload)
          updated.push(row)
        }
      }
      return updated
    }
    let result = rows.filter((row) => matches(row, q.filters))
    result = sortRows(result, q.orders)
    if (q.limitValue != null) result = result.slice(0, q.limitValue)
    return result
  }

  return {
    state,
    calls,
    rpc: jest.fn((name, params) => {
      calls.push({ mode: 'rpc', name, params })
      if (seed.rpcError) return Promise.resolve({ data: null, error: seed.rpcError })
      if (name !== 'set_default_whatsapp_instance') {
        return Promise.resolve({ data: null, error: { message: 'RPC nao suportada no mock' } })
      }
      const cid = Number(params.p_company_id)
      const id = Number(params.p_whatsapp_instance_id)
      const rows = state.whatsapp_instances || []
      const target = rows.find((row) => row.id === id && row.company_id === cid && row.ativo === true)
      if (!target) return Promise.resolve({ data: null, error: { message: 'Instancia WhatsApp ativa nao encontrada para esta empresa' } })
      for (const row of rows) {
        if (row.company_id === cid && row.provider === target.provider && row.id !== id) row.is_default = false
      }
      target.is_default = true
      target.ativo = true
      return Promise.resolve({ data: { ...target }, error: null })
    }),
    from: jest.fn((table) => makeBuilder(table)),
  }
}

describe('whatsappInstanceService', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  test('retorna default de whatsapp_instances sem expor tokens em listagem', async () => {
    const supabase = createSupabaseMock({
      whatsapp_instances: [
        { id: 1, company_id: 10, provider: 'ultramsg', nome: 'Suporte', instance_id: '111', instance_token: 'secret-1', client_token: 'client-1', ativo: true, is_default: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const { instance } = await service.getDefaultWhatsappInstance(10)
    const list = await service.listWhatsappInstances(10)

    expect(instance.id).toBe(1)
    expect(instance.instance_token).toBeUndefined()
    expect(list.instances[0].client_token).toBeUndefined()
  })

  test('mantem fallback seguro para empresa_zapi quando nova tabela nao tem default', async () => {
    const supabase = createSupabaseMock({
      empresa_zapi: [
        { id: 5, company_id: 20, instance_id: '222', instance_token: 'legacy-secret', client_token: 'legacy-client', ativo: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const { instance } = await service.getDefaultWhatsappInstance(20, { includeCredentials: true })

    expect(instance.source).toBe('empresa_zapi')
    expect(instance.instance_token).toBe('legacy-secret')
    expect(service.sanitizeWhatsappInstance(instance).instance_token).toBeUndefined()
  })

  test('valida company_id ao buscar instancia por id', async () => {
    const supabase = createSupabaseMock({
      whatsapp_instances: [
        { id: 7, company_id: 30, provider: 'ultramsg', nome: 'Financeiro', instance_id: '333', instance_token: 'secret', ativo: true, is_default: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const own = await service.getWhatsappInstanceById(30, 7)
    const other = await service.getWhatsappInstanceById(31, 7)

    expect(own.instance.id).toBe(7)
    expect(other.instance).toBeNull()
    expect(other.error).toMatch(/nao encontrada/i)
  })

  test('create define default quando empresa ainda nao possui default na nova tabela', async () => {
    const supabase = createSupabaseMock()
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const result = await service.createWhatsappInstance(40, {
      nome: 'Comercial',
      instance_id: '444',
      instance_token: 'secret-444',
    })

    expect(result.error).toBeNull()
    expect(result.instance.is_default).toBe(true)
    expect(result.instance.instance_token).toBeUndefined()
    expect(supabase.state.whatsapp_instances).toHaveLength(1)
  })

  test('setDefaultWhatsappInstance mantem apenas uma default ativa por empresa', async () => {
    const supabase = createSupabaseMock({
      whatsapp_instances: [
        { id: 1, company_id: 50, provider: 'ultramsg', nome: 'Principal', instance_id: '501', instance_token: 'secret-1', ativo: true, is_default: true },
        { id: 2, company_id: 50, provider: 'ultramsg', nome: 'Suporte', instance_id: '502', instance_token: 'secret-2', ativo: true, is_default: false },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const result = await service.setDefaultWhatsappInstance(50, 2)

    expect(result.error).toBeNull()
    expect(result.instance.id).toBe(2)
    expect(supabase.state.whatsapp_instances.find((r) => r.id === 1).is_default).toBe(false)
    expect(supabase.state.whatsapp_instances.find((r) => r.id === 2).is_default).toBe(true)
  })

  test('resolver por provider/instance bloqueia duplicidade ativa e nao escolhe primeira empresa', async () => {
    const supabase = createSupabaseMock({
      whatsapp_instances: [
        { id: 1, company_id: 60, provider: 'ultramsg', nome: 'A', instance_id: '601', instance_token: 'secret-a', ativo: true, is_default: true },
        { id: 2, company_id: 61, provider: 'ultramsg', nome: 'B', instance_id: 'instance601', instance_token: 'secret-b', ativo: true, is_default: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const result = await service.getWhatsappInstanceByProviderInstanceId('ultramsg', '601')

    expect(result.instance).toBeNull()
    expect(result.code).toBe('DUPLICATE_PROVIDER_INSTANCE')
    expect(result.error).toMatch(/Duplicidade ativa/i)
  })

  test('resolver por provider/instance encontra instance salva com prefixo quando webhook envia numerico', async () => {
    const supabase = createSupabaseMock({
      whatsapp_instances: [
        { id: 8, company_id: 1, provider: 'ultramsg', nome: 'Principal', instance_id: 'instance173587', instance_token: 'secret', ativo: true, is_default: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const result = await service.getWhatsappInstanceByProviderInstanceId('ultramsg', '173587')

    expect(result.error).toBeNull()
    expect(result.instance).toMatchObject({
      id: 8,
      company_id: 1,
      provider: 'ultramsg',
      instance_id: 'instance173587',
    })
    expect(result.instance.instance_token).toBeUndefined()
  })

  test('resolver por provider/instance encontra instance salva com prefixo quando webhook envia prefixado', async () => {
    const supabase = createSupabaseMock({
      whatsapp_instances: [
        { id: 8, company_id: 1, provider: 'ultramsg', nome: 'Principal', instance_id: 'instance173587', instance_token: 'secret', ativo: true, is_default: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const result = await service.getWhatsappInstanceByProviderInstanceId('UltraMSG', '  INSTANCE173587  ')

    expect(result.error).toBeNull()
    expect(result.instance.id).toBe(8)
    expect(result.instance.company_id).toBe(1)
  })

  test('resolver por provider/instance usa fallback legado quando existe uma unica empresa_zapi', async () => {
    const supabase = createSupabaseMock({
      empresa_zapi: [
        { id: 9, company_id: 70, instance_id: '701', instance_token: 'legacy-secret', client_token: 'client', ativo: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const result = await service.getWhatsappInstanceByProviderInstanceId('ultramsg', 'instance701', { includeCredentials: true })

    expect(result.error).toBeNull()
    expect(result.instance.company_id).toBe(70)
    expect(result.instance.source).toBe('empresa_zapi')
    expect(result.instance.instance_token).toBe('legacy-secret')
  })

  test('resolver legado bloqueia duplicidade em empresa_zapi', async () => {
    const supabase = createSupabaseMock({
      empresa_zapi: [
        { id: 1, company_id: 80, instance_id: '801', instance_token: 'secret-a', ativo: true },
        { id: 2, company_id: 81, instance_id: 'instance801', instance_token: 'secret-b', ativo: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const result = await service.getWhatsappInstanceByProviderInstanceId('ultramsg', '801')

    expect(result.instance).toBeNull()
    expect(result.code).toBe('DUPLICATE_PROVIDER_INSTANCE')
  })

  test('create bloqueia duplicidade ativa de provider instance_id', async () => {
    const supabase = createSupabaseMock({
      whatsapp_instances: [
        { id: 1, company_id: 90, provider: 'ultramsg', nome: 'A', instance_id: '901', instance_token: 'secret-a', ativo: true, is_default: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const result = await service.createWhatsappInstance(91, {
      nome: 'B',
      instance_id: 'instance901',
      instance_token: 'secret-b',
    })

    expect(result.instance).toBeNull()
    expect(result.code).toBe('DUPLICATE_PROVIDER_INSTANCE')
    expect(supabase.state.whatsapp_instances).toHaveLength(1)
  })

  test('update bloqueia ativacao que criaria duplicidade ativa', async () => {
    const supabase = createSupabaseMock({
      whatsapp_instances: [
        { id: 1, company_id: 92, provider: 'ultramsg', nome: 'A', instance_id: '9201', instance_token: 'secret-a', ativo: true, is_default: true },
        { id: 2, company_id: 93, provider: 'ultramsg', nome: 'B', instance_id: 'instance9201', instance_token: 'secret-b', ativo: false, is_default: false },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const result = await service.updateWhatsappInstance(93, 2, { ativo: true })

    expect(result.instance).toBeNull()
    expect(result.code).toBe('DUPLICATE_PROVIDER_INSTANCE')
    expect(supabase.state.whatsapp_instances.find((r) => r.id === 2).ativo).toBe(false)
  })

  test('getCompanyIdByInstanceId bloqueia webhook quando provider instance_id esta duplicado', async () => {
    const supabase = createSupabaseMock({
      whatsapp_instances: [
        { id: 1, company_id: 94, provider: 'ultramsg', nome: 'A', instance_id: '9401', instance_token: 'secret-a', ativo: true, is_default: true },
        { id: 2, company_id: 95, provider: 'ultramsg', nome: 'B', instance_id: 'instance9401', instance_token: 'secret-b', ativo: true, is_default: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const { getCompanyIdByInstanceId } = require('../services/whatsappConfigService')
    const companyId = await getCompanyIdByInstanceId('9401')

    expect(companyId).toBeNull()
  })

  test('resolveWebhookCompany preenche contexto quando UltraMsg envia instanceId numerico e banco tem prefixo', async () => {
    const supabase = createSupabaseMock({
      whatsapp_instances: [
        { id: 8, company_id: 1, provider: 'ultramsg', nome: 'Principal', instance_id: 'instance173587', instance_token: 'secret', ativo: true, is_default: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const middleware = require('../middleware/resolveWebhookCompany')
    const req = { method: 'POST', path: '/webhooks/ultramsg', body: { instanceId: '173587', type: 'message_received' } }
    const res = { status: jest.fn(() => res), json: jest.fn() }
    const next = jest.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(req.webhookContext).toMatchObject({
      company_id: 1,
      whatsapp_instance_id: 8,
      provider: 'ultramsg',
      provider_instance_id: 'instance173587',
      instanceId: '173587',
    })
    expect(req.webhookContext.instance_token).toBeUndefined()
  })

  test('resolveWebhookCompany preenche contexto quando UltraMsg envia instanceId ja prefixado', async () => {
    const supabase = createSupabaseMock({
      whatsapp_instances: [
        { id: 8, company_id: 1, provider: 'ultramsg', nome: 'Principal', instance_id: 'instance173587', instance_token: 'secret', ativo: true, is_default: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const middleware = require('../middleware/resolveWebhookCompany')
    const req = { method: 'POST', path: '/webhooks/ultramsg', body: { instanceId: 'instance173587', type: 'message_received' } }
    const res = { status: jest.fn(() => res), json: jest.fn() }
    const next = jest.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.webhookContext).toMatchObject({
      company_id: 1,
      whatsapp_instance_id: 8,
      provider: 'ultramsg',
      provider_instance_id: 'instance173587',
    })
  })

  test('resolveWebhookCompany bloqueia duplicidade ativa normalizada sem escolher primeira empresa', async () => {
    const supabase = createSupabaseMock({
      whatsapp_instances: [
        { id: 1, company_id: 1, provider: 'ultramsg', nome: 'A', instance_id: '173587', instance_token: 'secret-a', ativo: true, is_default: true },
        { id: 8, company_id: 2, provider: 'ultramsg', nome: 'B', instance_id: 'instance173587', instance_token: 'secret-b', ativo: true, is_default: true },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const middleware = require('../middleware/resolveWebhookCompany')
    const req = { method: 'POST', path: '/webhooks/ultramsg', body: { instanceId: '173587', type: 'message_received' } }
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) }
    const next = jest.fn()

    await middleware(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ ok: true, ignored: 'duplicate_provider_instance' })
    expect(req.webhookLogData).toMatchObject({
      status: 'blocked_duplicate_instance',
      instance_id: '173587',
      provider: 'ultramsg',
    })
  })

  test('falha da RPC de default nao deixa empresa sem default', async () => {
    const supabase = createSupabaseMock({
      rpcError: { message: 'falha simulada' },
      whatsapp_instances: [
        { id: 1, company_id: 100, provider: 'ultramsg', nome: 'Principal', instance_id: '1001', instance_token: 'secret-1', ativo: true, is_default: true },
        { id: 2, company_id: 100, provider: 'ultramsg', nome: 'Suporte', instance_id: '1002', instance_token: 'secret-2', ativo: true, is_default: false },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)

    const service = require('../services/whatsappInstanceService')
    const result = await service.setDefaultWhatsappInstance(100, 2)

    expect(result.instance).toBeNull()
    expect(result.error).toMatch(/falha simulada/i)
    expect(supabase.state.whatsapp_instances.find((r) => r.id === 1).is_default).toBe(true)
    expect(supabase.state.whatsapp_instances.find((r) => r.id === 2).is_default).toBe(false)
  })
})
