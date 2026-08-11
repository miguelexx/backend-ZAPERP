const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
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

test('video MP4 encaminhado preserva URL publica e nao passa por upload de documento', async () => {
  const uploadsRoot = ensureUploadsRootExists()
  const fileName = `forward-video-${Date.now()}.mp4`
  const filePath = path.join(uploadsRoot, fileName)
  fs.writeFileSync(filePath, Buffer.from('mp4-fake'))
  let uploadCalls = 0
  try {
    const result = await _test.resolveForwardMediaForProvider({
      provider: {
        uploadMedia: async () => {
          uploadCalls += 1
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
    assert.equal(result.source, 'public_video_url')
    assert.equal(result.url, `https://crm.example.test/uploads/${fileName}`)
    assert.equal(uploadCalls, 0)
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
})
