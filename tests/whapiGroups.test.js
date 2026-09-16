/**
 * Grupos Whapi — paths OpenAPI 1.8.7. fetch mockado.
 * DELETE de participante/admin/solicitação precisa enviar JSON no body.
 */

describe('Whapi — grupos', () => {
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
  const load = () => require('../services/providers/whapi')
  const callOf = (m, i = 0) => ({
    url: m.mock.calls[i][0],
    opts: m.mock.calls[i][1],
    body: m.mock.calls[i][1].body ? JSON.parse(m.mock.calls[i][1].body) : null,
  })

  test('toWhapiGroupId aceita dígitos, JID e grupo antigo com hífen; recusa grupo_ fake', () => {
    const { toWhapiGroupId } = load()
    expect(toWhapiGroupId('120363426760868023@g.us')).toBe('120363426760868023@g.us')
    expect(toWhapiGroupId('120363426760868023')).toBe('120363426760868023@g.us')
    expect(toWhapiGroupId('553484080098-1406738663')).toBe('553484080098-1406738663@g.us')
    expect(toWhapiGroupId('grupo_1')).toBe('')
    expect(toWhapiGroupId('comunidade_9')).toBe('')
  })

  test('createGroup POST /groups { subject, participants }', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ id: '120363000000000001@g.us' }) })
    const r = await load().createGroup('Equipe', ['553499911246', '3499911246'], CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/groups')
    expect(c.opts.method).toBe('POST')
    expect(c.body.subject).toBe('Equipe')
    expect(c.body.participants.length).toBeGreaterThanOrEqual(1)
  })

  test('getGroup com telefone só dígitos vira GroupID @g.us e resync', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({
        id: '120363426760868023@g.us',
        name: 'adoradores do bruno',
        participants: [{ id: '553484308030', rank: 'member' }],
      }),
    })
    const group = await load().getGroup('120363426760868023', { ...CTX, resync: true })
    expect(group.id).toBe('120363426760868023@g.us')
    expect(callOf(fetchWithRetry).url).toBe(
      'https://gate.whapi.test/groups/120363426760868023%40g.us?resync=true'
    )
  })

  test('addGroupParticipant POST /groups/{id}/participants', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const r = await load().addGroupParticipant('120363426760868023@g.us', '5534988887777', CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.url).toBe('https://gate.whapi.test/groups/120363426760868023%40g.us/participants')
    expect(c.opts.method).toBe('POST')
    expect(c.body).toEqual({ participants: ['5534988887777'] })
  })

  test('removeGroupParticipant DELETE envia body JSON', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const r = await load().removeGroupParticipant('120363426760868023@g.us', ['5534988887777'], CTX)
    expect(r.ok).toBe(true)
    const c = callOf(fetchWithRetry)
    expect(c.opts.method).toBe('DELETE')
    expect(c.body).toEqual({ participants: ['5534988887777'] })
  })

  test('promote PATCH /admins e demote DELETE /admins com body', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const whapi = load()
    await whapi.promoteToGroupAdmin('120363426760868023@g.us', '5534988887777', CTX)
    expect(callOf(fetchWithRetry, 0).opts.method).toBe('PATCH')
    expect(callOf(fetchWithRetry, 0).url).toMatch(/\/admins$/)
    await whapi.demoteGroupAdmin('120363426760868023@g.us', '5534988887777', CTX)
    expect(callOf(fetchWithRetry, 1).opts.method).toBe('DELETE')
    expect(callOf(fetchWithRetry, 1).body).toEqual({ participants: ['5534988887777'] })
  })

  test('getGroupInvite GET /invite e sendGroupInvite POST /groups/link/{code}', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async (url) => {
        if (String(url).includes('/invite')) return jsonRes({ invite_code: 'AbC123' })
        return jsonRes({ success: true })
      },
    })
    const whapi = load()
    const inv = await whapi.getGroupInvite('120363426760868023@g.us', CTX)
    expect(inv.ok).toBe(true)
    expect(inv.inviteCode).toBe('AbC123')
    expect(inv.inviteLink).toBe('https://chat.whatsapp.com/AbC123')
    await whapi.sendGroupInvite('AbC123', '5534988887777', { title: 'Entre' }, CTX)
    const send = callOf(fetchWithRetry, 1)
    expect(send.url).toBe('https://gate.whapi.test/groups/link/AbC123')
    expect(send.opts.method).toBe('POST')
    expect(send.body.to).toBe('5534988887777')
  })

  test('applications GET/POST/DELETE', async () => {
    const { fetchWithRetry } = mockDeps({
      fetchImpl: async () => jsonRes({ applications: [{ chatId: '553499911246' }] }),
    })
    const whapi = load()
    const list = await whapi.getGroupApplicationsList('120363426760868023@g.us', CTX)
    expect(list.applications).toHaveLength(1)
    expect(callOf(fetchWithRetry, 0).url).toMatch(/\/applications$/)
    await whapi.approveGroupApplication('120363426760868023@g.us', '553499911246', CTX)
    expect(callOf(fetchWithRetry, 1).opts.method).toBe('POST')
    await whapi.rejectGroupApplication('120363426760868023@g.us', '553499911246', CTX)
    expect(callOf(fetchWithRetry, 2).opts.method).toBe('DELETE')
    expect(callOf(fetchWithRetry, 2).body).toEqual({ application: '553499911246' })
  })

  test('updateGroupSetting PATCH só aceita setting/policy válidos', async () => {
    const { fetchWithRetry } = mockDeps({ fetchImpl: async () => jsonRes({ success: true }) })
    const whapi = load()
    const bad = await whapi.updateGroupSetting('120363426760868023@g.us', 'foo', 'bar', CTX)
    expect(bad.ok).toBe(false)
    expect(fetchWithRetry).not.toHaveBeenCalled()
    const ok = await whapi.updateGroupSetting('120363426760868023@g.us', 'send_messages', 'admins', CTX)
    expect(ok.ok).toBe(true)
    expect(callOf(fetchWithRetry).body).toEqual({ setting: 'send_messages', policy: 'admins' })
  })
})
