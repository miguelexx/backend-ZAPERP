const assert = require('node:assert/strict')
const path = require('path')

const { _test, scheduleR2MirrorIfNeeded } = require('../services/mediaR2MirrorService')

test('buildStorageKey: media/<company>/<ano>/<mes>/<tipo>/<arquivo>', () => {
  const key = _test.buildStorageKey({
    company_id: 1,
    tipo: 'imagem',
    criado_em: '2026-08-13T10:00:00.000Z',
    localFilename: 'inbound-c1-m50-abc123.jpg',
  })
  assert.equal(key, 'media/1/2026/08/imagem/inbound-c1-m50-abc123.jpg')
})

test('buildStorageKey: voice cai na pasta de audio; nome saneado', () => {
  const key = _test.buildStorageKey({
    company_id: 1, tipo: 'voice', criado_em: '2026-01-05T00:00:00Z', localFilename: 'a b/c.ogg',
  })
  assert.equal(key, 'media/1/2026/01/audio/c.ogg')
})

test('pastaDoTipo: mapeia tipos conhecidos e outros', () => {
  assert.equal(_test.pastaDoTipo('imagem'), 'imagem')
  assert.equal(_test.pastaDoTipo('voice'), 'audio')
  assert.equal(_test.pastaDoTipo('desconhecido'), 'outros')
})

test('tipoQualifica: só mídia real', () => {
  for (const t of ['imagem', 'sticker', 'video', 'audio', 'voice', 'arquivo']) {
    assert.equal(_test.tipoQualifica(t), true)
  }
  assert.equal(_test.tipoQualifica('texto'), false)
  assert.equal(_test.tipoQualifica('interna'), false)
})

test('podeEspelharAgora: espelha inbound e outbound imediatamente (independe de status)', () => {
  // O outbound agora é espelhado na hora do envio; entrega usa a URL capturada no envio e o
  // reenvio usa URL assinada do R2, então não é preciso esperar status final.
  assert.equal(_test.podeEspelharAgora({ direcao: 'in', status: 'received' }), true)
  assert.equal(_test.podeEspelharAgora({ direcao: 'out', status: 'sent' }), true)
  assert.equal(_test.podeEspelharAgora({ direcao: 'out', status: 'pending' }), true)
  assert.equal(_test.podeEspelharAgora({ direcao: 'out', status: 'sending' }), true)
})

test('resolveLocalPath: resolve /uploads e bloqueia traversal', () => {
  const ok = _test.resolveLocalPath('/uploads/foto.jpg')
  assert.ok(ok && ok.endsWith(`${path.sep}foto.jpg`))
  assert.equal(_test.resolveLocalPath('/uploads/../segredo.env'), null)
  assert.equal(_test.resolveLocalPath('https://exemplo.com/x.jpg'), null)
  assert.equal(_test.resolveLocalPath('/media/r2/media/1/x.jpg'), null)
})

test('mimeFromName: extensões de imagem e fallback', () => {
  assert.equal(_test.mimeFromName('x.jpg'), 'image/jpeg')
  assert.equal(_test.mimeFromName('x.png'), 'image/png')
  assert.equal(_test.mimeFromName('x.webp'), 'image/webp')
  assert.equal(_test.mimeFromName('x.desconhecido'), 'application/octet-stream')
})

test('scheduleR2MirrorIfNeeded: no-op quando R2 não configurado (não lança)', () => {
  // Sem credenciais R2 no ambiente de teste, empresaUsaR2 é false → não agenda nada.
  assert.doesNotThrow(() =>
    scheduleR2MirrorIfNeeded({ supabase: {}, company_id: 1, mensagem_id: 123 })
  )
})
