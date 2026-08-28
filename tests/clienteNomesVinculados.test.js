const fs = require('fs')
const path = require('path')
const {
  alunosParaVincular,
  anexarVinculosNasLinhas,
  agruparVinculosPorCliente,
  uniqueIds,
  normalizeNomeVinculado,
  upsertVinculosDoLote,
  resolverEncontradoPor,
} = require('../helpers/clienteNomesVinculados')

describe('clienteNomesVinculados — regras puras', () => {
  const alunos = [
    { nome: 'Arthur Miguel de Oliveira', serie: '6º Ano' },
    { nome: 'Isabela Maria de Oliveira', serie: '1ª Série do Ensino Médio' },
  ]

  it('exclui o nome principal e preserva nome+série', () => {
    const out = alunosParaVincular(alunos, 'Arthur Miguel de Oliveira')
    expect(out).toEqual([
      {
        nome: 'Isabela Maria de Oliveira',
        serie: '1ª Série do Ensino Médio',
        nome_normalizado: 'isabela maria de oliveira',
      },
    ])
  })

  it('não duplica o mesmo nome normalizado', () => {
    const out = alunosParaVincular(
      [
        { nome: 'Isabela Maria de Oliveira', serie: '1ª Série' },
        { nome: 'ISABELA MARIA DE OLIVEIRA', serie: '2ª Série' },
      ],
      'Arthur'
    )
    expect(out).toHaveLength(1)
    expect(out[0].serie).toBe('2ª Série')
  })

  it('pesquisa parcial, acento e caixa no encontrado_por', () => {
    const row = { contato_nome: 'Arthur Miguel de Oliveira', cliente_id: 1 }
    const vinculos = [{ nome: 'Isabela Maria de Oliveira', serie: '1ª Série' }]
    expect(resolverEncontradoPor(row, 'Isabela', vinculos, 'prefix')).toBe('Isabela Maria de Oliveira')
    expect(resolverEncontradoPor(row, 'isabela', vinculos, 'prefix')).toBe('Isabela Maria de Oliveira')
    expect(resolverEncontradoPor(row, 'ISABELA MARIA', vinculos, 'prefix')).toBe('Isabela Maria de Oliveira')
    expect(resolverEncontradoPor(row, 'Isabelá', vinculos, 'prefix')).toBe('Isabela Maria de Oliveira')
    expect(resolverEncontradoPor(row, 'Arthur', vinculos, 'prefix')).toBeNull()
  })

  it('anexa um único resultado por contato sem duplicar', () => {
    const rows = [
      { id: 9, cliente_id: 1, contato_nome: 'Arthur Miguel de Oliveira' },
      { id: 9, cliente_id: 1, contato_nome: 'Arthur Miguel de Oliveira' },
    ]
    const uniqueRows = uniqueIds(rows.map((r) => r.cliente_id)).map((cliente_id) => ({
      cliente_id,
      contato_nome: 'Arthur Miguel de Oliveira',
    }))
    expect(uniqueRows).toHaveLength(1)
    anexarVinculosNasLinhas(
      uniqueRows,
      agruparVinculosPorCliente([
        { cliente_id: 1, nome: 'Isabela Maria de Oliveira', serie: '1ª Série' },
      ]),
      'Isabela',
      'prefix'
    )
    expect(uniqueRows[0].encontrado_por).toBe('Isabela Maria de Oliveira')
    expect(uniqueRows[0].nomes_vinculados).toHaveLength(1)
  })

  it('normalize equivale ao prefixo de busca atual', () => {
    expect(normalizeNomeVinculado('José Humberto')).toBe('jose humberto')
    expect(normalizeNomeVinculado('  ISABELA—MARIA  ')).toBe('isabela maria')
  })
})

