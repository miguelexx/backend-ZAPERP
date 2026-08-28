const {
  isErroColunaNomeProtecao,
  marcarSchemaNomeProtecaoIndisponivel,
  resetSchemaNomeProtecaoParaTestes,
  sanitizarPatchNomeSchema,
  clienteSelectCols,
} = require('../helpers/clienteNomeColunas')
const { decidirPatchNomeCliente, ORIGEM_IMPORT_PLANILHA } = require('../helpers/clienteNomeProtecao')

describe('clienteNomeColunas — degradação se a migration ainda não existe', () => {
  afterEach(() => resetSchemaNomeProtecaoParaTestes())

  it('reconhece erro de coluna inexistente', () => {
    expect(isErroColunaNomeProtecao({ code: '42703', message: 'column nome_protegido does not exist' })).toBe(true)
    expect(isErroColunaNomeProtecao({ code: 'PGRST204', message: "Could not find the 'nome_protegido' column" })).toBe(true)
    expect(isErroColunaNomeProtecao({ code: '23505', message: 'duplicate' })).toBe(false)
  })

  it('remove campos de proteção do patch depois de detectar schema ausente', () => {
    marcarSchemaNomeProtecaoIndisponivel({ code: '42703', message: 'column nome_protegido does not exist' })
    expect(clienteSelectCols().includes('nome_protegido')).toBe(false)
    expect(sanitizarPatchNomeSchema({
      nome: 'ALEXIA',
      nome_origem: 'import_planilha',
      nome_protegido: true,
      nome_override: true,
      foto_perfil: 'https://cdn.example/a.jpg',
    })).toEqual({ nome: 'ALEXIA', foto_perfil: 'https://cdn.example/a.jpg' })
  })
})

describe('mensagem enviada (fromMe) não altera nome protegido', () => {
  it('rejeita chatName/senderName/sync com nome protegido', () => {
    const existente = {
      nome: 'ALEXIA CRISTINA MARCHEZAN DOS SANTOS',
      nome_protegido: true,
      nome_origem: ORIGEM_IMPORT_PLANILHA,
    }
    const d = decidirPatchNomeCliente(existente, 'KELEN', 'chatName', { fromMe: true })
    expect(d.patch).toBeNull()
    expect(d.nome).toBe(existente.nome)
  })
})
