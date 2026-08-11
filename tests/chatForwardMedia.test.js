const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { _test } = require('../controllers/chatController')
const { ensureUploadsRootExists } = require('../config/uploadsRoot')

test('normalizeForwardTipo preserva midias encaminhaveis em tipos canonicos', () => {
  assert.equal(_test.normalizeForwardTipo('image'), 'imagem')
  assert.equal(_test.normalizeForwardTipo('vídeo'), 'video')
  assert.equal(_test.normalizeForwardTipo('document'), 'arquivo')
  assert.equal(_test.normalizeForwardTipo('file'), 'arquivo')
  assert.equal(_test.normalizeForwardTipo('ptt'), 'voice')
})

test('resolveForwardMediaForProvider sobe /uploads local via provider.uploadMedia', async () => {
  const uploadsRoot = ensureUploadsRootExists()
  const fileName = `forward-test-${Date.now()}.jpg`
  const filePath = path.join(uploadsRoot, fileName)
  fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  try {
    let uploadedPath = null
    const provider = {
      uploadMedia: async (localPath, originalName) => {
        uploadedPath = localPath
        return { ok: true, url: `https://cdn.example.test/${originalName}` }
      },
    }
    const result = await _test.resolveForwardMediaForProvider({
      provider,
      mensagemOriginal: { url: `/uploads/${fileName}`, nome_arquivo: fileName },
      company_id: 1,
      whatsappInstanceId: 2,
      baseUrl: 'http://localhost:3001',
    })

    assert.equal(result.ok, true)
    assert.equal(result.url, `https://cdn.example.test/${fileName}`)
    assert.equal(result.source, 'provider_upload')
    assert.equal(uploadedPath, path.resolve(filePath))
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
})

test('resolveForwardMediaForProvider rejeita /uploads local sem uploadMedia e sem URL publica', async () => {
  const result = await _test.resolveForwardMediaForProvider({
    provider: {},
    mensagemOriginal: { url: '/uploads/inexistente.jpg', nome_arquivo: 'inexistente.jpg' },
    company_id: 1,
    whatsappInstanceId: 2,
    baseUrl: 'http://localhost:3001',
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /uploadMedia|URL/i)
})

test('video MP4 encaminhado e normalizado e sobe para o CDN antes de /messages/video', async () => {
  const uploadsRoot = ensureUploadsRootExists()
  const fileName = `forward-video-${Date.now()}.mp4`
  const filePath = path.join(uploadsRoot, fileName)
  const normalizedPath = path.join(uploadsRoot, fileName.replace(/\.mp4$/i, '-wa.mp4'))
  const ffmpegPath = require('ffmpeg-static')
  const generated = spawnSync(ffmpegPath, [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=blue:s=320x240:d=0.2',
    '-an',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    filePath,
  ], { windowsHide: true })
  assert.equal(generated.status, 0, String(generated.stderr || '').slice(-300))
  let uploadCalls = 0
  let uploadedPath = null
  let uploadedName = null
  try {
    const result = await _test.resolveForwardMediaForProvider({
      provider: {
        uploadMedia: async (localPath, originalName) => {
          uploadCalls += 1
          uploadedPath = localPath
          uploadedName = originalName
          return { ok: true, url: 'https://cdn.example.test/sem-extensao' }
        },
      },
      mensagemOriginal: {
        tipo: 'video',
        url: `/uploads/${fileName}`,
        nome_arquivo: fileName,
      },
      company_id: 1,
      whatsappInstanceId: 2,
      baseUrl: 'https://crm.example.test',
    })

    assert.equal(result.ok, true)
    assert.equal(result.source, 'provider_upload')
    assert.equal(result.url, 'https://cdn.example.test/sem-extensao')
    assert.equal(uploadCalls, 1)
    assert.match(uploadedPath, /-wa\.mp4$/i)
    assert.match(uploadedName, /-wa\.mp4$/i)
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    if (fs.existsSync(normalizedPath)) fs.unlinkSync(normalizedPath)
  }
})
