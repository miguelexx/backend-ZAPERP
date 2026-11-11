/**
 * Minhas Pendências / Supervisão sem varredura OFFSET (doc 29 §3 item 10).
 *
 * POR QUE EXISTE: `listLastMessagesByConversation` paginava TODAS as mensagens das conversas
 * abertas com `.range()` (OFFSET de 1000 em 1000) só para ficar com a primeira linha de cada
 * conversa, e `listRespostasAtendenteAposTransferencias` trazia todas as `out` do usuário sem
 * janela de data nem teto (o PostgREST cortava em ~1000 linhas em silêncio).
 *
 * O que este teste trava:
 *   (a) nenhuma chamada usa `.range()`/OFFSET nem consulta `mensagens` "a seco" para a última
 *       mensagem — é o embed lateral `conversas → mensagens(...)` com `limit(1, referencedTable)`;
 *   (b) a janela de data (`gte` na transferência mais antiga do lote) e o teto (`limit`) são
 *       aplicados na busca de respostas pós-transferência;
 *   (c) o resultado por conversa é IDÊNTICO ao da implementação antiga (copiada aqui, com a
 *       paginação por OFFSET) num cenário de 3 conversas × 5 mensagens — tanto o Map da
 *       última mensagem como o Set de "respondeu após transferência".
 *
 * O mock é um mini-PostgREST em memória: executa filtros no pai e no embed, `order`/`limit`
 * por `referencedTable` (lateral, por conversa) e `range` — o suficiente para rodar a versão
 * antiga e a nova sobre os MESMOS dados e comparar.
 */

const mockEstado = { dados: { conversas: [], mensagens: [] }, chamadas: [] }

