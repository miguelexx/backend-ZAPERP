/**
 * Boas-vindas única (sendOnlyFirstTime) sem menu de setores.
 * Regressão: "oi" do cliente não disparava a mensagem configurada.
 */

function loadFresh() {
  jest.resetModules()
  return require('../services/chatbotTriageService')
}

describe('boas-vindas única sem setores', () => {
  test('validateChatbotConfig aceita chatbot ligado só com welcome e sem opções', () => {
    const { validateChatbotConfig } = loadFresh()
    const cfg = validateChatbotConfig({
      enabled: true,
      usarMenuSetores: false,
      sendOnlyFirstTime: true,
      welcomeMessage: 'Olá! Seja bem-vindo(a) ao Mundo dos Presentes!',
      options: [{ key: '1', label: 'Vendas', departamento_id: 9, active: true }],
    })
    expect(cfg).not.toBeNull()
    expect(cfg.enabled).toBe(true)
    expect(cfg.usarMenuSetores).toBe(false)
    expect(cfg.options).toEqual([])
    expect(cfg.welcomeMessage).toContain('Mundo dos Presentes')
  })

  test('isWelcomeOnlyConfig é true com menu desligado ou sem opções ativas', () => {
    const { isWelcomeOnlyConfig } = loadFresh()
    expect(isWelcomeOnlyConfig({ usarMenuSetores: false, options: [] })).toBe(true)
    expect(isWelcomeOnlyConfig({ options: [] })).toBe(true)
    expect(isWelcomeOnlyConfig({
      usarMenuSetores: true,
      options: [{ key: '1', label: 'Vendas', departamento_id: 2, active: true }],
    })).toBe(false)
  })

  test('decideShouldSendTriageWelcome envia no primeiro oi (única, sem welcome anterior)', () => {
    const { decideShouldSendTriageWelcome } = loadFresh()
    expect(decideShouldSendTriageWelcome({
      inboundAntigoParaWelcome: false,
      conversaReabertaAposFinalizacao: false,
      welcomeAlreadySent: false,
      clientStartedConversation: true,
      hasHumanOutbound: false,
    })).toBe(true)
  })

  test('decideShouldSendTriageWelcome não reenvia se a mensagem única já está na conversa', () => {
    const { decideShouldSendTriageWelcome } = loadFresh()
    expect(decideShouldSendTriageWelcome({
      welcomeAlreadySent: true,
      clientStartedConversation: true,
      hasHumanOutbound: false,
    })).toBe(false)
  })

  test('menu antigo de setores na conversa NÃO conta como welcome atual', () => {
    const { welcomeTextNeedle, outboundContainsNeedle } = loadFresh()
    const needle = welcomeTextNeedle({
      welcomeMessage: 'Olá! Seja bem-vindo(a) ao Mundo dos Presentes!\n\nComo posso ajudar?',
    })
    expect(needle).toContain('Mundo dos Presentes')
    expect(outboundContainsNeedle(
      [{ texto: '1 - Vendas\n2 - Financeiro\nResponda com o número da opção desejada.' }],
      needle
    )).toBe(false)
    expect(outboundContainsNeedle(
      [{ texto: 'Olá! Seja bem-vindo(a) ao Mundo dos Presentes!\n\nComo posso ajudar?' }],
      needle
    )).toBe(true)
  })

  test('não envia se operador humano já falou na conversa', () => {
    const { decideShouldSendTriageWelcome } = loadFresh()
    expect(decideShouldSendTriageWelcome({
      welcomeAlreadySent: false,
      clientStartedConversation: true,
      hasHumanOutbound: true,
    })).toBe(false)
  })

  test('reabertura após finalização reenvia mesmo com welcome anterior', () => {
    const { decideShouldSendTriageWelcome } = loadFresh()
    expect(decideShouldSendTriageWelcome({
      conversaReabertaAposFinalizacao: true,
      welcomeAlreadySent: true,
      clientStartedConversation: false,
      hasHumanOutbound: true,
    })).toBe(true)
  })
})
