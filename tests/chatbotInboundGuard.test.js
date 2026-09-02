/**
 * Chatbot/URA: só dispara boas-vindas para mensagem real do contato na conversa privada.
 * Cobre a origem do chat (não o telefone do participant) e o pipeline UltraMSG → extract → guarda.
 */

const { shouldTriggerChatbotForInbound, inspectInboundOrigin } = require('../controllers/webhookInbound/chatbotInboundGuard')
const { extractMessage } = require('../controllers/webhookInbound/payload')
const { _test } = require('../controllers/webhookUltramsgController')
const { normalizeUltramsgToZapi } = _test

function pipeline(ultramsgBody) {
  const normalized = normalizeUltramsgToZapi(ultramsgBody)
  const payload = { ...normalized, type: 'ReceivedCallback', instanceId: ultramsgBody.instanceId }
  const extracted = extractMessage(payload)
  const eligibility = shouldTriggerChatbotForInbound({
    fromMe: extracted.fromMe,
    isGroup: extracted.isGroup,
    type: extracted.type,
    phone: extracted.phone,
    payload,
  })
  return { normalized, extracted, eligibility }
}

describe('shouldTriggerChatbotForInbound — guarda pura', () => {
  test('mensagem privada de texto → pode acionar chatbot', () => {
    const r = shouldTriggerChatbotForInbound({
      fromMe: false,
      isGroup: false,
      type: 'text',
      phone: '5534999999999',
      payload: { phone: '5534999999999', fromMe: false },
    })
    expect(r).toEqual({ ok: true, reason: 'private_customer_message' })
  })

  test('áudio/imagem/vídeo/documento privados → podem acionar chatbot', () => {
    for (const type of ['audio', 'image', 'video', 'document']) {
      const r = shouldTriggerChatbotForInbound({
        fromMe: false,
        isGroup: false,
        type,
        phone: '5534999999999',
        payload: { phone: '5534999999999', type },
      })
      expect(r.ok).toBe(true)
    }
  })

  test('fromMe → não aciona', () => {
    expect(shouldTriggerChatbotForInbound({
      fromMe: true, isGroup: false, type: 'text', phone: '5534999999999', payload: { fromMe: true },
    }).reason).toBe('from_me')
  })

  test('isGroup → não aciona', () => {
    expect(shouldTriggerChatbotForInbound({
      fromMe: false, isGroup: true, type: 'text', phone: '120363123456789012', payload: { isGroup: true },
    }).reason).toBe('group')
  })

  test('reação com emoji (privada) → não aciona', () => {
    expect(shouldTriggerChatbotForInbound({
      fromMe: false,
      isGroup: false,
      type: 'reaction',
      phone: '5534999999999',
      payload: { phone: '5534999999999', reaction: { value: '👍' } },
    }).reason).toBe('reaction')
  })

  test('ACK/sistema → não aciona', () => {
    expect(shouldTriggerChatbotForInbound({
      fromMe: false, isGroup: false, type: 'protocol', phone: '5534999999999', payload: {},
    }).reason).toBe('system_or_ack')
  })

  test('não usa telefone do participant como origem privada quando o chat é grupo', () => {
    const payload = {
      phone: '5534999999999',
      participantPhone: '5534999999999',
      fromMe: false,
      reaction: { value: '👍' },
      quotedMsg: { from: '120363411111111111-5534984080098@g.us' },
    }
    const origin = inspectInboundOrigin(payload)
    expect(origin.isGroup).toBe(true)
    expect(origin.isReaction).toBe(true)
    expect(shouldTriggerChatbotForInbound({
      fromMe: false, isGroup: false, type: 'reaction', phone: '5534999999999', payload,
    }).ok).toBe(false)
  })

  test('Status @broadcast → não aciona mesmo se phone for o participant', () => {
    const payload = {
      phone: '5534999999999',
      to: 'status@broadcast',
      fromMe: false,
      reaction: { value: '❤️' },
    }
    expect(inspectInboundOrigin(payload).isStatusBroadcast).toBe(true)
    expect(shouldTriggerChatbotForInbound({
      fromMe: false, isGroup: false, type: 'reaction', phone: '5534999999999', payload,
    }).reason).toBe('status_broadcast')
  })
})

