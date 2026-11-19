/**
 * Ranking gamificado de atendentes (doc 42).
 *
 * Cobre: regra de período (fuso, mínimo de 24h, continuidade semanal), classificação
 * (empates, vencedores múltiplos), contagem igual à da Supervisão (só `encerrou`, por quem
 * encerrou, só da empresa), encerramento único (concorrência e "reinício"), novo ciclo sem
 * sobreposição, config valendo para o próximo ciclo, desligar/religar, resultado consolidado
 * imune a alterações posteriores e tabela ausente (migration não aplicada).
 */

// ---------------------------------------------------------------------------
// Supabase falso em memória (só o subconjunto de PostgREST que o serviço usa)
// ---------------------------------------------------------------------------
const db = { ranking_config: [], ranking_ciclos: [], atendimentos: [], usuarios: [] }
let seq = 1
let tabelasAusentes = false

function matches(row, filters) {
  return filters.every(([op, col, val]) => {
    const v = row[col]
    if (op === 'eq') return String(v) === String(val)
    if (op === 'in') return val.map(String).includes(String(v))
    if (op === 'gte') return new Date(v).getTime() >= new Date(val).getTime()
    if (op === 'lt') return new Date(v).getTime() < new Date(val).getTime()
    return true
  })
}

function mockBuilder(table) {
  const st = { op: 'select', filters: [], payload: null, order: null, range: null, limit: null, mode: 'many', returning: false, onConflict: null }
  const b = {
    select() { if (st.op !== 'select') st.returning = true; return b },
    insert(p) { st.op = 'insert'; st.payload = p; return b },
    update(p) { st.op = 'update'; st.payload = p; return b },
    upsert(p, opts) { st.op = 'upsert'; st.payload = p; st.onConflict = opts?.onConflict; return b },
    eq(c, v) { st.filters.push(['eq', c, v]); return b },
    in(c, v) { st.filters.push(['in', c, v]); return b },
    gte(c, v) { st.filters.push(['gte', c, v]); return b },
    lt(c, v) { st.filters.push(['lt', c, v]); return b },
    order(c, o) { st.order = [c, o?.ascending !== false]; return b },
    range(a, z) { st.range = [a, z]; return b },
    limit(n) { st.limit = n; return b },
    maybeSingle() { st.mode = 'maybe'; return b },
    single() { st.mode = 'single'; return b },
    then(resolve, reject) { return Promise.resolve().then(() => exec(table, st)).then(resolve, reject) },
  }
  return b
}

function exec(table, st) {
  if (tabelasAusentes && table.startsWith('ranking_')) {
    return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } }
  }
  const rows = db[table]
  let out
  if (st.op === 'insert') {
    const p = { ...st.payload }
    if (table === 'ranking_ciclos' && p.status === 'em_andamento' &&
      rows.some((r) => r.company_id === p.company_id && r.status === 'em_andamento')) {
      return { data: null, error: { code: '23505', message: 'duplicate key ux_ranking_ciclos_em_andamento' } }
    }
    const row = { id: seq++, criado_em: new Date().toISOString(), ...p }
    rows.push(row)
    out = [row]
  } else if (st.op === 'upsert') {
    const key = st.onConflict
    const i = rows.findIndex((r) => String(r[key]) === String(st.payload[key]))
    if (i >= 0) rows[i] = { ...rows[i], ...st.payload }
    else rows.push({ ...st.payload })
    out = [st.payload]
  } else if (st.op === 'update') {
    out = []
    rows.forEach((r, i) => {
      if (matches(r, st.filters)) { rows[i] = { ...r, ...st.payload }; out.push(rows[i]) }
    })
  } else {
    out = rows.filter((r) => matches(r, st.filters))
    if (st.order) {
      const [c, asc] = st.order
      out = [...out].sort((a, z) => (a[c] > z[c] ? 1 : a[c] < z[c] ? -1 : 0) * (asc ? 1 : -1))
    }
    if (st.range) out = out.slice(st.range[0], st.range[1] + 1)
    if (st.limit != null) out = out.slice(0, st.limit)
  }
  const copy = out.map((r) => JSON.parse(JSON.stringify(r)))
  if (st.op !== 'select' && !st.returning) return { data: null, error: null }
  if (st.mode === 'maybe') return { data: copy[0] || null, error: null }
  if (st.mode === 'single') return copy[0] ? { data: copy[0], error: null } : { data: null, error: { message: 'no rows' } }
  return { data: copy, error: null }
}

