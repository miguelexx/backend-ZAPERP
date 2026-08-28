const fs = require('fs')
const path = require('path')
const {
  decidirPatchNomeCliente,
  podeEscreverNome,
  clienteTemNomeProtegido,
  ORIGEM_IMPORT_PLANILHA,
  ORIGEM_MANUAL,
} = require('../helpers/clienteNomeProtecao')
const { chooseBestName } = require('../helpers/contactEnrichment')
const { mergeAndReturnCliente, getOrCreateCliente } = require('../helpers/conversationSync')

function aplicarTrigger(oldRow, updates) {
  const next = { ...oldRow, ...updates }
  if (oldRow.nome_protegido === true && updates.nome !== undefined && updates.nome !== oldRow.nome) {
    if (!(updates.nome_override === true && (updates.nome_origem === 'manual' || updates.nome_origem === 'import_planilha'))) {
      next.nome = oldRow.nome
      next.nome_origem = oldRow.nome_origem
      next.nome_protegido = true
    } else {
      next.nome_protegido = true
    }
  }
  next.nome_override = false
  return next
}

function makeClientesFake(initial = []) {
  const db = { clientes: initial.map((r) => ({ ...r })), conversas: [] }
  let seq = db.clientes.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1

  function from(table) {
    const preds = []
    let payload = null
    let op = 'select'
    let inFilter = null
    const builder = {
      select() { return builder },
      insert(data) { payload = { ...data }; op = 'insert'; return builder },
      update(data) { payload = { ...data }; op = 'update'; return builder },
      upsert(data) { payload = { ...data }; op = 'upsert'; return builder },
      eq(col, val) { preds.push((row) => row[col] === val); return builder },
      in(col, arr) { inFilter = { col, set: new Set(arr) }; preds.push((row) => inFilter.set.has(row[col])); return builder },
      order() { return builder },
      limit() { return builder },
      like() { return builder },
      not() { return builder },
      is() { return builder },
      _matches(row) { return preds.every((p) => p(row)) },
      async maybeSingle() {
        if (op === 'insert') return builder._doInsert()
        if (op === 'upsert') return builder._doUpsert()
        if (op === 'update') return builder._doUpdate()
        const row = db[table].find((r) => builder._matches(r))
        return { data: row ? { ...row } : null, error: null }
      },
      async single() { return builder.maybeSingle() },
      then(resolve) {
        if (op === 'insert') return resolve(builder._doInsert())
        if (op === 'upsert') return resolve(builder._doUpsert())
        if (op === 'update') return resolve(builder._doUpdate())
        return resolve({ data: db[table].filter((r) => builder._matches(r)).map((r) => ({ ...r })), error: null })
      },
      _doInsert() {
        const dup = db.clientes.find((r) => r.company_id === payload.company_id && r.telefone === payload.telefone)
        if (dup) return Promise.resolve({ data: null, error: { code: '23505' } })
        const novo = { id: seq++, nome_protegido: false, nome_origem: null, ...payload }
        db.clientes.push(novo)
        return Promise.resolve({ data: { ...novo }, error: null })
      },
      _doUpsert() {
        const dup = db.clientes.find((r) => r.company_id === payload.company_id && r.telefone === payload.telefone)
        if (dup) return Promise.resolve({ data: null, error: null })
        return builder._doInsert()
      },
      _doUpdate() {
        const idx = db[table].findIndex((r) => builder._matches(r))
        if (idx < 0) return Promise.resolve({ data: null, error: null })
        const old = db[table][idx]
        const next = table === 'clientes' ? aplicarTrigger(old, payload) : { ...old, ...payload }
        db[table][idx] = next
        return Promise.resolve({ data: { ...next }, error: null })
      },
    }
    return builder
  }

  return { from, __db: db }
}

