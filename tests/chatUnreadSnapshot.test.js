const supabase = require('../config/supabase')
const { getUnreadSnapshot } = require('../services/chatUnreadSnapshotService')

function splitOr(text) {
  let depth = 0
  let start = 0
  const parts = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    if (text[i] === ')') depth--
    if (text[i] === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1 }
  }
  parts.push(text.slice(start))
  return parts
}

function matches(row, expression) {
  if (expression.startsWith('and(')) return splitOr(expression.slice(4, -1)).every((p) => matches(row, p))
  const [field, op, ...rest] = expression.split('.')
  const value = rest.join('.')
  if (op === 'is') return row[field] == null
  if (op === 'eq') return String(row[field]) === value
  if (op === 'neq') return row[field] != null && String(row[field]) !== value
  if (op === 'in') return value.slice(1, -1).split(',').includes(String(row[field]))
  throw new Error(`Filtro não suportado: ${expression}`)
}

let db, calls, failTable
beforeEach(() => {
  db = { conversas: [], conversa_unreads: [], atendimentos: [], conversa_atendentes: [], departamento_grupos: [] }
  calls = []
  failTable = null
  supabase.from.mockImplementation((table) => {
    let rows = [...db[table]], start = 0, end = Infinity
    const call = { table, filters: [] }
    calls.push(call)
    const query = {
      select() { return this },
      eq(key, value) { call.filters.push(['eq', key, value]); rows = rows.filter((r) => r[key] === value); return this },
      gt(key, value) { rows = rows.filter((r) => r[key] > value); return this },
      in(key, values) { rows = rows.filter((r) => values.includes(r[key])); return this },
      or(expr) { call.filters.push(['or', expr]); rows = rows.filter((r) => splitOr(expr).some((p) => matches(r, p))); return this },
      order(key) { rows.sort((a, b) => a[key] - b[key]); return this },
      limit(size) { end = size - 1; return this },
      range(from, to) { start = from; end = to; return this },
      then(resolve, reject) { return Promise.resolve(table === failTable
        ? { error: new Error('DB indisponível') } : { data: rows.slice(start, end + 1), error: null }).then(resolve, reject) },
    }
    return query
  })
})

function add(id, extra = {}, unread = 1) {
  db.conversas.push({ id, company_id: 7, departamento_id: null, tipo: null, atendente_id: null, ...extra })
  db.conversa_unreads.push({ conversa_id: id, company_id: 7, usuario_id: 4, unread_count: unread })
}
const req = { user: { company_id: 7, id: 4, perfil: 'atendente', departamento_ids: [10] }, query: {} }

test('snapshot usa visibilidade, inclui outras abas e exclui outro usuário/empresa', async () => {
  add(1, { departamento_id: 10 }, 3)
  add(2, { departamento_id: 99 }, 5)
  add(3, { departamento_id: 99, atendente_id: 4 }, 2)
  add(4, { status_atendimento: 'fechada' }, 4)
  add(5, { status_atendimento: 'mensagem_disparada' }, 6)
  add(6, { company_id: 8 }, 100)
  db.conversa_unreads.push({ conversa_id: 1, company_id: 7, usuario_id: 88, unread_count: 100 })
  const result = await getUnreadSnapshot({ ...req, query: { departamento_id: 99, palavra: 'xxx', status_atendimento: 'fechada' } })
  expect(result.unread_by_id).toEqual({ 1: 3, 3: 2, 4: 4, 5: 6 })
  expect(result.unread_total).toBe(15)
  expect(calls.every((c) => c.filters.some((f) => f[0] === 'eq' && f[1] === 'company_id' && f[2] === 7))).toBe(true)
})

test('grupos, participantes e quem transferiu seguem a permissão da lista', async () => {
  for (let id = 1; id <= 6; id++) add(id, { departamento_id: 99, tipo: id <= 3 ? 'grupo' : null })
  db.departamento_grupos.push({ id: 1, company_id: 7, conversa_id: 1, departamento_id: 10 },
    { id: 2, company_id: 7, conversa_id: 2, departamento_id: 99 })
  db.conversa_atendentes.push({ id: 1, company_id: 7, conversa_id: 4, usuario_id: 4, ativo: true })
  db.atendimentos.push(...Array.from({ length: 450 }, (_, i) => ({ id: i + 1, company_id: 7, conversa_id: 5, de_usuario_id: 4, acao: 'transferiu' })))
  expect((await getUnreadSnapshot(req)).unread_by_id).toEqual({ 1: 1, 3: 1, 4: 1, 5: 1 })
  expect(calls.filter((c) => c.table === 'atendimentos')).toHaveLength(3)
})

test('pagina todas as não lidas, sem limite de 1000 e sem contar IDs apagados', async () => {
  for (let id = 1; id <= 1201; id++) add(id)
  db.conversas = db.conversas.filter((r) => r.id !== 1201)
  const result = await getUnreadSnapshot({ ...req, user: { ...req.user, perfil: 'admin' } })
  expect(Object.keys(result.unread_by_id)).toHaveLength(1200)
  expect(result.unread_total).toBe(1200)
  expect(calls.filter((c) => c.table === 'conversa_unreads')).toHaveLength(7)
})

test('falha de leitura ou permissão não vira snapshot vazio; sessão inválida não consulta DB', async () => {
  add(1)
  failTable = 'conversa_unreads'
  await expect(getUnreadSnapshot(req)).rejects.toThrow('DB indisponível')
  failTable = 'departamento_grupos'
  await expect(getUnreadSnapshot(req)).rejects.toThrow('DB indisponível')
  calls = []
  await expect(getUnreadSnapshot({ user: {} })).rejects.toThrow('Escopo')
  expect(calls).toHaveLength(0)
})
