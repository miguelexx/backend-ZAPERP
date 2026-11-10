/**
 * 10/11/2026 — dois acertos pedidos depois do sync de grupos:
 *
 * 1) Grupo recém-importado tem 0 mensagens NA NOSSA BASE e sumia da aba "Abertas" (a regra
 *    exigia `ultima_mensagem`, de quando grupo só nascia por mensagem recebida). Com o sync
 *    trazendo a lista do WhatsApp, o atendente via o grupo no celular e não no sistema.
 * 2) `services/providers/ultramsg/http.js` logava a URL crua, e a URL do UltraMSG leva
 *    `?token=` — em TODA resposta >= 400 o token da instância ia em claro para o log.
 */

describe('Contador de "Abertas" — grupo conta mesmo sem mensagem', () => {
  let rowVisibleInPostFilteredList

  beforeEach(() => {
    jest.resetModules()
    jest.doMock('../config/supabase', () => ({ from: jest.fn() }))
    ;({ rowVisibleInPostFilteredList } = require('../services/chatListCountsService'))
  })

  const grupo = (extra = {}) => ({ id: 1, tipo: 'grupo', status_atendimento: 'aberta', ...extra })
  const individual = (extra = {}) => ({ id: 2, tipo: 'cliente', status_atendimento: 'aberta', ...extra })

  test('grupo sem mensagem entra no contador de Abertas (espelha a lista)', () => {
    expect(rowVisibleInPostFilteredList(grupo(), {}, { status_atendimento: 'aberta' })).toBe(true)
  })

  test('grupo com mensagem continua entrando', () => {
    expect(rowVisibleInPostFilteredList(grupo({ mensagens: [{ id: 9 }] }), {}, { status_atendimento: 'aberta' })).toBe(true)
  })

  test('individual sem mensagem e sem atendente continua FORA (regra não mudou)', () => {
    expect(rowVisibleInPostFilteredList(individual(), {}, { status_atendimento: 'aberta' })).toBe(false)
  })

  test('individual com atendente continua dentro', () => {
    expect(rowVisibleInPostFilteredList(individual({ atendente_id: 7 }), {}, { status_atendimento: 'aberta' })).toBe(true)
  })

  test('grupo segue fora de "Em atendimento" (não tem estado de atendimento)', () => {
    expect(rowVisibleInPostFilteredList(grupo(), {}, { status_atendimento: 'em_atendimento' })).toBe(false)
  })
})

describe('Log do UltraMSG — token da URL redigido', () => {
  let logs
  let http

  beforeEach(() => {
    jest.resetModules()
    logs = []
    jest.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry: jest.fn(), sleep: jest.fn(), isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn(() => ({})),
    }))
    http = require('../services/providers/ultramsg/http')
  })

  afterEach(() => {
    console.log.mockRestore?.()
    jest.resetModules()
  })

  test('erro 404 não derrama o token da instância no log', () => {
    // O caso real: as 3 instâncias paradas por não-pagamento respondem 404 a CADA chamada.
    // Token e instância aqui são FICTÍCIOS de propósito — nunca colar credencial real em teste.
    http.logUltramsgRequest({
      method: 'GET',
      url: 'https://api.ultramsg.com/instance000000/groups?token=TOKEN_FALSO_DE_TESTE',
      responseStatus: 404,
      responseData: { error: 'Your instance has been Stopped due to non-payment.' },
    })

    const saida = logs.join('\n')
    expect(saida).not.toContain('TOKEN_FALSO_DE_TESTE')
    expect(saida).toContain('[REDACTED]')
    // O endpoint continua legível — a redação é do VALOR, não do rastro.
    expect(saida).toContain('instance000000/groups')
    expect(saida).toContain('token=')
  })

  test('URL sem query passa intacta', () => {
    http.logUltramsgRequest({
      method: 'GET',
      url: 'https://api.ultramsg.com/instance1/groups',
      responseStatus: 500,
      responseData: { error: 'x' },
    })
    expect(logs.join('\n')).toContain('https://api.ultramsg.com/instance1/groups')
  })
})
