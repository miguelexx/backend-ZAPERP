/**
 * Puros do script de reparo retroativo (scripts/reparar-midia-sem-link.js).
 *
 * O que estes testes travam:
 *  - a seleção do passivo não pode arrastar linha sã (URL /uploads, /media/r2, https) nem linha
 *    apagada — cada alvo a mais é uma chamada a mais contra a conta WhatsApp;
 *  - a exigência de `--company-id` (isolamento app-layer: nada roda sem empresa explícita);
 *  - o parse de `criado_em` (timestamp sem fuso, gravado em UTC): sem o 'Z' o ranking por recência
 *    erra 3h e, no detector de lacuna, TODA conversa pareceria ter mídia perdida;
 *  - "conversa sem telefone" não pode contar como falha de provedor e abrir o disjuntor.
 *
 * Carrega o script como módulo: ele só executa quando é o main (require.main === module).
 */

const script = require('../scripts/reparar-midia-sem-link')

describe('reparar-midia-sem-link — classificação das linhas', () => {
  test('URL utilizável (remota, /uploads, /media/r2) não é estrago', () => {
    for (const url of ['https://cdn.exemplo/a.jpg', 'http://cdn.exemplo/a.jpg', '/uploads/a.jpg', '/media/r2/a.jpg']) {
      expect(script.temUrlUtilizavel(url)).toBe(true)
      expect(script.linhaQuebrada({ tipo: 'imagem', texto: '(imagem)', url })).toBe(false)
    }
  })

  test('url nula/vazia/lixo em mensagem de mídia é estrago', () => {
    for (const url of [null, '', '   ', 'data:image/png;base64,AAA']) {
      expect(script.temUrlUtilizavel(url)).toBe(false)
      expect(script.linhaQuebrada({ tipo: 'audio', texto: '(áudio)', url })).toBe(true)
    }
  })

  test('tipo=texto com placeholder de mídia conta (foto sem link virava tipo texto)', () => {
    expect(script.linhaQuebrada({ tipo: 'texto', texto: '(imagem)', url: null })).toBe(true)
    expect(script.linhaQuebrada({ tipo: 'texto', texto: '(mensagem)', url: null })).toBe(true)
    expect(script.linhaQuebrada({ tipo: 'texto', texto: '(ÁUDIO)', url: null })).toBe(true)
  })

  test('texto normal sem url não é estrago (mensagem de texto comum)', () => {
    expect(script.linhaQuebrada({ tipo: 'texto', texto: 'bom dia, tudo bem?', url: null })).toBe(false)
    expect(script.linhaQuebrada({ tipo: 'location', texto: 'Av. Paulista', url: null })).toBe(false)
  })

  test('linha apagada não entra no reparo', () => {
    expect(script.linhaQuebrada({ tipo: 'imagem', texto: '(imagem)', url: null, apagada_para_todos: true })).toBe(false)
    expect(script.linhaQuebrada({ tipo: 'imagem', texto: '(imagem)', url: null, apagada_pelo_cliente: true })).toBe(false)
  })

  test('sem whatsapp_id a linha é estrago, mas não é reparável (reparo casa por whatsapp_id)', () => {
    const semId = { tipo: 'audio', texto: '(áudio)', url: null, whatsapp_id: null }
    expect(script.linhaQuebrada(semId)).toBe(true)
    expect(script.linhaReparavel(semId)).toBe(false)
    expect(script.linhaReparavel({ ...semId, whatsapp_id: 'ABC123' })).toBe(true)
  })
})

