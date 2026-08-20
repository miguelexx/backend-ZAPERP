const {
  normalizeNoSelectionRoutingConfig,
} = require('../services/chatbotNoSelectionRoutingService')

describe('encaminhamento automático sem escolha de setor', () => {
  test('fica desativado e seguro por padrão', () => {
    expect(normalizeNoSelectionRoutingConfig({})).toEqual({
      ativo: false,
      minutos: 10,
      departamentosIds: [],
    })
  })

  test('normaliza prazo e remove setores inválidos ou duplicados', () => {
    expect(normalizeNoSelectionRoutingConfig({
      enabled: true,
      encaminhar_sem_escolha_ativo: true,
      encaminhar_sem_escolha_minutos: 9999,
      encaminhar_sem_escolha_departamentos_ids: ['4', 4, -2, 'x', 8],
    })).toEqual({
      ativo: true,
      minutos: 1440,
      departamentosIds: [4, 8],
    })
  })

  test('não executa quando o chatbot principal está desativado', () => {
    expect(normalizeNoSelectionRoutingConfig({
      enabled: false,
      encaminhar_sem_escolha_ativo: true,
      encaminhar_sem_escolha_departamentos_ids: [4],
    }).ativo).toBe(false)
  })

})
