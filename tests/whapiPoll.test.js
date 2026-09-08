/**
 * Enquetes (poll) Whapi: envio (POST /messages/poll) + normalização do VOTO inbound
 * (voto vira inbound de texto = opção escolhida, para a URA). fetch mockado. Ver doc 25 §29.
 */

describe('Whapi poll — envio', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    jest.resetModules()
  })

  function mockDeps({ instancesById = {}, fetchImpl = null } = {}) {
    const fetchWithRetry = jest.fn(fetchImpl || (async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ sent: true, message: { id: 'wamid.POLL' } }),
    })))
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn((type, to, opts, extra) => ({ type, to, opts, extra })),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry, sleep: jest.fn(async () => {}), isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async (companyId, id) => ({
        instance: instancesById[`${companyId}:${id}`] || null,
        error: instancesById[`${companyId}:${id}`] ? null : 'not found',
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    return { fetchWithRetry }
  }
  const inst = () => ({ id: 10, company_id: 1, provider: 'whapi', instance_id: 'NEBULA-AER3B', instance_token: 'TESTTOKEN', ativo: true })
  const OPTS = { companyId: 1, whatsappInstanceId: 10 }

  test('envia POST /messages/poll { to, title, options, count:1 } (escolha única default)', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.sendPoll('5534988887777', { title: 'Qual setor?', options: ['Suporte', 'Financeiro', 'Vendas'] }, OPTS)
    expect(r.ok).toBe(true)
    expect(r.messageId).toBe('wamid.POLL')
    const [url, opts] = fetchWithRetry.mock.calls[0]
    expect(url).toBe('https://gate.whapi.test/messages/poll')
    expect(opts.headers.Authorization).toBe('Bearer TESTTOKEN')
    expect(JSON.parse(opts.body)).toEqual({ to: '5534988887777', title: 'Qual setor?', options: ['Suporte', 'Financeiro', 'Vendas'], count: 1 })
  })

  test('count:0 = múltipla escolha; dedup e trim das opções; cap 12', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    await whapi.sendPoll('5534988887777', { title: 'T', options: [' A ', 'A', 'B', ''], count: 0 }, OPTS)
    const body = JSON.parse(fetchWithRetry.mock.calls[0][1].body)
    expect(body.count).toBe(0)
    expect(body.options).toEqual(['A', 'B'])
  })

  test('rejeita título vazio ou <2 opções sem chamar API', async () => {
    const { fetchWithRetry } = mockDeps({ instancesById: { '1:10': inst() } })
    const whapi = require('../services/providers/whapi')
    expect((await whapi.sendPoll('553', { title: '', options: ['A', 'B'] }, OPTS)).ok).toBe(false)
    expect((await whapi.sendPoll('553', { title: 'T', options: ['A'] }, OPTS)).ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })
})

describe('Whapi poll — voto inbound (normalização)', () => {
  let controller
  beforeEach(() => {
    jest.resetModules()
    jest.doMock('../controllers/webhookZapiController', () => ({ receberZapi: jest.fn(), statusZapi: jest.fn() }))
    controller = require('../controllers/webhookWhapiController')
  })
  afterEach(() => jest.resetModules())

  test('extractPollVote lê votes (texto) e target', () => {
    const v = controller._test.extractPollVote({ action: { type: 'vote', target: 'wamid.poll', votes: ['Financeiro'] } })
    expect(v).toEqual({ target: 'wamid.poll', options: ['Financeiro'] })
  })

  test('extractPollVote lê votes como { id: hash } (Whapi live)', () => {
    const hash = require('crypto').createHash('sha256').update('2', 'utf8').digest('base64')
    const v = controller._test.extractPollVote({
      action: { type: 'vote', target: 'wamid.poll', votes: [{ id: hash }] },
    })
    expect(v).toEqual({ target: 'wamid.poll', options: [hash] })
  })

  test('voto com hash no body vira placeholder até enrich', () => {
    const hash = require('crypto').createHash('sha256').update('2', 'utf8').digest('base64')
    const m = controller._test.normalizeWhapiMessageToInternal(
      {
        id: 'wamid.vote-hash',
        from_me: false,
        type: 'action',
        chat_id: '5534988887777@s.whatsapp.net',
        action: { type: 'vote', target: 'wamid.poll', votes: [{ id: hash }] },
        timestamp: 1,
      },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(m).not.toBeNull()
    expect(m.body).toBe('(voto na enquete)')
    expect(m.pollVoteOptions).toEqual([hash])
  })

  test('voto vira inbound de texto (chat) = opção escolhida', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'wamid.vote', from_me: false, type: 'action', chat_id: '5534988887777@s.whatsapp.net',
        action: { type: 'vote', target: 'wamid.poll', votes: ['Suporte'] }, timestamp: 1 },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(m).not.toBeNull()
    expect(m.type).toBe('chat')
    expect(m.body).toBe('Suporte')
    expect(m.pollVoteOptions).toEqual(['Suporte'])
    expect(m.pollVoteTarget).toBe('wamid.poll')
  })

  test('voto sem opção legível cai em placeholder (não vira inbound vazio)', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'wamid.vote2', from_me: false, type: 'action', chat_id: '5534988887777@s.whatsapp.net',
        action: { type: 'vote', target: 'wamid.poll', votes: [] }, timestamp: 1 },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(m.type).toBe('chat')
    expect(m.body).toBe('(voto na enquete)')
  })

  test('resolvePollVoteLabels (hash SHA-256) → texto da opção', () => {
    const { resolvePollVoteLabels } = controller._test
    const hash1 = require('crypto').createHash('sha256').update('1', 'utf8').digest('base64')
    expect(resolvePollVoteLabels([hash1], ['1', '2'])).toEqual(['1'])
  })

  test('action que não é reação nem voto continua ignorada', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'a.x', type: 'action', chat_id: '120363@g.us', action: { type: 'media_notify' }, timestamp: 1 },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(m).toBeNull()
  })
})
