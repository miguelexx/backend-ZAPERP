/**
 * Contadores das abas com regra pós-lista ("Abertas", "Minha fila", "Em atendimento") usando a
 * coluna denormalizada `conversas.tem_mensagem` — doc 40 §3.3 / doc 41 §8.
 *
 * ANTES: `countConversasWithPostListRules` paginava até CHAT_FILTER_ID_LIMIT (2000) linhas com
 * embed `mensagens(id)`, filtrava em JS e PARAVA no teto — acima dele o badge mentia para menos.
 * AGORA: com a coluna no banco é um `count(*)` exato sem embed e sem teto; sem a coluna (42703
 * na 1ª tentativa, lembrado por processo) o comportamento é IDÊNTICO ao antigo.
 *
 * O que este teste trava (cada caso conferido a FALHAR com a mutação indicada):
 *   (a) coluna presente: 1 query `select('id', {count:'exact', head:true})`, sem `mensagens` no
 *       select, sem `.range`, com `tem_mensagem.eq.true` no `.or`, e o resultado é o count do
 *       banco mesmo acima de 2000 (mutações: não aplicar o `.or(predicado)`; continuar varrendo);
 *   (b) coluna ausente: cai na varredura antiga (embed + range + regras JS) e a 2ª chamada nem
 *       tenta o count de novo (mutação: não chamar `desligarTemMensagem()`);
 *   (c) outro erro no count NÃO é engolido nem desliga a coluna (mutação: tratar todo erro como
 *       coluna ausente);
 *   (d) a varredura antiga continua parando no teto (mutação: tirar o teto);
 *   (e) o predicado SQL espelha `rowVisibleInPostFilteredList` caso a caso.
 */

// Prefixo `mock`: o Jest só permite a fábrica de `jest.mock()` referenciar variáveis assim.
const mockEstado = {
  colunaExiste: true,
  countDoBanco: 4321,
  erroDoCount: null, // sobrepõe o 42703 quando definido
  linhas: [], // devolvidas pela varredura (fatiadas pelo range)
  queries: [], // { tabela, chamadas: [{ metodo, args }] }
}

jest.mock('../config/supabase', () => {
  const METODOS = [
    'select', 'eq', 'neq', 'or', 'in', 'not', 'is', 'gte', 'lte', 'ilike', 'order', 'limit', 'range',
  ]
  const responder = (tabela, chamadas) => {
    if (tabela !== 'conversas') return { data: [], count: 0, error: null }
    const select = chamadas.find((c) => c.metodo === 'select')
    const ehCount = select && select.args[1] && select.args[1].head === true
    if (ehCount) {
      if (mockEstado.erroDoCount) return { data: null, count: null, error: mockEstado.erroDoCount }
      if (!mockEstado.colunaExiste) {
        return {
          data: null,
          count: null,
          error: { code: '42703', message: 'column conversas.tem_mensagem does not exist' },
        }
      }
      return { data: null, count: mockEstado.countDoBanco, error: null }
    }
    const range = chamadas.find((c) => c.metodo === 'range')
    const [de, ate] = range ? range.args : [0, mockEstado.linhas.length - 1]
    return { data: mockEstado.linhas.slice(de, ate + 1), count: null, error: null }
  }
  const fabricarBuilder = (tabela) => {
    const chamadas = []
    mockEstado.queries.push({ tabela, chamadas })
    const builder = {}
    for (const m of METODOS) {
      builder[m] = (...args) => {
        chamadas.push({ metodo: m, args })
        return builder
      }
    }
    builder.maybeSingle = () => ({ then: (resolve) => resolve({ data: null, error: null }) })
    builder.single = builder.maybeSingle
    builder.then = (resolve, reject) =>
      Promise.resolve(responder(tabela, chamadas)).then(resolve, reject)
    return builder
  }
  return {
    from: (tabela) => fabricarBuilder(tabela),
    rpc: () => ({ then: (resolve) => resolve({ data: [], error: null }) }),
  }
})

const coluna = require('../helpers/conversasTemMensagemColumn')
const service = require('../services/chatListCountsService')
const { countConversasWithFilter, rowVisibleInPostFilteredList, _test } = service

