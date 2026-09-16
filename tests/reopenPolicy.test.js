const { shouldReopenFinishedConversation } = require('../controllers/webhookInbound/reopenPolicy')

describe('reopenPolicy - conversa finalizada permanece finalizada em fechos casuais', () => {
  // Fechos/ACKs curtos que o cliente costuma mandar após a mensagem de finalização.
  // Não devem reabrir a conversa (evita voltar para "Aberta" logo após finalizar).
  const mantemFechada = [
    'Certinho',
    'certinho',
    'certim',
    'Ok certinho',
    'tá certinho',
    'ta certinho',
    'tudo certinho',
    'combinado',
    'fechado',
    'isso mesmo',
    'show de bola',
    'ótimo',
    'otimo',
    'joia',
    'certinho, obrigado',
    'ok combinado valeu',
    // Já cobertos antes (regressão):
    'obrigado',
    'ok',
    'valeu',
    '10',
  ]

  it.each(mantemFechada)('mantém fechada para "%s"', (texto) => {
    const r = shouldReopenFinishedConversation(texto, { status_atendimento: 'fechada' })
    expect(r.shouldReopen).toBe(false)
  })

  // Demanda real do cliente continua reabrindo normalmente.
  const reabre = [
    'Preciso de ajuda com outro pedido',
    'quero cancelar minha compra',
    'tenho uma dúvida sobre o valor',
    'o produto veio com defeito',
    'quando chega minha entrega?',
  ]

  it.each(reabre)('reabre para demanda real "%s"', (texto) => {
    const r = shouldReopenFinishedConversation(texto, { status_atendimento: 'fechada' })
    expect(r.shouldReopen).toBe(true)
  })
})

const {
  shouldSkipReopenAsOwnOutboundEcho,
  inboundLooksLikeRecentOutbound,
} = require('../controllers/webhookInbound/reopenPolicy')

describe('eco da nossa mensagem após finalizar — não reabre', () => {
  const finalizacao = 'Atendimento finalizado com sucesso. Segue seu protocolo: *63902*. De 0 a 10, qual nota você daria para o nosso atendimento?'
  const welcome = 'Olá! Seja bem-vindo(a) à WM Sistemas.\nPor favor, escolha o setor com o qual deseja falar:'
  const agente = 'Resolvido por ligação. Cliente estava acessando dentro do servidor, e a tef funciona somente fora.'

  test('mensagem de finalização do sistema não reabre', () => {
    expect(shouldSkipReopenAsOwnOutboundEcho({ inboundText: finalizacao }).skip).toBe(true)
    expect(shouldSkipReopenAsOwnOutboundEcho({ inboundText: finalizacao }).reason).toBe('finalizacao_template')
  })

  test('menu de boas-vindas ecoado não reabre', () => {
    expect(shouldSkipReopenAsOwnOutboundEcho({ inboundText: welcome }).skip).toBe(true)
    expect(shouldSkipReopenAsOwnOutboundEcho({ inboundText: welcome }).reason).toBe('welcome_menu_echo')
  })

  test('eco da última mensagem do atendente (ainda sem whatsapp_id) não reabre', () => {
    const r = shouldSkipReopenAsOwnOutboundEcho({
      inboundText: agente,
      recentOutboundTexts: [agente],
    })
    expect(r.skip).toBe(true)
    expect(r.reason).toBe('echo_recent_outbound')
  })

  test('demanda real do cliente continua reabrindo', () => {
    expect(shouldSkipReopenAsOwnOutboundEcho({
      inboundText: 'Preciso de ajuda com outro pedido',
      recentOutboundTexts: [finalizacao, agente],
    }).skip).toBe(false)
    expect(shouldReopenFinishedConversation('Preciso de ajuda com outro pedido').shouldReopen).toBe(true)
  })

  test('inboundLooksLikeRecentOutbound ignora texto curto', () => {
    expect(inboundLooksLikeRecentOutbound('ok', ['ok pronto'])).toBe(false)
  })
})
