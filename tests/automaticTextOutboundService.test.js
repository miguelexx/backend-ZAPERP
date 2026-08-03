jest.mock('../services/pendingOutboundReconciliationService', () => ({
  schedulePendingOutboundReconciliation: jest.fn(),
}))

const { sendAutomaticText } = require('../services/automaticTextOutboundService')
const { schedulePendingOutboundReconciliation } = require('../services/pendingOutboundReconciliationService')

function createSupabase({ reserveError = null } = {}) {
  const inserts = []
  const updates = []
  const reserved = { id: 42, conversa_id: 7, company_id: 3, status: 'pending' }

  const messagesTable = {
    insert(payload) {
      inserts.push(payload)
      return {
        select() { return this },
        async single() {
          return reserveError ? { data: null, error: reserveError } : { data: reserved, error: null }
        },
      }
    },
    update(payload) {
      updates.push(payload)
      const chain = {
        eq() { return this },
        select() { return this },
        async maybeSingle() { return { data: { ...reserved, ...payload }, error: null } },
        then(resolve) { return Promise.resolve({ data: null, error: null }).then(resolve) },
      }
      return chain
    },
  }

  return {
    client: { from: jest.fn(() => messagesTable) },
    inserts,
    updates,
  }
}

describe('automaticTextOutboundService', () => {
  beforeEach(() => jest.clearAllMocks())

  test('reserva antes do POST, envia crm-id, preserva instancia e queue id numerico', async () => {
    const db = createSupabase()
    const sendMessage = jest.fn().mockResolvedValue({
      ok: true,
      messageId: '35096',
      rawResponse: { id: '35096', status: 'queue' },
    })

    const result = await sendAutomaticText({
      supabase: db.client,
      sendMessage,
      telefone: '5511999999999',
      texto: 'Olá!',
      companyId: 3,
      conversaId: 7,
      whatsappInstanceId: 11,
      sendOrigin: 'chatbot_triage',
    })

    expect(db.inserts[0]).toMatchObject({
      conversa_id: 7,
      company_id: 3,
      whatsapp_instance_id: 11,
      status: 'pending',
      provider_attempt_count: 0,
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][2]).toMatchObject({
      referenceId: 'crm-42',
      whatsappInstanceId: 11,
      sendOrigin: 'chatbot_triage',
    })
    expect(db.updates.at(-1)).toMatchObject({
      provider_reference_id: 'crm-42',
      provider_queue_id: '35096',
      provider_delivery_state: 'queued',
      status: 'pending',
      provider_attempt_count: 1,
    })
    expect(result).toMatchObject({ ok: true, queued: true, messageId: '35096' })
    expect(schedulePendingOutboundReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 3,
      mensagemId: 42,
    }))
  })

  test('nao envia se a linha nao puder ser reservada', async () => {
    const db = createSupabase({ reserveError: { message: 'database unavailable' } })
    const sendMessage = jest.fn()

    const result = await sendAutomaticText({
      supabase: db.client,
      sendMessage,
      telefone: '5511999999999',
      texto: 'Mensagem',
      companyId: 3,
      conversaId: 7,
    })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, persisted: false })
  })

  test('timeout fica pendente e reconciliavel, sem virar erro definitivo imediatamente', async () => {
    const db = createSupabase()
    const timeout = new Error('request timed out')
    timeout.code = 'ETIMEDOUT'

    const result = await sendAutomaticText({
      supabase: db.client,
      sendMessage: jest.fn().mockRejectedValue(timeout),
      telefone: '5511999999999',
      texto: 'Mensagem',
      companyId: 3,
      conversaId: 7,
    })

    expect(db.updates.at(-1)).toMatchObject({
      status: 'pending',
      status_mensagem: 'sending',
      provider_delivery_state: 'uncertain',
      provider_retryable: true,
    })
    expect(result).toMatchObject({ ok: false, uncertain: true, persisted: true })
  })
})