describe('reparar-midia-sem-link — agrupamento por conversa', () => {
  test('conta linhas/reparáveis por conversa e ordena pela mídia mais recente', () => {
    const grupos = script.agruparPorConversa([
      { id: 1, conversa_id: 10, tipo: 'audio', texto: '(áudio)', url: null, whatsapp_id: 'a1', criado_em: '2026-10-10T12:00:00' },
      { id: 2, conversa_id: 10, tipo: 'imagem', texto: '(imagem)', url: null, whatsapp_id: null, criado_em: '2026-10-11T12:00:00' },
      { id: 3, conversa_id: 20, tipo: 'arquivo', texto: '(arquivo)', url: null, whatsapp_id: 'b1', criado_em: '2026-10-14T12:00:00' },
      { id: 4, conversa_id: 30, tipo: 'texto', texto: 'oi', url: null, whatsapp_id: 'c1', criado_em: '2026-10-15T12:00:00' },
      { id: 5, conversa_id: 40, tipo: 'imagem', texto: '(imagem)', url: '/uploads/ok.jpg', whatsapp_id: 'd1', criado_em: '2026-10-15T13:00:00' },
    ])

    expect(grupos.map((g) => g.conversa_id)).toEqual([20, 10])
    const dez = grupos.find((g) => g.conversa_id === 10)
    expect(dez).toMatchObject({ linhas: 2, reparaveis: 1, sem_whatsapp_id: 1 })
    expect(dez.tipos).toEqual(['audio', 'imagem'])
  })

  test('criado_em sem fuso é lido como UTC (não como hora local)', () => {
    const [grupo] = script.agruparPorConversa([
      { id: 1, conversa_id: 7, tipo: 'audio', texto: '(áudio)', url: null, whatsapp_id: 'x', criado_em: '2026-10-15 12:00:00' },
    ])
    expect(grupo.mais_recente).toBe(Date.parse('2026-10-15T12:00:00Z'))
  })

  test('lista vazia não quebra', () => {
    expect(script.agruparPorConversa([])).toEqual([])
    expect(script.agruparPorConversa(null)).toEqual([])
  })
})

describe('reparar-midia-sem-link — argumentos', () => {
  test('--company-id é obrigatório', () => {
    expect(script.parseArgs([]).erros.join(' ')).toMatch(/--company-id/)
    expect(script.parseArgs(['--company-id=abc']).erros.join(' ')).toMatch(/--company-id/)
    expect(script.parseArgs(['--company-id=1']).erros).toEqual([])
  })

  test('dry-run é o padrão; --apply liga a execução', () => {
    expect(script.parseArgs(['--company-id=1']).opts.apply).toBe(false)
    expect(script.parseArgs(['--company-id=1', '--apply']).opts.apply).toBe(true)
  })

  test('padrões conservadores e limites saneados', () => {
    const { opts } = script.parseArgs(['--company-id=1'])
    expect(opts).toMatchObject({ companyId: 1, dias: 45, limite: 50, pausaMs: 1500, falhasMax: 5, modo: 'linhas' })

    const { opts: extremos } = script.parseArgs(['--company-id=1', '--limite=99999', '--pausa-ms=-10', '--dias=0'])
    expect(extremos.limite).toBe(1000)
    expect(extremos.pausaMs).toBe(0)
    expect(extremos.dias).toBe(1)
  })

  test('modo inválido é recusado; os três válidos passam', () => {
    expect(script.parseArgs(['--company-id=1', '--modo=tudo']).erros.join(' ')).toMatch(/--modo/)
    for (const modo of ['linhas', 'lacunas', 'ambos']) {
      expect(script.parseArgs(['--company-id=1', `--modo=${modo}`]).erros).toEqual([])
    }
  })

  test('--conversa aceita só id numérico positivo', () => {
    expect(script.parseArgs(['--company-id=1', '--conversa=55']).opts.conversa).toBe(55)
    expect(script.parseArgs(['--company-id=1', '--conversa=zero']).erros.join(' ')).toMatch(/--conversa/)
  })
})

describe('reparar-midia-sem-link — disjuntor', () => {
  test('erro de identificador da conversa não é falha de provedor', () => {
    expect(script.erroEhDaConversa('Conversa sem telefone valido para buscar historico no WhatsApp.')).toBe(true)
    expect(script.erroEhDaConversa('Grupo sem identificador valido (@g.us) para buscar historico.')).toBe(true)
    expect(script.erroEhDaConversa('Conversa nao encontrada.')).toBe(true)
  })

  test('erro de provedor conta para o disjuntor', () => {
    expect(script.erroEhDaConversa('429 Too Many Requests')).toBe(false)
    expect(script.erroEhDaConversa('Erro ao buscar mensagens antigas deste contato.')).toBe(false)
  })
})

/**
 * Fake do supabase-js v2 que respeita o contrato real do builder: depois de `order()`/`limit()`
 * o objeto é um TransformBuilder e NÃO aceita mais `eq()`/`in()`/`gte()`. É o que pega a inversão
 * de ordem das chamadas — erro que só apareceria em produção, no meio do lote.
 */
