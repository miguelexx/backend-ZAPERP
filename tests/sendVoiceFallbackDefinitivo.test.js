/**
 * Doc 29 §3 item 5 — o fallback /messages/voice → /messages/audio do UltraMSG só vale para
 * RECUSA DEFINITIVA.
 *
 * O fallback existe porque o endpoint `voice` recusa certos formatos (HTTP 200 com
 * `sent:false` / erro de extensão) — aí repostar como áudio comum é a correção certa.
 * Numa falha TRANSITÓRIA (5xx/408/425/429) a UltraMSG pode já ter aceitado o áudio: repostar
 * o MESMO body (mesmo referenceId) entregava DOIS áudios ao cliente.
 *
 * Sem a correção o 3º teste falha: há um segundo POST, para /messages/audio.
 */

const mockPosts = []
let mockRespostas

jest.mock('../services/providers/ultramsg/http', () => ({
  postJson: async ({ endpoint, body }) => {
    mockPosts.push({ endpoint, body })
    return mockRespostas.shift() || { ok: true, status: 200, data: { sent: 'true', id: 'X' }, text: '' }
  },
  aplicarReferenceId: (body, opts) => ({ ...body, referenceId: opts?.referenceId || 'crm-55' }),
  maskToken: () => '***',
}))

jest.mock('../services/providers/ultramsg/config', () => ({
  resolveConfig: async () => ({ basePath: 'https://api.ultramsg.test/inst1', token: 'tkn', companyId: 1 }),
}))

jest.mock('../services/providers/ultramsg/delay', () => ({ awaitSendDelay: async () => {} }))
jest.mock('../services/whatsappSendGuardService', () => ({ buildSendMeta: () => ({}) }))

const { sendVoice } = require('../services/providers/ultramsg/audio')

const AUDIO = 'https://cdn.example/audio.ogg'

beforeEach(() => {
  mockPosts.length = 0
  mockRespostas = []
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => jest.restoreAllMocks())

describe('sendVoice — fallback /messages/audio', () => {
  test('voice aceito: um único POST, nenhum fallback', async () => {
    mockRespostas = [{ ok: true, status: 200, data: { sent: 'true', id: 'WA-1' }, text: '' }]
    const r = await sendVoice('5588999990000', AUDIO, { returnDetails: true })
    expect(r.ok).toBe(true)
    expect(mockPosts.map((p) => p.endpoint)).toEqual(['/messages/voice'])
  })

  test('recusa DEFINITIVA (200 + sent:false): o fallback /messages/audio continua acontecendo', async () => {
    mockRespostas = [
      { ok: true, status: 200, data: { sent: 'false', error: 'File extension not supported' }, text: '' },
      { ok: true, status: 200, data: { sent: 'true', id: 'WA-2' }, text: '' },
    ]
    const r = await sendVoice('5588999990000', AUDIO, { returnDetails: true })
    expect(mockPosts.map((p) => p.endpoint)).toEqual(['/messages/voice', '/messages/audio'])
    expect(r.ok).toBe(true)
  })

  test('falha TRANSITÓRIA (503): NÃO faz fallback — não duplica o áudio no cliente', async () => {
    mockRespostas = [{ ok: false, status: 503, data: null, text: 'service unavailable' }]
    const r = await sendVoice('5588999990000', AUDIO, { returnDetails: true })
    expect(mockPosts.map((p) => p.endpoint)).toEqual(['/messages/voice'])
    expect(r.ok).toBe(false)
    // httpStatus preservado: o chamador classifica como transitória e mantém pending + reconciliação.
    expect(r.httpStatus).toBe(503)
    expect(r.transient).toBe(true)
  })

  test.each([408, 425, 429, 500, 502, 504])('HTTP %i também é transitório: sem fallback', async (status) => {
    mockRespostas = [{ ok: false, status, data: null, text: 'erro' }]
    await sendVoice('5588999990000', AUDIO, { returnDetails: true })
    expect(mockPosts.map((p) => p.endpoint)).toEqual(['/messages/voice'])
  })

  test.each([400, 401, 403, 404, 422])('HTTP %i é definitivo: o fallback roda', async (status) => {
    mockRespostas = [
      { ok: false, status, data: { error: 'bad request' }, text: '' },
      { ok: true, status: 200, data: { sent: 'true', id: 'WA-3' }, text: '' },
    ]
    await sendVoice('5588999990000', AUDIO, { returnDetails: true })
    expect(mockPosts.map((p) => p.endpoint)).toEqual(['/messages/voice', '/messages/audio'])
  })

  test('disableAudioFallback continua suprimindo o fallback (comportamento anterior intacto)', async () => {
    mockRespostas = [{ ok: true, status: 200, data: { sent: 'false', error: 'File extension not supported' }, text: '' }]
    const r = await sendVoice('5588999990000', AUDIO, { returnDetails: true, disableAudioFallback: true })
    expect(mockPosts.map((p) => p.endpoint)).toEqual(['/messages/voice'])
    expect(r.ok).toBe(false)
  })
})
