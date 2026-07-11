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

// ─── Áudio: variantes de type por aparelho/versão do WhatsApp ─────────────────────────
// Bug real (cliente específico): type fora do par exato audio/ptt (ex.: 'voice',
// 'audiomessage' ou o MIME cru 'audio/ogg; codecs=opus') derrubava o tipo e a URL da
// mídia era DESCARTADA → mensagem gravada como "(mensagem)" sem conteúdo.
describe('normalizeUltramsgToZapi — áudio (variantes de type)', () => {
  const AUDIO_URL = 'https://cdn.ultramsg.com/media/voice-abc.ogg'

  test.each([
    ['ptt', 'nota de voz padrão'],
    ['audio', 'áudio padrão'],
    ['voice', 'alias voice (alguns aparelhos)'],
    ['audiomessage', 'alias audiomessage'],
    ['pttmessage', 'alias pttmessage'],
  ])('type=%s com media → type audio + audioUrl (%s)', (rawType) => {
    const n = normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: '123',
      data: { ...BASE_DATA, type: rawType, body: '', media: AUDIO_URL },
    })
    expect(n.type).toBe('audio')
    expect(n.audioUrl).toBe(AUDIO_URL)
  })

  test('type=MIME cru "audio/ogg; codecs=opus" com media → inferido audio + audioUrl', () => {
    const n = normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: '123',
      data: { ...BASE_DATA, type: 'audio/ogg; codecs=opus', body: '', media: AUDIO_URL },
    })
    expect(n.type).toBe('audio')
    expect(n.audioUrl).toBe(AUDIO_URL)
  })

  test('type=chat vazio + media .ogg → inferido por extensão da URL', () => {
    const n = normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: '123',
      data: { ...BASE_DATA, type: 'chat', body: '', media: AUDIO_URL },
    })
    expect(n.type).toBe('audio')
    expect(n.audioUrl).toBe(AUDIO_URL)
  })

  test('type ausente + mimetype audio/ogg sem URL ainda → type audio (placeholder tipado)', () => {
    const n = normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: '123',
      data: { ...BASE_DATA, body: '', mimetype: 'audio/ogg; codecs=opus' },
    })
    expect(n.type).toBe('audio')
    const r = extractMessage({ ...n, phone: '5511888888888', connectedPhone: '5511999999999' })
    expect(r.texto).toBe('(áudio)') // tipado — nunca '(mídia)'/'(mensagem)'
  })

  test('texto normal com type=chat NÃO é reclassificado', () => {
    const n = normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: '123',
      data: { ...BASE_DATA, type: 'chat', body: 'Oi, tudo bem?' },
    })
    expect(n.type).toBe('chat')
    expect(n.audioUrl).toBeFalsy()
    const r = extractMessage({ ...n, phone: '5511888888888', connectedPhone: '5511999999999' })
    expect(r.texto).toBe('Oi, tudo bem?')
  })

  test('type=image explícito nunca vira áudio mesmo com URL .ogg estranha', () => {
    const n = normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: '123',
      data: { ...BASE_DATA, type: 'image', body: '', media: AUDIO_URL },
    })
    expect(n.type).toBe('image')
    expect(n.imageUrl).toBe(AUDIO_URL)
  })

  test('type=chat + media .jpg → inferido image', () => {
    const n = normalizeUltramsgToZapi({
      event_type: 'message_received',
      instanceId: '123',
      data: { ...BASE_DATA, type: 'chat', body: '', media: 'https://cdn.ultramsg.com/media/foto.jpg' },
    })
    expect(n.type).toBe('image')
    expect(n.imageUrl).toBe('https://cdn.ultramsg.com/media/foto.jpg')
  })

  test('extractMessage: voice sem URL → placeholder "(áudio)" (defensivo rota Z-API)', () => {
    const r = extractMessage({
      phone: '5511888888888',
      connectedPhone: '5511999999999',
      fromMe: false,
      messageId: 'ABC',
      type: 'voice',
      body: '',
    })
    expect(r.texto).toBe('(áudio)')
  })
})