const ctxAdmin = {
  company_id: 1,
  user_id: 7,
  isAdmin: true,
  isAtendente: false,
  departamento_ids: [],
  filtroAtendenteInformado: null,
  conversaIdsTransferidas: [],
  conversaIdsParticipanteAtivo: [],
  grupoIdsPermitidosPorDepartamento: [],
  grupoIdsSemDepartamento: [],
  grupoIdsFixadosNaMinhaFila: [],
  conversaIdsFilter: null,
  forceEmptyConversas: false,
  instanciasPermitidasAtendente: null,
}

function queriesConversas() {
  return mockEstado.queries.filter((q) => q.tabela === 'conversas')
}
function chamadasDe(query, metodo) {
  return query.chamadas.filter((c) => c.metodo === metodo)
}
function ehCountHead(query) {
  const s = chamadasDe(query, 'select')[0]
  return Boolean(s && s.args[1] && s.args[1].head === true && s.args[1].count === 'exact')
}
function textoDoOr(query) {
  return chamadasDe(query, 'or').map((c) => String(c.args[0])).join(' | ')
}

let warnSpy
beforeEach(() => {
  mockEstado.colunaExiste = true
  mockEstado.countDoBanco = 4321
  mockEstado.erroDoCount = null
  mockEstado.linhas = []
  mockEstado.queries = []
  coluna._test.religar()
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
  delete process.env.CHAT_FILTER_ID_LIMIT
})

