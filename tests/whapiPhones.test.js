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
    expect(toWhapiRecipient('123456789012345@lid')).toBe('123456789012345@lid')
    expect(toWhapiRecipient('lid:123456789012345')).toBe('123456789012345@lid')
    expect(toWhapiChatId('lid:123456789012345')).toBe('123456789012345@lid')
  })

  test('celular BR de 12 dígitos (sem 9º) envia com o 9 — preferredBrSendDigits é string', () => {
    // 55 34 8888-7777 (local começa em 8 = celular). Sem o 9 a Whapi recusa / entrega errado.
    expect(toWhapiRecipient('553488887777')).toBe('5534988887777')
  })

  test('wa_id explicito e canonico: remove o sufixo sem reescrever os digitos', () => {
    // O checkPhones pode devolver a identidade legada sem o 9. Reinseri-lo recria o incidente.
    expect(toWhapiRecipient('553496616106@c.us')).toBe('553496616106')
    expect(toWhapiRecipient('553496616106@s.whatsapp.net')).toBe('553496616106')
  })

  test('grupo gravado só com dígitos 120… vira @g.us no envio (conversas.telefone)', () => {
    expect(toWhapiRecipient('120363426760868023')).toBe('120363426760868023@g.us')
    expect(toWhapiChatId('120363426760868023')).toBe('120363426760868023@g.us')
  })

  test('telefone privado NÃO é tratado como grupo', () => {
    expect(toWhapiGroupId('553499911246')).toBe('')
    expect(toWhapiGroupId('5534988887777')).toBe('')
    // 12 dígitos (celular sem 9º) → envio com 9; não vira @g.us
    expect(toWhapiRecipient('553499911246')).toBe('5534999911246')
    expect(toWhapiRecipient('5534988887777')).toBe('5534988887777')
  })

  test('toWhapiGroupId: dígitos, hífen legado e rejeita grupo_ fake', () => {
    expect(toWhapiGroupId('120363426760868023')).toBe('120363426760868023@g.us')
    expect(toWhapiGroupId('553484080098-1406738663')).toBe('553484080098-1406738663@g.us')
    expect(toWhapiGroupId('grupo_1')).toBe('')
  })
})
