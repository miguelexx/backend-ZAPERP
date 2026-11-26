/**
 * UltraMSG `deleteChat` — mesmo bug que a Whapi teve (doc 34 §8.2).
 *
 * Antes: um endereço só, montado por `toZapiSendFormat` (INSERE o 9º dígito), e HTTP 200 contava
 * como sucesso mesmo com `{ error }` no corpo. Chat BR que vive com 12 dígitos nunca saía do
 * WhatsApp, e a resposta dizia que tinha saído.
 */

describe('UltraMSG deleteChat — endereços ±9º e corpo de erro', () => {
  const COM9 = '5534999911246@c.us'
  const SEM9 = '553499911246@c.us'
  const OPTS = { companyId: 5, whatsappInstanceId: 8 }

  function mockDeps({ existem = [], instanciaParada = false } = {}) {
    jest.resetModules()
    const vivos = new Set(existem)
    const chamadas = []
    jest.doMock('../services/providers/ultramsg/config', () => ({
      resolveConfig: jest.fn(async () => ({ basePath: 'https://api.ultramsg.test/instance1', token: 'T' })),
    }))
    jest.doMock('../services/providers/ultramsg/http', () => ({
      getJson: jest.fn(),
      post: jest.fn(async ({ endpoint, body }) => {
        chamadas.push({ endpoint, chatId: body.chatId })
        if (instanciaParada) return { ok: true, status: 200, data: { error: 'Your instance has been Stopped' }, text: '' }
        if (!vivos.has(body.chatId)) return { ok: true, status: 200, data: { error: 'chat not found' }, text: '' }
        vivos.delete(body.chatId)
        return { ok: true, status: 200, data: { success: 'chat deleted' }, text: '' }
      }),
    }))
    return { chamadas, vivos }
  }

  afterEach(() => jest.resetModules())

  test('chat só na forma de 12 dígitos: apaga (antes ia direto no endereço com o 9º)', async () => {
    const { vivos } = mockDeps({ existem: [SEM9] })
    const { deleteChat } = require('../services/providers/ultramsg/chatsAdmin')

    const r = await deleteChat('5534999911246', OPTS)

    expect(r.ok).toBe(true)
    expect(r.apagados).toEqual([SEM9])
    expect(vivos.size).toBe(0)
  })

  test('contato com DOIS chats (±9º): apaga os dois', async () => {
    const { vivos } = mockDeps({ existem: [SEM9, COM9] })
    const { deleteChat } = require('../services/providers/ultramsg/chatsAdmin')

    const r = await deleteChat('5534999911246', OPTS)

    expect(r.ok).toBe(true)
    expect(vivos.size).toBe(0)
  })

  test('200 com { error } não é sucesso (instância parada por falta de pagamento)', async () => {
    mockDeps({ existem: [SEM9], instanciaParada: true })
    const { deleteChat } = require('../services/providers/ultramsg/chatsAdmin')

    const r = await deleteChat('5534999911246', OPTS)

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Stopped/)
  })

  test('FIXO não ganha variante de celular (não apaga conversa de outra pessoa)', async () => {
    const { chamadas } = mockDeps({ existem: ['553434238595@c.us'] })
    const { deleteChat } = require('../services/providers/ultramsg/chatsAdmin')

    await deleteChat('553434238595', OPTS)

    expect(chamadas.map((c) => c.chatId)).not.toContain('5534934238595@c.us')
  })
})
