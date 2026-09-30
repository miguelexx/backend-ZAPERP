'use strict'

/**
 * Testes do endpoint OUTBOUND POST /crm/enviar-mensagem (crmEnvioController):
 *   - autenticação por x-zaperp-secret (comparação segura) → 401 sem/segredo errado
 *   - contrato: sucesso 200 {ok:true,messageId}; erro de negócio 200 {ok:false,error}
 *   - resolução do chat id canônico (wa_id) no Whapi ANTES de enviar, com fallback 9º dígito
 *   - roteamento de mídia por extensão (texto | imagem | documento)
 *   - idempotência por `referencia` (não reenvia; devolve o messageId anterior)
 *
 * Infra mockada: instância (whatsappInstanceService), provider (adapter Whapi) e a checagem
 * de números (whapi/contacts.checkPhones). O phoneHelper é REAL (a expansão 12↔13 importa).
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

// checkPhones (POST /contacts) — resolve o wa_id canônico. Mockado por teste.
const mockCheckPhones = jest.fn()
jest.mock('../services/providers/whapi/contacts', () => ({
  checkPhones: (...a) => mockCheckPhones(...a),
}))

const { enviarMensagem } = require('../controllers/crmEnvioController')

const OLD_ENV = process.env
const TEL = '5511988887777' // celular BR salvo COM o 9 (13 dígitos)
const CHAT_13 = '5511988887777@s.whatsapp.net'
const CHAT_12 = '551188887777@s.whatsapp.net'

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

// Marca TODOS os candidatos como válidos (waId = próprio input) — caso comum.
function checkPhonesTodosValidos() {
  mockCheckPhones.mockImplementation(async (cands) =>
    (cands || []).map((c) => ({ input: String(c), exists: true, waId: String(c).replace(/\D/g, ''), status: 'valid' })),
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env = { ...OLD_ENV, ZAP_SSO_SECRET: 'segredo-teste' }
  mockGetDefaultInstance.mockResolvedValue({ instance: { id: 99, instance_token: 'tok-whapi' } })
  checkPhonesTodosValidos()
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
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'x' }), res)
    expect(res.statusCode).toBe(503)
    expect(res.body.ok).toBe(false)
  })

  test('sem header de segredo → 401', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'x' }, null), res)
    expect(res.statusCode).toBe(401)
  })

  test('segredo errado → 401', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'x' }, 'errado'), res)
    expect(res.statusCode).toBe(401)
    expect(mockSendText).not.toHaveBeenCalled()
  })
})

describe('validação de entrada', () => {
  test('companyId inválido → 400 ok:false', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 0, telefone: TEL, mensagem: 'x' }), res)
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
    await enviarMensagem(req({ companyId: 1, telefone: TEL }), res)
    expect(res.statusCode).toBe(400)
  })
})

describe('envio de texto (com wa_id resolvido)', () => {
  test('sucesso → 200 {ok:true,messageId}; envia para o chat id resolvido', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'olá' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, messageId: 'BAE543FE1CE17AFA' })
    // Destino = wa_id canônico (não o número cru).
    expect(mockSendText).toHaveBeenCalledWith(
      CHAT_13,
      'olá',
      expect.objectContaining({ companyId: 1, whatsappInstanceId: 99, returnDetails: true }),
    )
  })

  test('checkPhones é consultado com as variantes 12↔13 do celular BR', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'olá' }), res)
    const [cands] = mockCheckPhones.mock.calls[0]
    expect(cands).toEqual(expect.arrayContaining(['5511988887777', '551188887777']))
  })

  test('provider é FORÇADO a whapi (nunca cai em ultramsg)', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'olá' }), res)
    expect(mockGetProvider).toHaveBeenCalledWith({ provider: 'whapi' })
  })
})

describe('fallback do 9º dígito', () => {
  test('número salvo com 9 (13), mas o WhatsApp real é o 12 → envia para o wa_id de 12', async () => {
    // Só o candidato de 12 dígitos existe no WhatsApp.
    mockCheckPhones.mockImplementation(async (cands) =>
      (cands || []).map((c) => {
        const d = String(c).replace(/\D/g, '')
        const is12 = d === '551188887777'
        return { input: d, exists: is12, waId: is12 ? d : null, status: is12 ? 'valid' : 'invalid' }
      }),
    )
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'oi teste' }), res)
    expect(res.body).toEqual({ ok: true, messageId: 'BAE543FE1CE17AFA' })
    expect(mockSendText).toHaveBeenCalledWith(CHAT_12, 'oi teste', expect.any(Object))
  })

  test('número sem WhatsApp em nenhuma variante → 200 ok:false e NÃO envia', async () => {
    mockCheckPhones.mockResolvedValue([
      { input: '5511988887777', exists: false, waId: null, status: 'invalid' },
      { input: '551188887777', exists: false, waId: null, status: 'invalid' },
    ])
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'x' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: false, error: `Número não tem WhatsApp: ${TEL}` })
    expect(mockSendText).not.toHaveBeenCalled()
  })

  test('falha ao verificar no Whapi → 200 ok:false e NÃO envia', async () => {
    mockCheckPhones.mockRejectedValue(new Error('HTTP 502'))
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'x' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/verificar o número/i)
    expect(mockSendText).not.toHaveBeenCalled()
  })
})

describe('erro de negócio → 200 {ok:false}', () => {
  test('sem instância Whapi → 200 ok:false (não 409)', async () => {
    mockGetDefaultInstance.mockResolvedValue({ instance: null, error: 'x' })
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'x' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: false, error: 'Empresa sem instância Whapi conectada.' })
  })

  test('instância Whapi sem token → 200 ok:false', async () => {
    mockGetDefaultInstance.mockResolvedValue({ instance: { id: 5, instance_token: '' } })
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'x' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: false, error: 'Empresa sem instância Whapi conectada.' })
    expect(mockSendText).not.toHaveBeenCalled()
  })

  test('provider recusa (ok:false) → 200 ok:false com o erro do provedor', async () => {
    mockSendText.mockResolvedValue({ ok: false, error: 'Token inválido' })
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'x' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: false, error: 'Token inválido' })
  })

  test('provider devolve false booleano → 200 ok:false', async () => {
    mockSendText.mockResolvedValue(false)
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'x' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(false)
  })
})

describe('roteamento de mídia por extensão', () => {
  test('midiaUrl .jpg → sendImage com legenda, para o wa_id resolvido', async () => {
    const res = mockRes()
    await enviarMensagem(
      req({ companyId: 1, telefone: TEL, mensagem: 'foto', midiaUrl: 'https://cdn/x/foto.jpg?sig=1' }),
      res,
    )
    expect(mockSendImage).toHaveBeenCalledWith(
      CHAT_13,
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
      req({ companyId: 1, telefone: TEL, mensagem: 'contrato', midiaUrl: 'https://cdn/doc.pdf' }),
      res,
    )
    expect(mockSendFile).toHaveBeenCalledWith(
      CHAT_13,
      'https://cdn/doc.pdf',
      'doc.pdf',
      expect.objectContaining({ caption: 'contrato' }),
    )
    expect(res.body.messageId).toBe('DOC12345678ABCD')
  })

  test('midiaUrl sem mensagem (legenda vazia) é permitido', async () => {
    const res = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, midiaUrl: 'https://cdn/x.mp4' }), res)
    expect(res.statusCode).toBe(200)
    expect(mockSendVideo).toHaveBeenCalled()
  })
})

describe('idempotência por referencia', () => {
  test('mesma referencia não reenvia e devolve o messageId anterior', async () => {
    const r1 = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'x', referencia: 'ref-unica-123' }), r1)
    expect(r1.body).toEqual({ ok: true, messageId: 'BAE543FE1CE17AFA' })
    expect(mockSendText).toHaveBeenCalledTimes(1)

    const r2 = mockRes()
    await enviarMensagem(req({ companyId: 1, telefone: TEL, mensagem: 'x', referencia: 'ref-unica-123' }), r2)
    expect(mockSendText).toHaveBeenCalledTimes(1)
    expect(r2.body).toMatchObject({ ok: true, messageId: 'BAE543FE1CE17AFA', idempotent: true })
  })

  test('falha no envio NÃO grava a referência (permite retry)', async () => {
    mockSendText.mockResolvedValueOnce({ ok: false, error: 'falhou' })
    const r1 = mockRes()
    await enviarMensagem(req({ companyId: 2, telefone: TEL, mensagem: 'x', referencia: 'ref-retry' }), r1)
    expect(r1.body.ok).toBe(false)

    const r2 = mockRes()
    await enviarMensagem(req({ companyId: 2, telefone: TEL, mensagem: 'x', referencia: 'ref-retry' }), r2)
    expect(mockSendText).toHaveBeenCalledTimes(2)
    expect(r2.body.ok).toBe(true)
  })
})
