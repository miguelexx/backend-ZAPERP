const { _test } = require('../controllers/iaController')

describe('iaController - seguranca da configuracao do chatbot', () => {
  test('configuracao antiga invalida nunca aparece ativa na API', () => {
    const config = _test.chatbotConfigForApi({
      enabled: true,
      options: [],
      welcomeMessage: 'Bem-vindo',
    })

    expect(config.enabled).toBe(false)
    expect(config.config_invalid).toBe(true)
    expect(config.config_validation_error).toMatch(/opção ativa/i)
  })

  test('configuracao valida permanece ativa', () => {
    const config = _test.chatbotConfigForApi({
      enabled: true,
      options: [{ key: '1', label: 'Vendas', departamento_id: 9, active: true }],
    })

    expect(config.enabled).toBe(true)
    expect(config.config_invalid).toBeUndefined()
  })
})
