/**
 * Webhook Whapi — detecção de revogação do CLIENTE ("apagar para todos").
 * O painel NÃO esconde o conteúdo; só marca apagada_pelo_cliente. Aqui cobrimos a
 * detecção do evento e a extração do id-alvo (as duas variam de shape no Whapi).
 */

describe('Whapi webhook — cliente apagou para todos (detecção)', () => {
  let controller
  beforeEach(() => {
    jest.resetModules()
    jest.doMock('../controllers/webhookZapiController', () => ({
      receberZapi: jest.fn(),
      statusZapi: jest.fn(),
    }))
    controller = require('../controllers/webhookWhapiController')
  })
  afterEach(() => jest.resetModules())

  test('detecta type=deleted / revoke / revoked / trash', () => {
    const d = controller._test.isWhapiDeletedMessage
    expect(d({ type: 'deleted', id: 'wamid.1' })).toBe(true)
    expect(d({ type: 'revoke', id: 'wamid.1' })).toBe(true)
    expect(d({ type: 'revoked', id: 'wamid.1' })).toBe(true)
    expect(d({ type: 'trash', id: 'wamid.1' })).toBe(true)
  })

  test('detecta flag deleted:true e action.type=delete', () => {
    const d = controller._test.isWhapiDeletedMessage
    expect(d({ type: 'text', deleted: true, id: 'wamid.1' })).toBe(true)
    expect(d({ type: 'action', action: { type: 'delete', target: 'wamid.9' } })).toBe(true)
    expect(d({ type: 'action', action: { type: 'revoke', target: 'wamid.9' } })).toBe(true)
  })

  test('NÃO confunde mensagem normal, reação ou voto com revogação', () => {
    const d = controller._test.isWhapiDeletedMessage
    expect(d({ type: 'text', text: { body: 'oi' } })).toBe(false)
    expect(d({ type: 'action', action: { type: 'reaction', emoji: '👍' } })).toBe(false)
    expect(d({ type: 'action', action: { type: 'vote' } })).toBe(false)
    expect(d(null)).toBe(false)
  })

  test('extrai id-alvo de action.target e do id da própria mensagem', () => {
    const x = controller._test.extractWhapiDeletedTargetId
    expect(x({ type: 'action', action: { type: 'delete', target: 'wamid.ALVO' }, id: 'evt.1' })).toBe('wamid.ALVO')
    expect(x({ type: 'deleted', id: 'wamid.SELF' })).toBe('wamid.SELF')
    expect(x({ type: 'deleted' })).toBe(null)
  })
})
