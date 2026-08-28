const fs = require('fs')
const path = require('path')
const { detectColumns, planImport } = require('../helpers/clienteImportPlanner')
const { lerPlanilha } = require('../controllers/clienteImportController')._test

function resolverArquivo() {
  const candidatos = [
    path.join(__dirname, 'fixtures', 'Contatos_Alunos_ZapERP.xlsx'),
    path.join(process.env.USERPROFILE || '', 'Downloads', 'Contatos_Alunos_ZapERP.xlsx'),
  ]
  return candidatos.find((p) => p && fs.existsSync(p))
}

describe('planilha real Contatos_Alunos_ZapERP.xlsx', () => {
  const arquivo = resolverArquivo()

  const maybe = arquivo ? it : it.skip

  maybe('reconhece Nome/Telefone/Tags, 727 alunos e o caso Alexia', () => {
    const buffer = fs.readFileSync(arquivo)
    const { headers, dataRows } = lerPlanilha(buffer)
    expect(headers).toEqual(['Nome', 'Telefone', 'Tags'])
    const mapping = detectColumns(headers)
    expect(mapping).toMatchObject({ nome: 0, telefone: 1, serie: 2 })

    const plano = planImport(dataRows, mapping)
    expect(plano.stats.totalLinhas).toBe(727)
    expect(plano.stats.telefonesUnicos).toBeLessThan(727)
    expect(plano.stats.telefonesUnicos).toBeGreaterThan(0)
    expect(plano.conflicts.length).toBe(plano.stats.conflitos)

    const alexia = plano.entries.find((e) => /ALEXIA CRISTINA MARCHEZAN DOS SANTOS/i.test(e.nome))
      || plano.conflicts.find((c) => (c.nomesConflitantes || []).some((n) => /ALEXIA CRISTINA/i.test(n)))
    expect(alexia).toBeTruthy()
    const tel = alexia.telefoneNormalizado || alexia.telefone
    expect(tel).toBe('5534999514579')
    expect(tel.startsWith('55')).toBe(true)
    expect(String(tel).includes('e')).toBe(false)

    const tagsAlexia = alexia.tags || []
    expect(tagsAlexia.some((t) => t.includes('6º Ano'))).toBe(true)

    const compartilhado = plano.entries.find((e) => (e.alunos || []).length > 1)
    expect(compartilhado).toBeTruthy()
    expect(plano.conflicts.length).toBeGreaterThan(0)
    expect(plano.stats.telefonesUnicos).toBeLessThan(plano.stats.validas)

    const irmaos = plano.entries.find((e) =>
      (e.alunos || []).some((a) => /ISABELA/i.test(a.nome)) &&
      (e.alunos || []).some((a) => /ARTHUR/i.test(a.nome))
    )
    if (irmaos) {
      expect(irmaos.alunos.length).toBeGreaterThanOrEqual(2)
      expect(String(irmaos.telefoneNormalizado || irmaos.telefone)).toMatch(/^\d+$/)
    }

    const segunda = planImport(dataRows, mapping)
    expect(segunda.stats.telefonesUnicos).toBe(plano.stats.telefonesUnicos)
    expect(segunda.conflicts.length).toBe(plano.conflicts.length)
  })
})