function fakeSupabase(porTabela) {
  const chamadas = []
  const make = (tabela, estado) => {
    const transform = {
      _tabela: tabela,
      estado,
      order() { return transform },
      limit() { return transform },
      maybeSingle() {
        chamadas.push(estado)
        const linhas = porTabela[tabela] ? porTabela[tabela](estado) : []
        return Promise.resolve({ data: linhas[0] || null, error: null })
      },
      then(resolve, reject) {
        chamadas.push(estado)
        const linhas = porTabela[tabela] ? porTabela[tabela](estado) : []
        return Promise.resolve({ data: linhas, error: null }).then(resolve, reject)
      },
    }
    const filtros = {
      select() { return filtros },
      eq(coluna, valor) { estado.filtros.push([coluna, valor]); return filtros },
      gte(coluna, valor) { estado.filtros.push([`gte:${coluna}`, valor]); return filtros },
      in(coluna, valores) { estado.in = [coluna, valores]; return filtros },
      order() { return transform },
      limit() { return transform },
      maybeSingle() { return transform.maybeSingle() },
      then(resolve, reject) { return transform.then(resolve, reject) },
    }
    return filtros
  }
  return {
    chamadas,
    from(tabela) { return make(tabela, { tabela, filtros: [], in: null }) },
  }
}

describe('reparar-midia-sem-link — forma das consultas (contrato supabase-js v2)', () => {
  test('busca por tipo e por texto, sempre com company_id, e une sem duplicar', async () => {
    const db = fakeSupabase({
      mensagens: (estado) => {
        const [coluna] = estado.in || []
        if (coluna === 'tipo') {
          return [
            { id: 1, conversa_id: 10, tipo: 'audio', texto: '(áudio)', url: null, whatsapp_id: 'a', criado_em: '2026-10-15T10:00:00' },
            { id: 2, conversa_id: 10, tipo: 'imagem', texto: '(imagem)', url: '/uploads/ok.jpg', whatsapp_id: 'b', criado_em: '2026-10-15T11:00:00' },
          ]
        }
        // a MESMA linha 1 volta aqui (tipo de mídia + texto placeholder): não pode contar duas vezes
        return [
          { id: 1, conversa_id: 10, tipo: 'audio', texto: '(áudio)', url: null, whatsapp_id: 'a', criado_em: '2026-10-15T10:00:00' },
          { id: 3, conversa_id: 11, tipo: 'texto', texto: '(arquivo)', url: null, whatsapp_id: 'c', criado_em: '2026-10-15T09:00:00' },
        ]
      },
    })

    const linhas = await script.buscarLinhasQuebradas(db, { companyId: 7, dias: 45, conversaId: null })

    expect(linhas.map((l) => l.id).sort()).toEqual([1, 2, 3])
    expect(script.agruparPorConversa(linhas).map((g) => g.conversa_id)).toEqual([10, 11])
    expect(db.chamadas).toHaveLength(2)
    for (const chamada of db.chamadas) {
      expect(chamada.filtros).toContainEqual(['company_id', 7])
      expect(chamada.filtros.map(([c]) => c)).toContain('gte:criado_em')
    }
    expect(db.chamadas.map((c) => c.in[0]).sort()).toEqual(['texto', 'tipo'])
  })

  test('--conversa adiciona o filtro de conversa nas duas consultas', async () => {
    const db = fakeSupabase({ mensagens: () => [] })
    await script.buscarLinhasQuebradas(db, { companyId: 7, dias: 45, conversaId: 99 })
    for (const chamada of db.chamadas) {
      expect(chamada.filtros).toContainEqual(['conversa_id', 99])
    }
  })

  test('lacuna: só entra conversa cuja atividade passou da última mensagem, lendo criado_em como UTC', async () => {
    const db = fakeSupabase({
      conversas: () => [
        { id: 1, telefone: '5511999990001', ultima_atividade: '2026-10-15T12:10:00.000Z' }, // lacuna 600s
        { id: 2, telefone: '5511999990002', ultima_atividade: '2026-10-15T12:00:30.000Z' }, // lacuna 30s
      ],
      mensagens: () => [{ criado_em: '2026-10-15T12:00:00' }],
    })

    const achadas = await script.buscarConversasComLacuna(db, {
      companyId: 7, dias: 45, lacunaMinSeg: 120, scanLacunas: 300,
    })

    expect(achadas).toEqual([{ conversa_id: 1, telefone: '5511999990001', lacuna_seg: 600 }])
  })
})

describe('reparar-midia-sem-link — janela', () => {
  test('cutoff é ISO UTC e recua os dias pedidos', () => {
    const iso = script.cutoffIsoUtc(45)
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    const dias = (Date.now() - Date.parse(iso)) / 86_400_000
    expect(dias).toBeGreaterThan(44.9)
    expect(dias).toBeLessThan(45.1)
  })
})
