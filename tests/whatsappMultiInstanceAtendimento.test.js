/**
 * Testes de separação multi-instância no atendimento (manual + dedupe).
 */

function createSupabaseConversationMock(seed = {}) {
  const state = {
    conversas: [...(seed.conversas || [])],
    clientes: [...(seed.clientes || [])],
  }

  function makeBuilder(table) {
    const q = {
      table,
      filters: [],
      mode: 'select',
      payload: null,
      select() { return this },
      eq(field, value) { this.filters.push({ type: 'eq', field, value }); return this },
      in(field, values) { this.filters.push({ type: 'in', field, values }); return this },
      is(field, value) { this.filters.push({ type: 'is', field, value }); return this },
      order() { return this },
      limit() { return this },
      update(payload) { this.mode = 'update'; this.payload = payload; return this },
      maybeSingle() {
        const rows = (state[q.table] || []).filter((row) =>
          q.filters.every((f) => {
            if (f.type === 'in') return f.values.includes(row[f.field])
            if (f.type === 'is') return f.value === null ? row[f.field] == null : row[f.field] === f.value
            return row[f.field] === f.value
          })
        )
        return Promise.resolve({ data: rows[0] || null, error: null })
      },
      then(resolve, reject) {
        const rows = (state[q.table] || []).filter((row) =>
          q.filters.every((f) => row[f.field] === f.value)
        )
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
      },
    }
    return q
  }

  return {
    state,
    from(table) { return makeBuilder(table) },
  }
}

describe('WhatsApp multi-instance atendimento', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  test('ensureConversaForCliente usa instancia informada para mesmo telefone', async () => {
    const supabase = createSupabaseConversationMock({
      conversas: [
        { id: 10, company_id: 1, telefone: '5534999999999', whatsapp_instance_id: 1, cliente_id: 5, tipo: 'cliente', status_atendimento: 'aberta' },
        { id: 20, company_id: 1, telefone: '5534999999999', whatsapp_instance_id: 8, cliente_id: 5, tipo: 'cliente', status_atendimento: 'aberta' },
      ],
    })
    jest.doMock('../config/supabase', () => supabase)
    jest.doMock('../services/whatsappInstanceService', () => ({
      resolveWhatsappInstanceForManualAction: jest.fn(async () => ({
        error: null,
        code: null,
        instanceId: 8,
        isDefault: false,
        instance: { id: 8, nome: 'WhatsApp Teste', display_phone: null, provider: 'ultramsg' },
        instances: [],
      })),
      sanitizeWhatsappInstance: (i) => (i ? { ...i, instance_token: undefined } : null),
    }))
    jest.doMock('../helpers/conversationSync', () => ({
      findOrCreateConversation: jest.fn(async () => ({
        conversa: { id: 20, telefone: '5534999999999', whatsapp_instance_id: 8, cliente_id: 5, tipo: 'cliente', status_atendimento: 'aberta' },
        created: false,
      })),
    }))

    const { ensureConversaForCliente } = require('../services/conversaAbrirClienteService')
    const r = await ensureConversaForCliente({
      company_id: 1,
      usuario_id: 99,
      cliente: { id: 5, nome: 'Miguel', telefone: '5534999999999' },
      whatsapp_instance_id: 8,
    })

    expect(r.ok).toBe(true)
    expect(r.conversa.id).toBe(20)
    expect(r.conversa.whatsapp_instance_id).toBe(8)
    expect(r.conversa.whatsapp_instance_nome).toBe('WhatsApp Teste')
  })

  test('ensureConversaForCliente retorna SELECIONE_WHATSAPP_INSTANCE quando necessario', async () => {
    jest.doMock('../services/whatsappInstanceService', () => ({
      resolveWhatsappInstanceForManualAction: jest.fn(async () => ({
        error: 'Selecione por qual numero WhatsApp deseja iniciar a conversa.',
        code: 'SELECIONE_WHATSAPP_INSTANCE',
        instanceId: null,
        isDefault: false,
        instance: null,
        instances: [
          { id: 1, nome: 'WM Sistemas' },
          { id: 8, nome: 'WhatsApp Teste' },
        ],
      })),
      sanitizeWhatsappInstance: (i) => i,
    }))

    const { ensureConversaForCliente } = require('../services/conversaAbrirClienteService')
    const r = await ensureConversaForCliente({
      company_id: 1,
      usuario_id: 99,
      cliente: { id: 5, nome: 'Miguel', telefone: '5534999999999' },
    })

    expect(r.ok).toBe(false)
    expect(r.codigo).toBe('SELECIONE_WHATSAPP_INSTANCE')
    expect(r.whatsapp_instances).toHaveLength(2)
  })
})
