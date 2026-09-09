const supabase = require('../config/supabase')
const { marcarComoLidaPorUsuario } = require('../services/chat/unread/conversationUnreadService')
test.each(['conversa_unreads', 'conversas'])('erro retornado em %s não confirma leitura', async (tableWithError) => {
  supabase.from.mockImplementation(table => {
    const q = { update: jest.fn(() => q), eq: jest.fn(() => q),
      then: (ok, fail) => Promise.resolve({ error: table === tableWithError ? { message: 'Banco indisponível' } : null }).then(ok, fail) }
    return q
  })
  await expect(marcarComoLidaPorUsuario({ company_id: 1, conversa_id: 2, usuario_id: 3 })).rejects.toEqual({ message: 'Banco indisponível' })
})
