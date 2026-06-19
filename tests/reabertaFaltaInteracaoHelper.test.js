const {
  resolveReabertaPorFaltaInteracao,
} = require('../helpers/reabertaFaltaInteracaoHelper')

describe('reabertaFaltaInteracaoHelper', () => {
  it('só marca reaberta quando gestor foi notificado e conversa reaberta', () => {
    expect(resolveReabertaPorFaltaInteracao({ reaberta_por_falta_interacao: true })).toBe(true)
    expect(
      resolveReabertaPorFaltaInteracao({
        reaberta_em: '2026-06-08T12:00:00Z',
        gestor_notificado_em: '2026-06-08T12:00:00Z',
      })
    ).toBe(true)
  })

  it('não marca só por tag automática ou reaberta sem gestor', () => {
    expect(
      resolveReabertaPorFaltaInteracao({
        tags: [{ nome: 'Reaberta por falta de resposta', cor: '#2563eb' }],
      })
    ).toBe(false)
    expect(resolveReabertaPorFaltaInteracao({ reaberta_em: '2026-06-08T12:00:00Z' })).toBe(false)
    expect(resolveReabertaPorFaltaInteracao({ reaberta_falta_interacao_em: '2026-06-08T12:00:00Z' })).toBe(false)
    expect(resolveReabertaPorFaltaInteracao({ status_atendimento: 'aberta' })).toBe(false)
  })
})
