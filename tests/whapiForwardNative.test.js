/**
 * Forward nativo Whapi no forwardController — fast-path com fallback seguro para cópia.
 * supabase é injetado via ctx → mock direto, io=null pula o socket. Ver docs/ai-handoff/25.
 */

const { _test } = require('../controllers/chat/forwardController')

function fakeSupabase() {
  // insert(...).select().single() → row; update(...).eq().eq() → resolve
  const inserted = []
  const api = {
    from() { return api },
    insert(row) { inserted.push(row); api._last = row; return api },
    select() { return api },
    async single() { return { data: { id: 999, ...api._last }, error: null } },
    update() { return api },
    eq() { return api },
  }
  api._inserted = inserted
  return api
}

function baseCtx(over = {}) {
  return {
    io: null,
    supabase: fakeSupabase(),
    company_id: 1,
    user_id: 7,
    conversa_id: 55,
    telefoneParaEnvio: '5534988887777',
    whatsappInstanceId: 10,
    usuarioNome: 'Atendente',
    tipo_encaminhamento: 'texto',
    timestamp: new Date().toISOString(),
    mensagemOriginal: {
      tipo: 'texto',
      texto: 'mensagem original',
      whatsapp_id: 'wamid.HBgLNTUzNDk4ODg4Nzc3AB',
      whatsapp_instance_id: 10,
    },
    ...over,
  }
}

describe('forward nativo Whapi (com fallback)', () => {
  test('mesma instância + whatsapp_id real → usa forwardMessage e NÃO copia (sendText)', async () => {
    const fwdId = 'wamid.HBgLFWDNEW0987654321XYZ'
    const forwardMessage = jest.fn(async () => ({ ok: true, messageId: fwdId }))
    const sendText = jest.fn(async () => ({ ok: true, messageId: 'x' }))
    const provider = { forwardMessage, sendText }
    const r = await _test.encaminharUmaMensagemParaConversa(baseCtx({ provider }))
    expect(r.ok).toBe(true)
    expect(forwardMessage).toHaveBeenCalledTimes(1)
    expect(forwardMessage.mock.calls[0][0]).toBe('5534988887777')
    expect(forwardMessage.mock.calls[0][1]).toBe('wamid.HBgLNTUzNDk4ODg4Nzc3AB')
    expect(sendText).not.toHaveBeenCalled()
    expect(r.mensagem.whatsapp_id).toBe(fwdId)
  })

  test('instância diferente → NÃO usa forward nativo, cai na cópia (sendText)', async () => {
    const forwardMessage = jest.fn(async () => ({ ok: true, messageId: 'nope' }))
    const sendText = jest.fn(async () => ({ ok: true, messageId: 'wamid.COPY' }))
    const provider = { forwardMessage, sendText }
    const ctx = baseCtx({ provider, mensagemOriginal: {
      tipo: 'texto', texto: 'orig', whatsapp_id: 'wamid.HBgLNTUzNDk4ODg4Nzc3AB', whatsapp_instance_id: 99,
    } })
    await _test.encaminharUmaMensagemParaConversa(ctx)
    expect(forwardMessage).not.toHaveBeenCalled()
    expect(sendText).toHaveBeenCalledTimes(1)
  })

  test('origem sem whatsapp_id real → cópia', async () => {
    const forwardMessage = jest.fn()
    const sendText = jest.fn(async () => ({ ok: true, messageId: 'wamid.COPY' }))
    const ctx = baseCtx({ provider: { forwardMessage, sendText }, mensagemOriginal: {
      tipo: 'texto', texto: 'orig', whatsapp_id: null, whatsapp_instance_id: 10,
    } })
    await _test.encaminharUmaMensagemParaConversa(ctx)
    expect(forwardMessage).not.toHaveBeenCalled()
    expect(sendText).toHaveBeenCalledTimes(1)
  })

  test('provider sem forwardMessage (UltraMSG) → cópia, sem quebrar', async () => {
    const sendText = jest.fn(async () => ({ ok: true, messageId: 'wamid.COPY' }))
    const ctx = baseCtx({ provider: { sendText } })
    await _test.encaminharUmaMensagemParaConversa(ctx)
    expect(sendText).toHaveBeenCalledTimes(1)
  })

  test('forward nativo falha (ok:false) → fallback cópia', async () => {
    const forwardMessage = jest.fn(async () => ({ ok: false, error: 'not found' }))
    const sendText = jest.fn(async () => ({ ok: true, messageId: 'wamid.COPY' }))
    const ctx = baseCtx({ provider: { forwardMessage, sendText } })
    await _test.encaminharUmaMensagemParaConversa(ctx)
    expect(forwardMessage).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledTimes(1)
  })
})
