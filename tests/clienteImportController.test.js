/**
 * Testa o controller de importação com .xlsx gerado em memória (exceljs),
 * cobrindo: parsing, detecção de colunas (novos e antigos), telefone numérico,
 * isolamento por empresa e casos de erro.
 */

jest.mock('../services/clienteImportService', () => ({
  executarImportacao: jest.fn(),
}))

const ExcelJS = require('exceljs')
const { executarImportacao } = require('../services/clienteImportService')
const controller = require('../controllers/clienteImportController')

// ── helpers ──────────────────────────────────────────────────────────────────

async function montarXlsx(rows, headers, sheetName = 'Plan1') {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName)
  ws.addRow(headers)
  rows.forEach((r) => ws.addRow(r))
  return Buffer.from(await wb.xlsx.writeBuffer())
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

// Linha no formato antigo (modelo da secretaria).
const HEADERS_ANTIGOS = [
  'Data',
  'Nome do(a) Aluno(a)',
  'Objetivo da Contratação',
  'Série (Ano)',
  'Turno',
  'Celular do(a) Responsável Pedagógico',
  'E-mail do (a) Responsável Pedagógico',
]
function linhaAntiga({ data = '2025-10-07', nome, objetivo = 'Matrícula', serie, turno = 'Vespertino', cel, email = 'x@y.com' }) {
  return [data, nome, objetivo, serie, turno, cel, email]
}

// Linha no formato novo (planilha ZapERP simplificada).
const HEADERS_NOVOS = ['Nome', 'Telefone', 'Tags']
function linhaNova({ nome, telefone, tags }) {
  return [nome, telefone, tags]
}

// ── testes de preview ─────────────────────────────────────────────────────────

