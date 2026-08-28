const {
  detectColumns,
  planImport,
  normalizeHeader,
  cellToPhoneString,
} = require('../helpers/clienteImportPlanner')

// Cabeçalhos reais do modelo (secretaria), com colunas irrelevantes ao redor.
const HEADERS_MODELO = [
  'Data',
  'Nome do(a) Aluno(a)',
  'Objetivo da Contratação',
  'Série (Ano)',
  'Turno',
  'CPF do(a) Aluno(a)',
  'Celular do(a) Responsável Pedagógico',
  'E-mail do (a) Responsável Pedagógico',
]

describe('clienteImportPlanner — detecção de colunas', () => {
  it('detecta nome, telefone e série pelos nomes exatos do modelo', () => {
    const m = detectColumns(HEADERS_MODELO)
    expect(m.nome).toBe(1)
    expect(m.serie).toBe(3)
    expect(m.telefone).toBe(6)
  })

  it('detecta mesmo com acentos/caixa/variação de espaços', () => {
    const m = detectColumns(['SÉRIE (ANO)', 'nome do(a)  aluno(a)', 'Celular do(a) Responsável Pedagógico'])
    expect(m.serie).toBe(0)
    expect(m.nome).toBe(1)
    expect(m.telefone).toBe(2)
  })

  it('detecta Nome, Telefone e Tags da planilha de alunos', () => {
    const m = detectColumns(['Nome', 'Telefone', 'Tags'])
    expect(m.nome).toBe(0)
    expect(m.telefone).toBe(1)
    expect(m.serie).toBe(2)
  })

  it('detecta variações seguras (caixa, acento, Tag/Tags, Celular/WhatsApp/Fone, Nome completo)', () => {
    const m = detectColumns(['NOME COMPLETO', 'WhatsApp', 'Tag'])
    expect(m.nome).toBe(0)
    expect(m.telefone).toBe(1)
    expect(m.serie).toBe(2)
  })

  it('não escolhe coluna incorreta por casamento parcial curto', () => {
    const m = detectColumns(['Objetivo da Contratação', 'E-mail do (a) Responsável Pedagógico', 'Turno'])
    expect(m.nome).toBeNull()
    expect(m.telefone).toBeNull()
    expect(m.serie).toBeNull()
  })

  it('normalizeHeader remove acentos e pontuação', () => {
    expect(normalizeHeader('Série (Ano)')).toBe('serie ano')
    expect(normalizeHeader('Nome do(a) Aluno(a)')).toBe('nome do a aluno a')
  })
})

