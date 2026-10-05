/**
 * Whapi — exceção de transporte no envio (timeout/rede) devolve { ok:false, transportError:true }
 * em vez de recusa definitiva: os controllers mantêm a mensagem pending + reconciliação
 * (espelha o comportamento da UltraMSG, cuja exceção propaga até o catch do controller).
 * Também garante que sendLink NÃO faz fallback para texto na exceção (duplicaria no cliente).
 */

describe('Whapi provider — transport error nos envios', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    jest.resetModules()
  })

  const whapiInstance = (over = {}) => ({
    id: 10, company_id: 1, provider: 'whapi', instance_id: 'NEBULA-AER3B', instance_token: 'TESTTOKEN', ativo: true, ...over,
  })

  function mockDeps({ fetchImpl } = {}) {
    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    const fetchWithRetry = jest.fn(fetchImpl || (async () => { throw timeoutError }))
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn((type, to, opts, extra) => ({ type, to, opts, extra })),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry,
      sleep: jest.fn(async () => {}),
      isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async () => ({ instance: whapiInstance(), error: null })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: whapiInstance(), error: null })),
    }))
    // Resolver de destino não deve tocar banco neste teste.
    jest.doMock('../services/whapiRecipientResolverService', () => ({
      resolveWhapiSendRecipient: jest.fn(async (phone) => String(phone || '').replace(/\D/g, '')),
      listWhapiIdentityDigits: jest.fn(() => []),
    }))
    return { fetchWithRetry }
  }

  const opts = { companyId: 1, whatsappInstanceId: 10 }

  test('sendText com timeout devolve ok=false + transportError=true (sem httpStatus)', async () => {
    mockDeps()
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendText('5534988887777', 'olá', opts)
    expect(r.ok).toBe(false)
    expect(r.transportError).toBe(true)
    expect(r.httpStatus).toBeUndefined()
    expect(String(r.error)).toMatch(/Falha de conexão/)
  })

  test('sendText com transportError é classificado como falha transitória pelos controllers', async () => {
    mockDeps()
    const whapi = require('../services/providers/whapi')
    const { isTransientOutboundFailure } = require('../services/chat/outbound/outboundFailureClassifier')
    const r = await whapi.sendText('5534988887777', 'olá', opts)
    expect(isTransientOutboundFailure({ httpStatus: r?.httpStatus, transportError: r?.transportError === true })).toBe(true)
  })

  test('sendLink com título NÃO cai para texto na exceção (evita duplicar) e marca transportError', async () => {
    const { fetchWithRetry } = mockDeps()
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendLink('5534988887777', {
      message: 'veja', linkUrl: 'https://exemplo.com', title: 'Exemplo', linkDescription: 'desc',
    }, opts)
    expect(r.ok).toBe(false)
    expect(r.transportError).toBe(true)
    // Só a chamada do link_preview; nenhum segundo POST /messages/text de fallback.
    expect(fetchWithRetry).toHaveBeenCalledTimes(1)
    expect(String(fetchWithRetry.mock.calls[0][0])).toContain('/messages/link_preview')
  })

  test('sendLink mantém fallback a texto quando o provedor RECUSA explicitamente o card', async () => {
    let call = 0
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => {
        call += 1
        if (call === 1) {
          return { ok: false, status: 400, text: async () => JSON.stringify({ sent: false, message: 'card inválido' }) }
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ sent: true, message: { id: 'wamid.TXT' } }) }
      },
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendLink('5534988887777', {
      message: 'veja', linkUrl: 'https://exemplo.com', title: 'Exemplo',
    }, opts)
    expect(r.ok).toBe(true)
    expect(r.messageId).toBe('wamid.TXT')
    expect(fetchWithRetry).toHaveBeenCalledTimes(2)
    expect(String(fetchWithRetry.mock.calls[1][0])).toContain('/messages/text')
  })

  test('sendImage (returnDetails) e sendVoice com timeout devolvem transportError=true', async () => {
    mockDeps()
    const whapi = require('../services/providers/whapi')
    const img = await whapi.sendImage('5534988887777', 'https://cdn/x.jpg', 'legenda', { ...opts, returnDetails: true })
    expect(img.ok).toBe(false)
    expect(img.transportError).toBe(true)
    const voice = await whapi.sendVoice('5534988887777', 'https://cdn/a.ogg', { ...opts, returnDetails: true })
    expect(voice.ok).toBe(false)
    expect(voice.transportError).toBe(true)
  })

  test('recusa definitiva (400 recebido) NÃO vira transportError', async () => {
    mockDeps({
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ sent: false, message: 'invalid to' }) }),
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendText('5534988887777', 'olá', opts)
    expect(r.ok).toBe(false)
    expect(r.transportError).toBeUndefined()
    expect(r.httpStatus).toBe(400)
  })
})
