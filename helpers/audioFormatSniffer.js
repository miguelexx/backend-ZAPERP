/**
 * Identificação do formato de áudio inbound pelo conteúdo real do arquivo.
 *
 * Para áudio, a UltraMSG entrega `nome_arquivo` sem extensão e o S3 costuma responder
 * `application/octet-stream`. Deduzir a extensão dessas duas fontes fazia um M4A/AAC/MP3 ser gravado
 * como `.ogg`; como `/uploads` responde com `X-Content-Type-Options: nosniff`, o navegador não pode
 * corrigir o palpite e o áudio nunca toca. Os primeiros bytes são a única fonte confiável, e por isso
 * têm precedência sobre Content-Type e nome do arquivo.
 */

/** Mínimo para cobrir a maior assinatura verificada (`ftyp` + brand, que termina no byte 11). */
const MIN_SNIFF_BYTES = 12

/**
 * Content-Type servido para extensões que só existem como áudio. WebM e 3GP ficam de fora de
 * propósito: são containers que também carregam vídeo, `/uploads` guarda vídeo do atendente com
 * essas mesmas extensões, e forçar `audio/*` neles quebraria a reprodução desses vídeos.
 */
const UNAMBIGUOUS_AUDIO_CONTENT_TYPE = Object.freeze({
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  amr: 'audio/amr',
})

/** Extensão canônica por Content-Type de áudio. Usado só como fonte auxiliar. */
const AUDIO_EXT_BY_CONTENT_TYPE = Object.freeze({
  'audio/ogg': 'ogg',
  'audio/oga': 'ogg',
  'audio/opus': 'ogg',
  'audio/vorbis': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/x-pn-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/aacp': 'aac',
  'audio/x-aac': 'aac',
  'audio/amr': 'amr',
  'audio/amr-wb': 'amr',
  'audio/3gpp': '3gp',
  'audio/3gpp2': '3gp',
  'audio/webm': 'webm',
})

/**
 * Tipos que não identificam formato algum. Ficam fora do mapa acima de propósito: reconhecê-los é
 * justamente não extrair extensão deles — é daqui que vinha o `.ogg` errado.
 */
const GENERIC_CONTENT_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/binary',
  'text/plain',
  '',
])

/** Extensões de nome de arquivo aceitas como pista, normalizadas para a forma canônica. */
const TRUSTED_NAME_EXTENSIONS = Object.freeze({
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
  mp3: 'mp3',
  wav: 'wav',
  m4a: 'm4a',
  aac: 'aac',
  amr: 'amr',
  webm: 'webm',
  '3gp': '3gp',
  '3gpp': '3gp',
})

const SUPPORTED_AUDIO_EXTENSIONS = Object.freeze(['ogg', 'mp3', 'wav', 'm4a', 'aac', 'webm', 'amr', '3gp'])

function asciiAt(buffer, offset, length) {
  if (buffer.length < offset + length) return ''
  return buffer.slice(offset, offset + length).toString('latin1')
}

/**
 * Brand do container MPEG-4. `3gp*`/`3g2*` identificam 3GPP; qualquer outra brand (M4A, isom, mp42,
 * mp41...) é MPEG-4 comum, que no fluxo inbound de áudio significa M4A — o sniff só roda para
 * mensagens já classificadas como áudio pelo webhook.
 */
function extensionFromFtypBrand(brand) {
  const b = String(brand || '').toLowerCase()
  if (b.startsWith('3gp') || b.startsWith('3g2')) return '3gp'
  return 'm4a'
}

/**
 * MP3 e AAC-ADTS compartilham o sync de 11 bits ligados; o que os separa são os dois bits de camada
 * logo depois. Camada `00` é reservada no MPEG Audio e é o valor que o ADTS usa.
 */
function extensionFromMpegSync(buffer) {
  if (buffer[0] !== 0xff || (buffer[1] & 0xe0) !== 0xe0) return null
  const layer = (buffer[1] >> 1) & 0x03
  return layer === 0 ? 'aac' : 'mp3'
}

/**
 * Extensão canônica a partir dos primeiros bytes, ou null quando a assinatura não é reconhecida.
 * @param {Buffer} buffer
 * @returns {string|null}
 */
function sniffAudioExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_SNIFF_BYTES) return null

  if (asciiAt(buffer, 0, 4) === 'OggS') return 'ogg'
  if (asciiAt(buffer, 0, 4) === 'RIFF' && asciiAt(buffer, 8, 4) === 'WAVE') return 'wav'
  if (asciiAt(buffer, 0, 3) === 'ID3') return 'mp3'
  if (asciiAt(buffer, 0, 5) === '#!AMR') return 'amr'
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'webm'
  if (asciiAt(buffer, 4, 4) === 'ftyp') return extensionFromFtypBrand(asciiAt(buffer, 8, 4))

  return extensionFromMpegSync(buffer)
}

/**
 * Extensão canônica a partir do Content-Type, ou null para tipos genéricos/desconhecidos.
 * @param {string} contentType
 * @returns {string|null}
 */
function audioExtensionFromContentType(contentType) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (!ct || GENERIC_CONTENT_TYPES.has(ct)) return null
  return AUDIO_EXT_BY_CONTENT_TYPE[ct] || null
}

/**
 * Extensão canônica a partir do nome do arquivo, aceita apenas quando é uma extensão de áudio
 * conhecida. Nomes sem extensão (o caso da UltraMSG, que manda literalmente "audio") retornam null.
 * @param {string} name
 * @returns {string|null}
 */
function audioExtensionFromFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop() || ''
  const match = base.split('?')[0].split('#')[0].match(/\.([a-z0-9]{2,5})$/i)
  if (!match) return null
  return TRUSTED_NAME_EXTENSIONS[match[1].toLowerCase()] || null
}

/**
 * Decide a extensão de um áudio inbound. Conteúdo real primeiro; Content-Type e nome do arquivo só
 * entram quando a assinatura não foi reconhecida. Retorna null quando nenhuma fonte confirma o
 * formato — nesse caso o chamador não deve inventar extensão.
 * @param {{ buffer?: Buffer, contentType?: string, filename?: string }} params
 * @returns {{ ext: string, source: 'magic-bytes'|'content-type'|'filename' }|null}
 */
function resolveInboundAudioExtension({ buffer, contentType, filename } = {}) {
  const fromBytes = sniffAudioExtension(buffer)
  if (fromBytes) return { ext: fromBytes, source: 'magic-bytes' }

  const fromContentType = audioExtensionFromContentType(contentType)
  if (fromContentType) return { ext: fromContentType, source: 'content-type' }

  const fromFilename = audioExtensionFromFilename(filename)
  if (fromFilename) return { ext: fromFilename, source: 'filename' }

  return null
}

/**
 * Content-Type a servir para um caminho/extensão de áudio inequívoca, ou null quando a extensão é
 * ambígua (webm/3gp) ou não é de áudio — nesses casos o padrão do express.static continua valendo.
 * @param {string} pathOrExt
 * @returns {string|null}
 */
function contentTypeForAudioPath(pathOrExt) {
  const raw = String(pathOrExt || '').toLowerCase()
  const match = raw.match(/\.([a-z0-9]{2,5})$/)
  const ext = match ? match[1] : raw
  return UNAMBIGUOUS_AUDIO_CONTENT_TYPE[ext] || null
}

module.exports = {
  SUPPORTED_AUDIO_EXTENSIONS,
  sniffAudioExtension,
  audioExtensionFromContentType,
  audioExtensionFromFilename,
  resolveInboundAudioExtension,
  contentTypeForAudioPath,
}
