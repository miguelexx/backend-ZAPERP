const { validateChatbotConfig } = require('../services/chatbotTriageService')

describe('chatbot finalization message config', () => {
  it('desativa o envio quando a mensagem esta vazia', () => {
    const config = validateChatbotConfig({
      enabled: false,
      enviarMensagemFinalizacao: true,
      mensagemFinalizacao: '   ',
    })

    expect(config.enviarMensagemFinalizacao).toBe(false)
  })

  it('mantem o envio habilitado quando existe mensagem', () => {
    const config = validateChatbotConfig({
      enabled: false,
      enviarMensagemFinalizacao: true,
      mensagemFinalizacao: ' Atendimento encerrado. ',
    })

    expect(config.enviarMensagemFinalizacao).toBe(true)
    expect(config.mensagemFinalizacao).toBe('Atendimento encerrado.')
  })

  it('preserva a mensagem salva quando o envio esta desligado', () => {
    const config = validateChatbotConfig({
      enabled: false,
      enviarMensagemFinalizacao: false,
      mensagemFinalizacao: 'Texto para uso futuro.',
    })

    expect(config.enviarMensagemFinalizacao).toBe(false)
    expect(config.mensagemFinalizacao).toBe('Texto para uso futuro.')
  })
})
