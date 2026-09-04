/**
 * Fase A — webhook Whapi: normalização inbound/ACK e dispatch ao pipeline (receberZapi/statusZapi).
 * O core é mockado para isolar o normalizador. Ver docs/ai-handoff/25.
 */

describe('Whapi webhook — normalização e dispatch', () => {
  let receberZapi, statusZapi, controller

  beforeEach(() => {
    jest.resetModules()
    receberZapi = jest.fn(async (req, res) => res.status(200).json({ ok: true }))
    statusZapi = jest.fn(async (req, res) => res.status(200).json({ ok: true }))
    jest.doMock('../controllers/webhookZapiController', () => ({
      receberZapi,
      statusZapi,
    }))
    controller = require('../controllers/webhookWhapiController')
  })
  afterEach(() => jest.resetModules())

  function fakeRes() {
    const r = { statusCode: 200, body: null }
    r.status = (c) => { r.statusCode = c; return r }
    r.json = (o) => { r.body = o; return r }
    return r
  }

  test('normaliza inbound texto privado', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'wamid.1', from_me: false, type: 'text', chat_id: '5534988887777@s.whatsapp.net', from_name: 'Cliente', text: { body: 'oi' }, timestamp: 1700000000 },
      { channelId: 'NEBULA-AER3B', connectedPhone: '553433334444' }
    )
    expect(m.type).toBe('chat')
    expect(m.id).toBe('wamid.1')
    expect(m.fromMe).toBe(false)
    expect(m.isGroup).toBe(false)
    expect(m.body).toBe('oi')
    expect(m.senderName).toBe('Cliente')
    expect(String(m.phone)).toContain('5534')
    expect(m.instanceId).toBe('NEBULA-AER3B')
  })

  test('inbound de grupo preserva JID @g.us e participante', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'wamid.g', from_me: false, type: 'text', chat_id: '120363999@g.us', from: '5534988887777@s.whatsapp.net', text: { body: 'grupo' }, timestamp: 1700000000 },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(m.isGroup).toBe(true)
    expect(m.remoteJid).toBe('120363999@g.us')
    expect(m.participantPhone).toBe('5534988887777')
  })

  test('fromMe (eco do CRM/celular) marcado corretamente e sem senderName', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'wamid.me', from_me: true, type: 'text', chat_id: '5534988887777@s.whatsapp.net', from_name: 'Nosso', text: { body: 'resposta' }, timestamp: 1700000000 },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(m.fromMe).toBe(true)
    expect(m.senderName).toBeNull()
  })

  test('status ACK mapeia status+code sem inventar referenceId', () => {
    const s = controller._test.normalizeWhapiStatusToInternal(
      { id: 'p.w30M7fgwWD4XwHu.g4CA-gBgTwl0rVw', code: 4, status: 'read', recipient_id: '5534988887777@s.whatsapp.net' },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(s.status).toBe('read')
    expect(s.type).toBe('MessageStatusCallback')
    expect(s.id).toBe('p.w30M7fgwWD4XwHu.g4CA-gBgTwl0rVw')
    expect(s.referenceId).toBeNull()
    expect(s.ids).toEqual(['p.w30M7fgwWD4XwHu.g4CA-gBgTwl0rVw'])
  })

  test('inbound imagem mapeia image.link; voz mapeia voice.link', () => {
    const img = controller._test.normalizeWhapiMessageToInternal(
      { id: 'img.1', from_me: false, type: 'image', chat_id: '5534988887777@s.whatsapp.net', image: { link: 'https://cdn.example/a.jpg', caption: 'foto' }, timestamp: 1700000000 },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(img.type).toBe('image')
    expect(img.imageUrl).toBe('https://cdn.example/a.jpg')
    expect(img.caption).toBe('foto')
    const voice = controller._test.normalizeWhapiMessageToInternal(
      { id: 'v.1', from_me: false, type: 'voice', chat_id: '5534988887777@s.whatsapp.net', voice: { link: 'https://cdn.example/a.oga', mime_type: 'audio/ogg; codecs=opus' }, timestamp: 1700000000 },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(voice.type).toBe('audio')
    expect(voice.audioUrl).toBe('https://cdn.example/a.oga')
  })

  test('reação oficial é type=action + action.type=reaction', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'r.1', from_me: false, type: 'action', chat_id: '5534988887777@s.whatsapp.net', action: { type: 'reaction', target: 'yqJRppZk7BI-wNoTwl0rVw', emoji: '👍' }, timestamp: 1700000000 },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(m.type).toBe('reaction')
    expect(m.reaction.emoji).toBe('👍')
    expect(m.reaction.messageId).toBe('yqJRppZk7BI-wNoTwl0rVw')
  })

  test('action que não é reação é ignorada', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'a.1', type: 'action', chat_id: '120363999@g.us', action: { type: 'media_notify' }, timestamp: 1700000000 },
      { channelId: 'NEBULA-AER3B' }
    )
    expect(m).toBeNull()
  })

  test('handle despacha messages→receberZapi e statuses→statusZapi, responde 200 uma vez', async () => {
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, provider_instance_id: 'NEBULA-AER3B', connected_phone: '553433334444' },
      body: {
        channel_id: 'NEBULA-AER3B',
        messages: [{ id: 'wamid.1', from_me: false, type: 'text', chat_id: '5534988887777@s.whatsapp.net', text: { body: 'oi' }, timestamp: 1700000000 }],
        statuses: [{ id: 'wamid.1', status: 'delivered' }],
      },
    }
    // snapshot do body no momento da chamada (o handler reusa o mesmo req e muta body entre itens)
    let recSnap = null
    receberZapi.mockImplementation(async (rq, rs) => { recSnap = { type: rq.body.type, id: rq.body.id }; return rs.status(200).json({ ok: true }) })
    const res = fakeRes()
    await controller.handleWebhookWhapi(req, res)
    expect(receberZapi).toHaveBeenCalledTimes(1)
    expect(statusZapi).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
    expect(recSnap.type).toBe('ReceivedCallback')
    expect(recSnap.id).toBe('wamid.1')
  })

  test('from_me (eco de mensagem enviada) também despacha para receberZapi', async () => {
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, provider_instance_id: 'NEBULA-AER3B' },
      body: {
        channel_id: 'NEBULA-AER3B',
        messages: [{
          id: 'wamid.out',
          from_me: true,
          type: 'text',
          chat_id: '5534988887777@s.whatsapp.net',
          text: { body: 'enviada pelo crm' },
          timestamp: 1700000000,
        }],
      },
    }
    let snap = null
    receberZapi.mockImplementation(async (rq, rs) => {
      snap = { fromMe: rq.body.fromMe, type: rq.body.type, id: rq.body.id }
      return rs.status(200).json({ ok: true })
    })
    const res = fakeRes()
    await controller.handleWebhookWhapi(req, res)
    expect(receberZapi).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
    expect(snap.fromMe).toBe(true)
    expect(snap.type).toBe('ReceivedCallback')
    expect(snap.id).toBe('wamid.out')
  })

  test('sem company_id no contexto → 200 e não despacha', async () => {
    const req = { method: 'POST', webhookContext: { company_id: null }, body: { channel_id: 'X', messages: [{ id: 'a', type: 'text', text: { body: 'x' } }] } }
    const res = fakeRes()
    await controller.handleWebhookWhapi(req, res)
    expect(receberZapi).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
  })

  test('erro interno no inbound → 500 (reentrega), idempotência protege', async () => {
    receberZapi.mockImplementationOnce(async () => { throw new Error('db down') })
    const req = {
      method: 'POST',
      webhookContext: { company_id: 1, provider_instance_id: 'NEBULA-AER3B' },
      body: { channel_id: 'NEBULA-AER3B', messages: [{ id: 'wamid.x', type: 'text', chat_id: '5534988887777@s.whatsapp.net', text: { body: 'oi' } }] },
    }
    const res = fakeRes()
    await controller.handleWebhookWhapi(req, res)
    expect(res.statusCode).toBe(500)
  })
})