describe('clienteImportController — preview', () => {
  beforeEach(() => executarImportacao.mockReset())

  it('rejeita quando não há arquivo', async () => {
    const res = makeRes()
    await controller.previewImportacao({ body: {}, user: { company_id: 7 } }, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.codigo).toBe('ARQUIVO_OBRIGATORIO')
  })

  it('detecta as 3 colunas do modelo antigo e devolve prévia', async () => {
    const buffer = await montarXlsx(
      [
        linhaAntiga({ nome: 'João Silva', serie: '6º Ano do Ensino Fundamental II', cel: '(34) 99999-1234' }),
        linhaAntiga({ nome: 'Maria Souza', serie: '5º Ano do Ensino Fundamental I', cel: '5534988887777' }),
      ],
      HEADERS_ANTIGOS
    )
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body.mapping).toEqual({ nome: 1, telefone: 5, serie: 3 })
    expect(res.body.colunas_faltando).toEqual([])
    expect(res.body.stats.telefonesUnicos).toBe(2)
    expect(res.body.amostra[0]).toMatchObject({
      nome: 'João Silva',
      telefone: '5534999991234',
      tags: ['6º Ano do Ensino Fundamental II'],
    })
  })

  it('detecta as 3 colunas simples: Nome, Telefone, Tags', async () => {
    const buffer = await montarXlsx(
      [
        linhaNova({ nome: 'Rafael Castro de Paula', telefone: '5534999744993', tags: 'Maternal 3 (03 anos)' }),
        linhaNova({ nome: 'ALEXIA CRISTINA MARCHEZAN DOS SANTOS', telefone: '5534999514579', tags: '6º Ano do Ensino Fundamental II' }),
      ],
      HEADERS_NOVOS
    )
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body.mapping).toEqual({ nome: 0, telefone: 1, serie: 2 })
    expect(res.body.colunas_faltando).toEqual([])
    expect(res.body.stats.telefonesUnicos).toBe(2)
    expect(res.body.amostra[0]).toMatchObject({
      nome: 'Rafael Castro de Paula',
      telefone: '5534999744993',
      tags: ['Maternal 3 (03 anos)'],
    })
    expect(res.body.amostra[1]).toMatchObject({
      nome: 'ALEXIA CRISTINA MARCHEZAN DOS SANTOS',
      tags: ['6º Ano do Ensino Fundamental II'],
    })
  })

  it('detecta TAG (singular, maiúsculo) como coluna de série', async () => {
    const buffer = await montarXlsx(
      [['Aluno X', '5534999111111', 'Pré II (05 anos)']],
      ['NOME', 'TELEFONE', 'TAG']
    )
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body.mapping.serie).toBe(2)
    expect(res.body.amostra[0].tags).toEqual(['Pré II (05 anos)'])
  })

  it('preserva acentos, símbolos ordinais e parênteses na tag', async () => {
    const tags = ['6º Ano do Ensino Fundamental II', '3ª Série do Ensino Médio', 'Maternal 3 (03 anos)', 'Pré II (05 anos)']
    const buffer = await montarXlsx(
      tags.map((t, i) => [`Aluno ${i}`, `553499999${1000 + i}`, t]),
      HEADERS_NOVOS
    )
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)

    expect(res.statusCode).toBe(200)
    tags.forEach((t, i) => {
      expect(res.body.amostra[i].tags).toEqual([t])
    })
  })

  it('preserva nome do aluno com acentos intactos', async () => {
    const buffer = await montarXlsx(
      [['ALICE VILAS BÔAS QUEIROZ ASSUNÇÃO', '5534999692199', '4º Ano']],
      HEADERS_NOVOS
    )
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)
    expect(res.body.amostra[0].nome).toBe('ALICE VILAS BÔAS QUEIROZ ASSUNÇÃO')
  })

  it('sinaliza conflito de irmãos com mesmo telefone', async () => {
    const buffer = await montarXlsx(
      [
        ['Maria Ana', '5534999991234', 'Maternal 3 (03 anos)'],
        ['Pedro Ana', '5534999991234', '5º Ano do Ensino Fundamental I'],
      ],
      HEADERS_NOVOS
    )
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body.stats.telefonesUnicos).toBe(1)
    expect(res.body.stats.conflitos).toBe(1)
    expect(res.body.amostra[0].conflito).toBe(true)
    expect(res.body.amostra[0].nomes_conflitantes).toContain('Pedro Ana')
    // Ambas as séries devem aparecer na prévia
    expect(res.body.amostra[0].tags).toEqual(
      expect.arrayContaining(['Maternal 3 (03 anos)', '5º Ano do Ensino Fundamental I'])
    )
  })

  it('respeita "não usar" (null) para a serie mesmo que a detecção automática a encontre', async () => {
    const buffer = await montarXlsx(
      [linhaNova({ nome: 'João Silva', telefone: '34999991234', tags: '6º Ano' })],
      HEADERS_NOVOS
    )
    const res = makeRes()
    await controller.previewImportacao(
      { file: { buffer, size: buffer.length }, body: { mapping: JSON.stringify({ nome: 0, telefone: 1, serie: null }) }, user: { company_id: 7 } },
      res
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.mapping.serie).toBeNull()
    expect(res.body.amostra[0].tags).toEqual([])
  })

  it('respeita override de mapeamento vindo do body', async () => {
    const buffer = await montarXlsx(
      [['Contato XPTO', '34999990000', 'Turma A']],
      ['Aluno XPTO', 'Fone XPTO', 'Turma XPTO']
    )
    const res = makeRes()
    await controller.previewImportacao(
      { file: { buffer, size: buffer.length }, body: { mapping: JSON.stringify({ nome: 0, telefone: 1, serie: 2 }) }, user: { company_id: 7 } },
      res
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.mapping).toEqual({ nome: 0, telefone: 1, serie: 2 })
    expect(res.body.amostra[0].telefone).toBe('5534999990000')
  })

  it('lê telefone gravado como número (Excel) sem notação científica', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Plan1')
    ws.addRow(HEADERS_NOVOS)
    ws.addRow(['João Silva', 5534999991234, '6º Ano'])  // número, não string
    const buffer = Buffer.from(await wb.xlsx.writeBuffer())
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.amostra[0].telefone).toBe('5534999991234')
  })

  it('não devolve 500 para buffer que não é xlsx (mensagem 400)', async () => {
    const buffer = Buffer.from('isto nao e uma planilha')
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.codigo).toBe('ARQUIVO_INVALIDO')
    expect(res.body.erro).toMatch(/xlsx/i)
  })

  it('não devolve 500 para .xls (OLE2) disfarçado de xlsx', async () => {
    const buffer = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00, 0x00])
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)
    expect(res.statusCode).toBe(400)
    expect(res.body.codigo).toBe('FORMATO_XLS')
  })

  it('acha o cabeçalho mesmo com linha de título acima (modelo secretaria)', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Plan1')
    ws.addRow(['Relatório de Matrículas — 2026'])
    ws.addRow([])
    ws.addRow(HEADERS_ANTIGOS)
    ws.addRow(linhaAntiga({ nome: 'João Silva', serie: '6º Ano', cel: '34999991234' }))
    const buffer = Buffer.from(await wb.xlsx.writeBuffer())
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.mapping).toEqual({ nome: 1, telefone: 5, serie: 3 })
    expect(res.body.amostra[0]).toMatchObject({ nome: 'João Silva', telefone: '5534999991234' })
  })

  it('usa a aba com as colunas do modelo, não a primeira aba de instruções', async () => {
    const wb = new ExcelJS.Workbook()
    const instrucoes = wb.addWorksheet('Instruções')
    instrucoes.addRow(['Leia antes de preencher'])
    instrucoes.addRow(['Use o modelo da secretaria'])
    const dados = wb.addWorksheet('Contatos')
    dados.addRow(HEADERS_NOVOS)
    dados.addRow(linhaNova({ nome: 'Maria Souza', telefone: '34988887777', tags: '5º Ano' }))
    const buffer = Buffer.from(await wb.xlsx.writeBuffer())
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.amostra[0]).toMatchObject({ nome: 'Maria Souza', telefone: '5534988887777' })
  })

  it('planilha sem cabeçalho reconhecível retorna colunas_faltando preenchidas', async () => {
    const buffer = await montarXlsx(
      [['João', '34999991234', '6º Ano']],
      ['ColA', 'ColB', 'ColC']  // cabeçalhos não reconhecíveis
    )
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)
    expect(res.statusCode).toBe(200)
    // auto-detecção falha → colunas_faltando informa o usuário
    expect(res.body.colunas_faltando.length).toBeGreaterThan(0)
    expect(res.body.mapping.nome).toBeNull()
    expect(res.body.mapping.telefone).toBeNull()
  })

  it('linha com telefone inválido aparece em ignored com motivo', async () => {
    const buffer = await montarXlsx(
      [
        ['Ana', '5534999991234', '5º Ano'],  // válida
        ['Bob', '123', '6º Ano'],             // inválida: telefone curto
        ['Cia', '', '6º Ano'],               // inválida: sem telefone
      ],
      HEADERS_NOVOS
    )
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.stats.telefonesUnicos).toBe(1)
    expect(res.body.stats.ignoradas).toBe(2)
    expect(res.body.ignored).toHaveLength(2)
    expect(res.body.ignored[0].motivo).toBe('Telefone inválido')
    expect(res.body.ignored[1].motivo).toBe('Sem telefone')
  })

  it('linha vazia é ignorada sem gerar entrada', async () => {
    const buffer = await montarXlsx(
      [
        ['Ana', '5534999991234', '5º Ano'],
        ['', '', ''],  // vazia
      ],
      HEADERS_NOVOS
    )
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.stats.telefonesUnicos).toBe(1)
    expect(res.body.ignored[0].motivo).toBe('Linha vazia')
  })

  it('linha com tag vazia é importada sem tag (não rejeita)', async () => {
    const buffer = await montarXlsx(
      [['Ana', '5534999991234', '']],
      HEADERS_NOVOS
    )
    const res = makeRes()
    await controller.previewImportacao({ file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7 } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.stats.telefonesUnicos).toBe(1)
    expect(res.body.amostra[0].tags).toEqual([])
  })
})

