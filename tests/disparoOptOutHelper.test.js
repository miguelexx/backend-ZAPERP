/**
 * Testes unitários — detecção de opt-out (Etapa 8).
 */

const {
  DEFAULT_PALAVRAS,
  normalizeOptOutCommand,
  isExactOptOutCommand,
  removeAccents,
} = require('../helpers/disparoOptOutHelper')

describe('disparoOptOutHelper — normalizeOptOutCommand', () => {
  it('trim, lower e remove acentos', () => {
    expect(normalizeOptOutCommand('  CANCELAR  ')).toBe('cancelar')
    expect(normalizeOptOutCommand('SÁIR')).toBe('sair')
    expect(removeAccents('PARÁR')).toBe('PARAR')
  })

  it('remove pontuação final', () => {
    expect(normalizeOptOutCommand('PARAR!!!')).toBe('parar')
    expect(normalizeOptOutCommand('SAIR?')).toBe('sair')
    expect(normalizeOptOutCommand('STOP…')).toBe('stop')
  })

  it('texto vazio → string vazia', () => {
    expect(normalizeOptOutCommand('')).toBe('')
    expect(normalizeOptOutCommand(null)).toBe('')
  })
})

describe('disparoOptOutHelper — isExactOptOutCommand', () => {
  it('match exato das palavras padrão', () => {
    for (const palavra of DEFAULT_PALAVRAS) {
      expect(isExactOptOutCommand(palavra)).toBe(true)
      expect(isExactOptOutCommand(palavra.toLowerCase())).toBe(true)
    }
  })

  it('case insensitive', () => {
    expect(isExactOptOutCommand('sair')).toBe(true)
    expect(isExactOptOutCommand('SaIr')).toBe(true)
    expect(isExactOptOutCommand('stop')).toBe(true)
  })

  it('aceita acentos e pontuação final', () => {
    expect(isExactOptOutCommand('  SÁIR!!!  ')).toBe(true)
    expect(isExactOptOutCommand('Cancelar?')).toBe(true)
  })

  it('NÃO é substring — frases com palavra embutida', () => {
    expect(isExactOptOutCommand('quero sair')).toBe(false)
    expect(isExactOptOutCommand('por favor parar')).toBe(false)
    expect(isExactOptOutCommand('não quero mais, cancelar tudo')).toBe(false)
    expect(isExactOptOutCommand('STOP spam')).toBe(false)
    expect(isExactOptOutCommand('SAIR da lista por favor')).toBe(false)
  })

  it('NÃO confunde palavras parecidas', () => {
    expect(isExactOptOutCommand('pararar')).toBe(false)
    expect(isExactOptOutCommand('stopped')).toBe(false)
    expect(isExactOptOutCommand('cancel')).toBe(false)
  })

  it('respeita lista customizada de palavras', () => {
    expect(isExactOptOutCommand('descadastrar', ['DESCADASTRAR'])).toBe(true)
    expect(isExactOptOutCommand('sair', ['DESCADASTRAR'])).toBe(false)
  })
})
