const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
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

test('prepara todo video para codec e container nativos do WhatsApp', () => {
  assert.equal(
    _test.shouldNormalizeVideoForUltraMsg(file({ mimetype: 'video/mp4', originalname: 'video.mp4', path: '/tmp/video.mp4' }), 'video'),
    true
  )
  assert.equal(
    _test.shouldNormalizeVideoForUltraMsg(file({ mimetype: 'video/quicktime', originalname: 'IMG_004.mov', path: '/tmp/IMG_004.mov' }), 'video'),
    true
  )
  assert.equal(
    _test.shouldNormalizeVideoForUltraMsg(file({ mimetype: 'video/3gpp', originalname: 'clip.3gp', path: '/tmp/clip.3gp' }), 'video'),
    true
  )
  for (const ext of ['webm', 'avi', 'mkv', 'm4v', 'mpeg', 'mpg', 'ogv']) {
    assert.equal(
      _test.shouldNormalizeVideoForUltraMsg(file({ mimetype: `video/${ext}`, originalname: `clip.${ext}`, path: `/tmp/clip.${ext}` }), 'video'),
      true,
      `esperava conversao para .${ext}`
    )
  }
  assert.equal(
    _test.shouldNormalizeVideoForUltraMsg(file({ mimetype: 'video/webm', originalname: 'clip.webm', path: '/tmp/clip.webm' }), 'arquivo'),
    false
  )
})

test('reprocessa ate MP4 real e produz MP4 H.264 identificado com sufixo -wa', async () => {
  const ffmpegPath = require('ffmpeg-static')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaperp-video-mp4-normalize-'))
  const sourcePath = path.join(tempDir, 'camera.mp4')
  try {
    const generated = spawnSync(ffmpegPath, [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=green:s=320x240:d=0.3',
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      sourcePath,
    ], { windowsHide: true })
    assert.equal(generated.status, 0, String(generated.stderr || '').slice(-300))

    const result = await _test.normalizeVideoForUltraMsg({
      mimetype: 'video/mp4',
      originalname: 'camera.mp4',
      filename: 'camera.mp4',
      path: sourcePath,
      size: fs.statSync(sourcePath).size,
    }, 'video')

    assert.equal(result.converted, true, result.error)
    assert.match(result.file.filename, /-wa\.mp4$/i)
    assert.equal(result.file.mimetype, 'video/mp4')
    const inspected = spawnSync(ffmpegPath, ['-hide_banner', '-i', result.file.path], { windowsHide: true })
    assert.match(String(inspected.stderr || ''), /Video:\s+h264/i)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('video usa CDN da UltraMSG para nao depender da URL publica do backend', () => {
  assert.equal(_test.shouldForceProviderUploadForMedia('video'), true)
  assert.equal(_test.shouldForceProviderUploadForMedia('vídeo'), false)
  assert.equal(_test.shouldForceProviderUploadForMedia('imagem'), false)
  assert.equal(_test.shouldForceProviderUploadForMedia('audio'), true)
  assert.equal(_test.shouldForceProviderUploadForMedia('voice'), true)
})

test('tipo video explicito so e aplicado a arquivo realmente de video', () => {
  const mp4Generico = file({ mimetype: 'application/octet-stream', originalname: 'camera.mp4' })
  mp4Generico.__tipoForcado = 'video'
  assert.equal(_test.aplicarTipoForcadoSticker(mp4Generico, 'arquivo'), 'video')

  const pdf = file({ mimetype: 'application/pdf', originalname: 'contrato.pdf' })
  pdf.__tipoForcado = 'video'
  assert.equal(_test.aplicarTipoForcadoSticker(pdf, 'arquivo'), 'arquivo')
})

test('converte WebM real para MP4 H.264 antes de enviar a UltraMSG', async () => {
  const ffmpegPath = require('ffmpeg-static')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaperp-video-normalize-'))
  const sourcePath = path.join(tempDir, 'clip.webm')
  try {
    const generated = spawnSync(ffmpegPath, [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=blue:s=320x240:d=0.3',
      '-an',
      '-c:v', 'libvpx-vp9',
      sourcePath,
    ], { windowsHide: true })
    assert.equal(generated.status, 0, String(generated.stderr || '').slice(-300))

    const result = await _test.normalizeVideoForUltraMsg({
      mimetype: 'video/webm',
      originalname: 'clip.webm',
      filename: 'clip.webm',
      path: sourcePath,
      size: fs.statSync(sourcePath).size,
    }, 'video')

    assert.equal(result.converted, true, result.error)
    assert.equal(result.file.mimetype, 'video/mp4')
    assert.match(result.file.originalname, /\.mp4$/i)
    assert.ok(result.file.size > 0)
    assert.equal(fs.existsSync(result.file.path), true)
    assert.equal(fs.existsSync(sourcePath), false)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
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
