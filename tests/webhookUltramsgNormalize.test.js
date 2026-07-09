/**
 * Testes da normalização UltraMSG → pipeline interno (documentos/mídia).
 */
const { _test } = require('../controllers/webhookUltramsgController')
const { normalizeUltramsgToZapi } = _test
const { _test: zapiTest } = require('../controllers/webhookZapiController')
const { extractMessage } = zapiTest

beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}) })
afterAll(() => { jest.restoreAllMocks() })

const BASE_DATA = {
  id: 'false_5511999999999@c.us_ABC123',
  from: '5511888888888@c.us',
  to: '5511999999999@c.us',
  pushname: 'Cliente',
  fromMe: false,
  time: 1720000000,
}

describe('normalizeUltramsgToZapi — documentos', () => {
  test('type=document com media URL + filename', () => {
    const n = normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: '123',
      data: {
        ...BASE_DATA,
        type: 'document',
        body: 'Ofício Dr. 13 - EMOF - Tijolar.docx',
        media: 'https://cdn.ultramsg.com/docs/abc.docx',
        filename: 'Ofício Dr. 13 - EMOF - Tijolar.docx',
      },
    })
    expect(n.type).toBe('document')
    expect(n.documentUrl).toBe('https://cdn.ultramsg.com/docs/abc.docx')
    expect(n.fileName).toBe('Ofício Dr. 13 - EMOF - Tijolar.docx')
    expect(n.document?.fileName).toBe('Ofício Dr. 13 - EMOF - Tijolar.docx')
  })

  test('type=chat com body=arquivo.docx (sem media) → reclassifica document', () => {
    const n = normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: '123',
      data: {
        ...BASE_DATA,
        type: 'chat',
        body: 'Ofício Dr. 13 - EMOF - Tijolar.docx',
        media: '',
      },
    })
    expect(n.type).toBe('document')
    expect(n.fileName).toBe('Ofício Dr. 13 - EMOF - Tijolar.docx')
    expect(n.documentUrl).toBeFalsy()
  })

  test('type=chat com body=arquivo.pdf + media URL → document com URL', () => {
    const n = normalizeUltramsgToZapi({
      event_type: 'webhook_message_download_media',
      instanceId: '123',
      data: {
        ...BASE_DATA,
        type: 'chat',
        body: '2026-07-09_083657.pdf',
        media: 'https://cdn.ultramsg.com/docs/xyz.pdf',
      },
    })
    expect(n.type).toBe('document')
    expect(n.documentUrl).toBe('https://cdn.ultramsg.com/docs/xyz.pdf')
    expect(n.fileName).toBe('2026-07-09_083657.pdf')
  })

  test('texto normal type=chat NÃO vira documento', () => {
    const n = normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: '123',
      data: {
        ...BASE_DATA,
        type: 'chat',
        body: 'Olá, tudo bem?',
        media: '',
      },
    })
    expect(n.type).toBe('chat')
    expect(n.documentUrl).toBeFalsy()
    expect(n.fileName).toBeFalsy()
  })
})

describe('extractMessage — documento UltraMSG normalizado', () => {
  test('payload normalizado sem URL ainda → type=document + fileName', () => {
    const n = normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: '123',
      data: {
        ...BASE_DATA,
        type: 'document',
        body: 'contrato.pdf',
        media: '',
        filename: 'contrato.pdf',
      },
    })
    const r = extractMessage({
      ...n,
      phone: '5511888888888',
      connectedPhone: '5511999999999',
    })
    expect(r.type).toBe('document')
    expect(r.fileName).toBe('contrato.pdf')
    expect(r.texto).toBe('contrato.pdf')
    expect(r.documentUrl).toBeFalsy()
  })
})
