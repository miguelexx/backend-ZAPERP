/**
 * Webhook Whapi — evento `chats` método `delete` (conversa apagada no WhatsApp).
 *
 * Contrato oficial Whapi (verificado 2026-10-19):
 *   { chats_removed: ["<jid>"], event: { type: 'chats', event: 'delete' }, channel_id }
 *
 * Aqui cobrimos a EXTRAÇÃO e o roteamento: `chats.post` (chat novo) e `chats.patch`
 * (pin/mute/label) jamais podem ser lidos como exclusão — isso apagaria conversa viva.
 * A aplicação no banco é testada em exclusaoConversaSincronizacaoWhatsapp.test.js.
 */

describe('Whapi webhook — chats_removed (chat apagado no celular)', () => {
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

  test('extrai chats_removed do payload oficial de delete', () => {
    const out = controller._test.extractChatsRemoved({
      chats_removed: ['919984351847@s.whatsapp.net'],
      event: { type: 'chats', event: 'delete' },
      channel_id: 'NEBULA-AER3B',
    })
    expect(out).toEqual(['919984351847@s.whatsapp.net'])
  })

  test('chats.post (chat NOVO) não é exclusão', () => {
    const out = controller._test.extractChatsRemoved({
      chats: [{ id: '919984351847@s.whatsapp.net', type: 'contact' }],
      event: { type: 'chats', event: 'post' },
    })
    expect(out).toEqual([])
  })

  test('chats.patch (pin/mute/label) não é exclusão nem com chats_removed presente', () => {
    const out = controller._test.extractChatsRemoved({
      chats_updates: [{ changes: ['mute'] }],
      chats_removed: ['919984351847@s.whatsapp.net'],
      event: { type: 'chats', event: 'patch' },
    })
    expect(out).toEqual([])
  })

  test('evento de outro tipo (messages.delete) não vira exclusão de chat', () => {
    const out = controller._test.extractChatsRemoved({
      chats_removed: ['919984351847@s.whatsapp.net'],
      event: { type: 'messages', event: 'delete' },
    })
    expect(out).toEqual([])
  })

  test('tolera string única e descarta valores vazios', () => {
    expect(controller._test.extractChatsRemoved({ chats_removed: '5534999887766@s.whatsapp.net' }))
      .toEqual(['5534999887766@s.whatsapp.net'])
    expect(controller._test.extractChatsRemoved({ chats_removed: ['', null, '  '] })).toEqual([])
    expect(controller._test.extractChatsRemoved({})).toEqual([])
  })

  test('extractEvents devolve chatsRemoved junto dos outros arrays', () => {
    const ev = controller._test.extractEvents({
      chats_removed: ['5534999887766@s.whatsapp.net'],
      event: { type: 'chats', event: 'delete' },
    })
    expect(ev.chatsRemoved).toEqual(['5534999887766@s.whatsapp.net'])
    expect(ev.messages).toEqual([])
    expect(ev.statuses).toEqual([])
  })

  test('applyWhapiRemovedChats passa tenant e instância DO CANAL (nunca do corpo)', async () => {
    const aplicarExclusaoRemotaEmLote = jest.fn().mockResolvedValue({ aplicadas: [5], ignorados: {} })
    jest.doMock('../services/chat/sync/chatDeletionSyncService', () => ({ aplicarExclusaoRemotaEmLote }))
    jest.resetModules()
    jest.doMock('../controllers/webhookZapiController', () => ({ receberZapi: jest.fn(), statusZapi: jest.fn() }))
    jest.doMock('../services/chat/sync/chatDeletionSyncService', () => ({ aplicarExclusaoRemotaEmLote }))
    const ctl = require('../controllers/webhookWhapiController')

    const io = { to: jest.fn(() => ({ emit: jest.fn() })) }
    await ctl._test.applyWhapiRemovedChats(
      { company_id: 42, whatsapp_instance_id: 7 },
      ['5534999887766@s.whatsapp.net'],
      io,
    )
    expect(aplicarExclusaoRemotaEmLote).toHaveBeenCalledWith(expect.objectContaining({
      company_id: 42,
      whatsapp_instance_id: 7,
      origem: 'whatsapp',
    }))
  })

  test('lista vazia não chama o serviço', async () => {
    const r = await controller._test.applyWhapiRemovedChats({ company_id: 1, whatsapp_instance_id: 2 }, [], null)
    expect(r).toEqual({ aplicadas: [], ignorados: {} })
  })
})