describe('pipeline UltraMSG → extract → chatbot: origem real do chat', () => {
  const OUR = '5534888888888@c.us'
  const CONTACT = '5534999999999@c.us'
  const GROUP = '120363411111111111-5534984080098@g.us'

  test('mensagem privada de texto → chatbot elegível', () => {
    const { extracted, eligibility } = pipeline({
      event_type: 'message_received',
      instanceId: '51534',
      data: {
        from: CONTACT,
        to: OUR,
        fromMe: false,
        type: 'chat',
        body: 'oi',
        id: 'false_5534999999999@c.us_AAAA',
      },
    })
    expect(extracted.isGroup).toBe(false)
    expect(extracted.fromMe).toBe(false)
    expect(extracted.type).toBe('text')
    expect(extracted.phone).toMatch(/5534999999999/)
    expect(eligibility.ok).toBe(true)
  })

  test('áudio privado → chatbot elegível', () => {
    const { extracted, eligibility } = pipeline({
      event_type: 'message_received',
      instanceId: '51534',
      data: {
        from: CONTACT,
        to: OUR,
        fromMe: false,
        type: 'audio',
        media: 'https://example.com/a.ogg',
        id: 'false_5534999999999@c.us_AUDIO',
      },
    })
    expect(extracted.isGroup).toBe(false)
    expect(extracted.type).toBe('audio')
    expect(eligibility.ok).toBe(true)
  })

  test('imagem privada → chatbot elegível', () => {
    const { extracted, eligibility } = pipeline({
      event_type: 'message_received',
      instanceId: '51534',
      data: {
        from: CONTACT,
        to: OUR,
        fromMe: false,
        type: 'image',
        media: 'https://example.com/a.jpg',
        id: 'false_5534999999999@c.us_IMG',
      },
    })
    expect(extracted.type).toBe('image')
    expect(eligibility.ok).toBe(true)
  })

  test('reação em grupo (from=participant, to=empresa, quotedMsg=@g.us) → NÃO trata participant como privado', () => {
    const { normalized, extracted, eligibility } = pipeline({
      event_type: 'message_reaction',
      instanceId: '51534',
      data: {
        from: CONTACT,
        to: OUR,
        fromMe: false,
        type: 'reaction',
        body: '👍',
        id: 'false_5534999999999@c.us_REACTG',
        quotedMsg: { from: GROUP, id: 'orig-msg' },
      },
    })
    expect(normalized.isGroup).toBe(true)
    expect(normalized.phone).toContain('@g.us')
    expect(extracted.isGroup).toBe(true)
    expect(eligibility.ok).toBe(false)
    expect(['group', 'group_origin', 'reaction']).toContain(eligibility.reason)
  })

  test('reação em Status (to=status@broadcast) → NÃO usa phone do participant como conversa privada', () => {
    const { normalized, extracted, eligibility } = pipeline({
      event_type: 'message_reaction',
      instanceId: '51534',
      data: {
        from: CONTACT,
        to: 'status@broadcast',
        fromMe: false,
        type: 'reaction',
        body: '❤️',
        id: 'false_5534999999999@c.us_REACTS',
      },
    })
    expect(normalized.isStatusBroadcast).toBe(true)
    expect(String(normalized.phone).toLowerCase()).toContain('broadcast')
    expect(extracted.phone).toBe('')
    expect(eligibility.ok).toBe(false)
    expect(eligibility.reason).toBe('status_broadcast')
  })

  test('mensagem de texto em grupo (to=@g.us) → chatbot não elegível', () => {
    const { extracted, eligibility } = pipeline({
      event_type: 'message_received',
      instanceId: '51534',
      data: {
        from: CONTACT,
        to: GROUP,
        author: CONTACT,
        fromMe: false,
        type: 'chat',
        body: 'fala galera',
        id: 'false_120363@g.us_G1',
      },
    })
    expect(extracted.isGroup).toBe(true)
    expect(eligibility.ok).toBe(false)
  })

  test('fromMe privado → chatbot não elegível', () => {
    const { extracted, eligibility } = pipeline({
      event_type: 'message_create',
      instanceId: '51534',
      data: {
        from: OUR,
        to: CONTACT,
        fromMe: true,
        type: 'chat',
        body: 'enviado por nós',
        id: 'true_5534999999999@c.us_OUT',
      },
    })
    expect(extracted.fromMe).toBe(true)
    expect(eligibility.ok).toBe(false)
    expect(eligibility.reason).toBe('from_me')
  })
})