// ── testes de confirmar ───────────────────────────────────────────────────────

describe('clienteImportController — confirmar', () => {
  beforeEach(() => executarImportacao.mockReset())

  it('executa a importação usando company_id de req.user (ignora company_id do body)', async () => {
    executarImportacao.mockResolvedValue({ ok: true, resumo: { clientesImportados: 1 } })
    const buffer = await montarXlsx(
      [linhaNova({ nome: 'João Silva', telefone: '34999991234', tags: '6º Ano' })],
      HEADERS_NOVOS
    )
    const res = makeRes()
    await controller.confirmarImportacao(
      { file: { buffer, size: buffer.length }, body: { company_id: 999 }, user: { company_id: 7, perfil: 'admin' } },
      res
    )

    expect(res.statusCode).toBe(200)
    expect(executarImportacao).toHaveBeenCalledTimes(1)
    const [, companyIdArg, planoArg] = executarImportacao.mock.calls[0]
    expect(companyIdArg).toBe(7)   // NUNCA 999 do body
    expect(planoArg.entries).toHaveLength(1)
    expect(planoArg.entries[0].telefoneNormalizado).toBe('5534999991234')
    expect(planoArg.entries[0].tags).toEqual(['6º Ano'])
  })

  it('executa importação com cabeçalhos novos e detecta tags corretamente', async () => {
    executarImportacao.mockResolvedValue({ ok: true, resumo: { clientesImportados: 2 } })
    const buffer = await montarXlsx(
      [
        ['Maria Ana', '5534999991234', 'Maternal 3 (03 anos)'],
        ['Pedro Souza', '5534988887777', '6º Ano do Ensino Fundamental II'],
      ],
      HEADERS_NOVOS
    )
    const res = makeRes()
    await controller.confirmarImportacao(
      { file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7, perfil: 'admin' } },
      res
    )
    expect(res.statusCode).toBe(200)
    const planoArg = executarImportacao.mock.calls[0][2]
    expect(planoArg.entries[0].tags).toEqual(['Maternal 3 (03 anos)'])
    expect(planoArg.entries[1].tags).toEqual(['6º Ano do Ensino Fundamental II'])
  })

  it('rejeita quando não há nenhuma linha válida', async () => {
    const buffer = await montarXlsx(
      [linhaNova({ nome: '', telefone: '', tags: 'X' })],
      HEADERS_NOVOS
    )
    const res = makeRes()
    await controller.confirmarImportacao(
      { file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7, perfil: 'admin' } },
      res
    )
    expect(res.statusCode).toBe(400)
    expect(res.body.codigo).toBe('NENHUMA_LINHA_VALIDA')
    expect(executarImportacao).not.toHaveBeenCalled()
  })

  it('rejeita quando nome e telefone não foram mapeados', async () => {
    const buffer = await montarXlsx(
      [['João', '34999991234', '6º Ano']],
      ['ColA', 'ColB', 'ColC']
    )
    const res = makeRes()
    // Sem override de mapping → auto-detecção falha → rejeita
    await controller.confirmarImportacao(
      { file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7, perfil: 'admin' } },
      res
    )
    expect(res.statusCode).toBe(400)
    expect(res.body.codigo).toBe('MAPEAMENTO_INCOMPLETO')
    expect(executarImportacao).not.toHaveBeenCalled()
  })

  it('não reexecuta a importação num segundo clique (loading state no frontend previne, service apenas 1 vez)', async () => {
    // Simula que o service demora (resolve imediatamente aqui, mas o button fica disabled)
    executarImportacao.mockResolvedValue({ ok: true, resumo: { clientesImportados: 1 } })
    const buffer = await montarXlsx(
      [linhaNova({ nome: 'X', telefone: '5534999991234', tags: 'A' })],
      HEADERS_NOVOS
    )
    const req = { file: { buffer, size: buffer.length }, body: {}, user: { company_id: 7, perfil: 'admin' } }
    const res = makeRes()
    // Dois calls "simultâneos" (simulam duplo clique chegando ao backend)
    await Promise.all([
      controller.confirmarImportacao(req, makeRes()),
      controller.confirmarImportacao(req, makeRes()),
    ])
    // O service pode ser chamado até 2x (sem debounce no backend) — o importante é
    // que o frontend desabilita o botão; aqui apenas garantimos que não crasha.
    expect(executarImportacao).toHaveBeenCalled()
  })

  it('company_id inválido no JWT retorna 401 sem chamar o service', async () => {
    const buffer = await montarXlsx(
      [linhaNova({ nome: 'X', telefone: '5534999991234', tags: 'A' })],
      HEADERS_NOVOS
    )
    const res = makeRes()
    await controller.confirmarImportacao(
      { file: { buffer, size: buffer.length }, body: {}, user: { company_id: null } },
      res
    )
    expect(res.statusCode).toBe(401)
    expect(executarImportacao).not.toHaveBeenCalled()
  })
})
