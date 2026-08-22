/**
 * Testes unitários — referência disp-{filaItemId} (Etapa 7).
 */

const {
  buildDispReferenceId,
  parseDispReferenceId,
} = require('../helpers/disparoReferenceHelper')

describe('disparoReferenceHelper', () => {
  describe('buildDispReferenceId', () => {
    it('gera disp-{id} para inteiros positivos', () => {
      expect(buildDispReferenceId(42)).toBe('disp-42')
      expect(buildDispReferenceId('99')).toBe('disp-99')
    })

    it('retorna null para ids inválidos', () => {
      expect(buildDispReferenceId(0)).toBeNull()
      expect(buildDispReferenceId(-1)).toBeNull()
      expect(buildDispReferenceId(1.5)).toBeNull()
      expect(buildDispReferenceId(null)).toBeNull()
      expect(buildDispReferenceId(undefined)).toBeNull()
      expect(buildDispReferenceId('abc')).toBeNull()
    })
  })

  describe('parseDispReferenceId', () => {
    it('extrai id de disp-{n}', () => {
      expect(parseDispReferenceId('disp-42')).toBe(42)
      expect(parseDispReferenceId('  disp-1001  ')).toBe(1001)
    })

    it('retorna null para formatos inválidos', () => {
      expect(parseDispReferenceId('disp-')).toBeNull()
      expect(parseDispReferenceId('disp-0')).toBeNull()
      expect(parseDispReferenceId('disp-abc')).toBeNull()
      expect(parseDispReferenceId('msg-42')).toBeNull()
      expect(parseDispReferenceId('')).toBeNull()
      expect(parseDispReferenceId(null)).toBeNull()
    })
  })

  describe('round-trip', () => {
    it('build → parse recupera o id original', () => {
      const ids = [1, 7, 999, 123456]
      for (const id of ids) {
        const ref = buildDispReferenceId(id)
        expect(parseDispReferenceId(ref)).toBe(id)
      }
    })
  })
})
