const fs = require('fs')
const path = require('path')
const XLSX = require('xlsx')
const {
  detectColumns,
  planImport,
  normalizeHeader,
  findHeaderRow,
  cellToString,
} = require('../helpers/clienteImportPlanner')

// Cabeçalhos do modelo antigo (secretaria), com colunas irrelevantes ao redor.
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

// Cabeçalhos novos (planilha ZapERP simplificada).
const HEADERS_NOVOS = ['Nome', 'Telefone', 'Tags']

describe('clienteImportPlanner — detecção de colunas', () => {
  it('detecta nome, telefone e série pelos nomes exatos do modelo antigo', () => {
    const m = detectColumns(HEADERS_MODELO)
    expect(m.nome).toBe(1)
    expect(m.serie).toBe(3)
    expect(m.telefone).toBe(6)
  })

  it('detecta cabeçalhos simples: Nome, Telefone, Tags', () => {
    const m = detectColumns(HEADERS_NOVOS)
    expect(m.nome).toBe(0)
    expect(m.telefone).toBe(1)
    expect(m.serie).toBe(2)
  })

  it('detecta variações em maiúsculas: NOME, TELEFONE, TAG', () => {
    const m = detectColumns(['NOME', 'TELEFONE', 'TAG'])
    expect(m.nome).toBe(0)
    expect(m.telefone).toBe(1)
    expect(m.serie).toBe(2)
  })

  it('detecta sinônimos: Celular → telefone, Etiqueta → serie', () => {
    const m = detectColumns(['Nome', 'Celular', 'Etiqueta'])
    expect(m.nome).toBe(0)
    expect(m.telefone).toBe(1)
    expect(m.serie).toBe(2)
  })

  it('detecta whatsapp como telefone e etiquetas como serie', () => {
    const m = detectColumns(['nome', 'whatsapp', 'etiquetas'])
    expect(m.nome).toBe(0)
    expect(m.telefone).toBe(1)
    expect(m.serie).toBe(2)
  })

  it('detecta mesmo com acentos/caixa/variação de espaços (modelo antigo)', () => {
    const m = detectColumns(['SÉRIE (ANO)', 'nome do(a)  aluno(a)', 'Celular do(a) Responsável Pedagógico'])
    expect(m.serie).toBe(0)
    expect(m.nome).toBe(1)
    expect(m.telefone).toBe(2)
  })

  it('retorna null quando a coluna não existe', () => {
    const m = detectColumns(['Coluna A', 'Coluna B'])
    expect(m.nome).toBeNull()
    expect(m.telefone).toBeNull()
    expect(m.serie).toBeNull()
  })

  it('normalizeHeader remove acentos e pontuação', () => {
    expect(normalizeHeader('Série (Ano)')).toBe('serie ano')
    expect(normalizeHeader('Nome do(a) Aluno(a)')).toBe('nome do a aluno a')
    expect(normalizeHeader('Tags')).toBe('tags')
    expect(normalizeHeader('NOME')).toBe('nome')
  })

  it('findHeaderRow ignora título no topo e acha as colunas do modelo antigo', () => {
    const rows = [
      ['Relatório de Matrículas 2026'],
      [],
      HEADERS_MODELO,
      ['2025-10-07', 'João Silva', 'Matrícula', '6º Ano', 'Vespertino', '000', '(34) 99999-1234', 'x@y.com'],
    ]
    const found = findHeaderRow(rows)
    expect(found.index).toBe(2)
    expect(found.score).toBe(3)
    expect(found.mapping.nome).toBe(1)
    expect(found.mapping.telefone).toBe(6)
    expect(found.mapping.serie).toBe(3)
  })

  it('findHeaderRow detecta cabeçalhos simples na primeira linha', () => {
    const rows = [
      HEADERS_NOVOS,
      ['Rafael Castro de Paula', '5534999744993', 'Maternal 3 (03 anos)'],
    ]
    const found = findHeaderRow(rows)
    expect(found.index).toBe(0)
    expect(found.score).toBe(3)
    expect(found.mapping.nome).toBe(0)
    expect(found.mapping.telefone).toBe(1)
    expect(found.mapping.serie).toBe(2)
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

  it('preserva acentos e símbolos ordinais na tag', () => {
    const plano = planImport([
      ['Ana', '34999991234', 'Maternal 3 (03 anos)'],
      ['Carlos', '34999992345', '6º Ano do Ensino Fundamental II'],
      ['Maria', '34999993456', '3ª Série do Ensino Médio'],
      ['Pedro', '34999994567', 'Pré II (05 anos)'],
    ], mapping)
    expect(plano.entries[0].tags).toEqual(['Maternal 3 (03 anos)'])
    expect(plano.entries[1].tags).toEqual(['6º Ano do Ensino Fundamental II'])
    expect(plano.entries[2].tags).toEqual(['3ª Série do Ensino Médio'])
    expect(plano.entries[3].tags).toEqual(['Pré II (05 anos)'])
  })

  it('preserva acentos no nome do aluno', () => {
    const plano = planImport([
      ['ALICE VILAS BÔAS QUEIROZ ASSUNÇÃO', '5534999692199', '4º Ano'],
    ], mapping)
    expect(plano.entries[0].nome).toBe('ALICE VILAS BÔAS QUEIROZ ASSUNÇÃO')
  })

  it('o nome do contato vem da coluna mapeada, não de outra coluna', () => {
    // mapping.nome = 0 → nome do aluno; coluna 3 = nome do responsável (ignorado)
    const m = { nome: 0, telefone: 1, serie: 2 }
    const plano = planImport([
      ['João Aluno', '34999991234', '6º Ano', 'Responsável Pai'],
    ], m)
    expect(plano.entries[0].nome).toBe('João Aluno')
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
      ['João Silva', '553497799905', 'A'],  // 12 díg (mesmo número, sem o 9)
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

  it('sinaliza conflito quando o mesmo telefone aparece com nomes diferentes (irmãos, sem sobrescrever)', () => {
    const rows = [
      ['Maria Ana', '34999991234', 'Maternal 3 (03 anos)'],
      ['Pedro Ana', '34999991234', '5º Ano do Ensino Fundamental I'],
    ]
    const plano = planImport(rows, mapping)
    expect(plano.entries).toHaveLength(1)
    expect(plano.entries[0].nome).toBe('Maria Ana') // mantém o primeiro
    expect(plano.conflicts).toHaveLength(1)
    expect(plano.conflicts[0].nomesConflitantes).toEqual(['Maria Ana', 'Pedro Ana'])
    // Ambas as séries (irmãos com o mesmo responsável) são preservadas
    expect(plano.entries[0].tags).toEqual(['Maternal 3 (03 anos)', '5º Ano do Ensino Fundamental I'])
  })

  it('linha sem tag é importada sem tag (serie é opcional)', () => {
    const plano = planImport([['João', '34999991234', '']], mapping)
    expect(plano.entries).toHaveLength(1)
    expect(plano.entries[0].tags).toEqual([])
  })

  it('estatísticas refletem totais corretos', () => {
    const rows = [
      ['João', '34999991234', 'A'],
      ['Maria', '34988887777', 'B'],
      ['', '34977776666', 'C'], // ignorada (sem nome)
      ['Ana', 'xxx', 'D'],     // ignorada (tel inválido)
    ]
    const plano = planImport(rows, mapping)
    expect(plano.stats.totalLinhas).toBe(4)
    expect(plano.stats.telefonesUnicos).toBe(2)
    expect(plano.stats.ignoradas).toBe(2)
  })

  it('usa headerRowNumber para numerar linhas do relatório', () => {
    const plano = planImport([['', '34999991234', 'X']], mapping, { headerRowNumber: 3 })
    expect(plano.ignored[0].linha).toBe(4)
  })

  it('não separa tag em múltiplas por conteúdo com parênteses ou vírgulas', () => {
    // A tag "Maternal 3 (03 anos)" deve ser tratada como uma só tag, não splittada
    const plano = planImport([['Ana', '34999991234', 'Maternal 3 (03 anos)']], mapping)
    expect(plano.entries[0].tags).toHaveLength(1)
    expect(plano.entries[0].tags[0]).toBe('Maternal 3 (03 anos)')
  })

  it('cellToString converte número do Excel sem notação científica', () => {
    // Telefone gravado como número inteiro (sem formatação) no Excel
    expect(cellToString(5534999744993)).toBe('5534999744993')
    // Número grande que sem tratamento ficaria em notação científica
    expect(cellToString(55349977999050)).toBe('55349977999050')
  })
})

// Teste com a planilha real — salta se o arquivo não estiver disponível.
const PLANILHA_PATH = path.resolve(process.env.PLANILHA_ALUNOS || 'C:/Users/Miguel/Downloads/Contatos_Alunos_ZapERP.xlsx')
const planilhaDisponivel = fs.existsSync(PLANILHA_PATH)

;(planilhaDisponivel ? describe : describe.skip)(
  'clienteImportPlanner — planilha real Contatos_Alunos_ZapERP.xlsx',
  () => {
    let plano
    let headers
    let detected

    beforeAll(() => {
      const buf = fs.readFileSync(PLANILHA_PATH)
      const wb = XLSX.read(buf, { cellFormula: false, cellHTML: false, raw: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true })
        .map((r) => (Array.isArray(r) ? r : []).map(cellToString))
      headers = allRows[0]
      detected = detectColumns(headers)
      const dataRows = allRows.slice(1)
      plano = planImport(
        dataRows,
        { nome: detected.nome, telefone: detected.telefone, serie: detected.serie },
        { headerRowNumber: 1 }
      )
    })

    it('aba Contatos tem exatamente 3 cabeçalhos: Nome, Telefone, Tags', () => {
      expect(headers).toEqual(['Nome', 'Telefone', 'Tags'])
    })

    it('detecta automaticamente Nome→col 0, Telefone→col 1, Tags→col 2', () => {
      expect(detected.nome).toBe(0)
      expect(detected.telefone).toBe(1)
      expect(detected.serie).toBe(2)
    })

    it('lê 727 linhas de dados', () => {
      expect(plano.stats.totalLinhas).toBe(727)
    })

    it('todas as 727 linhas são válidas (0 ignoradas)', () => {
      expect(plano.stats.ignoradas).toBe(0)
      expect(plano.entries.reduce((s, e) => s + e.linhas.length, 0)).toBe(727)
    })

    it('detecta 587 telefones únicos (727 alunos com 124+ grupos compartilhados)', () => {
      expect(plano.stats.telefonesUnicos).toBe(587)
    })

    it('detecta 127 conflitos de irmãos com mesmo telefone', () => {
      expect(plano.stats.conflitos).toBe(127)
    })

    it('todos os telefones começam com 55 e têm 12 ou 13 dígitos', () => {
      const invalidos = plano.entries.filter((e) => {
        const d = e.telefoneNormalizado
        return !d.startsWith('55') || (d.length !== 12 && d.length !== 13)
      })
      expect(invalidos).toHaveLength(0)
    })

    it('nenhum telefone está em notação científica ou truncado', () => {
      const errados = plano.entries.filter((e) => /e\+/i.test(e.telefoneNormalizado))
      expect(errados).toHaveLength(0)
    })

    it('nomes dos alunos têm acentos preservados', () => {
      const comAcento = plano.entries.find((e) => /[áéíóúàãõâêîôûçÁÉÍÓÚÀÃÕÂÊÎÔÛÇBÔ]/.test(e.nome))
      expect(comAcento).toBeDefined()
    })

    it('tags com símbolos ordinais (º, ª) são preservadas integralmente', () => {
      const comOrdinal = plano.entries.find((e) => e.tags.some((t) => /[ºª]/.test(t)))
      expect(comOrdinal).toBeDefined()
      expect(comOrdinal.tags[0]).toMatch(/[ºª]/)
    })

    it('cada aluno sem irmão tem exatamente uma tag', () => {
      // Alunos sem conflito de nome: devem ter 1 tag (serie)
      const semConflito = plano.entries.filter((e) => e.nomesConflitantes.length === 0)
      const comTagErrada = semConflito.filter((e) => e.tags.length !== 1)
      expect(comTagErrada).toHaveLength(0)
    })

    it('o nome do aluno não é o nome do responsável (nome vem da coluna 0)', () => {
      // O nome deve ser o primeiro campo de cada linha — verificar que não é um telefone
      const nomesParecemTelefone = plano.entries.filter(
        (e) => /^\d{10,}$/.test((e.nome || '').replace(/\D/g, '')) && (e.nome || '').replace(/\D/g, '').length >= 10
      )
      expect(nomesParecemTelefone).toHaveLength(0)
    })

    it('segunda passagem da mesma planilha produz resultado idêntico (idempotência do planner)', () => {
      const buf2 = fs.readFileSync(PLANILHA_PATH)
      const wb2 = XLSX.read(buf2, { cellFormula: false, cellHTML: false, raw: true })
      const ws2 = wb2.Sheets[wb2.SheetNames[0]]
      const rows2 = XLSX.utils.sheet_to_json(ws2, { header: 1, defval: '', raw: true })
        .map((r) => (Array.isArray(r) ? r : []).map(cellToString))
      const plano2 = planImport(
        rows2.slice(1),
        { nome: 0, telefone: 1, serie: 2 },
        { headerRowNumber: 1 }
      )
      expect(plano2.stats).toEqual(plano.stats)
      expect(plano2.entries.length).toBe(plano.entries.length)
    })
  }
)
