const {
  atendentePodeVerNumero,
  aplicarFiltroNumerosPermitidos,
} = require('../services/chat/access/usuarioWhatsappInstanceAccessRules')

function fakeQuery() {
  const calls = []
  return {
    calls,
    in(column, values) {
      calls.push(['in', column, values])
      return this
    },
  }
}

test('sem marcação o atendente continua vendo o número', () => {
  expect(atendentePodeVerNumero(null, 4)).toBe(true)
  expect(atendentePodeVerNumero(undefined, null)).toBe(true)
})

test('com marcação só vê os números escolhidos, inclusive grupo do mesmo número', () => {
  const permitidas = new Set([8, 9])
  expect(atendentePodeVerNumero(permitidas, 8)).toBe(true)
  expect(atendentePodeVerNumero(permitidas, 3)).toBe(false)
  expect(atendentePodeVerNumero(permitidas, null)).toBe(false)
})

test('query sem trava não ganha filtro extra', () => {
  const q = fakeQuery()
  aplicarFiltroNumerosPermitidos(q, null, null)
  expect(q.calls).toEqual([])
})

test('query com trava limita whatsapp_instance_id', () => {
  const q = fakeQuery()
  aplicarFiltroNumerosPermitidos(q, new Set([2, 5]), null)
  expect(q.calls).toEqual([['in', 'whatsapp_instance_id', [2, 5]]])
})

test('filtro manual de um número bloqueado esvazia a lista', () => {
  const q = fakeQuery()
  aplicarFiltroNumerosPermitidos(q, new Set([2]), 7)
  expect(q.calls).toEqual([['in', 'id', [0]]])
})

test('filtro manual de um número liberado não duplica a trava', () => {
  const q = fakeQuery()
  aplicarFiltroNumerosPermitidos(q, new Set([2]), 2)
  expect(q.calls).toEqual([])
})
