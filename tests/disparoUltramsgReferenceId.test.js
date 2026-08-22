/**
 * Testes — message_ack preserva referenceId disp-{id}.
 */

const { _test } = require('../controllers/webhookUltramsgController')
const { normalizeUltramsgToZapi } = _test

describe('webhookUltramsg — referenceId disp-N em message_ack', () => {
  it('preserva referenceId no body raiz', () => {
    const body = {
      event_type: 'message_ack',
      instanceId: '51534',
      referenceId: 'disp-10042',
      data: {
        id: '35096',
        ack: 'device',
        status: 'device',
      },
    }

    const normalized = normalizeUltramsgToZapi(body)

    expect(normalized.referenceId).toBe('disp-10042')
    expect(normalized.ultramsgReferenceId).toBe('disp-10042')
    expect(normalized.messageId).toBe('35096')
    expect(normalized.ids).toEqual(['35096'])
    expect(normalized.status).toBe('delivered')
  })

  it('preserva referenceId em data.referenceId quando ausente no raiz', () => {
    const body = {
      event_type: 'webhook_message_ack',
      instanceId: '51534',
      data: {
        id: 'msg-777',
        referenceId: 'disp-999',
        ack: 3,
      },
    }

    const normalized = normalizeUltramsgToZapi(body)

    expect(normalized.referenceId).toBe('disp-999')
    expect(normalized.ultramsgReferenceId).toBe('disp-999')
    expect(normalized.status).toBe('read')
  })

  it('aceita ultramsgReferenceId como fallback', () => {
    const body = {
      event_type: 'message_ack',
      instanceId: '51534',
      data: {
        id: 'abc',
        ultramsgReferenceId: 'disp-55',
        ack: 'server',
      },
    }

    const normalized = normalizeUltramsgToZapi(body)

    expect(normalized.referenceId).toBe('disp-55')
    expect(normalized.ultramsgReferenceId).toBe('disp-55')
    expect(normalized.status).toBe('sent')
  })

  it('referenceId null quando não informado', () => {
    const body = {
      event_type: 'message_ack',
      instanceId: '51534',
      data: { id: 'xyz', ack: 'pending' },
    }

    const normalized = normalizeUltramsgToZapi(body)

    expect(normalized.referenceId).toBeNull()
    expect(normalized.ultramsgReferenceId).toBeNull()
  })
})
