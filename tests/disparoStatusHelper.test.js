/**
 * Smoke — disparoStatusHelper
 */
const {
  statusPermiteEdicao,
  statusEstaCongelado,
  statusPermiteVoltarEdicao,
  mensagemBloqueioEdicao,
  STATUS_TODOS,
} = require('../helpers/disparoStatusHelper')

describe('disparoStatusHelper smoke', () => {
  it('pronta está no conjunto completo', () => {
    expect(STATUS_TODOS.has('pronta')).toBe(true)
  })

  it('mensagem de bloqueio para pronta menciona congelada', () => {
    expect(mensagemBloqueioEdicao('pronta')).toMatch(/congelada|Voltar para edição/i)
  })

  it('configurando é editável', () => {
    expect(statusPermiteEdicao('configurando')).toBe(true)
    expect(statusEstaCongelado('configurando')).toBe(false)
  })

  it('voltar edição só pronta/agendada', () => {
    expect(statusPermiteVoltarEdicao('pronta')).toBe(true)
    expect(statusPermiteVoltarEdicao('agendada')).toBe(true)
    expect(statusPermiteVoltarEdicao('configurando')).toBe(false)
  })
})
