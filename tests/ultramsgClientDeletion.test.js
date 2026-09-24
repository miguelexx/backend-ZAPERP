/**
 * UltraMSG inbound — revogação do CLIENTE ("apagar para todos").
 * Cobre a detecção conservadora do evento + a marcação compartilhada (idempotente),
 * que mantém o conteúdo e só liga o aviso via socket mensagem_apagada_cliente.
 */

jest.mock('../services/chat/realtime/chatRealtimeGateway', () => ({
  emitirEventoEmpresaConversa: jest.fn(),
  emitirConversaAtualizada: jest.fn(),
  emitirParaUsuario: jest.fn(),
}))

const supabase = require('../config/supabase')
const { emitirEventoEmpresaConversa } = require('../services/chat/realtime/chatRealtimeGateway')
const { markClientDeletedMessage } = require('../services/chat/deletion/markClientDeletedMessage')
const { _test } = require('../controllers/webhookZapiController')

describe('UltraMSG — detecção da revogação do contato', () => {
  const isDel = _test.isUltramsgClientDeletion
  const target = _test.extractUltramsgDeletedTargetId

  test('detecta type/subtype/ack/flag de revogação', () => {
    expect(isDel({ type: 'revoked', id: 'x' })).toBe(true)
    expect(isDel({ type: 'message_revoke_everyone', id: 'x' })).toBe(true)
    expect(isDel({ event: 'delete', id: 'x' })).toBe(true)
    expect(isDel({ subtype: 'revoke', id: 'x' })).toBe(true)
    expect(isDel({ ack: 'deleted', id: 'x' })).toBe(true)
    expect(isDel({ deleted: true, id: 'x' })).toBe(true)
  })

  test('NÃO confunde mensagem/reação/status normal com revogação', () => {
    expect(isDel({ type: 'message', body: 'oi', id: 'x' })).toBe(false)
    expect(isDel({ type: 'chat', text: { message: 'oi' } })).toBe(false)
    expect(isDel({ reaction: '👍', id: 'x' })).toBe(false)
    expect(isDel({ ack: 'read', messageId: 'x' })).toBe(false)
    expect(isDel(null)).toBe(false)
  })

  test('extrai id-alvo (referência ou id do próprio evento)', () => {
    expect(target({ type: 'revoked', referenced_message: { id: 'wamid.ALVO' }, id: 'evt.1' })).toBe('wamid.ALVO')
    expect(target({ type: 'revoked', id: 'wamid.SELF' })).toBe('wamid.SELF')
    expect(target({ type: 'revoked', key: { id: 'wamid.KEY' } })).toBe('wamid.KEY')
    expect(target({ type: 'revoked' })).toBe(null)
  })
})

describe('markClientDeletedMessage — marcação idempotente', () => {
  let chain
  beforeEach(() => {
    jest.clearAllMocks()
    chain = supabase.from()
  })

  test('marca a mensagem do contato e emite mensagem_apagada_cliente', async () => {
    chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 55, conversa_id: 9, apagada_pelo_cliente: false, apagada_para_todos: false },
      error: null,
    })
    const io = {}
    const ok = await markClientDeletedMessage({ company_id: 1, whatsapp_instance_id: 10 }, 'wamid.ALVO', io)
    expect(ok).toBe(true)
    const updatePayload = chain.update.mock.calls.map((c) => c[0]).find((p) => p && p.apagada_pelo_cliente === true)
    expect(updatePayload).toBeTruthy()
    expect(updatePayload).toHaveProperty('apagada_pelo_cliente_em')
    const call = emitirEventoEmpresaConversa.mock.calls.find((c) => c[3] === 'mensagem_apagada_cliente')
    expect(call).toBeTruthy()
    expect(call[4]).toMatchObject({ conversa_id: 9, mensagem_id: 55 })
  })

  test('idempotente: já apagada (por nós ou pelo cliente) não re-marca nem emite', async () => {
    chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 55, conversa_id: 9, apagada_pelo_cliente: true, apagada_para_todos: false },
      error: null,
    })
    const ok = await markClientDeletedMessage({ company_id: 1, whatsapp_instance_id: 10 }, 'wamid.ALVO', {})
    expect(ok).toBe(true)
    const marked = chain.update.mock.calls.map((c) => c[0]).find((p) => p && p.apagada_pelo_cliente === true)
    expect(marked).toBeFalsy()
    expect(emitirEventoEmpresaConversa).not.toHaveBeenCalled()
  })

  test('mensagem inexistente → não marca', async () => {
    chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
    const ok = await markClientDeletedMessage({ company_id: 1, whatsapp_instance_id: 10 }, 'wamid.SUMIU', {})
    expect(ok).toBe(false)
    expect(emitirEventoEmpresaConversa).not.toHaveBeenCalled()
  })
})
