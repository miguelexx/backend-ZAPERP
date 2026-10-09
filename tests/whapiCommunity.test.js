/**
 * Comunidades Whapi — paths confirmados (OpenAPI/readme.io). fetch mockado.
 * Garante método/rota/body corretos e que DELETE de participante/admin leva JSON no body.
 */

describe('Whapi — comunidades', () => {
  let prevBase
  beforeEach(() => {
    jest.resetModules()
    prevBase = process.env.WHAPI_BASE_URL
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    if (prevBase === undefined) delete process.env.WHAPI_BASE_URL
    else process.env.WHAPI_BASE_URL = prevBase
    jest.resetModules()
  })

  function mockDeps({ fetchImpl } = {}) {
    const fetchWithRetry = jest.fn(fetchImpl)
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
        instance: { id, company_id: companyId, provider: 'whapi', instance_id: 'NEBULA-AER3B', instance_token: 'TESTTOKEN', ativo: true },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    return { fetchWithRetry }
  }

  const jsonRes = (obj, { ok = true, status = 200 } = {}) => ({ ok, status, text: async () => JSON.stringify(obj) })
  const CTX = { companyId: 1, whatsappInstanceId: 10 }
  const CID = '120363426760868023@g.us'
  const load = () => require('../services/providers/whapi')
  const callOf = (m, i = 0) => ({
    url: m.mock.calls[i][0],
    opts: m.mock.calls[i][1],
    body: m.mock.calls[i][1].body ? JSON.parse(m.mock.calls[i][1].body) : null,
  })

  test('createCommunity POST /communities { subject, description }', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ id: CID, type: 'community' }) })
    const r = await load().createCommunity('VIP', 'Clientes especiais', CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/communities')
    expect(c.opts.method).toBe('POST')
    expect(c.body).toEqual({ subject: 'VIP', description: 'Clientes especiais' })
  })

  test('getCommunities GET /communities?count&offset e mapeia groups[]', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ groups: [{ id: CID, name: 'VIP' }], total: 1 }) })
    const r = await load().getCommunities({ ...CTX, count: 50, offset: 0 })
    expect(r.ok).toBe(true)
    expect(r.communities).toHaveLength(1)
    expect(r.total).toBe(1)
    expect(callOf(fetchWithRetry).url).toContain('https://gate.whapi.test/communities?')
    expect(callOf(fetchWithRetry).url).toContain('count=50')
  })

  test('getCommunity GET /communities/{cid} e monta inviteLink', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ id: CID, name: 'VIP', invite_code: 'AbC123', participants: [] }) })
    const r = await load().getCommunity(CID, CTX)
    expect(r.ok).toBe(true)
    expect(r.inviteCode).toBe('AbC123')
    expect(r.inviteLink).toBe('https://chat.whatsapp.com/AbC123')
    expect(callOf(fetchWithRetry).url).toBe('https://gate.whapi.test/communities/120363426760868023%40g.us')
  })

  test('getCommunitySubGroups GET /subgroups separa announce/other', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ announceGroupInfo: { id: 'a@g.us', title: 'Avisos' }, otherGroups: [{ id: 'b@g.us', title: 'Geral' }] }) })
    const r = await load().getCommunitySubGroups(CID, CTX)
    expect(r.ok).toBe(true)
    expect(r.announceGroup.title).toBe('Avisos')
    expect(r.subGroups).toHaveLength(1)
    expect(callOf(fetchWithRetry).url).toMatch(/\/communities\/120363426760868023%40g\.us\/subgroups$/)
  })

  test('createGroupInCommunity POST /communities/{cid} { subject, participants }', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ id: 'novo@g.us' }) })
    const r = await load().createGroupInCommunity(CID, 'Suporte', ['553499911246'], CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/communities/120363426760868023%40g.us')
    expect(c.opts.method).toBe('POST')
    expect(c.body.subject).toBe('Suporte')
    expect(c.body.participants.length).toBeGreaterThanOrEqual(1)
  })

  test('link PUT /communities/{cid}/{gid} e unlink DELETE', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const whapi = load()
    await whapi.linkGroupToCommunity(CID, '120363000000000009@g.us', CTX)
    expect(callOf(fetchWithRetry, 0).opts.method).toBe('PUT')
    expect(callOf(fetchWithRetry, 0).url).toBe('https://gate.whapi.test/communities/120363426760868023%40g.us/120363000000000009%40g.us')
    await whapi.unlinkGroupFromCommunity(CID, '120363000000000009@g.us', CTX)
    expect(callOf(fetchWithRetry, 1).opts.method).toBe('DELETE')
  })

  test('addCommunityParticipant POST /participants { participants }', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true, processed: ['5534988887777'], failed: [] }) })
    const r = await load().addCommunityParticipant(CID, '5534988887777', CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/communities/120363426760868023%40g.us/participants')
    expect(c.opts.method).toBe('POST')
    expect(c.body).toEqual({ participants: ['5534988887777'] })
  })

  test('removeCommunityParticipant DELETE /participants envia body JSON', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const r = await load().removeCommunityParticipant(CID, ['5534988887777'], CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.opts.method).toBe('DELETE')
    expect(c.url).toMatch(/\/participants$/)
    expect(c.body).toEqual({ participants: ['5534988887777'] })
  })

  test('promote PATCH /admins e demote DELETE /admins', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const whapi = load()
    await whapi.promoteCommunityParticipant(CID, '5534988887777', CTX)
    expect(callOf(fetchWithRetry, 0).opts.method).toBe('PATCH')
    expect(callOf(fetchWithRetry, 0).url).toMatch(/\/admins$/)
    await whapi.demoteCommunityParticipant(CID, '5534988887777', CTX)
    expect(callOf(fetchWithRetry, 1).opts.method).toBe('DELETE')
    expect(callOf(fetchWithRetry, 1).body).toEqual({ participants: ['5534988887777'] })
  })

  test('changeCommunitySettings valida setting/policy', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const whapi = load()
    const bad = await whapi.changeCommunitySettings(CID, 'foo', 'bar', CTX)
    expect(bad.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
    const ok = await whapi.changeCommunitySettings(CID, 'member_add_mode', 'admins', CTX)
    expect(ok.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.opts.method).toBe('PATCH')
    expect(c.url).toMatch(/\/settings$/)
    expect(c.body).toEqual({ setting: 'member_add_mode', policy: 'admins' })
  })

  test('deactivateCommunity DELETE /communities/{cid}', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const r = await load().deactivateCommunity(CID, CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.opts.method).toBe('DELETE')
    expect(c.url).toBe('https://gate.whapi.test/communities/120363426760868023%40g.us')
  })

  test('comunidade inválida não chama a rede', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({}) })
    const r = await load().addCommunityParticipant('comunidade_9', '553499911246', CTX)
    expect(r.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })
})
