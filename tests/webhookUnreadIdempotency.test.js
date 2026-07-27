const fs = require('fs')
const path = require('path')

describe('webhook unread idempotency contract', () => {
  test('incrementa unread apenas quando mensagem foi inserida pelo webhook', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../controllers/webhookZapiController.js'),
      'utf8'
    )

    // Contrato: reentrega com o mesmo whatsapp_id não pode inflar unread.
    expect(src).toMatch(/if\s*\(\s*!fromMe\s*&&\s*mensagemFoiInseridaPeloWebhook\s*\)/)
    expect(src).not.toMatch(/if\s*\(\s*!fromMe\s*\)\s*\{\s*\n\s*await incrementarUnreadParaConversa/)
  })
})
