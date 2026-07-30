const {
  normalizeMessageType,
  dedupeOperationalMessages,
  explicitMessageOrigin,
  isExplicitHumanOutbound,
  isIndividualCustomerConversation,
  summarizeDailyCustomerActivity,
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

  test('clientes do dia conta toda conversa individual real e exclui grupos', () => {
    const summary = summarizeDailyCustomerActivity({
      todayKey: '2026-07-29',
      dateKeyFor: (value) => String(value).slice(0, 10),
      conversations: [
        { id: 1, cliente_id: 10, tipo: null, telefone: '5511999999999' },
        { id: 2, cliente_id: 11, tipo: null, telefone: '5511888888888' },
        { id: 3, cliente_id: null, tipo: 'grupo', telefone: '120@g.us' },
      ],
      messages: [
        { id: 1, conversa_id: 1, criado_em: '2026-07-29T10:00:00Z', direcao: 'in' },
        { id: 2, conversa_id: 1, criado_em: '2026-07-29T10:01:00Z', direcao: 'out', origem: 'whatsapp_celular' },
        { id: 3, conversa_id: 2, criado_em: '2026-07-29T11:00:00Z', direcao: 'in' },
        { id: 4, conversa_id: 3, criado_em: '2026-07-29T12:00:00Z', direcao: 'in' },
        { id: 5, conversa_id: 2, criado_em: '2026-07-28T11:00:00Z', direcao: 'out', origem: 'sistema_humano' },
      ],
    })
    expect(summary).toEqual({
      clientes_com_conversa: 2,
      clientes_com_resposta_humana: 1,
    })
  })

  test('SLA reconhece somente conversas individuais de clientes', () => {
    expect(isIndividualCustomerConversation({ tipo: null, telefone: '5511999999999' })).toBe(true)
    expect(isIndividualCustomerConversation({ tipo: 'grupo', telefone: '1203630' })).toBe(false)
    expect(isIndividualCustomerConversation({ tipo: null, telefone: '1203630@g.us' })).toBe(false)
  })
})