describe('clienteNomesVinculados — persistência em lote', () => {
  function makeSb() {
    const db = { cliente_nomes_vinculados: [] }
    let seq = 1
    return {
      __db: db,
      from(table) {
        const preds = []
        let payload = null
        let op = 'select'
        const builder = {
          select() { return builder },
          insert(data) { payload = data; op = 'insert'; return builder },
          update(data) { payload = data; op = 'update'; return builder },
          eq(col, val) { preds.push((row) => row[col] === val); return builder },
          in(col, arr) { const set = new Set(arr); preds.push((row) => set.has(row[col])); return builder },
          then(resolve) {
            if (op === 'insert') {
              const rows = Array.isArray(payload) ? payload : [payload]
              for (const row of rows) {
                const dup = db[table].find(
                  (r) =>
                    r.company_id === row.company_id &&
                    r.cliente_id === row.cliente_id &&
                    r.nome_normalizado === row.nome_normalizado
                )
                if (dup) return resolve({ data: null, error: { code: '23505' } })
              }
              for (const row of rows) db[table].push({ id: seq++, ...row })
              return resolve({ data: null, error: null })
            }
            if (op === 'update') {
              db[table] = db[table].map((r) => (preds.every((p) => p(r)) ? { ...r, ...payload } : r))
              return resolve({ data: null, error: null })
            }
            return resolve({
              data: db[table].filter((r) => preds.every((p) => p(r))).map((r) => ({ ...r })),
              error: null,
            })
          },
        }
        return builder
      },
    }
  }

  it('isola por company_id e não mistura empresas', async () => {
    const sb = makeSb()
    await upsertVinculosDoLote(sb, 7, [{
      clienteId: 10,
      nomePrincipal: 'Arthur',
      alunos: [
        { nome: 'Arthur', serie: '6º' },
        { nome: 'Isabela', serie: '1ª' },
      ],
    }])
    await upsertVinculosDoLote(sb, 8, [{
      clienteId: 99,
      nomePrincipal: 'Arthur',
      alunos: [
        { nome: 'Arthur', serie: '6º' },
        { nome: 'Outra Empresa', serie: '1ª' },
      ],
    }])
    expect(sb.__db.cliente_nomes_vinculados.filter((r) => r.company_id === 7)).toHaveLength(1)
    expect(sb.__db.cliente_nomes_vinculados.filter((r) => r.company_id === 8)[0].nome).toBe('Outra Empresa')
    expect(sb.__db.cliente_nomes_vinculados.filter((r) => r.company_id === 7)[0].nome).toBe('Isabela')
  })
})

describe('clienteNomesVinculados — limites de origem', () => {
  const raiz = path.join(__dirname, '..')
  const arquivosWhatsapp = [
    'helpers/conversationSync.js',
    'controllers/webhookZapiController.js',
    'controllers/webhookUltramsgController.js',
    'services/ultramsgSyncContact.js',
    'services/contactSyncService.js',
    'services/syncFotosProgressivaService.js',
  ]

  it('fluxos de WhatsApp/webhook/sync não gravam nomes vinculados', () => {
    for (const rel of arquivosWhatsapp) {
      const src = fs.readFileSync(path.join(raiz, rel), 'utf8')
      expect(src).not.toMatch(/cliente_nomes_vinculados/)
      expect(src).not.toMatch(/upsertVinculosDoLote/)
    }
  })

  it('migration cria tabela isolada, UNIQUE e EXISTS sem JOIN duplicador', () => {
    const sql = fs.readFileSync(
      path.join(raiz, 'supabase/migrations/20260827220000_cliente_nomes_vinculados.sql'),
      'utf8'
    )
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.cliente_nomes_vinculados/)
    expect(sql).toMatch(/UNIQUE \(company_id, cliente_id, nome_normalizado\)/)
    expect(sql).toMatch(/ON DELETE CASCADE/)
    expect(sql).toMatch(/origem = 'planilha'/)
    expect(sql).toMatch(/EXISTS \(/)
    expect(sql).not.toMatch(/JOIN\s+cliente_nomes_vinculados/)
    expect(sql).toMatch(/DROP TABLE IF EXISTS public\.cliente_nomes_vinculados/)
  })
})
