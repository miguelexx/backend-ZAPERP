/**
 * Reenvio automático de mídia outbound presa em 'erro'.
 * Foca na lógica de segurança: filtro de tipo/status, guarda anti-duplicidade (checagem no provedor)
 * e o caminho de sucesso do reenvio a partir do arquivo salvo no servidor.
 */

const fs = require('fs')

// Mocks (variáveis prefixadas com "mock" são permitidas dentro do factory do jest.mock).
let mockProvider = {}
let mockConversaRow = { id: 10, telefone: '5511999999999', tipo: 'individual', whatsapp_instance_id: 1 }
const mockUpdates = []

jest.mock('../services/providers', () => ({ getProvider: () => mockProvider }))

jest.mock('../services/pendingOutboundReconciliationService', () => ({
  schedulePendingOutboundReconciliation: jest.fn(),
}))

jest.mock('../config/supabase', () => {
  const builder = {
    _table: null,
    _op: null,
    _payload: null,
    from(t) { this._table = t; this._op = null; this._payload = null; return this },
    select() { return this },
    update(payload) { this._op = 'update'; this._payload = payload; return this },
    not() { return this },
    in() { return this },
    gte() { return this },
    lte() { return this },
    order() { return this },
    limit() { return this },
    eq() { return this },
    maybeSingle() {
      const data = this._table === 'conversas' ? mockConversaRow : null
      return Promise.resolve({ data, error: null })
    },
    then(resolve, reject) {
      if (this._op === 'update' && this._table === 'mensagens') {
        mockUpdates.push({ ...this._payload })
      }
      return Promise.resolve({ data: null, error: null }).then(resolve, reject)
    },
  }
  return builder
})

const svc = require('../services/outboundMediaResendService')
const { schedulePendingOutboundReconciliation } = require('../services/pendingOutboundReconciliationService')

const baseRow = () => ({
  id: 555,
  company_id: 1,
  conversa_id: 10,
  tipo: 'voice',
  status: 'erro',
  status_mensagem: 'erro',
  url: '/uploads/audio-teste.ogg',
  nome_arquivo: 'audio.ogg',
  whatsapp_id: null,
  whatsapp_instance_id: 1,
})

