const {
  normalizeMessageType,
  dedupeOperationalMessages,
  explicitMessageOrigin,
  isExplicitHumanOutbound,
} = require('../services/dashboardDataRulesService')

describe('dashboardDataRulesService', () => {
  test.each([
    ['text', 'texto'],
    ['ptt', 'audio'],
    ['image', 'imagem'],
    ['video', 'video'],
    ['file', 'documento'],
    ['sticker', 'outros'],
    ['contact', 'outros'],
  ])('normaliza tipo %s como %s', (input, expected) => {
    expect(normalizeMessageType(input)).toBe(expected)
  })

  test('deduplica reprocessamento pelo id estável do provedor sem duplicar por status', () => {
    const base = {
      direcao: 'out',
      whatsapp_instance_id: 9,
      whatsapp_id: 'provider-123',
      tipo: 'audio',
    }
    const result = dedupeOperationalMessages([
      { ...base, id: 1, status: 'sent' },
      { ...base, id: 2, status: 'read' },
    ])
    expect(result.rows).toHaveLength(1)
    expect(result.duplicateCount).toBe(1)
  })

  test('mantém áudio atualizado como uma mensagem e exclui apagada', () => {
    const result = dedupeOperationalMessages([
      { id: 10, direcao: 'in', whatsapp_id: 'audio-1', whatsapp_instance_id: 3, tipo: 'audio', duracao: null },
      { id: 10, direcao: 'in', whatsapp_id: 'audio-1', whatsapp_instance_id: 3, tipo: 'audio', duracao: 12 },
      { id: 11, direcao: 'in', whatsapp_id: 'deleted-1', whatsapp_instance_id: 3, apagada_para_todos: true },
    ])
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].tipo).toBe('audio')
    expect(result.invalidCount).toBe(1)
  })

  test('preserva e interpreta origem operacional', () => {
    const mobile = { direcao: 'out', origem: 'whatsapp_celular', autor_usuario_id: null }
    const bot = { direcao: 'out', origem: 'automacao', autor_usuario_id: null }
    expect(explicitMessageOrigin(mobile)).toBe('whatsapp_celular')
    expect(isExplicitHumanOutbound(mobile)).toBe(true)
    expect(isExplicitHumanOutbound(bot)).toBe(false)
  })
})
