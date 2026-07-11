const {
  empresaRoom,
  usuarioRoom,
  conversaRoom,
  departamentoRoom,
} = require('../helpers/socketRooms')

describe('socketRooms', () => {
  test('departamento inclui empresa para evitar colisao cross-tenant', () => {
    expect(departamentoRoom(7, 12)).toBe('empresa_7_departamento_12')
    expect(departamentoRoom(8, 12)).toBe('empresa_8_departamento_12')
  })

  test('rooms retornam null para IDs invalidos', () => {
    expect(empresaRoom(null)).toBeNull()
    expect(usuarioRoom(0)).toBeNull()
    expect(conversaRoom('abc')).toBeNull()
    expect(departamentoRoom(1, null)).toBeNull()
  })
})
