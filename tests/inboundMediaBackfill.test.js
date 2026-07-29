/**
 * Testes puros do gating do backfill de mídia recebida sem URL.
 */
const { precisaBackfillMidia, hasUsableMediaUrl } = require('../services/inboundMediaBackfillService')

describe('hasUsableMediaUrl', () => {
  test.each([
    ['https://s3.amazonaws.com/x', true],
    ['http://cdn/x', true],
    ['/uploads/inbound-c1-m2.ogg', true],
    ['', false],
    [null, false],
    ['(áudio)', false],
  ])('%s → %s', (url, expected) => {
    expect(hasUsableMediaUrl(url)).toBe(expected)
  })
})

describe('precisaBackfillMidia', () => {
  test('áudio recebido sem URL (caso real: type=ptt, media vazio) → precisa', () => {
    expect(precisaBackfillMidia({ tipo: 'texto', texto: '(áudio)', url: null })).toBe(true)
    expect(precisaBackfillMidia({ tipo: 'voice', texto: '(áudio)', url: '' })).toBe(true)
  })

  test('imagem/arquivo/vídeo sem URL → precisa', () => {
    expect(precisaBackfillMidia({ tipo: 'texto', texto: '(imagem)', url: null })).toBe(true)
    expect(precisaBackfillMidia({ tipo: 'arquivo', texto: '(arquivo)', url: null })).toBe(true)
    expect(precisaBackfillMidia({ tipo: 'texto', texto: '(vídeo)', url: null })).toBe(true)
  })

  test('placeholder genérico "(mensagem)" sem URL → precisa (pode ser mídia sem tipo)', () => {
    expect(precisaBackfillMidia({ tipo: 'texto', texto: '(mensagem)', url: null })).toBe(true)
  })

  test('mídia JÁ com URL renderável → NÃO precisa', () => {
    expect(precisaBackfillMidia({ tipo: 'voice', texto: '(áudio)', url: 'https://s3/x.ogg' })).toBe(false)
    expect(precisaBackfillMidia({ tipo: 'imagem', texto: '(imagem)', url: '/uploads/x.jpg' })).toBe(false)
  })

  test('texto normal → NÃO precisa', () => {
    expect(precisaBackfillMidia({ tipo: 'texto', texto: 'Oi, tudo bem?', url: null })).toBe(false)
    expect(precisaBackfillMidia({ tipo: 'texto', texto: 'qual valor?', url: null })).toBe(false)
  })

  test('tipos não-mídia (contato/localização) → NÃO precisa backfill de mídia', () => {
    expect(precisaBackfillMidia({ tipo: 'contact', texto: 'João', url: null })).toBe(false)
    expect(precisaBackfillMidia({ tipo: 'location', texto: 'Rua X', url: null })).toBe(false)
  })

  test('nulo/vazio → NÃO precisa', () => {
    expect(precisaBackfillMidia(null)).toBe(false)
    expect(precisaBackfillMidia({})).toBe(false)
  })
})