beforeEach(() => {
  svc._test._state.attemptsById.clear()
  svc._test._state.inFlight.clear()
  svc._test._state.deferredTimers.clear()
  mockUpdates.length = 0
  schedulePendingOutboundReconciliation.mockClear()
  mockConversaRow = { id: 10, telefone: '5511999999999', tipo: 'individual', whatsapp_instance_id: 1 }
  mockProvider = {}
  jest.spyOn(fs, 'existsSync').mockReturnValue(true)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('helpers puros', () => {
  test('isResendableTipo aceita mídia e rejeita texto', () => {
    expect(svc._test.isResendableTipo('voice')).toBe(true)
    expect(svc._test.isResendableTipo('imagem')).toBe(true)
    expect(svc._test.isResendableTipo('ARQUIVO')).toBe(true)
    expect(svc._test.isResendableTipo('texto')).toBe(false)
    expect(svc._test.isResendableTipo('contact')).toBe(false)
  })

  test('resolveStoredMediaPath exige /uploads e bloqueia traversal', () => {
    expect(svc._test.resolveStoredMediaPath('/uploads/a.ogg')).toMatch(/a\.ogg$/)
    expect(svc._test.resolveStoredMediaPath('/etc/passwd')).toBeNull()
    // basename neutraliza traversal → resolve para o arquivo dentro de uploads, nunca acima
    const p = svc._test.resolveStoredMediaPath('/uploads/../../secret')
    expect(p).not.toBeNull()
    expect(p).toMatch(/secret$/)
    expect(p).not.toMatch(/\.\./)
  })
})

describe('resendOutboundMediaMessage — filtros', () => {
  test('ignora tipo não-mídia', async () => {
    const r = await svc.resendOutboundMediaMessage({ ...baseRow(), tipo: 'texto' })
    expect(r.action).toBe('skip_tipo')
  })

  test('ignora mensagem que não está em erro', async () => {
    const r = await svc.resendOutboundMediaMessage({ ...baseRow(), status: 'sent', status_mensagem: 'sent' })
    expect(r.action).toBe('skip_not_erro')
  })

  test('arquivo ausente no disco → não reenvia e trava tentativas', async () => {
    fs.existsSync.mockReturnValue(false)
    const row = baseRow()
    const r = await svc.resendOutboundMediaMessage(row)
    expect(r.action).toBe('skip_arquivo_ausente')
    expect(svc._test._state.attemptsById.get(row.id)).toBe(svc._test.getMaxAttempts())
  })
})

describe('resendOutboundMediaMessage — guarda anti-duplicidade', () => {
  test('se o provedor já tem a mensagem (sent), NÃO reenvia — só corrige status', async () => {
    const sendVoice = jest.fn()
    mockProvider = {
      getMessages: jest.fn().mockResolvedValue({ ok: true, data: [{ status: 'sent' }] }),
      uploadMedia: jest.fn(),
      sendVoice,
    }
    const r = await svc.resendOutboundMediaMessage(baseRow())
    expect(r.action).toBe('already_at_provider')
    expect(sendVoice).not.toHaveBeenCalled()
    expect(mockProvider.uploadMedia).not.toHaveBeenCalled()
    expect(schedulePendingOutboundReconciliation).toHaveBeenCalledTimes(1)
    expect(mockUpdates[0]).toMatchObject({ status: 'pending' })
  })

  test('se o provedor confirma falha (invalid), não reenvia e trava tentativas', async () => {
    mockProvider = {
      getMessages: jest.fn().mockResolvedValue({ ok: true, data: [{ status: 'invalid' }] }),
      uploadMedia: jest.fn(),
      sendVoice: jest.fn(),
    }
    const row = baseRow()
    const r = await svc.resendOutboundMediaMessage(row)
    expect(r.action).toBe('provider_confirmou_falha')
    expect(mockProvider.sendVoice).not.toHaveBeenCalled()
    expect(svc._test._state.attemptsById.get(row.id)).toBe(svc._test.getMaxAttempts())
  })
})

describe('resendOutboundMediaMessage — reenvio', () => {
  test('provedor sem registro → sobe arquivo e reenvia com sucesso', async () => {
    const uploadMedia = jest.fn().mockResolvedValue({ ok: true, url: 'https://cdn/x.ogg' })
    const sendVoice = jest.fn().mockResolvedValue({ ok: true, messageId: 'BAE543FE1CE17AFA' })
    mockProvider = {
      getMessages: jest.fn().mockResolvedValue({ ok: true, data: [] }),
      uploadMedia,
      sendVoice,
    }
    const row = baseRow()
    const r = await svc.resendOutboundMediaMessage(row)
    expect(r.action).toBe('resent')
    expect(uploadMedia).toHaveBeenCalledTimes(1)
    expect(sendVoice).toHaveBeenCalledWith('5511999999999', 'https://cdn/x.ogg', expect.objectContaining({
      referenceId: 'crm-555',
      sendOrigin: 'reenvio_automatico_midia',
    }))
    // ID real do WhatsApp → status vai direto para sent, e a tentativa é limpa no sucesso
    expect(mockUpdates.at(-1)).toMatchObject({ status: 'sent', whatsapp_id: 'BAE543FE1CE17AFA' })
    expect(svc._test._state.attemptsById.has(row.id)).toBe(false)
  })

  test('reenvio ainda falha → mantém erro e conta tentativa', async () => {
    mockProvider = {
      getMessages: jest.fn().mockResolvedValue({ ok: true, data: [] }),
      uploadMedia: jest.fn().mockResolvedValue({ ok: true, url: 'https://cdn/x.ogg' }),
      sendVoice: jest.fn().mockResolvedValue({ ok: false, error: 'timeout' }),
    }
    const row = baseRow()
    const r = await svc.resendOutboundMediaMessage(row)
    expect(r.action).toBe('resend_failed')
    expect(svc._test._state.attemptsById.get(row.id)).toBe(1)
    expect(mockUpdates.at(-1)).toMatchObject({ status: 'erro' })
  })

  test('respeita o teto de tentativas', async () => {
    const row = baseRow()
    svc._test._state.attemptsById.set(row.id, svc._test.getMaxAttempts())
    mockProvider = { getMessages: jest.fn(), uploadMedia: jest.fn(), sendVoice: jest.fn() }
    const r = await svc.resendOutboundMediaMessage(row)
    expect(r.action).toBe('skip_max_attempts')
    expect(mockProvider.uploadMedia).not.toHaveBeenCalled()
  })
})