jest.mock('../config/supabase', () => {
  function lerValor(row, col) {
    return row[col]
  }
  function passaFiltro(row, f) {
    const v = lerValor(row, f.col)
    if (f.op === 'eq') return String(v) === String(f.val)
    if (f.op === 'in') return f.val.map(String).includes(String(v))
    if (f.op === 'not-is-null') return v != null
    if (f.op === 'gte') return v != null && new Date(v).getTime() >= new Date(f.val).getTime()
    throw new Error(`filtro nao suportado no mock: ${f.op}`)
  }
  function ordenar(rows, ordens) {
    if (!ordens.length) return rows.slice()
    return rows.slice().sort((a, b) => {
      for (const o of ordens) {
        const av = a[o.col]
        const bv = b[o.col]
        if (av === bv) continue
        if (av == null) return o.nullsFirst ? -1 : 1
        if (bv == null) return o.nullsFirst ? 1 : -1
        const cmp = av < bv ? -1 : 1
        return o.ascending ? cmp : -cmp
      }
      return 0
    })
  }
  function projetar(row, colunas) {
    if (!colunas) return { ...row }
    const out = {}
    for (const c of colunas) out[c] = row[c]
    return out
  }
  function parseSelect(sel) {
    const s = String(sel || '*').replace(/\s+/g, ' ').trim()
    const m = s.match(/^(.*?)\s*,?\s*mensagens\s*\(\s*(.*?)\s*\)\s*$/)
    if (!m) return { pai: s === '*' ? null : s.split(',').map((x) => x.trim()).filter(Boolean), embed: null }
    const pai = m[1].split(',').map((x) => x.trim()).filter(Boolean)
    const embed = m[2].split(',').map((x) => x.trim()).filter(Boolean)
    return { pai, embed }
  }

  function executar(q) {
    const tabela = mockEstado.dados[q.tabela] || []
    const { pai: colsPai, embed: colsEmbed } = parseSelect(q.select)
    let rows = tabela.filter((r) => q.filtros.every((f) => passaFiltro(r, f)))
    rows = ordenar(rows, q.ordens)
    if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1)
    if (q.limit != null) rows = rows.slice(0, q.limit)
    const data = rows.map((r) => {
      const out = projetar(r, colsPai)
      if (colsEmbed) {
        // LATERAL por pai: filtros, order e limit do embed aplicam-se dentro de cada conversa.
        let filhos = (mockEstado.dados.mensagens || []).filter(
          (m) => Number(m.conversa_id) === Number(r.id) && q.filtrosEmbed.every((f) => passaFiltro(m, f))
        )
        filhos = ordenar(filhos, q.ordensEmbed)
        if (q.limitEmbed != null) filhos = filhos.slice(0, q.limitEmbed)
        out.mensagens = filhos.map((m) => projetar(m, colsEmbed))
      }
      return out
    })
    return { data, error: null }
  }

  function builder(tabela) {
    const q = {
      tabela,
      select: '*',
      filtros: [],
      filtrosEmbed: [],
      ordens: [],
      ordensEmbed: [],
      limit: null,
      limitEmbed: null,
      range: null,
      metodos: [],
    }
    mockEstado.chamadas.push(q)
    const registrar = (nome, args) => q.metodos.push({ nome, args })
    const ehEmbed = (col) => String(col).startsWith('mensagens.')
    const colSem = (col) => String(col).replace(/^mensagens\./, '')
    const api = {
      select(sel) { registrar('select', [sel]); q.select = sel; return api },
      eq(col, val) {
        registrar('eq', [col, val])
        ;(ehEmbed(col) ? q.filtrosEmbed : q.filtros).push({ op: 'eq', col: colSem(col), val })
        return api
      },
      in(col, val) {
        registrar('in', [col, val])
        ;(ehEmbed(col) ? q.filtrosEmbed : q.filtros).push({ op: 'in', col: colSem(col), val })
        return api
      },
      not(col, op, val) {
        registrar('not', [col, op, val])
        if (op !== 'is' || val !== null) throw new Error('mock so suporta not(col, "is", null)')
        ;(ehEmbed(col) ? q.filtrosEmbed : q.filtros).push({ op: 'not-is-null', col: colSem(col) })
        return api
      },
      gte(col, val) {
        registrar('gte', [col, val])
        ;(ehEmbed(col) ? q.filtrosEmbed : q.filtros).push({ op: 'gte', col: colSem(col), val })
        return api
      },
      order(col, opts = {}) {
        registrar('order', [col, opts])
        const o = { col, ascending: opts.ascending !== false, nullsFirst: !!opts.nullsFirst }
        ;(opts.referencedTable === 'mensagens' ? q.ordensEmbed : q.ordens).push(o)
        return api
      },
      limit(n, opts = {}) {
        registrar('limit', [n, opts])
        if (opts.referencedTable === 'mensagens') q.limitEmbed = n
        else q.limit = n
        return api
      },
      range(a, b) { registrar('range', [a, b]); q.range = [a, b]; return api },
      then(resolve, reject) {
        try { return Promise.resolve(executar(q)).then(resolve, reject) } catch (e) { return Promise.reject(e).then(resolve, reject) }
      },
    }
    return api
  }

  return { from: (tabela) => builder(tabela), rpc: () => Promise.resolve({ data: [], error: null }) }
})

const supabase = require('../config/supabase')
const {
  _test: {
    listLastMessagesByConversation,
    listRespostasAtendenteAposTransferencias,
    transferenciaMaisAntigaIso,
    buildUltimaTransferenciaRecebidaMap,
    buildRespostaAposTransferenciaSet,
  },
} = require('../services/minhasPendenciasService')
const { listUltimaMensagemPorConversa, CONV_ID_IN_CHUNK } = require('../services/chat/read/ultimaMensagemPorConversa')

const EMPRESA = 1
const OUTRA_EMPRESA = 2
const USER_B = 2
const USER_OUTRO = 7

// ---------------------------------------------------------------------------
// IMPLEMENTAÇÕES ANTIGAS (copiadas do serviço antes da mudança) — o oráculo da paridade.
// Página pequena (2) para a paginação por OFFSET realmente correr (a antiga para assim que
// achou todas as conversas; com 2 por página precisa de mais de uma página no cenário).
// ---------------------------------------------------------------------------
const MSG_PAGE_ANTIGA = 2

