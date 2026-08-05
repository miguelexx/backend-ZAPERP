const assert = require('node:assert/strict')
const { _test } = require('../controllers/chatController')

function file({ mimetype = '', originalname = 'arquivo.bin', filename = '', path = '' } = {}) {
  return { mimetype, originalname, filename, path }
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

test('audio gravado pelo sistema pode ser enviado como voice note', () => {
  const gravado = file({ mimetype: 'audio/webm', originalname: 'audio.webm' })
  gravado.__tipoForcado = 'voice'
  assert.equal(_test.aplicarTipoForcadoSticker(gravado, _test.inferirTipoArquivo(gravado)), 'voice')

  const anexoAudio = file({ mimetype: 'audio/mp4', originalname: 'musica.m4a' })
  assert.equal(_test.aplicarTipoForcadoSticker(anexoAudio, _test.inferirTipoArquivo(anexoAudio)), 'audio')
})

test('voice forçado aceita webm com MIME generico/vazio (nao vira video)', () => {
  const octet = file({ mimetype: 'application/octet-stream', originalname: 'audio.webm' })
  octet.__tipoForcado = 'voice'
  assert.equal(_test.inferirTipoArquivo(octet), 'video') // sem force, webm continua video
  assert.equal(_test.aplicarTipoForcadoSticker(octet, _test.inferirTipoArquivo(octet)), 'voice')

  const vazio = file({ mimetype: '', originalname: 'nota.webm' })
  vazio.__tipoForcado = 'voice'
  assert.equal(_test.aplicarTipoForcadoSticker(vazio, _test.inferirTipoArquivo(vazio)), 'voice')

  const videoWebm = file({ mimetype: 'video/webm', originalname: 'gravacao.webm' })
  videoWebm.__tipoForcado = 'voice'
  assert.equal(_test.aplicarTipoForcadoSticker(videoWebm, _test.inferirTipoArquivo(videoWebm)), 'voice')

  // webm de galeria sem tipo=voice continua video
  assert.equal(
    _test.inferirTipoArquivo(file({ mimetype: 'application/octet-stream', originalname: 'clip.webm' })),
    'video'
  )
})

test('shouldAbortAudioAfterNormalize bloqueia envio quando conversao obrigatoria falha', () => {
  assert.equal(
    _test.shouldAbortAudioAfterNormalize('voice', {
      converted: false,
      required: true,
      error: 'ffmpeg exit=1',
    }),
    true
  )
  assert.equal(
    _test.shouldAbortAudioAfterNormalize('audio', {
      converted: false,
      required: true,
      error: 'ffmpeg-static não disponível',
    }),
    true
  )
  // mp3/ogg/aac ja aceitos: conversao nao e obrigatoria
  assert.equal(
    _test.shouldAbortAudioAfterNormalize('audio', {
      converted: false,
      required: false,
      error: null,
    }),
    false
  )
  assert.equal(
    _test.shouldAbortAudioAfterNormalize('voice', {
      converted: true,
      required: true,
      error: null,
    }),
    false
  )
  assert.equal(
    _test.shouldAbortAudioAfterNormalize('imagem', {
      converted: false,
      required: true,
      error: 'x',
    }),
    false
  )
})

test('parseAudioDuracaoSecFromBody usa duration_ms e fallbacks', () => {
  assert.equal(_test.parseAudioDuracaoSecFromBody({ audio_duration_ms: '3500' }), 4)
  assert.equal(_test.parseAudioDuracaoSecFromBody({ audio_elapsed_ms: 1200 }), 1)
  assert.equal(_test.parseAudioDuracaoSecFromBody({ audio_duracao_sec: 12 }), 12)
  assert.equal(_test.parseAudioDuracaoSecFromBody({ audio_duration_ms: 0 }), null)
  assert.equal(_test.parseAudioDuracaoSecFromBody({}), null)
  assert.equal(_test.parseAudioDuracaoSecFromBody(null), null)
  // Cap em 10 min
  assert.equal(_test.parseAudioDuracaoSecFromBody({ audio_duration_ms: 999999 }), 600)
})

test('normaliza imagens de galeria para JPEG compativel com WhatsApp', () => {
  assert.equal(
    _test.shouldNormalizeImageForWhatsapp(file({ mimetype: 'image/heic', originalname: 'IMG_1001.HEIC', path: '/tmp/IMG_1001.HEIC' }), 'imagem'),
    true
  )
  assert.equal(
    _test.shouldNormalizeImageForWhatsapp(file({ mimetype: 'image/jpeg', originalname: 'foto.jpg', path: '/tmp/foto.jpg' }), 'imagem'),
    true
  )
  assert.equal(
    _test.shouldNormalizeImageForWhatsapp(file({ mimetype: 'image/gif', originalname: 'animado.gif', path: '/tmp/animado.gif' }), 'imagem'),
    false
  )
  assert.equal(
    _test.shouldNormalizeImageForWhatsapp(file({ mimetype: 'image/webp', originalname: 'figurinha.webp', path: '/tmp/figurinha.webp' }), 'sticker'),
    false
  )
})