describe('(a) coluna presente: count(*) exato, sem embed, sem teto', () => {
  // "Em atendimento" nunca precisou de tem_mensagem (a regra é status + vínculo), mas varria
  // junto com as outras duas; o trecho esperado é a parte da regra pós-lista que foi para o SQL.
  test.each([
    ['aberta', { status_atendimento: 'aberta' }, 'tem_mensagem.eq.true'],
    ['minha_fila', { minha_fila: true }, 'tem_mensagem.eq.true'],
    ['em_atendimento', { status_atendimento: 'em_atendimento' }, 'status_atendimento.in.(em_atendimento,aguardando_cliente)'],
  ])('%s → 1 query head count com a regra pós-lista no .or; devolve 4321 (> teto de 2000)', async (_nome, overrides, trecho) => {
    const total = await countConversasWithFilter(ctxAdmin, overrides)
    expect(total).toBe(4321)

    const qs = queriesConversas()
    expect(qs).toHaveLength(1)
    const [q] = qs
    expect(ehCountHead(q)).toBe(true)
    expect(String(chamadasDe(q, 'select')[0].args[0])).not.toMatch(/mensagens/)
    expect(chamadasDe(q, 'range')).toHaveLength(0)
    expect(textoDoOr(q)).toContain(trecho)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('abas sem regra pós-lista (ex.: fechada) não ganham o predicado', async () => {
    await countConversasWithFilter(ctxAdmin, { status_atendimento: 'fechada' })
    const [q] = queriesConversas()
    expect(ehCountHead(q)).toBe(true)
    expect(textoDoOr(q)).not.toContain('tem_mensagem')
  })
})

describe('(b) coluna ausente: comportamento idêntico ao antigo', () => {
  const linhas = [
    // visíveis em "Abertas": individual com mensagem; individual sem msg mas assumida; grupo
    { id: 1, tipo: null, status_atendimento: 'aberta', atendente_id: null, mensagens: [{ id: 10 }] },
    { id: 2, tipo: null, status_atendimento: 'aberta', atendente_id: 7, mensagens: [] },
    { id: 3, tipo: 'grupo', status_atendimento: null, atendente_id: null, mensagens: [] },
    // invisíveis: individual sem mensagem e sem atendente; campanha
    { id: 4, tipo: null, status_atendimento: 'aberta', atendente_id: null, mensagens: [] },
    { id: 5, tipo: null, status_atendimento: 'aberta', atendente_id: null, mensagens: [{ id: 11 }], aguardando_resposta_campanha: true },
  ]
  const esperadoJs = linhas.filter((r) =>
    rowVisibleInPostFilteredList(r, ctxAdmin, { status_atendimento: 'aberta' })
  ).length

  test('42703 na 1ª tentativa → varredura com embed + regras JS; 2ª chamada nem tenta o count', async () => {
    mockEstado.colunaExiste = false
    mockEstado.linhas = linhas
    expect(esperadoJs).toBe(3)

    const total1 = await countConversasWithFilter(ctxAdmin, { status_atendimento: 'aberta' })
    expect(total1).toBe(3)

    let qs = queriesConversas()
    expect(qs).toHaveLength(2)
    expect(ehCountHead(qs[0])).toBe(true)
    const varredura = qs[1]
    expect(ehCountHead(varredura)).toBe(false)
    expect(String(chamadasDe(varredura, 'select')[0].args[0])).toMatch(/mensagens \( id \)/)
    expect(chamadasDe(varredura, 'range')[0].args).toEqual([0, 999])
    expect(textoDoOr(varredura)).not.toContain('tem_mensagem')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/tem_mensagem/)

    // 2ª chamada: a ausência foi lembrada — só a varredura, sem novo 42703 e sem novo aviso.
    mockEstado.queries = []
    const total2 = await countConversasWithFilter(ctxAdmin, { status_atendimento: 'aberta' })
    expect(total2).toBe(3)
    qs = queriesConversas()
    expect(qs).toHaveLength(1)
    expect(ehCountHead(qs[0])).toBe(false)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  test('religar + coluna de volta: volta ao count(*)', async () => {
    mockEstado.colunaExiste = false
    await countConversasWithFilter(ctxAdmin, { status_atendimento: 'aberta' })
    coluna._test.religar()
    mockEstado.colunaExiste = true
    mockEstado.queries = []
    const total = await countConversasWithFilter(ctxAdmin, { status_atendimento: 'aberta' })
    expect(total).toBe(4321)
    expect(queriesConversas()).toHaveLength(1)
  })
})

describe('(c) outro erro no count não é engolido nem desliga a coluna', () => {
  test('timeout (57014) propaga e a próxima chamada ainda usa o count', async () => {
    mockEstado.erroDoCount = { code: '57014', message: 'canceling statement due to statement timeout' }
    await expect(countConversasWithFilter(ctxAdmin, { status_atendimento: 'aberta' })).rejects.toMatchObject({
      code: '57014',
    })
    expect(coluna.temMensagemDisponivel()).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()

    mockEstado.erroDoCount = null
    mockEstado.queries = []
    expect(await countConversasWithFilter(ctxAdmin, { status_atendimento: 'aberta' })).toBe(4321)
    expect(queriesConversas()).toHaveLength(1)
    expect(ehCountHead(queriesConversas()[0])).toBe(true)
  })

  test('42703 de OUTRA coluna também propaga (não é a nossa ausência)', async () => {
    mockEstado.erroDoCount = { code: '42703', message: 'column conversas.outra_coisa does not exist' }
    await expect(countConversasWithFilter(ctxAdmin, { status_atendimento: 'aberta' })).rejects.toMatchObject({
      code: '42703',
    })
    expect(coluna.temMensagemDisponivel()).toBe(true)
  })
})

describe('(d) a varredura antiga continua parando no teto', () => {
  test('com 2500 linhas elegíveis e teto 2000, devolve 2000 em 2 páginas', async () => {
    mockEstado.colunaExiste = false
    mockEstado.linhas = Array.from({ length: 2500 }, (_, i) => ({
      id: i + 1, tipo: null, status_atendimento: 'aberta', atendente_id: null, mensagens: [{ id: 1 }],
    }))
    const total = await countConversasWithFilter(ctxAdmin, { status_atendimento: 'aberta' })
    expect(total).toBe(2000)
    const varreduras = queriesConversas().filter((q) => !ehCountHead(q))
    expect(varreduras.map((q) => chamadasDe(q, 'range')[0].args)).toEqual([[0, 999], [1000, 1999]])
  })
})

describe('(e) predicado SQL espelha rowVisibleInPostFilteredList', () => {
  const build = _test.buildPostListRulesSqlOr

  test('aberta: grupo entra sempre; individual exige aberta + sem campanha + (mensagem ou atendente)', () => {
    expect(build(ctxAdmin, { status_atendimento: 'aberta' })).toBe(
      'tipo.eq.grupo,and(or(tipo.is.null,tipo.neq.grupo),aguardando_resposta_campanha.not.is.true,' +
      'status_atendimento.eq.aberta,or(tem_mensagem.eq.true,atendente_id.not.is.null))'
    )
  })

  test('minha_fila: grupo só se fixado; ativas vinculadas; abertas livres/minhas com movimento', () => {
    const ctx = { ...ctxAdmin, conversaIdsParticipanteAtivo: [31, 32], grupoIdsFixadosNaMinhaFila: [90] }
    expect(build(ctx, { minha_fila: true })).toBe(
      'and(tipo.eq.grupo,id.in.(90)),' +
      'and(or(tipo.is.null,tipo.neq.grupo),aguardando_resposta_campanha.not.is.true,' +
      'status_atendimento.in.(em_atendimento,aguardando_cliente,pagamento_pendente,em_atraso),' +
      'or(atendente_id.eq.7,id.in.(31,32))),' +
      'and(or(tipo.is.null,tipo.neq.grupo),aguardando_resposta_campanha.not.is.true,status_atendimento.eq.aberta,' +
      'or(atendente_id.is.null,atendente_id.eq.7),or(tem_mensagem.eq.true,atendente_id.not.is.null))'
    )
  })

  test('minha_fila sem grupos fixados e sem participação: grupo não entra; vinculada só pelo atendente_id', () => {
    const sql = build(ctxAdmin, { minha_fila: true })
    expect(sql).not.toContain('tipo.eq.grupo')
    expect(sql).toContain('status_atendimento.in.(em_atendimento,aguardando_cliente,pagamento_pendente,em_atraso),atendente_id.eq.7)')
  })

  test('minha_fila sem user_id e sem participação: ativas nunca casam (id.in.(0)), abertas só livres', () => {
    const sql = build({ ...ctxAdmin, user_id: null }, { minha_fila: true })
    expect(sql).toContain('id.in.(0)')
    expect(sql).toContain('status_atendimento.eq.aberta,atendente_id.is.null,')
  })

  test('em_atendimento (admin): em_atendimento ou aguardando_cliente, nunca grupo', () => {
    expect(build(ctxAdmin, { status_atendimento: 'em_atendimento' })).toBe(
      'and(or(tipo.is.null,tipo.neq.grupo),status_atendimento.in.(em_atendimento,aguardando_cliente))'
    )
  })

  test('em_atendimento (admin com atendente_id na query): restringe ao atendente', () => {
    expect(build({ ...ctxAdmin, filtroAtendenteInformado: 12 }, { status_atendimento: 'em_atendimento' })).toBe(
      'and(or(tipo.is.null,tipo.neq.grupo),atendente_id.eq.12,status_atendimento.in.(em_atendimento,aguardando_cliente))'
    )
  })

  test('em_atendimento (atendente): só em_atendimento e vinculada (dono ou participante)', () => {
    const ctx = { ...ctxAdmin, isAdmin: false, isAtendente: true, conversaIdsParticipanteAtivo: [5] }
    expect(build(ctx, { status_atendimento: 'em_atendimento' })).toBe(
      'and(or(tipo.is.null,tipo.neq.grupo),status_atendimento.eq.em_atendimento,or(atendente_id.eq.7,id.in.(5)))'
    )
  })

  test('em_atendimento + aguardando_cliente e demais overrides: sem predicado', () => {
    expect(build(ctxAdmin, { status_atendimento: 'em_atendimento', aguardando_cliente: true })).toBeNull()
    expect(build(ctxAdmin, { status_atendimento: 'fechada' })).toBeNull()
    expect(build(ctxAdmin, { hoje: true })).toBeNull()
  })

  test('a varredura JS e o predicado concordam no que exige tem_mensagem', () => {
    // Linha que SÓ entra por ter mensagem — o único caso que obrigava o embed.
    const soPorMensagem = { id: 1, tipo: null, status_atendimento: 'aberta', atendente_id: null, mensagens: [{ id: 1 }] }
    const semNada = { ...soPorMensagem, mensagens: [] }
    expect(rowVisibleInPostFilteredList(soPorMensagem, ctxAdmin, { status_atendimento: 'aberta' })).toBe(true)
    expect(rowVisibleInPostFilteredList(semNada, ctxAdmin, { status_atendimento: 'aberta' })).toBe(false)
    expect(build(ctxAdmin, { status_atendimento: 'aberta' })).toContain('tem_mensagem.eq.true')
  })
})
