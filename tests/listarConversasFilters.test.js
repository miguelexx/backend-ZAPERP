/**
 * Teste de caracterização da derivação de filtros de GET /chats (listarConversas).
 * Congela o parsing/normalização de req.query antes de extrair etapas do handler gigante.
 */

const { deriveListarConversasFilters } = require('../services/chat/read/listarConversasFilters')

describe('deriveListarConversasFilters', () => {
  test('query vazia → tudo desligado, sem erro', () => {
    const f = deriveListarConversasFilters({})
    expect(f).toMatchObject({
      tagFilterAtivo: false,
      incluirColaboradoresEncaminhar: false,
      incluirTodosClientesAtivo: false,
      palavraTrim: '',
      searchBypassesStateFilters: false,
      aguardandoClienteAtivo: false,
      aguardandoAtendenteAtivo: false,
      pagamentoPendenteAtivo: false,
      emAtrasoAtivo: false,
      hojeAtivo: false,
      minhaFilaAtiva: false,
      campanhasAtiva: false,
      tempoParadoHoras: null,
      filtroAusenciaLista: false,
      statusNorm: null,
      filtroAtendenteInformado: null,
      atendenteIdInvalido: false,
    })
  })

  test('flags aceitam "1", "true", 1 e true', () => {
    for (const v of ['1', 'true', 1, true]) {
      expect(deriveListarConversasFilters({ minha_fila: v }).minhaFilaAtiva).toBe(true)
      expect(deriveListarConversasFilters({ aguardando_cliente: v }).aguardandoClienteAtivo).toBe(true)
      expect(deriveListarConversasFilters({ campanhas: v }).campanhasAtiva).toBe(true)
    }
    expect(deriveListarConversasFilters({ minha_fila: '0' }).minhaFilaAtiva).toBe(false)
    expect(deriveListarConversasFilters({ minha_fila: 'sim' }).minhaFilaAtiva).toBe(false)
  })

  test('tag_id: "todas" (qualquer caixa) e vazio não ativam o filtro', () => {
    expect(deriveListarConversasFilters({ tag_id: '5' }).tagFilterAtivo).toBe(true)
    expect(deriveListarConversasFilters({ tag_id: 'todas' }).tagFilterAtivo).toBe(false)
    expect(deriveListarConversasFilters({ tag_id: 'TODAS' }).tagFilterAtivo).toBe(false)
    expect(deriveListarConversasFilters({ tag_id: '  ' }).tagFilterAtivo).toBe(false)
    expect(deriveListarConversasFilters({}).tagFilterAtivo).toBe(false)
  })

  test('tempo_parado mapeia chaves conhecidas para horas; desconhecida → null', () => {
    expect(deriveListarConversasFilters({ tempo_parado: '2h' }).tempoParadoHoras).toBe(2)
    expect(deriveListarConversasFilters({ tempo_parado: '24h' }).tempoParadoHoras).toBe(24)
    expect(deriveListarConversasFilters({ tempo_parado: '7d' }).tempoParadoHoras).toBe(24 * 7)
    expect(deriveListarConversasFilters({ tempo_parado: '30d' }).tempoParadoHoras).toBe(24 * 30)
    expect(deriveListarConversasFilters({ tempo_parado: '99x' }).tempoParadoHoras).toBeNull()
    expect(deriveListarConversasFilters({ tempo_parado: '' }).tempoParadoHoras).toBeNull()
  })

  test('finalizacao_motivo=ausencia_cliente → filtroAusenciaLista', () => {
    expect(deriveListarConversasFilters({ finalizacao_motivo: 'ausencia_cliente' }).filtroAusenciaLista).toBe(true)
    expect(deriveListarConversasFilters({ finalizacao_motivo: 'AUSENCIA_CLIENTE' }).filtroAusenciaLista).toBe(true)
    expect(deriveListarConversasFilters({ finalizacao_motivo: 'outro' }).filtroAusenciaLista).toBe(false)
  })

  describe('statusNorm', () => {
    test('normaliza status_atendimento quando nenhum chip conflitante está ativo', () => {
      expect(deriveListarConversasFilters({ status_atendimento: ' Aberta ' }).statusNorm).toBe('aberta')
    })
    test('é ignorado quando minha_fila/campanhas/pagamento/em_atraso/hoje ativo', () => {
      expect(deriveListarConversasFilters({ status_atendimento: 'aberta', minha_fila: '1' }).statusNorm).toBeNull()
      expect(deriveListarConversasFilters({ status_atendimento: 'aberta', hoje: '1' }).statusNorm).toBeNull()
      expect(deriveListarConversasFilters({ status_atendimento: 'aberta', campanhas: '1' }).statusNorm).toBeNull()
    })
    test('é null em busca por texto', () => {
      expect(deriveListarConversasFilters({ status_atendimento: 'aberta', palavra: 'joao' }).statusNorm).toBeNull()
    })
  })

  describe('busca por texto desliga filtros de estado, preserva tag/atendente', () => {
    test('palavra desliga aguardando/minha_fila/tempo_parado/etc.', () => {
      const f = deriveListarConversasFilters({
        palavra: '  maria ',
        aguardando_cliente: '1',
        minha_fila: '1',
        pagamento_pendente: '1',
        em_atraso: '1',
        hoje: '1',
        campanhas: '1',
        tempo_parado: '24h',
        finalizacao_motivo: 'ausencia_cliente',
      })
      expect(f.palavraTrim).toBe('maria')
      expect(f.searchBypassesStateFilters).toBe(true)
      expect(f.aguardandoClienteAtivo).toBe(false)
      expect(f.minhaFilaAtiva).toBe(false)
      expect(f.pagamentoPendenteAtivo).toBe(false)
      expect(f.emAtrasoAtivo).toBe(false)
      expect(f.hojeAtivo).toBe(false)
      expect(f.campanhasAtiva).toBe(false)
      expect(f.tempoParadoHoras).toBeNull()
      expect(f.filtroAusenciaLista).toBe(false)
    })
    test('palavra de 1 caractere não dispara busca global; 2+ sim', () => {
      expect(deriveListarConversasFilters({ palavra: 'a', minha_fila: '1' }).palavraTrim).toBe('')
      expect(deriveListarConversasFilters({ palavra: 'a', minha_fila: '1' }).searchBypassesStateFilters).toBe(false)
      expect(deriveListarConversasFilters({ palavra: 'a', minha_fila: '1' }).minhaFilaAtiva).toBe(true)
      expect(deriveListarConversasFilters({ palavra: 'al' }).palavraTrim).toBe('al')
      expect(deriveListarConversasFilters({ palavra: 'al' }).searchBypassesStateFilters).toBe(true)
    })
    test('tag e atendente_id continuam valendo mesmo com busca', () => {
      const f = deriveListarConversasFilters({ palavra: 'jo', tag_id: '9', atendente_id: '42' })
      expect(f.tagFilterAtivo).toBe(true)
      expect(f.filtroAtendenteInformado).toBe(42)
    })
  })

  describe('atendente_id', () => {
    test('inteiro positivo vira filtroAtendenteInformado', () => {
      expect(deriveListarConversasFilters({ atendente_id: '7' }).filtroAtendenteInformado).toBe(7)
      expect(deriveListarConversasFilters({ atendente_id: 7 }).filtroAtendenteInformado).toBe(7)
    })
    test('UUID/texto/zero/negativo → atendenteIdInvalido', () => {
      for (const bad of ['abc', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', '0', '-2', '1.5']) {
        const f = deriveListarConversasFilters({ atendente_id: bad })
        expect(f.atendenteIdInvalido).toBe(true)
        expect(f.filtroAtendenteInformado).toBeNull()
      }
    })
    test('vazio/ausente → sem filtro, sem erro', () => {
      expect(deriveListarConversasFilters({ atendente_id: '' }).atendenteIdInvalido).toBe(false)
      expect(deriveListarConversasFilters({ atendente_id: '  ' }).atendenteIdInvalido).toBe(false)
      expect(deriveListarConversasFilters({}).filtroAtendenteInformado).toBeNull()
    })
  })
})
