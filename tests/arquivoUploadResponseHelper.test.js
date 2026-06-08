const assert = require('node:assert/strict')
const {
  parseClientTempIdsFromBody,
  buildArquivoApiResultRow,
} = require('../helpers/arquivoUploadResponseHelper')

test('parseClientTempIdsFromBody: lote JSON na ordem dos arquivos', () => {
  const ids = parseClientTempIdsFromBody(
    { client_temp_ids: JSON.stringify(['temp-a', 'temp-b']) },
    3
  )
  assert.deepEqual(ids, ['temp-a', 'temp-b', null])
})

test('parseClientTempIdsFromBody: arquivo único via client_temp_id', () => {
  const ids = parseClientTempIdsFromBody({ client_temp_id: 'temp-1' }, 1)
  assert.deepEqual(ids, ['temp-1'])
})

test('buildArquivoApiResultRow: inclui metadados para reconciliação no frontend', () => {
  const row = buildArquivoApiResultRow(
    {
      id: 99,
      conversa_id: 12,
      tipo: 'imagem',
      url: '/uploads/foto.jpg',
      nome_arquivo: 'foto.jpg',
      texto: '(imagem)',
      status: 'pending',
    },
    'temp-xyz'
  )
  assert.equal(row.ok, true)
  assert.equal(row.id, 99)
  assert.equal(row.client_temp_id, 'temp-xyz')
  assert.equal(row.tipo, 'imagem')
  assert.equal(row.url, '/uploads/foto.jpg')
  assert.equal(row.nome_arquivo, 'foto.jpg')
  assert.equal(row.texto, '(imagem)')
})
