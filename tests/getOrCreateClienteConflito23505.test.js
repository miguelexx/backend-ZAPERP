/**
 * Recuperação de 23505 (chave duplicada) no getOrCreateCliente.
 *
 * Cenário do botão "Conversar" com um cliente que JÁ existe: o INSERT/upsert falha com
 * 23505 e a busca por variantes de telefone não localiza o registro (formato divergente).
 * Antes, isso retornava { cliente_id: null } → 400 "Não foi possível salvar o contato".
 * Agora, o valor exato reportado pelo Postgres no erro é usado para localizar e reutilizar
 * o registro — a conversa sempre abre. Ver conversationSync.findClienteRowByUniqueConflict.
 */

const supabaseMock = { from: null }
jest.mock('../config/supabase', () => ({ from: (...a) => supabaseMock.from(...a) }))

const { getOrCreateCliente } = require('../helpers/conversationSync')

/**
 * Mock de Supabase que simula um índice único cujo valor gravado NÃO bate com nenhuma
 * variante gerada pela busca (telefone armazenado em formato divergente). Qualquer INSERT
 * ou upsert (não-ignoreDuplicates) para a mesma empresa lança 23505 apontando, no `details`,
 * o telefone REAL já existente — exatamente como o PostgREST faz em produção.
 */
function makeConflitoSupabase(existingRow) {
  const db = { clientes: [{ ...existingRow }] }
  function from() {
    const preds = []
    let op = 'select'
    let payload = null
    let ignoreDuplicates = false
    const dupError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "clientes_company_telefone_unique"',
      details: `Key (company_id, telefone)=(${existingRow.company_id}, ${existingRow.telefone}) already exists.`,
    }
    const builder = {
      select() { return builder },
      insert(d) { op = 'insert'; payload = d; return builder },
      upsert(d, opts) { op = 'upsert'; payload = d; ignoreDuplicates = !!(opts && opts.ignoreDuplicates); return builder },
      update(d) { op = 'update'; payload = d; return builder },
      eq(col, val) { preds.push((r) => r[col] === val); return builder },
      neq(col, val) { preds.push((r) => r[col] !== val); return builder },
      in(col, arr) { const s = new Set(arr); preds.push((r) => s.has(r[col])); return builder },
      like(col, pattern) {
        const re = new RegExp('^' + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$')
        preds.push((r) => typeof r[col] === 'string' && re.test(r[col]))
        return builder
      },
      not() { return builder },
      is() { return builder },
      order() { return builder },
      limit() { return builder },
      _selected() { return db.clientes.filter((r) => preds.every((p) => p(r))) },
      async maybeSingle() {
        // upsert com ignoreDuplicates que bate em conflito não retorna linha (ON CONFLICT DO NOTHING).
        if (op === 'upsert') return { data: null, error: ignoreDuplicates ? null : dupError }
        const r = builder._selected()[0]
        return { data: r ? { ...r } : null, error: null }
      },
      async single() {
        if (op === 'insert') return { data: null, error: dupError } // sempre conflita
        const r = builder._selected()[0]
        return { data: r ? { ...r } : null, error: r ? null : { message: 'not found' } }
      },
      then(resolve) {
        if (op === 'select') return resolve({ data: builder._selected().map((r) => ({ ...r })), error: null })
        if (op === 'insert') return resolve({ data: null, error: dupError })
        if (op === 'upsert') {
          if (ignoreDuplicates) return resolve({ data: null, error: null }) // DO NOTHING silencioso
          return resolve({ data: null, error: dupError })
        }
        if (op === 'update') { for (const r of db.clientes) if (preds.every((p) => p(r))) Object.assign(r, payload); return resolve({ data: null, error: null }) }
        return resolve({ data: null, error: null })
      },
    }
    return builder
  }
  return { from, _db: db }
}

const COMPANY = 7

describe('getOrCreateCliente — 23505 reutiliza o registro em conflito (não retorna null)', () => {
  test('telefone gravado em formato divergente: recupera pelo valor do erro e reaproveita', async () => {
    // Registro real gravado com um valor que a busca por variantes NÃO gera.
    const existente = { id: 4242, company_id: COMPANY, telefone: '000000000000', nome: 'Alex Maranata' }
    const sb = makeConflitoSupabase(existente)

    const res = await getOrCreateCliente(sb, COMPANY, '5534996621011', { nome: 'Alex Maranata cliente', allowNonBR: true })

    expect(res.cliente_id).toBe(4242)
    expect(res.created).toBe(false)
    // Não criou linha nova: continua só o registro existente.
    expect(sb._db.clientes).toHaveLength(1)
  })

  test('sem details no erro, os fallbacks por telefone ainda reaproveitam o registro', async () => {
    const existente = { id: 99, company_id: COMPANY, telefone: '5534996621011', nome: 'Cliente' }
    const sb = makeConflitoSupabase(existente)
    // Remove o details para forçar o caminho dos fallbacks (busca por variante exata).
    const origFrom = sb.from

    const res = await getOrCreateCliente(sb, COMPANY, '5534996621011', { nome: 'Cliente', allowNonBR: true })
    expect(res.cliente_id).toBe(99)
    expect(res.created).toBe(false)
    void origFrom
  })
})