async function listLastMessagesByConversationAntiga(companyId, conversationIds) {
  const normalizeIds = [...new Set((conversationIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))]
  if (!normalizeIds.length) return new Map()
  const needed = new Set(normalizeIds)
  const map = new Map()
  let offset = 0
  for (;;) {
    const { data, error } = await supabase
      .from('mensagens')
      .select('conversa_id, direcao, criado_em')
      .eq('company_id', companyId)
      .in('conversa_id', normalizeIds)
      .in('direcao', ['in', 'out'])
      .not('criado_em', 'is', null)
      .order('criado_em', { ascending: false, nullsFirst: false })
      .range(offset, offset + MSG_PAGE_ANTIGA - 1)
    if (error) throw error
    const rows = data || []
    for (const msg of rows) {
      const cid = Number(msg.conversa_id)
      if (!needed.has(cid)) continue
      if (!map.has(cid)) map.set(cid, msg)
    }
    if (rows.length < MSG_PAGE_ANTIGA) break
    offset += MSG_PAGE_ANTIGA
    if (map.size >= needed.size) break
  }
  return map
}

async function listRespostasAntiga(companyId, usuarioId, transferMap) {
  const idsComTransfer = [...transferMap.keys()]
  if (!idsComTransfer.length) return []
  const { data, error } = await supabase
    .from('mensagens')
    .select('conversa_id, direcao, criado_em, autor_usuario_id')
    .eq('company_id', companyId)
    .in('conversa_id', idsComTransfer)
    .eq('direcao', 'out')
    .eq('autor_usuario_id', usuarioId)
    .not('criado_em', 'is', null)
  if (error) throw error
  return data || []
}

// ---------------------------------------------------------------------------
// Cenário: 3 conversas × 5 mensagens (+ ruído de outra empresa e de conversa fora da lista).
// ---------------------------------------------------------------------------
function iso(min) {
  return new Date(Date.UTC(2026, 10, 10, 8, min, 0)).toISOString()
}

let proximoId = 1
function msg(conversa_id, direcao, min, extra = {}) {
  return {
    id: proximoId++,
    company_id: EMPRESA,
    conversa_id,
    direcao,
    criado_em: min == null ? null : iso(min),
    autor_usuario_id: null,
    texto: `m${proximoId}`,
    tipo: 'texto',
    ...extra,
  }
}

function montarCenario() {
  proximoId = 1
  mockEstado.chamadas = []
  mockEstado.dados = {
    conversas: [
      { id: 10, company_id: EMPRESA },
      { id: 20, company_id: EMPRESA },
      { id: 30, company_id: EMPRESA },
      { id: 40, company_id: EMPRESA }, // fora da lista pedida
      { id: 50, company_id: OUTRA_EMPRESA },
    ],
    mensagens: [
      // conversa 10: última in/out é OUT do USER_B (min 30); nota interna depois NÃO conta.
      msg(10, 'in', 5),
      msg(10, 'out', 10, { autor_usuario_id: USER_B }),
      msg(10, 'in', 20),
      msg(10, 'out', 30, { autor_usuario_id: USER_B }),
      msg(10, 'interna', 40),
      // conversa 20: última é IN (min 45); há out do USER_B antes da transferência só.
      msg(20, 'out', 1, { autor_usuario_id: USER_B }),
      msg(20, 'in', 12),
      msg(20, 'out', 15, { autor_usuario_id: USER_OUTRO }),
      msg(20, 'in', 45),
      msg(20, 'out', null, { autor_usuario_id: USER_B }), // criado_em nulo: ignorada
      // conversa 30: última é IN (min 50); nunca respondida pelo USER_B.
      msg(30, 'in', 2),
      msg(30, 'out', 3, { autor_usuario_id: USER_OUTRO }),
      msg(30, 'in', 25),
      msg(30, 'in', 50),
      msg(30, 'interna', 55),
      // ruído
      msg(40, 'in', 59),
      { ...msg(10, 'in', 58), company_id: OUTRA_EMPRESA }, // mesma conversa_id, outra empresa
      { ...msg(50, 'in', 57), company_id: OUTRA_EMPRESA },
    ],
  }
}