describe('clienteImportPlanner — planejamento', () => {
  const mapping = { nome: 0, telefone: 1, serie: 2 }

  it('importa linha válida com telefone normalizado ao padrão do sistema', () => {
    const plano = planImport([['João Silva', '(34) 99999-1234', '6º Ano do Ensino Fundamental II']], mapping)
    expect(plano.entries).toHaveLength(1)
    expect(plano.entries[0].telefoneNormalizado).toBe('5534999991234')
    expect(plano.entries[0].nome).toBe('João Silva')
    expect(plano.entries[0].tags).toEqual(['6º Ano do Ensino Fundamental II'])
    expect(plano.stats.ignoradas).toBe(0)
  })

  it('normaliza diversos formatos de telefone (parênteses, hífen, espaço, com/sem 55)', () => {
    const rows = [
      ['A', '5534997799905', 'X'],
      ['B', '34999744993', 'X'],
      ['C', '(34)996850960', 'X'],
      ['D', '3498431-6376', 'X'],
      ['E', '34 99684 7663', 'X'],
    ]
    const plano = planImport(rows, mapping)
    const tels = plano.entries.map((e) => e.telefoneNormalizado)
    expect(tels).toEqual([
      '5534997799905',
      '5534999744993',
      '5534996850960',
      '5534984316376',
      '5534996847663',
    ])
  })

  it('ignora linha sem nome', () => {
    const plano = planImport([['', '34999991234', 'X']], mapping)
    expect(plano.entries).toHaveLength(0)
    expect(plano.ignored[0].motivo).toBe('Sem nome')
  })

  it('ignora linha com telefone inválido', () => {
    const plano = planImport([['Fulano', '123', 'X'], ['Beltrano', '5534997799905999888', 'X']], mapping)
    expect(plano.entries).toHaveLength(0)
    expect(plano.ignored).toHaveLength(2)
    expect(plano.ignored.every((i) => i.motivo === 'Telefone inválido')).toBe(true)
  })

  it('ignora linha sem telefone', () => {
    const plano = planImport([['Fulano', '', 'X']], mapping)
    expect(plano.ignored[0].motivo).toBe('Sem telefone')
  })

  it('ignora linha totalmente vazia', () => {
    const plano = planImport([['', '', '']], mapping)
    expect(plano.entries).toHaveLength(0)
    expect(plano.ignored[0].motivo).toBe('Linha vazia')
  })

  it('deduplica o mesmo telefone (com e sem o 9º dígito) em um único cliente', () => {
    const rows = [
      ['João Silva', '5534997799905', 'A'], // 13 díg
      ['João Silva', '553497799905', 'A'], // 12 díg (mesmo número, sem o 9)
    ]
    const plano = planImport(rows, mapping)
    expect(plano.entries).toHaveLength(1)
    expect(plano.stats.telefonesUnicos).toBe(1)
    expect(plano.entries[0].tags).toEqual(['A'])
  })

  it('agrega tags distintas do mesmo telefone e não repete', () => {
    const rows = [
      ['João', '34999991234', '6º Ano'],
      ['João', '34999991234', '7º Ano'],
      ['João', '34999991234', '6º Ano'],
    ]
    const plano = planImport(rows, mapping)
    expect(plano.entries).toHaveLength(1)
    expect(plano.entries[0].tags).toEqual(['6º Ano', '7º Ano'])
  })

  it('sinaliza conflito quando o mesmo telefone aparece com nomes diferentes (não sobrescreve)', () => {
    const rows = [
      ['Maria Ana', '34999991234', 'Maternal 3 (03 anos)'],
      ['Pedro Ana', '34999991234', '5º Ano do Ensino Fundamental I'],
    ]
    const plano = planImport(rows, mapping)
    expect(plano.entries).toHaveLength(1)
    expect(plano.entries[0].nome).toBe('Maria Ana') // mantém o primeiro
    expect(plano.conflicts).toHaveLength(1)
    expect(plano.conflicts[0].nomesConflitantes).toEqual(['Maria Ana', 'Pedro Ana'])
    expect(plano.conflicts[0].alunos).toHaveLength(2)
    expect(plano.conflicts[0].alunos.map((a) => a.serie)).toEqual([
      'Maternal 3 (03 anos)',
      '5º Ano do Ensino Fundamental I',
    ])
    expect(plano.entries[0].tags).toEqual(['Maternal 3 (03 anos)', '5º Ano do Ensino Fundamental I'])
  })

  it('permite escolher o nome principal do telefone compartilhado', () => {
    const rows = [
      ['Maria Ana', '34999991234', 'Maternal 3 (03 anos)'],
      ['Pedro Ana', '34999991234', '5º Ano do Ensino Fundamental I'],
    ]
    const primeiro = planImport(rows, mapping)
    const key = primeiro.entries[0].phoneKey
    const plano = planImport(rows, mapping, { nomesPrincipais: { [key]: 'Pedro Ana' } })
    expect(plano.entries[0].nome).toBe('Pedro Ana')
    expect(plano.conflicts[0].nome).toBe('Pedro Ana')
  })

  it('preserva acentos e símbolos da tag integralmente (não divide a série)', () => {
    const plano = planImport(
      [['Alexia', '5534999514579', '3ª Série do Ensino Médio']],
      mapping
    )
    expect(plano.entries[0].tags).toEqual(['3ª Série do Ensino Médio'])
  })

  it('não perde dígitos nem o 55; não converte telefone com Number()', () => {
    const plano = planImport([['Alexia', '5534999514579', 'X']], mapping)
    expect(plano.entries[0].telefoneNormalizado).toBe('5534999514579')
    expect(String(plano.entries[0].telefoneNormalizado).includes('e')).toBe(false)
  })

  it('expande notação científica de telefone sem Number()', () => {
    expect(cellToPhoneString('5.534999514579E+12')).toBe('5534999514579')
    expect(cellToPhoneString(5534999514579)).toBe('5534999514579')
  })

  it('linha sem série é importada sem tag (série é opcional)', () => {
    const plano = planImport([['João', '34999991234', '']], mapping)
    expect(plano.entries).toHaveLength(1)
    expect(plano.entries[0].tags).toEqual([])
  })

  it('estatísticas refletem totais corretos', () => {
    const rows = [
      ['João', '34999991234', 'A'],
      ['Maria', '34988887777', 'B'],
      ['', '34977776666', 'C'], // ignorada (sem nome)
      ['Ana', 'xxx', 'D'], // ignorada (tel inválido)
    ]
    const plano = planImport(rows, mapping)
    expect(plano.stats.totalLinhas).toBe(4)
    expect(plano.stats.telefonesUnicos).toBe(2)
    expect(plano.stats.ignoradas).toBe(2)
  })

  it('agrupa 3 e 5 alunos no mesmo telefone em um único contato', () => {
    const tres = [
      ['A1', '34999996236', '6º Ano'],
      ['A2', '34999996236', '1ª Série'],
      ['A3', '34999996236', '2ª Série'],
    ]
    const p3 = planImport(tres, mapping)
    expect(p3.entries).toHaveLength(1)
    expect(p3.entries[0].alunos).toHaveLength(3)
    expect(p3.conflicts[0].quantidade).toBe(3)

    const cinco = [
      ['N1', '34999990000', 'A'],
      ['N2', '34999990000', 'B'],
      ['N3', '34999990000', 'C'],
      ['N4', '34999990000', 'D'],
      ['N5', '34999990000', 'E'],
    ]
    const p5 = planImport(cinco, mapping)
    expect(p5.entries).toHaveLength(1)
    expect(p5.entries[0].alunos.map((a) => a.nome)).toEqual(['N1', 'N2', 'N3', 'N4', 'N5'])
    expect(p5.conflicts[0].nomesConflitantes).toHaveLength(5)
  })
})
