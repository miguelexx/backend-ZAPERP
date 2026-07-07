const {
  applyAguardandoAtendenteModoSimplesQuery,
  rowAguardandoAtendenteModoSimples,
} = require('../helpers/modoSimplesGrupoUnread')

describe('modoSimplesGrupoUnread', () => {
  describe('rowAguardandoAtendenteModoSimples', () => {
    it('grupo entra na fila só com unread > 0', () => {
      expect(rowAguardandoAtendenteModoSimples({ tipo: 'grupo' }, 2)).toBe(true)
      expect(rowAguardandoAtendenteModoSimples({ tipo: 'grupo' }, 0)).toBe(false)
    })

    it('individual usa modo_simples_aguardando', () => {
      expect(
        rowAguardandoAtendenteModoSimples({ tipo: null, modo_simples_aguardando: 'atendente' }, 0)
      ).toBe(true)
      expect(
        rowAguardandoAtendenteModoSimples({ tipo: null, modo_simples_aguardando: 'cliente' }, 5)
      ).toBe(false)
    })
  })

  describe('applyAguardandoAtendenteModoSimplesQuery', () => {
    it('monta OR com grupos não lidos quando houver ids', () => {
      const calls = []
      const q = {
        or(expr) {
          calls.push(expr)
          return q
        },
        eq() {
          return q
        },
      }
      applyAguardandoAtendenteModoSimplesQuery(q, [10, 20])
      expect(calls[0]).toContain('modo_simples_aguardando.eq.atendente')
      expect(calls[0]).toContain('id.in.(10,20)')
    })
  })
})
