const assert = require('node:assert/strict')
const { _test } = require('../controllers/chatController')

function file({ mimetype = '', originalname = 'arquivo.bin', filename = '' } = {}) {
  return { mimetype, originalname, filename }
}

test('classifica imagens comuns e WebP como imagem normal', () => {
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: 'image/jpeg', originalname: 'foto.jpg' })), 'imagem')
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: 'image/png', originalname: 'foto.png' })), 'imagem')
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: 'image/webp', originalname: 'foto.webp' })), 'imagem')
})

test('classifica imagem de celular por extensao quando MIME e generico', () => {
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: 'application/octet-stream', originalname: 'IMG_001.JPG' })), 'imagem')
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: '', originalname: 'IMG_002.heic' })), 'imagem')
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: 'application/octet-stream', originalname: 'IMG_003.heif' })), 'imagem')
})

test('classifica videos de galeria e iPhone como video', () => {
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: 'video/mp4', originalname: 'video.mp4' })), 'video')
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: 'video/quicktime', originalname: 'IMG_004.mov' })), 'video')
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: 'application/octet-stream', originalname: 'IMG_005.MOV' })), 'video')
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: '', originalname: 'clip.m4v' })), 'video')
})

test('classifica audio e documentos sem transformar em imagem/video', () => {
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: 'audio/ogg', originalname: 'audio.ogg' })), 'audio')
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: 'audio/mp4', originalname: 'audio.m4a' })), 'audio')
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: 'application/pdf', originalname: 'contrato.pdf' })), 'arquivo')
  assert.equal(_test.inferirTipoArquivo(file({ mimetype: 'application/octet-stream', originalname: 'planilha.xlsx' })), 'arquivo')
})
