// Banco em memória: exercita persistência, filtros de empresa e estados reais do serviço.
function contactSyncDb(seed = {}) {
  const tables = { clientes: [], jobs: [], sync_locks: [], checkpoints_sync: [], ...seed }
  const calls = []
  const failures = {}
  let sequence = 100
  const from = jest.fn((table) => {
    tables[table] ||= []
    const op = { table, action: 'select', filters: [], payload: null, limit: Infinity }
    const query = {
      select: () => query,
      eq: (key, value) => { op.filters.push((row) => row[key] === value); return query },
      in: (key, values) => { op.filters.push((row) => values.includes(row[key])); return query },
      lt: (key, value) => { op.filters.push((row) => row[key] < value); return query },
      or: () => query,
      order: (key, options = {}) => { op.order = [key, options.ascending !== false]; return query },
      limit: (n) => { op.limit = n; return query },
      insert: (payload) => { op.action = 'insert'; op.payload = payload; return query },
      upsert: (payload, options) => { op.action = 'upsert'; op.payload = payload; op.options = options; return query },
      update: (payload) => { op.action = 'update'; op.payload = payload; return query },
      delete: () => { op.action = 'delete'; return query },
      single: () => { op.single = true; return query },
      maybeSingle: () => { op.single = true; return query },
      then: (resolve, reject) => Promise.resolve().then(() => {
        calls.push(op)
        if (failures[`${table}:${op.action}`]) return { data: null, error: failures[`${table}:${op.action}`] }
        let rows = tables[table].filter((row) => op.filters.every((fn) => fn(row)))
        if (op.order) rows.sort((a, b) => (a[op.order[0]] > b[op.order[0]] ? 1 : -1) * (op.order[1] ? 1 : -1))
        rows = rows.slice(0, op.limit)
        if (op.action === 'insert' || op.action === 'upsert') {
          const payload = op.payload
          const keys = op.options?.onConflict?.split(',') || (table === 'sync_locks' ? ['company_id', 'tipo'] : [])
          const existing = keys.length ? tables[table].find((row) => keys.every((key) => row[key] === payload[key])) : null
          if (existing && op.action === 'insert') return { data: null, error: { code: '23505' } }
          if (existing) {
            if (op.options?.ignoreDuplicates) rows = []
            else { Object.assign(existing, payload); rows = [existing] }
          } else {
            const row = { id: ++sequence, locked_at: new Date().toISOString(), ...payload }
            tables[table].push(row)
            rows = [row]
          }
        } else if (op.action === 'update') rows.forEach((row) => Object.assign(row, op.payload))
        else if (op.action === 'delete') tables[table] = tables[table].filter((row) => !rows.includes(row))
        return { data: op.single ? (rows[0] || null) : rows, error: null }
      }).then(resolve, reject),
    }
    return query
  })
  return { from, tables, calls, failures }
}
module.exports = { contactSyncDb }
