'use strict'

/**
 * Testes do endpoint OUTBOUND POST /crm/enviar-mensagem (crmEnvioController):
 *   - autenticação por x-zaperp-secret (comparação segura) → 401 sem/segredo errado
 *   - contrato: sucesso 200 {ok:true,messageId}; erro de negócio 200 {ok:false,error}
 *   - roteamento de mídia por extensão (texto | imagem | documento)
 *   - idempotência por `referencia` (não reenvia; devolve o messageId anterior)
 *
 * As dependências de infraestrutura (instância, provider, opt-out) são mockadas —
 * o foco é a lógica do controller, não o envio real.
 */

jest.mock('../config/supabase', () => ({}))

const mockSendText = jest.fn()
const mockSendImage = jest.fn()
const mockSendFile = jest.fn()
const mockSendVideo = jest.fn()
const mockGetProvider = jest.fn(() => ({
  sendText: mockSendText,
  sendImage: mockSendImage,
  sendFile: mockSendFile,
  sendVideo: mockSendVideo,
}))

jest.mock('../services/providers', () => ({
  getProvider: (...a) => mockGetProvider(...a),
}))

const mockGetDefaultInstance = jest.fn()
jest.mock('../services/whatsappInstanceService', () => ({
  getDefaultWhatsappInstance: (...args) => mockGetDefaultInstance(...args),
}))

jest.mock('../helpers/phoneHelper', () => ({
  normalizePhoneBR: (t) => String(t || '').replace(/\D/g, '') || null,
}))

const { enviarMensagem } = require('../controllers/crmEnvioController')

const OLD_ENV = process.env

function mockRes() {
  const res = { statusCode: 200, body: null }
  res.status = jest.fn((c) => {
    res.statusCode = c
    return res
  })
  res.json = jest.fn((b) => {
    res.body = b
    return res
  })
  return res
}

function req(body, secret = 'segredo-teste') {
  return { headers: secret == null ? {} : { 'x-zaperp-secret': secret }, body }
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env = { ...OLD_ENV, ZAP_SSO_SECRET: 'segredo-teste' }
  mockGetDefaultInstance.mockResolvedValue({ instance: { id: 99, instance_token: 'tok-whapi' } })
  mockSendText.mockResolvedValue({ ok: true, messageId: 'BAE543FE1CE17AFA' })
  mockSendImage.mockResolvedValue({ ok: true, messageId: 'IMG12345678ABCD' })
  mockSendFile.mockResolvedValue({ ok: true, messageId: 'DOC12345678ABCD' })
  mockSendVideo.mockResolvedValue({ ok: true, messageId: 'VID12345678ABCD' })
})

afterAll(() => {
  process.env = OLD_ENV
})

describe('autenticação', () => {
  test('sem ZAP_SSO_SECRET no ambiente → 503', async () => {
    delete process.env.ZAP_SSO_SECRET
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: '55119', mensagem: 'x' }), res)
    expect(res.statusCode).toBe(503)
    expect(res.body.ok).toBe(false)
  })

  test('sem header de segredo → 401', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: '55119', mensagem: 'x' }, null), res)
    expect(res.statusCode).toBe(401)
  })

  test('segredo errado → 401', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: '55119', mensagem: 'x' }, 'errado'), res)
    expect(res.statusCode).toBe(401)
    expect(mockSendText).not.toHaveBeenCalled()
  })
})

describe('validação de entrada', () => {
  test('companyId inválido → 400 ok:false', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 0, telefone: '55119', mensagem: 'x' }), res)
    expect(res.statusCode).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('sem telefone → 400 ok:false', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: '', mensagem: 'x' }), res)
    expect(res.statusCode).toBe(400)
  })

  test('sem mídia e sem mensagem → 400 ok:false', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: '55119' }), res)
    expect(res.statusCode).toBe(400)
  })
})

describe('envio de texto', () => {
  test('sucesso → 200 {ok:true,messageId} e sendText chamado', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: '5511988887777', mensagem: 'olá' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, messageId: 'BAE543FE1CE17AFA' })
    expect(mockSendText).toHaveBeenCalledWith(
      '5511988887777',
      'olá',
      expect.objectContaining({ companyId: 1, whatsappInstanceId: 99, returnDetails: true }),
    )
  })

  test('provider é FORÇADO a whapi (nunca cai em ultramsg)', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: '5511988887777', mensagem: 'olá' }), res)
    expect(mockGetProvider).toHaveBeenCalledWith({ provider: 'whapi' })
  })
})