jest.mock('../config/supabase', () => ({ from: (t) => mockBuilder(t) }))
jest.mock('../helpers/empresaTimezone', () => ({
  getEmpresaTimezone: jest.fn(async () => ({ timezone: 'America/Sao_Paulo', timezone_label: 'Horário de Brasília' })),
}))

const regras = require('../services/rankingGamificado/rankingRegras')
const service = require('../services/rankingGamificado/rankingGamificadoService')
const { getEmpresaTimezone } = require('../helpers/empresaTimezone')

function fakeIo() {
  const emitidos = []
  return { emitidos, emitEmpresa: (cid, ev, payload) => emitidos.push({ cid, ev, payload }) }
}

function encerrou(company_id, de_usuario_id, criado_em, acao = 'encerrou') {
  db.atendimentos.push({ id: seq++, company_id, de_usuario_id, conversa_id: seq, acao, criado_em })
}

beforeEach(() => {
  db.ranking_config = []
  db.ranking_ciclos = []
  db.atendimentos = []
  db.usuarios = [
    { id: 1, company_id: 7, nome: 'João' },
    { id: 2, company_id: 7, nome: 'Maria' },
    { id: 3, company_id: 7, nome: 'Pedro' },
    { id: 9, company_id: 8, nome: 'Outra Empresa' },
  ]
  tabelasAusentes = false
  service._cacheClassificacao.clear()
  getEmpresaTimezone.mockClear()
})

// ---------------------------------------------------------------------------
// Regras puras
// ---------------------------------------------------------------------------
describe('calcularFimDoCiclo (fuso da empresa)', () => {
  const regra = { diaSemana: 5, horario: '18:00' } // sexta 18h

  test('ativou quarta 10h (Brasília) → termina nesta sexta 18h = 21h UTC', () => {
    const fim = regras.calcularFimDoCiclo(new Date('2026-11-18T13:00:00Z'), regra, 'America/Sao_Paulo')
    expect(fim.toISOString()).toBe('2026-11-20T21:00:00.000Z')
  })

  test('ciclo contínuo (início = fim anterior) dura exatamente 7 dias', () => {
    const fim = regras.calcularFimDoCiclo(new Date('2026-11-20T21:00:00Z'), regra, 'America/Sao_Paulo')
    expect(fim.toISOString()).toBe('2026-11-27T21:00:00.000Z')
  })

  test('ativou sexta 17h → não cria ciclo de 1 hora; vai para a sexta seguinte', () => {
    const fim = regras.calcularFimDoCiclo(new Date('2026-11-20T20:00:00Z'), regra, 'America/Sao_Paulo')
    expect(fim.toISOString()).toBe('2026-11-27T21:00:00.000Z')
  })

  test('respeita o fuso: 18h em Cuiabá é 22h UTC', () => {
    const fim = regras.calcularFimDoCiclo(new Date('2026-11-18T13:00:00Z'), regra, 'America/Cuiaba')
    expect(fim.toISOString()).toBe('2026-11-20T22:00:00.000Z')
  })

  test('fuso inválido cai em Brasília', () => {
    const fim = regras.calcularFimDoCiclo(new Date('2026-11-18T13:00:00Z'), regra, 'Marte/Olympus')
    expect(fim.toISOString()).toBe('2026-11-20T21:00:00.000Z')
  })

  test('dia/horário inválidos lançam', () => {
    expect(() => regras.calcularFimDoCiclo(new Date(), { diaSemana: 9, horario: '18:00' }, 'America/Sao_Paulo')).toThrow()
    expect(() => regras.calcularFimDoCiclo(new Date(), { diaSemana: 5, horario: '25:00' }, 'America/Sao_Paulo')).toThrow()
  })

  test('descrição legível', () => {
    expect(regras.descreverEncerramento(5, '18:00')).toBe('sexta-feira, às 18h')
    expect(regras.descreverEncerramento(1, '09:30')).toBe('segunda-feira, às 9h30')
  })
})

