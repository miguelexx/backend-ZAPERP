const {
  tagIndicaReabertaFaltaInteracao,
  resolveReabertaPorFaltaInteracao,
} = require('../helpers/reabertaFaltaInteracaoHelper')

describe('reabertaFaltaInteracaoHelper', () => {
  it('detecta tag padrão de reabertura', () => {
    expect(tagIndicaReabertaFaltaInteracao('Reaberta por falta de resposta')).toBe(true)
    expect(tagIndicaReabertaFaltaInteracao('reaberta por inatividade')).toBe(true)
    expect(tagIndicaReabertaFaltaInteracao('VIP')).toBe(false)
  })

  it('resolve flag por coluna, tag ou evento implícito', () => {
    expect(resolveReabertaPorFaltaInteracao({ reaberta_falta_interacao_em: '2026-06-08T12:00:00Z' })).toBe(true)
    expect(
      resolveReabertaPorFaltaInteracao({
        tags: [{ nome: 'Reaberta por falta de resposta', cor: '#2563eb' }],
      })
    ).toBe(true)
    expect(resolveReabertaPorFaltaInteracao({ status_atendimento: 'aberta' })).toBe(false)
  })
})
