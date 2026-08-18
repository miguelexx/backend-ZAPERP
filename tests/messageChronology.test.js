const {
  parseTimestampMillis,
  normalizeMessageTimestamp,
  compareMessagesChronologically,
  requestReceivedTimestamp,
} = require('../helpers/messageChronology')

describe('messageChronology', () => {
  test('interpreta timestamp Unix em segundos e milissegundos do mesmo modo', () => {
    expect(parseTimestampMillis(1_754_044_800)).toBe(1_754_044_800_000)
    expect(parseTimestampMillis('1754044800000')).toBe(1_754_044_800_000)
  })

  test('aceita ISO com timezone e usa fallback para ausente/inválido', () => {
    expect(normalizeMessageTimestamp('2026-08-18T16:47:00-03:00')).toBe('2026-08-18T19:47:00.000Z')
    expect(normalizeMessageTimestamp('inválido', '2026-08-18T19:48:00Z')).toBe('2026-08-18T19:48:00.000Z')
    expect(normalizeMessageTimestamp(null, '2026-08-18T19:49:00Z')).toBe('2026-08-18T19:49:00.000Z')
  })

  test('ordena pelo timestamp canônico e desempata pelo id sequencial', () => {
    const rows = [
      { id: 3, message_timestamp: '2026-08-18T19:48:00Z' },
      { id: 2, message_timestamp: '2026-08-18T19:47:00Z' },
      { id: 1, message_timestamp: '2026-08-18T19:47:00Z' },
    ].sort(compareMessagesChronologically)
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3])
  })

  test('ignora updated_at e usa o instante de entrada da requisição', () => {
    const req = { messageReceivedAt: '2026-08-18T19:47:00Z' }
    expect(requestReceivedTimestamp(req)).toBe('2026-08-18T19:47:00.000Z')
    const oldUpdatedLater = {
      id: 1,
      message_timestamp: '2026-08-18T19:47:00Z',
      updated_at: '2026-08-18T20:00:00Z',
    }
    const newer = { id: 2, message_timestamp: '2026-08-18T19:48:00Z' }
    expect(compareMessagesChronologically(oldUpdatedLater, newer)).toBeLessThan(0)
  })

  test('ignora timestamp canônico inválido quando o registro legado tem criado_em válido', () => {
    const legacy = {
      id: 1,
      message_timestamp: 'valor-inválido',
      criado_em: '2026-08-18T19:47:00Z',
    }
    const newer = { id: 2, message_timestamp: '2026-08-18T19:48:00Z' }
    expect(compareMessagesChronologically(legacy, newer)).toBeLessThan(0)
  })
})