describe('proteção persistente do nome', () => {
  it('contato novo importado recebe nome da planilha e fica protegido', () => {
    const decided = decidirPatchNomeCliente(
      { nome: null, nome_protegido: false },
      'ALEXIA CRISTINA MARCHEZAN DOS SANTOS',
      ORIGEM_IMPORT_PLANILHA
    )
    expect(decided.decision).toBe('updated')
    expect(decided.patch).toMatchObject({
      nome: 'ALEXIA CRISTINA MARCHEZAN DOS SANTOS',
      nome_origem: ORIGEM_IMPORT_PLANILHA,
      nome_protegido: true,
      nome_override: true,
    })
  })

  it('contato existente com nome da mãe passa a exibir o aluno e fica protegido', () => {
    const decided = decidirPatchNomeCliente(
      { nome: 'KELEN CRISTINA MARCHEZAN DOS SANTOS', nome_protegido: false },
      'ALEXIA CRISTINA MARCHEZAN DOS SANTOS',
      ORIGEM_IMPORT_PLANILHA
    )
    expect(decided.patch.nome).toBe('ALEXIA CRISTINA MARCHEZAN DOS SANTOS')
    expect(decided.patch.nome_protegido).toBe(true)
  })

  it('mensagem recebida / push name / webhook / sync não alteram nome protegido', () => {
    const existente = {
      nome: 'ALEXIA CRISTINA MARCHEZAN DOS SANTOS',
      nome_protegido: true,
      nome_origem: ORIGEM_IMPORT_PLANILHA,
    }
    for (const src of ['senderName', 'pushname', 'chatName', 'name', 'syncUltramsg', 'old_messages_sync', 'grupo_sender']) {
      const d = decidirPatchNomeCliente(existente, 'KELEN CRISTINA MARCHEZAN DOS SANTOS', src)
      expect(d.patch).toBeNull()
      expect(d.nome).toBe(existente.nome)
      const chosen = chooseBestName(existente.nome, 'KELEN', src, { nomeProtegido: true })
      expect(chosen.decision).toBe('kept')
    }
  })

  it('edição manual altera o nome e permanece protegida', () => {
    const d = decidirPatchNomeCliente(
      { nome: 'ALEXIA', nome_protegido: true, nome_origem: ORIGEM_IMPORT_PLANILHA },
      'Alexia Marchezan',
      ORIGEM_MANUAL
    )
    expect(d.patch).toMatchObject({
      nome: 'Alexia Marchezan',
      nome_origem: ORIGEM_MANUAL,
      nome_protegido: true,
      nome_override: true,
    })
  })

  it('importação não sobrescreve nome manual sem confirmação', () => {
    const gate = podeEscreverNome(
      { nome: 'Nome Manual', nome_protegido: true, nome_origem: ORIGEM_MANUAL },
      ORIGEM_IMPORT_PLANILHA,
      { confirmarNomeManual: false }
    )
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toBe('manual_preservado')
  })

  it('importação sobrescreve nome manual somente com confirmação explícita', () => {
    const d = decidirPatchNomeCliente(
      { nome: 'Nome Manual', nome_protegido: true, nome_origem: ORIGEM_MANUAL },
      'ALEXIA CRISTINA MARCHEZAN DOS SANTOS',
      ORIGEM_IMPORT_PLANILHA,
      { confirmarNomeManual: true }
    )
    expect(d.patch.nome).toBe('ALEXIA CRISTINA MARCHEZAN DOS SANTOS')
  })
})

describe('getOrCreateCliente + trigger simulado', () => {
  it('upsert/webhook simultâneo preserva o nome importado', async () => {
    const sb = makeClientesFake([
      {
        id: 1,
        company_id: 7,
        telefone: '5534999514579',
        nome: 'ALEXIA CRISTINA MARCHEZAN DOS SANTOS',
        nome_protegido: true,
        nome_origem: ORIGEM_IMPORT_PLANILHA,
      },
    ])

    const webhook = await getOrCreateCliente(sb, 7, '5534999514579', {
      nome: 'KELEN CRISTINA MARCHEZAN DOS SANTOS',
      nomeSource: 'senderName',
    })
    expect(webhook.nome).toBe('ALEXIA CRISTINA MARCHEZAN DOS SANTOS')
    expect(sb.__db.clientes[0].nome).toBe('ALEXIA CRISTINA MARCHEZAN DOS SANTOS')
    expect(sb.__db.clientes[0].nome_protegido).toBe(true)

    const foto = await mergeAndReturnCliente(sb, 7, sb.__db.clientes[0], '5534999514579', {
      foto_perfil: 'https://cdn.example/kelen.jpg',
      foto_perfil_refresh: true,
      nome: 'KELEN',
      nomeSource: 'syncUltramsg',
    })
    expect(sb.__db.clientes[0].nome).toBe('ALEXIA CRISTINA MARCHEZAN DOS SANTOS')
    expect(sb.__db.clientes[0].foto_perfil).toBe('https://cdn.example/kelen.jpg')
    expect(foto.changed).toBe(true)
  })

  it('empresas permanecem isoladas', async () => {
    const sb = makeClientesFake()
    await getOrCreateCliente(sb, 7, '5534999514579', {
      nome: 'ALEXIA',
      nomeSource: ORIGEM_IMPORT_PLANILHA,
    })
    await getOrCreateCliente(sb, 8, '5534999514579', {
      nome: 'OUTRA EMPRESA',
      nomeSource: ORIGEM_IMPORT_PLANILHA,
    })
    expect(sb.__db.clientes).toHaveLength(2)
    expect(sb.__db.clientes.find((c) => c.company_id === 7).nome).toBe('ALEXIA')
    expect(sb.__db.clientes.find((c) => c.company_id === 8).nome).toBe('OUTRA EMPRESA')
  })

  it('segunda importação não duplica o contato', async () => {
    const sb = makeClientesFake()
    const a = await getOrCreateCliente(sb, 7, '5534999514579', {
      nome: 'ALEXIA',
      nomeSource: ORIGEM_IMPORT_PLANILHA,
    })
    const b = await getOrCreateCliente(sb, 7, '5534999514579', {
      nome: 'ALEXIA',
      nomeSource: ORIGEM_IMPORT_PLANILHA,
    })
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(a.cliente_id).toBe(b.cliente_id)
    expect(sb.__db.clientes).toHaveLength(1)
    expect(sb.__db.clientes[0].nome_protegido).toBe(true)
  })
})

describe('migration de proteção do nome', () => {
  it('declara colunas persistentes e trigger no banco', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20260827130000_clientes_nome_protegido.sql'),
      'utf8'
    )
    expect(sql).toContain('nome_origem')
    expect(sql).toContain('nome_protegido')
    expect(sql).toContain('trg_proteger_nome_cliente')
    expect(sql).toContain('import_planilha')
    expect(clienteTemNomeProtegido({ nome_protegido: true })).toBe(true)
  })
})
