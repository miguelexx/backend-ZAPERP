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
