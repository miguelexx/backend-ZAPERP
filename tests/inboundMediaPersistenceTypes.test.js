const { _test } = require('../services/inboundMediaPersistenceService')

describe('persistência de tipos de arquivo recebidos', () => {
  test.each([
    ['foto.avif', 'application/octet-stream', '.avif'],
    ['foto.heic', 'application/octet-stream', '.heic'],
    ['documento.odt', 'application/octet-stream', '.odt'],
    ['planilha.ods', 'application/octet-stream', '.ods'],
    ['apresentacao.odp', 'application/octet-stream', '.odp'],
    ['livro.epub', 'application/octet-stream', '.epub'],
    ['texto.rtf', 'application/octet-stream', '.rtf'],
    ['video.mkv', 'application/octet-stream', '.mkv'],
    ['gravacao.amr', 'application/octet-stream', '.amr'],
  ])('%s mantém extensão reconhecível', (nome_arquivo, contentType, ext) => {
    const stored = _test.pickStoredFilename({
      company_id: 1,
      mensagem_id: 2,
      contentType,
      nome_arquivo,
      tipo: 'arquivo',
    })
    expect(stored.endsWith(ext)).toBe(true)
  })

  test('MIME conhecido fornece extensão quando o provedor omite o nome', () => {
    const stored = _test.pickStoredFilename({
      company_id: 1,
      mensagem_id: 3,
      contentType: 'application/vnd.oasis.opendocument.text',
      nome_arquivo: '',
      tipo: 'arquivo',
    })
    expect(stored.endsWith('.odt')).toBe(true)
  })
})
