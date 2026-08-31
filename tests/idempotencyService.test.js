/**
 * Caracterização do idempotencyService (extração da fachada chatController).
 * Usa o mock global de supabase (tests/setup.js) controlando o retorno de maybeSingle.
 */

const supabase = require('../config/supabase')
const idem = require('../services/chat/outbound/idempotencyService')

describe('idempotencyService', () => {
  let chain
  beforeEach(() => {
    jest.clearAllMocks()
    chain = supabase.from()
  })

  test('deduplicationMap é um Map compartilhado (mesma referência entre requires)', () => {
    expect(idem.deduplicationMap).toBeInstanceOf(Map)
    const again = require('../services/chat/outbound/idempotencyService')
    expect(again.deduplicationMap).toBe(idem.deduplicationMap)
  })

  test('findMensagemByClientTempId retorna null sem clientTempId (sem consultar)', async () => {
    const r = await idem.findMensagemByClientTempId(1, 10, '')
    expect(r).toBeNull()
  })

  test('retorna a linha quando encontrada', async () => {
    chain.maybeSingle.mockResolvedValueOnce({ data: { id: 7, status: 'pending' }, error: null })
    const r = await idem.findMensagemByClientTempId(1, 10, 'abc')
    expect(r).toMatchObject({ id: 7, status: 'pending' })
  })

  test('retorna null e mantém disponível em erro genérico (não-coluna)', async () => {
    chain.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } })
    const r = await idem.findMensagemByClientTempId(1, 10, 'abc')
    expect(r).toBeNull()
    expect(idem.isDbDedupeUnavailable()).toBe(false)
  })

  test('erro de coluna ausente lata a flag (latch) e pula consultas futuras', async () => {
    expect(idem.isDbDedupeUnavailable()).toBe(false)
    chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "column mensagens.client_temp_id does not exist" },
    })
    const r1 = await idem.findMensagemByClientTempId(1, 10, 'abc')
    expect(r1).toBeNull()
    expect(idem.isDbDedupeUnavailable()).toBe(true)

    // Após o latch, nem chama supabase de novo.
    chain.maybeSingle.mockClear()
    const r2 = await idem.findMensagemByClientTempId(1, 10, 'def')
    expect(r2).toBeNull()
    expect(chain.maybeSingle).not.toHaveBeenCalled()
  })

  test('flag de audio_duracao_sec: getter/setter latch', () => {
    expect(idem.isAudioDuracaoSecColumnUnavailable()).toBe(false)
    idem.markAudioDuracaoSecColumnUnavailable()
    expect(idem.isAudioDuracaoSecColumnUnavailable()).toBe(true)
  })
})
