/**
 * Content-Type pelos primeiros bytes para o que NÃO é áudio (imagem, vídeo, PDF).
 *
 * Por que existe (auditoria de mídia 2026-10-20): o `/media/proxy` resolvia Content-Type
 * genérico (`application/octet-stream`, que é o que o S3 da UltraMSG/Whapi costuma mandar)
 * com `contentTypeFromAudioMagicBytes`. Esse sniffer é de ÁUDIO por contrato — ele enxerga
 * `ftyp` no byte 4 e devolve `audio/mp4`, porque no fluxo de persistência só roda para
 * mensagem já classificada como áudio. No proxy ele roda para QUALQUER mídia: um vídeo MP4
 * recebido sem extensão na URL saía como `audio/mp4`. O Chrome ignora o Content-Type e usa o
 * próprio demuxer, mas o Safari (iOS, que é metade do uso) respeita o header — vídeo sem
 * imagem — e o "Salvar como…" gravava `.m4a` num arquivo de vídeo.
 *
 * Regra de ouro deste helper: devolver tipo SÓ para assinaturas que não podem ser áudio.
 * Qualquer coisa com cheiro de áudio (OggS, MP3 sync, AMR, WAV, WebM/Matroska, 3GP, brands
 * M4A/M4B/F4A do MPEG-4) retorna null para o sniffer de áudio continuar decidindo exatamente
 * como decidia antes.
 */

/** `ftyp` + brand termina no byte 11. */
const MIN_SNIFF_BYTES = 12

/** Brands MPEG-4 que só aparecem em vídeo. M4A/M4B/M4P/F4A ficam fora: são áudio. */
const VIDEO_FTYP_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'mp71',
  'avc1',
  'dash',
  'mmp4',
  'm4v ',
  'm4vh',
  'm4vp',
])

/** Brands de imagem HEIF/HEIC (iPhone). */
const HEIF_FTYP_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])

function asciiAt(buffer, offset, length) {
  if (buffer.length < offset + length) return ''
  return buffer.slice(offset, offset + length).toString('latin1')
}

/**
 * @param {Buffer} buffer
 * @returns {string|null} Content-Type, ou null quando a assinatura não é reconhecida como
 *   imagem/vídeo/PDF (inclui todo formato que possa ser áudio).
 */
function contentTypeFromNonAudioMagicBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_SNIFF_BYTES) return null

  // Imagens
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (
    buffer[0] === 0x89 &&
    asciiAt(buffer, 1, 3) === 'PNG' &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a
  ) {
    return 'image/png'
  }
  if (asciiAt(buffer, 0, 4) === 'GIF8') return 'image/gif'
  if (asciiAt(buffer, 0, 4) === 'RIFF' && asciiAt(buffer, 8, 4) === 'WEBP') return 'image/webp'
  if (asciiAt(buffer, 0, 2) === 'BM') return 'image/bmp'
  if (asciiAt(buffer, 0, 4) === 'II*\u0000' || asciiAt(buffer, 0, 4) === 'MM\u0000*') return 'image/tiff'

  // Documento
  if (asciiAt(buffer, 0, 4) === '%PDF') return 'application/pdf'

  // Contêiner MPEG-4: só decide quando a brand é inequivocamente vídeo (ou imagem HEIF).
  if (asciiAt(buffer, 4, 4) === 'ftyp') {
    const brand = asciiAt(buffer, 8, 4).toLowerCase()
    if (VIDEO_FTYP_BRANDS.has(brand)) return 'video/mp4'
    if (HEIF_FTYP_BRANDS.has(brand)) return 'image/heic'
    if (brand === 'qt  ') return 'video/quicktime'
    return null // M4A/M4B/3GP/desconhecida → sniffer de áudio decide (comportamento antigo)
  }

  return null
}

module.exports = { contentTypeFromNonAudioMagicBytes, VIDEO_FTYP_BRANDS, HEIF_FTYP_BRANDS }