describe('montarClassificacao', () => {
  const nomes = { 1: 'João', 2: 'Maria', 3: 'Pedro', 4: 'Ana' }
  const rows = (pares) => pares.flatMap(([id, n]) => Array.from({ length: n }, () => ({ de_usuario_id: id })))

  test('ordena por total e posiciona 1, 2, 3…', () => {
    const r = regras.montarClassificacao(rows([[2, 74], [1, 87], [3, 61], [4, 49]]), nomes)
    expect(r.classificacao.map((i) => [i.posicao, i.nome, i.total])).toEqual([
      [1, 'João', 87], [2, 'Maria', 74], [3, 'Pedro', 61], [4, 'Ana', 49],
    ])
    expect(r.vencedores.map((v) => v.nome)).toEqual(['João'])
    expect(r.total_vencedor).toBe(87)
    expect(r.total_atendimentos).toBe(271)
  })

  test('empate no 1º lugar: TODOS são vencedores e a posição seguinte pula', () => {
    const r = regras.montarClassificacao(rows([[1, 10], [2, 10], [3, 4]]), nomes)
    expect(r.classificacao.map((i) => i.posicao)).toEqual([1, 1, 3])
    expect(r.vencedores.map((v) => v.usuario_id).sort()).toEqual([1, 2])
  })

  test('sem atendimentos não há vencedor', () => {
    const r = regras.montarClassificacao([], nomes)
    expect(r.classificacao).toEqual([])
    expect(r.vencedores).toEqual([])
    expect(r.total_vencedor).toBe(0)
  })

  test('linha sem de_usuario_id é ignorada', () => {
    const r = regras.montarClassificacao([{ de_usuario_id: null }, { de_usuario_id: 1 }], nomes)
    expect(r.total_atendimentos).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Serviço (banco falso)
// ---------------------------------------------------------------------------
async function ativar(cid = 7, regra = { dia_semana: 5, horario: '18:00' }) {
  return service.salvarConfig(cid, 1, { ativo: true, ...regra }, { io: fakeIo() })
}

function cicloEmAndamento(cid = 7) {
  return db.ranking_ciclos.find((c) => c.company_id === cid && c.status === 'em_andamento')
}

describe('contagem = regra da Supervisão ("Finalizadas hoje")', () => {
  test('só acao=encerrou, por quem encerrou, dentro da janela e da própria empresa', async () => {
    const ini = '2026-11-16T03:00:00Z'
    const fim = '2026-11-20T21:00:00Z'
    encerrou(7, 1, '2026-11-17T12:00:00Z')
    encerrou(7, 1, '2026-11-18T12:00:00Z')
    encerrou(7, 2, '2026-11-18T13:00:00Z')
    encerrou(7, 2, '2026-11-18T14:00:00Z', 'assumiu') // não conta
    encerrou(7, 3, '2026-11-18T15:00:00Z', 'transferiu') // não conta
    encerrou(7, 3, '2026-11-15T12:00:00Z') // antes da janela
    encerrou(7, 3, fim) // exatamente no fim → próximo ciclo
    encerrou(8, 9, '2026-11-18T12:00:00Z') // outra empresa

    const r = await service.calcularClassificacao(7, ini, fim)
    expect(r.classificacao.map((i) => [i.usuario_id, i.total])).toEqual([[1, 2], [2, 1]])

    // Mesmo predicado que supervisaoService usa em finalizadas_hoje.
    const supervisao = (uid) => db.atendimentos.filter(
      (a) => a.company_id === 7 && a.acao === 'encerrou' && Number(a.de_usuario_id) === uid &&
        new Date(a.criado_em) >= new Date(ini) && new Date(a.criado_em) < new Date(fim)
    ).length
    for (const item of r.classificacao) expect(item.total).toBe(supervisao(item.usuario_id))
  })
})

describe('ciclo de vida da competição', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    jest.setSystemTime(new Date('2026-11-18T13:00:00Z')) // quarta 10h Brasília
  })
  afterEach(() => jest.useRealTimers())

  test('ativar inicia o primeiro ciclo agora, terminando na sexta 18h', async () => {
    const painel = await ativar()
    expect(painel.config.ativo).toBe(true)
    const c = cicloEmAndamento()
    expect(c.inicio).toBe('2026-11-18T13:00:00.000Z')
    expect(c.fim).toBe('2026-11-20T21:00:00.000Z')
    expect(c.timezone).toBe('America/Sao_Paulo')
  })

  test('ativar duas vezes não cria dois ciclos', async () => {
    await ativar()
    await ativar()
    expect(db.ranking_ciclos.filter((c) => c.status === 'em_andamento')).toHaveLength(1)
  })

  test('encerra uma única vez, registra vencedor e abre o próximo sem sobreposição', async () => {
    await ativar()
    encerrou(7, 1, '2026-11-19T12:00:00Z')
    encerrou(7, 1, '2026-11-19T13:00:00Z')
    encerrou(7, 2, '2026-11-19T14:00:00Z')

    jest.setSystemTime(new Date('2026-11-20T21:00:30Z'))
    const io = fakeIo()
    const fechados = await service.encerrarCiclosVencidos(7, { io })
    expect(fechados).toHaveLength(1)
    expect(fechados[0].vencedores.map((v) => v.nome)).toEqual(['João'])
    expect(fechados[0].total_vencedor).toBe(2)
    expect(io.emitidos.filter((e) => e.ev === service.EVENTO_VENCEDOR)).toHaveLength(1)

    const proximo = cicloEmAndamento()
    expect(proximo.inicio).toBe('2026-11-20T21:00:00.000Z') // = fim anterior
    expect(proximo.fim).toBe('2026-11-27T21:00:00.000Z')

    // Segunda chamada (outro tick / outro processo) não encerra nem anuncia de novo.
    const io2 = fakeIo()
    expect(await service.encerrarCiclosVencidos(7, { io: io2 })).toHaveLength(0)
    expect(io2.emitidos).toHaveLength(0)
    expect(db.ranking_ciclos.filter((c) => c.status === 'encerrado')).toHaveLength(1)
  })

  test('duas apurações concorrentes: só uma anuncia', async () => {
    await ativar()
    encerrou(7, 1, '2026-11-19T12:00:00Z')
    jest.setSystemTime(new Date('2026-11-20T21:01:00Z'))
    const io = fakeIo()
    await Promise.all([
      service.encerrarCiclosVencidos(7, { io }),
      service.encerrarCiclosVencidos(7, { io }),
    ])
    expect(io.emitidos.filter((e) => e.ev === service.EVENTO_VENCEDOR)).toHaveLength(1)
    expect(db.ranking_ciclos.filter((c) => c.status === 'encerrado')).toHaveLength(1)
    expect(db.ranking_ciclos.filter((c) => c.status === 'em_andamento')).toHaveLength(1)
  })

  test('após "reinício" (módulo recarregado) nada é reanunciado', async () => {
    await ativar()
    jest.setSystemTime(new Date('2026-11-20T21:01:00Z'))
    await service.encerrarCiclosVencidos(7, { io: fakeIo() })

    let fresh
    jest.isolateModules(() => { fresh = require('../services/rankingGamificado/rankingGamificadoService') })
    const io = fakeIo()
    expect(await fresh.encerrarCiclosVencidos(7, { io })).toHaveLength(0)
    expect(io.emitidos).toHaveLength(0)
  })

  test('queda entre encerrar e abrir o próximo: retoma do fim anterior (sem buraco)', async () => {
    await ativar()
    jest.setSystemTime(new Date('2026-11-20T21:01:00Z'))
    await service.encerrarCiclosVencidos(7, { io: fakeIo() })
    // simula o próximo ciclo nunca ter sido gravado
    db.ranking_ciclos = db.ranking_ciclos.filter((c) => c.status !== 'em_andamento')
    const r = await service.getRankingAtual(7, 1, { io: fakeIo() })
    expect(r.ciclo.inicio).toBe('2026-11-20T21:00:00.000Z')
  })

  test('empate no 1º lugar: todos reconhecidos como vencedores', async () => {
    await ativar()
    encerrou(7, 1, '2026-11-19T12:00:00Z')
    encerrou(7, 2, '2026-11-19T13:00:00Z')
    jest.setSystemTime(new Date('2026-11-20T21:01:00Z'))
    const [fechado] = await service.encerrarCiclosVencidos(7, { io: fakeIo() })
    expect(fechado.vencedores.map((v) => v.nome).sort()).toEqual(['João', 'Maria'])
  })

  test('semana sem atendimentos encerra sem vencedor', async () => {
    await ativar()
    jest.setSystemTime(new Date('2026-11-20T21:01:00Z'))
    const [fechado] = await service.encerrarCiclosVencidos(7, { io: fakeIo() })
    expect(fechado.vencedores).toEqual([])
  })

  test('resultado consolidado não muda se atendimentos forem apagados depois', async () => {
    await ativar()
    encerrou(7, 1, '2026-11-19T12:00:00Z')
    jest.setSystemTime(new Date('2026-11-20T21:01:00Z'))
    await service.encerrarCiclosVencidos(7, { io: fakeIo() })
    db.atendimentos = [] // ex.: conversa apagada (conversationDeletionService apaga atendimentos)
    const { itens } = await service.listarHistorico(7)
    expect(itens).toHaveLength(1)
    expect(itens[0].vencedores[0].nome).toBe('João')
    expect(itens[0].total_vencedor).toBe(1)
  })

  test('mudar dia/horário NÃO altera o ciclo em andamento; vale para o próximo', async () => {
    await ativar()
    const antes = { ...cicloEmAndamento() }
    await service.salvarConfig(7, 1, { ativo: true, dia_semana: 3, horario: '12:00' }, { io: fakeIo() })
    const depois = cicloEmAndamento()
    expect(depois.id).toBe(antes.id)
    expect(depois.fim).toBe(antes.fim)

    const painel = await service.getRankingAtual(7, 1, { resumo: true })
    expect(painel.proximo_ciclo_com_nova_regra).toBe(true)

    jest.setSystemTime(new Date('2026-11-20T21:01:00Z'))
    await service.encerrarCiclosVencidos(7, { io: fakeIo() })
    const prox = cicloEmAndamento()
    expect(prox.inicio).toBe('2026-11-20T21:00:00.000Z')
    expect(prox.fim).toBe('2026-11-25T15:00:00.000Z') // quarta 12h Brasília
    expect(prox.dia_semana).toBe(3)
  })

  test('desativar cancela sem vencedor; religar começa do zero agora', async () => {
    await ativar()
    encerrou(7, 1, '2026-11-18T14:00:00Z')
    const io = fakeIo()
    await service.salvarConfig(7, 1, { ativo: false, dia_semana: 5, horario: '18:00' }, { io })
    expect(cicloEmAndamento()).toBeUndefined()
    expect(db.ranking_ciclos[0].status).toBe('cancelado')
    expect(io.emitidos.some((e) => e.ev === service.EVENTO_VENCEDOR)).toBe(false)
    expect(io.emitidos.some((e) => e.ev === service.EVENTO_CONFIG && e.payload.ativo === false)).toBe(true)
    expect((await service.getRankingAtual(7, 1)).ativo).toBe(false)

    jest.setSystemTime(new Date('2026-11-19T13:00:00Z'))
    await ativar()
    expect(cicloEmAndamento().inicio).toBe('2026-11-19T13:00:00.000Z')
  })

  test('painel ao vivo marca o próprio atendente e apura sozinho ciclo vencido', async () => {
    await ativar()
    encerrou(7, 1, '2026-11-18T14:00:00Z')
    encerrou(7, 2, '2026-11-18T14:10:00Z')
    encerrou(7, 2, '2026-11-18T14:20:00Z')
    const r = await service.getRankingAtual(7, 1)
    expect(r.classificacao.map((i) => i.nome)).toEqual(['Maria', 'João'])
    expect(r.eu).toEqual({ usuario_id: 1, posicao: 2, total: 1 })

    const semPontos = await service.getRankingAtual(7, 3)
    expect(semPontos.eu).toEqual({ usuario_id: 3, posicao: null, total: 0 })

    // scheduler parado: quem abre a tela depois do fim dispara a apuração (uma vez)
    jest.setSystemTime(new Date('2026-11-20T22:00:00Z'))
    const io = fakeIo()
    const depois = await service.getRankingAtual(7, 1, { io })
    expect(depois.ultimo_resultado.vencedores[0].nome).toBe('Maria')
    expect(io.emitidos.filter((e) => e.ev === service.EVENTO_VENCEDOR)).toHaveLength(1)
  })

  test('isolamento: o ranking de uma empresa não enxerga a outra', async () => {
    await ativar(7)
    await ativar(8)
    encerrou(8, 9, '2026-11-18T14:00:00Z')
    const r7 = await service.getRankingAtual(7, 1)
    expect(r7.classificacao).toEqual([])
    const r8 = await service.getRankingAtual(8, 9)
    expect(r8.classificacao.map((i) => i.nome)).toEqual(['Outra Empresa'])
  })
})

describe('validação e robustez', () => {
  test('dia/horário inválidos → 400', async () => {
    await expect(service.salvarConfig(7, 1, { ativo: true, dia_semana: 8, horario: '18:00' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(service.salvarConfig(7, 1, { ativo: true, dia_semana: 5, horario: '18h' })).rejects.toMatchObject({ statusCode: 400 })
    expect(db.ranking_config).toHaveLength(0)
  })

  test('migration não aplicada: ranking aparece desligado, sem erro', async () => {
    tabelasAusentes = true
    const r = await service.getRankingAtual(7, 1)
    expect(r).toMatchObject({ ativo: false, indisponivel: true })
    expect((await service.listarHistorico(7)).indisponivel).toBe(true)
    await expect(service.salvarConfig(7, 1, { ativo: true, dia_semana: 5, horario: '18:00' })).rejects.toMatchObject({ statusCode: 503 })
  })

  test('scheduler tolera tabela ausente e não derruba nada', async () => {
    tabelasAusentes = true
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { runRankingCycle } = require('../services/rankingGamificado/rankingGamificadoScheduler')
    await expect(runRankingCycle(null)).resolves.toMatchObject({ ok: true, indisponivel: true })
    warn.mockRestore()
  })
})
