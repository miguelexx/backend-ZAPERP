/**
 * Auditoria de mídia (2026-10-20): Content-Type do /media/proxy quando o provedor manda
 * `application/octet-stream` e a URL não tem extensão (padrão do S3 da UltraMSG/Whapi).
 *
 * O proxy resolvia isso com o sniffer de ÁUDIO, que por contrato devolve `audio/mp4` ao ver
 * `ftyp` no byte 4 — ele só deveria rodar para mensagem já classificada como áudio. Resultado:
 * vídeo recebido sem extensão era anunciado como áudio (Safari/iOS não mostrava imagem) e o
 * "Salvar como…" gravava `.m4a`.
 *
 * O que este teste trava:
 *  - imagem/vídeo/PDF passam a sair com o tipo certo;
 *  - TODO formato que possa ser áudio continua decidido pelo sniffer de áudio (sem regressão):
 *    OggS, MP3, WAV, AMR, WebM, 3GP e MPEG-4 com brand de áudio (M4A).
 */

const { _test } = require('../controllers/mediaProxyController')
const { contentTypeFromNonAudioMagicBytes } = require('../helpers/binaryMediaSniffer')

const URL_SEM_EXTENSAO = 'https://mmg.whatsapp.net/v/t62/abc'

/** Buffer com `ftyp<brand>` na posição canônica. */
function ftyp(brand) {
  const b = Buffer.alloc(16)
  b.write('\u0000\u0000\u0000\u0014', 0, 'latin1')
  b.write('ftyp', 4, 'latin1')
  b.write(brand, 8, 'latin1')
  return b
}

function comPrefixo(bytes) {
  const b = Buffer.alloc(16)
  Buffer.from(bytes).copy(b, 0)
  return b
}

describe('resolveContentType — bytes reais com upstream genérico', () => {
  const resolver = (buffer) => _test.resolveContentType('application/octet-stream', URL_SEM_EXTENSAO, '', buffer)

  test('vídeo MP4 (brand isom/mp42) deixa de virar audio/mp4', () => {
    expect(resolver(ftyp('isom'))).toBe('video/mp4')
    expect(resolver(ftyp('mp42'))).toBe('video/mp4')
    expect(resolver(ftyp('avc1'))).toBe('video/mp4')
  })

  test('MOV (brand qt) sai como video/quicktime', () => {
    expect(resolver(ftyp('qt  '))).toBe('video/quicktime')
  })

  test('áudio M4A continua audio/mp4 (sniffer de áudio segue decidindo)', () => {
    expect(resolver(ftyp('M4A '))).toBe('audio/mp4')
  })

  test('foto do iPhone (HEIC) sai como imagem', () => {
    expect(resolver(ftyp('heic'))).toBe('image/heic')
  })

  test.each([
    ['JPEG', [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01], 'image/jpeg'],
    ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d], 'image/png'],
    ['GIF', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00], 'image/gif'],
    ['PDF', [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45], 'application/pdf'],
  ])('%s sai com o tipo certo', (_nome, bytes, esperado) => {
    expect(resolver(comPrefixo(bytes))).toBe(esperado)
  })

  test('WebP (RIFF…WEBP) não é confundido com WAV (RIFF…WAVE)', () => {
    const webp = Buffer.alloc(16)
    webp.write('RIFF', 0, 'latin1')
    webp.write('WEBP', 8, 'latin1')
    expect(resolver(webp)).toBe('image/webp')

    const wav = Buffer.alloc(16)
    wav.write('RIFF', 0, 'latin1')
    wav.write('WAVE', 8, 'latin1')
    expect(resolver(wav)).toBe('audio/wav')
  })

  test.each([
    ['OggS (voz do WhatsApp)', 'OggS', 'audio/ogg'],
    ['ID3 (MP3)', 'ID3\u0003', 'audio/mpeg'],
    ['#!AMR', '#!AMR', 'audio/amr'],
  ])('%s continua áudio', (_nome, assinatura, esperado) => {
    const b = Buffer.alloc(16)
    b.write(assinatura, 0, 'latin1')
    expect(resolver(b)).toBe(esperado)
  })

  test('WebM/Matroska continua decidido pelo sniffer de áudio (comportamento antigo)', () => {
    expect(contentTypeFromNonAudioMagicBytes(comPrefixo([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
    expect(resolver(comPrefixo([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('audio/webm')
  })

  test('upstream específico nunca é sobrescrito pelos bytes', () => {
    expect(_test.resolveContentType('video/mp4', URL_SEM_EXTENSAO, '', ftyp('M4A '))).toBe('video/mp4')
    expect(_test.resolveContentType('image/png; charset=binary', URL_SEM_EXTENSAO, '', ftyp('isom'))).toBe('image/png')
  })

  test('bytes irreconhecíveis mantêm a cadeia antiga (filename → URL → octet-stream)', () => {
    const lixo = comPrefixo([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b])
    expect(_test.resolveContentType('application/octet-stream', URL_SEM_EXTENSAO, 'contrato.pdf', lixo)).toBe('application/pdf')
    expect(
      _test.resolveContentType('application/octet-stream', 'https://x.s3.amazonaws.com/ultramsgmedia/foto.png', '', lixo)
    ).toBe('image/png')
    expect(_test.resolveContentType('application/octet-stream', URL_SEM_EXTENSAO, '', lixo)).toBe('application/octet-stream')
  })

  test('buffer curto não é sniffado (nem quebra)', () => {
    expect(contentTypeFromNonAudioMagicBytes(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull()
    expect(contentTypeFromNonAudioMagicBytes(null)).toBeNull()
  })
})
