/**
 * Contrato JID Whapi (MCP sendMessageText / OpenAPI ChatID).
 * @c.us é UltraMSG — o adapter não pode mandar isso cru para /chats/{id} nem /messages/list/{id}.
 */

const {
  toWhapiRecipient,
  toWhapiChatId,
  toWhapiContactId,
  toWhapiGroupId,
  isGroupJid,
} = require('../services/providers/whapi/phones')

describe('whapi/phones — JID Whapi vs UltraMSG', () => {
  test('grupo @g.us é preservado', () => {
    expect(isGroupJid('120363012345678901@g.us')).toBe(true)
    expect(toWhapiChatId('120363012345678901@g.us')).toBe('120363012345678901@g.us')
    expect(toWhapiRecipient('120363012345678901@g.us')).toBe('120363012345678901@g.us')
  })

  test('privado em dígitos vira ChatID @s.whatsapp.net; envio é só dígitos', () => {
    const chatId = toWhapiChatId('553499911246')
    expect(chatId).toMatch(/@s\.whatsapp\.net$/)
    expect(chatId).not.toMatch(/@c\.us/)
    expect(toWhapiRecipient('553499911246')).toMatch(/^\d+$/)
  })

  test('@c.us UltraMSG é convertido — não vai cru para a Whapi', () => {
    expect(toWhapiChatId('553499911246@c.us')).toMatch(/@s\.whatsapp\.net$/)
    expect(toWhapiChatId('553499911246@c.us')).not.toMatch(/@c\.us/)
    expect(toWhapiRecipient('553499911246@c.us')).toMatch(/^\d+$/)
    expect(toWhapiContactId('553499911246@c.us')).toMatch(/^\d+$/)
  })

  test('@lid privado é preservado', () => {
    expect(toWhapiChatId('123456789012345@lid')).toBe('123456789012345@lid')
  })

  test('toWhapiGroupId: dígitos, hífen legado e rejeita grupo_ fake', () => {
    expect(toWhapiGroupId('120363426760868023')).toBe('120363426760868023@g.us')
    expect(toWhapiGroupId('553484080098-1406738663')).toBe('553484080098-1406738663@g.us')
    expect(toWhapiGroupId('grupo_1')).toBe('')
  })
})