function transferMapCenario() {
  return buildUltimaTransferenciaRecebidaMap(
    [
      { id: 1, conversa_id: 10, acao: 'transferiu', para_usuario_id: USER_B, criado_em: iso(25) }, // respondida (min 30)
      { id: 2, conversa_id: 20, acao: 'transferiu', para_usuario_id: USER_B, criado_em: iso(14) }, // só out ANTES (min 1)
      { id: 3, conversa_id: 30, acao: 'transferiu', para_usuario_id: USER_B, criado_em: iso(8) },  // nunca respondida
    ],
    USER_B
  )
}

function chamadasDaTabela(tabela) {
  return mockEstado.chamadas.filter((q) => q.tabela === tabela)
}
function usouMetodo(q, nome) {
  return q.metodos.some((m) => m.nome === nome)
}

beforeEach(montarCenario)

describe('(a) última mensagem por conversa sem OFFSET', () => {
  it('não usa .range() nem consulta `mensagens` a seco; é embed lateral limit 1 por conversa', async () => {
    const mapa = await listLastMessagesByConversation(EMPRESA, [10, 20, 30])
    expect(mapa.size).toBe(3)

    expect(chamadasDaTabela('mensagens')).toHaveLength(0)
    for (const q of mockEstado.chamadas) expect(usouMetodo(q, 'range')).toBe(false)

    const [q] = chamadasDaTabela('conversas')
    expect(q).toBeTruthy()
    expect(q.metodos).toEqual(expect.arrayContaining([
      { nome: 'eq', args: ['company_id', EMPRESA] },
      { nome: 'eq', args: ['mensagens.company_id', EMPRESA] },
      { nome: 'in', args: ['mensagens.direcao', ['in', 'out']] },
      { nome: 'not', args: ['mensagens.criado_em', 'is', null] },
      { nome: 'order', args: ['criado_em', { ascending: false, referencedTable: 'mensagens' }] },
      { nome: 'limit', args: [1, { referencedTable: 'mensagens' }] },
    ]))
  })

  it('divide em lotes de CONV_ID_IN_CHUNK ids — uma query por lote, nunca uma por conversa', async () => {
    const ids = Array.from({ length: CONV_ID_IN_CHUNK * 2 + 5 }, (_, i) => 1000 + i)
    mockEstado.dados.conversas.push(...ids.map((id) => ({ id, company_id: EMPRESA })))
    await listUltimaMensagemPorConversa(EMPRESA, ids)
    const qs = chamadasDaTabela('conversas')
    expect(qs).toHaveLength(3)
    for (const q of qs) {
      const inIds = q.metodos.find((m) => m.nome === 'in' && m.args[0] === 'id')
      expect(inIds.args[1].length).toBeLessThanOrEqual(CONV_ID_IN_CHUNK)
    }
  })

  it('lista vazia não toca no banco', async () => {
    const mapa = await listLastMessagesByConversation(EMPRESA, [])
    expect(mapa.size).toBe(0)
    expect(mockEstado.chamadas).toHaveLength(0)
  })
})

