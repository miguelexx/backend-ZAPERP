/**
 * As travas do grupo apareciam DESLIGADAS na tela mesmo estando ligadas no WhatsApp.
 *
 * `mapSettings` lia `announce`, `restrict` e `approve_participants`, que não existem na resposta
 * da Whapi. Os nomes reais, conferidos no canal em 10/11/2026 (GET /groups/{id}):
 *   {"announcements":true,"restricted":true,"adminAddMemberMode":true,"joinApprovalMode":true}
 *
 * Isso importa porque com `joinApprovalMode` ligado o WhatsApp NÃO deixa adicionar participante
 * direto — a adição vira convite. O atendente via "1 falha" sem entender o porquê, e a tela
 * ainda informava que a opção estava desligada.
 */

jest.mock('../config/supabase', () => ({ from: jest.fn() }))

const { _test: { mapSettings } } = require('../controllers/chat/groupAdminController')

describe('mapSettings — nomes reais dos campos da Whapi', () => {
  test('resposta REAL do canal: as quatro travas ligadas são reconhecidas', () => {
    expect(mapSettings({
      announcements: true,
      restricted: true,
      adminAddMemberMode: true,
      joinApprovalMode: true,
    })).toEqual({
      send_messages: 'admins',
      edit_group_info: 'admins',
      add_participants: 'admins',
      approve_participants: 'admins',
    })
  })

  test('grupo liberado: tudo "anyone"', () => {
    expect(mapSettings({
      announcements: false,
      restricted: false,
      adminAddMemberMode: false,
      joinApprovalMode: false,
    })).toEqual({
      send_messages: 'anyone',
      edit_group_info: 'anyone',
      add_participants: 'anyone',
      approve_participants: 'anyone',
    })
  })

  test('campo ausente não inventa trava (grupo da empresa 4 vinha sem `restricted`)', () => {
    const r = mapSettings({ announcements: true, adminAddMemberMode: true, joinApprovalMode: true })
    expect(r.edit_group_info).toBe('anyone')
    expect(r.approve_participants).toBe('admins')
  })

  test('nomes antigos seguem funcionando (compatibilidade)', () => {
    expect(mapSettings({ announce: true, restrict: true }).send_messages).toBe('admins')
    expect(mapSettings({ announce: true, restrict: true }).edit_group_info).toBe('admins')
    expect(mapSettings({ member_add_mode: 'admin_approval' }).approve_participants).toBe('admins')
  })

  test('sem dados: nada bloqueado', () => {
    expect(mapSettings(null).approve_participants).toBe('anyone')
  })
})
