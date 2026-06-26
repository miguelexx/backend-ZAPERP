const { chooseBestName } = require('../helpers/contactEnrichment')
const { getCanonicalPhone } = require('../helpers/conversationSync')

describe('cadastro manual de contato — nome e telefone', () => {
  it('prioriza nome digitado manualmente sobre nome já salvo', () => {
    const { name, decision } = chooseBestName('Maria Antiga', 'João Silva', 'manual')
    expect(name).toBe('João Silva')
    expect(decision).toBe('updated')
  })

  it('salva nome manual quando o contato ainda não tem nome', () => {
    const { name, decision } = chooseBestName(null, 'Cliente Novo', 'manual')
    expect(name).toBe('Cliente Novo')
    expect(decision).toBe('updated')
  })

  it('normaliza telefone mascarado para formato canônico BR', () => {
    expect(getCanonicalPhone('(11) 98765-4321')).toBe('5511987654321')
    expect(getCanonicalPhone('+55 11 98765-4321')).toBe('5511987654321')
    expect(getCanonicalPhone('11987654321')).toBe('5511987654321')
  })

  it('rejeita telefone inválido no cadastro manual', () => {
    expect(getCanonicalPhone('123')).toBe('')
    expect(getCanonicalPhone('')).toBe('')
  })
})
