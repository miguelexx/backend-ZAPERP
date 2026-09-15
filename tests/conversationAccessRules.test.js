const {
  isPerfilAtendente,
  conversaAssumidaAtivaPorOutro,
  atendenteNaoPodeVerAssumidaPorOutro,
} = require('../services/chat/access/conversationAccessRules')
const { pushAtendenteFilaLivreVisibilityParts } = require('../helpers/departamentoGruposHelper')

describe('conversationAccessRules — atendente nao ve assumida por outro', () => {
  const assumida = {
    tipo: null,
    atendente_id: 9,
    status_atendimento: 'em_atendimento',
  }

  test('so perfil atendente e cortado', () => {
    expect(isPerfilAtendente('atendente')).toBe(true)
    expect(isPerfilAtendente('supervisor')).toBe(false)
    expect(isPerfilAtendente('admin')).toBe(false)
    expect(
      atendenteNaoPodeVerAssumidaPorOutro({ role: 'atendente', userId: 2, conv: assumida })
    ).toBe(true)
    expect(
      atendenteNaoPodeVerAssumidaPorOutro({ role: 'supervisor', userId: 2, conv: assumida })
    ).toBe(false)
    expect(
      atendenteNaoPodeVerAssumidaPorOutro({ role: 'admin', userId: 2, conv: assumida })
    ).toBe(false)
  })

  test('dona da conversa, fila livre, grupo e encerrada continuam visiveis', () => {
    expect(conversaAssumidaAtivaPorOutro({ ...assumida, atendente_id: 2 }, 2)).toBe(false)
    expect(conversaAssumidaAtivaPorOutro({ ...assumida, atendente_id: null }, 2)).toBe(false)
    expect(conversaAssumidaAtivaPorOutro({ ...assumida, tipo: 'grupo' }, 2)).toBe(false)
    expect(conversaAssumidaAtivaPorOutro({ ...assumida, status_atendimento: 'fechada' }, 2)).toBe(false)
  })
})

describe('pushAtendenteFilaLivreVisibilityParts', () => {
  test('restringe setor a fila livre ou encerrada', () => {
    const parts = []
    pushAtendenteFilaLivreVisibilityParts(parts, { depIds: [3], includeNullDepartamento: true })
    expect(parts.some((p) => p.includes('departamento_id.eq.3') && p.includes('atendente_id.is.null'))).toBe(true)
    expect(parts.some((p) => p.includes('status_atendimento.in.(fechada,encerrada,finalizada,finalizado)'))).toBe(true)
    expect(parts.every((p) => !p.includes('atendente_id.eq.'))).toBe(true)
  })
})