describe('(b) respostas pós-transferência: janela de data e teto', () => {
  it('aplica gte na transferência MAIS ANTIGA do lote, limit 1 por conversa e teto = tamanho do lote', async () => {
    const transferMap = transferMapCenario()
    await listRespostasAtendenteAposTransferencias(EMPRESA, [10, 20, 30], USER_B, transferMap)

    expect(chamadasDaTabela('mensagens')).toHaveLength(0)
    const [q] = chamadasDaTabela('conversas')
    expect(q).toBeTruthy()
    const maisAntiga = iso(8) // conversa 30
    expect(transferenciaMaisAntigaIso([10, 20, 30], transferMap)).toBe(maisAntiga)
    expect(q.metodos).toEqual(expect.arrayContaining([
      { nome: 'eq', args: ['company_id', EMPRESA] },
      { nome: 'eq', args: ['mensagens.company_id', EMPRESA] },
      { nome: 'eq', args: ['mensagens.direcao', 'out'] },
      { nome: 'eq', args: ['mensagens.autor_usuario_id', USER_B] },
      { nome: 'gte', args: ['mensagens.criado_em', maisAntiga] },
      { nome: 'limit', args: [1, { referencedTable: 'mensagens' }] },
      { nome: 'limit', args: [3, {}] },
    ]))
    for (const c of mockEstado.chamadas) expect(usouMetodo(c, 'range')).toBe(false)
  })

  it('o teto nunca trunca: no máximo uma linha por conversa transferida', async () => {
    const transferMap = transferMapCenario()
    // Muitas `out` do USER_B depois da transferência na conversa 10 — a antiga traria todas.
    for (let m = 31; m < 31 + 50; m++) mockEstado.dados.mensagens.push(msg(10, 'out', m, { autor_usuario_id: USER_B }))
    const linhas = await listRespostasAtendenteAposTransferencias(EMPRESA, [10, 20, 30], USER_B, transferMap)
    const porConversa = new Map(linhas.map((l) => [l.conversa_id, l]))
    expect(linhas.length).toBe(porConversa.size)
    expect(linhas.length).toBeLessThanOrEqual(transferMap.size)
    // Cada linha é a ÚLTIMA out do usuário na conversa (a de maior criado_em).
    expect(porConversa.get(10).criado_em).toBe(iso(80))
  })

  it('sem transferência com data válida, não consulta nada', async () => {
    const transferMap = new Map([[10, { criado_em: null, id: 1 }]])
    const linhas = await listRespostasAtendenteAposTransferencias(EMPRESA, [10], USER_B, transferMap)
    expect(linhas).toEqual([])
    expect(mockEstado.chamadas).toHaveLength(0)
  })
})

describe('(c) paridade com a implementação antiga — 3 conversas × 5 mensagens', () => {
  function normalizarMapa(mapa) {
    return [...mapa.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([cid, m]) => [cid, { conversa_id: Number(m.conversa_id), direcao: m.direcao, criado_em: m.criado_em }])
  }

  it('última mensagem por conversa é idêntica (chaves, direcao e criado_em)', async () => {
    const ids = [10, 20, 30]
    const antiga = await listLastMessagesByConversationAntiga(EMPRESA, ids)
    // Prova que o oráculo paginou de verdade (OFFSET) antes de comparar.
    expect(chamadasDaTabela('mensagens').length).toBeGreaterThan(1)
    expect(chamadasDaTabela('mensagens').every((q) => usouMetodo(q, 'range'))).toBe(true)

    mockEstado.chamadas = []
    const nova = await listLastMessagesByConversation(EMPRESA, ids)

    expect(normalizarMapa(nova)).toEqual(normalizarMapa(antiga))
    expect(normalizarMapa(nova)).toEqual([
      [10, { conversa_id: 10, direcao: 'out', criado_em: iso(30) }],
      [20, { conversa_id: 20, direcao: 'in', criado_em: iso(45) }],
      [30, { conversa_id: 30, direcao: 'in', criado_em: iso(50) }],
    ])
    // Linhas da outra empresa e de conversa fora da lista não vazam.
    expect(nova.has(40)).toBe(false)
    expect(nova.has(50)).toBe(false)
  })

  it('Set de "respondeu após transferência" é idêntico', async () => {
    const transferMap = transferMapCenario()
    const linhasAntigas = await listRespostasAntiga(EMPRESA, USER_B, transferMap)
    const setAntigo = buildRespostaAposTransferenciaSet(linhasAntigas, transferMap, USER_B)

    const linhasNovas = await listRespostasAtendenteAposTransferencias(EMPRESA, [10, 20, 30], USER_B, transferMap)
    const setNovo = buildRespostaAposTransferenciaSet(linhasNovas, transferMap, USER_B)

    expect([...setNovo].sort()).toEqual([...setAntigo].sort())
    // 10 respondida após a transferência; 20 só ANTES (não conta); 30 nunca.
    expect([...setNovo]).toEqual([10])
    // A versão antiga trazia mais linhas (todas as out do usuário); a nova, no máximo 1 por conversa.
    expect(linhasAntigas.length).toBeGreaterThan(linhasNovas.length)
  })
})
