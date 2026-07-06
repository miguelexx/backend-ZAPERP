const {
  MOVIMENTACAO_INTERNA_PERFIS,
  buildMensagemInternaMovimentacao,
  perfilPodeVerMovimentacaoInterna,
} = require('../services/atendimentosRegistroService')

describe('atendimentosRegistroService', () => {
  it('permite que supervisores vejam movimentacoes internas', () => {
    expect(perfilPodeVerMovimentacaoInterna('admin')).toBe(true)
    expect(perfilPodeVerMovimentacaoInterna('administrador')).toBe(true)
    expect(perfilPodeVerMovimentacaoInterna('supervisor')).toBe(true)
    expect(perfilPodeVerMovimentacaoInterna('atendente')).toBe(false)
  })

  it('inclui supervisor na visibilidade das mensagens internas de atendimento', () => {
    const msg = buildMensagemInternaMovimentacao({
      id: 123,
      company_id: 7,
      conversa_id: 42,
      acao: 'transferiu',
      de_usuario_id: 10,
      para_usuario_id: 20,
      criado_em: '2026-07-05T12:00:00.000Z',
    }, {
      10: 'Ana',
      20: 'Bruno',
    })

    expect(MOVIMENTACAO_INTERNA_PERFIS).toContain('supervisor')
    expect(msg.visibilidade_perfis).toContain('supervisor')
    expect(msg.mensagem_interna).toBe(true)
    expect(msg.movimentacao_interna.acao).toBe('transferiu')
  })
})