describe('erro de negócio → 200 {ok:false}', () => {
  test('sem instância Whapi → 200 ok:false (não 409)', async () => {
    mockGetDefaultInstance.mockResolvedValue({ instance: null, error: 'x' })
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: '55119', mensagem: 'x' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: false, error: 'Empresa sem instância Whapi conectada.' })
  })

  test('instância Whapi sem token → 200 ok:false', async () => {
    mockGetDefaultInstance.mockResolvedValue({ instance: { id: 5, instance_token: '' } })
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: '55119', mensagem: 'x' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: false, error: 'Empresa sem instância Whapi conectada.' })
    expect(mockSendText).not.toHaveBeenCalled()
  })

  test('provider recusa (ok:false) → 200 ok:false com o erro do provedor', async () => {
    mockSendText.mockResolvedValue({ ok: false, error: 'Token inválido' })
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: '55119', mensagem: 'x' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: false, error: 'Token inválido' })
  })

  test('provider devolve false booleano → 200 ok:false', async () => {
    mockSendText.mockResolvedValue(false)
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: '55119', mensagem: 'x' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(false)
  })
})

describe('roteamento de mídia por extensão', () => {
  test('midiaUrl .jpg → sendImage com legenda', async () => {
    const res = mockRes()
    await enviarMensagem(
      req({ companyId: 1, telefone: '55119', mensagem: 'foto', midiaUrl: 'https://cdn/x/foto.jpg?sig=1' }),
      res,
    )
    expect(mockSendImage).toHaveBeenCalledWith(
      '55119',
      'https://cdn/x/foto.jpg?sig=1',
      'foto',
      expect.objectContaining({ whatsappInstanceId: 99 }),
    )
    expect(mockSendText).not.toHaveBeenCalled()
    expect(res.body).toEqual({ ok: true, messageId: 'IMG12345678ABCD' })
  })

  test('midiaUrl .pdf → sendFile com caption nas opts', async () => {
    const res = mockRes()
    await enviarMensagem(
      req({ companyId: 1, telefone: '55119', mensagem: 'contrato', midiaUrl: 'https://cdn/doc.pdf' }),
      res,
    )
    expect(mockSendFile).toHaveBeenCalledWith(
      '55119',
      'https://cdn/doc.pdf',
      'doc.pdf',
      expect.objectContaining({ caption: 'contrato' }),
    )
    expect(res.body.messageId).toBe('DOC12345678ABCD')
  })

  test('midiaUrl sem mensagem (legenda vazia) é permitido', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: '55119', midiaUrl: 'https://cdn/x.mp4' }), res)
    expect(res.statusCode).toBe(200)
    expect(mockSendVideo).toHaveBeenCalled()
  })
})

describe('idempotência por referencia', () => {
  test('mesma referencia não reenvia e devolve o messageId anterior', async () => {
    const r1 = mockRes()
    await enviarMensagem(
      req({ companyId: 1, telefone: '55119', mensagem: 'x', referencia: 'ref-unica-123' }),
      r1,
    )
    expect(r1.body).toEqual({ ok: true, messageId: 'BAE543FE1CE17AFA' })
    expect(mockSendText).toHaveBeenCalledTimes(1)

    const r2 = mockRes()
    await enviarMensagem(
      req({ companyId: 1, telefone: '55119', mensagem: 'x', referencia: 'ref-unica-123' }),
      r2,
    )
    // Não reenviou: sendText continua com 1 chamada; resposta idempotente com o mesmo id.
    expect(mockSendText).toHaveBeenCalledTimes(1)
    expect(r2.body).toMatchObject({ ok: true, messageId: 'BAE543FE1CE17AFA', idempotent: true })
  })

  test('falha no envio NÃO grava a referência (permite retry)', async () => {
    mockSendText.mockResolvedValueOnce({ ok: false, error: 'falhou' })
    const r1 = mockRes()
    await enviarMensagem(req({ companyId: 2, telefone: '55119', mensagem: 'x', referencia: 'ref-retry' }), r1)
    expect(r1.body.ok).toBe(false)

    // Segunda tentativa com a mesma referência DEVE reenviar (agora com sucesso).
    const r2 = mockRes()
    await enviarMensagem(req({ companyId: 2, telefone: '55119', mensagem: 'x', referencia: 'ref-retry' }), r2)
    expect(mockSendText).toHaveBeenCalledTimes(2)
    expect(r2.body.ok).toBe(true)
  })
})
