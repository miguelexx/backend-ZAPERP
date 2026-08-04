/**
 * Garante que um áudio inbound nunca seja gravado com extensão diferente do conteúdo real.
 *
 * As amostras são geradas com o ffmpeg que o próprio backend já usa, então são arquivos válidos de
 * verdade (com os cabeçalhos reais de cada container) e não vetores de bytes escritos à mão.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const {
  sniffAudioExtension,
  audioExtensionFromContentType,
  audioExtensionFromFilename,
  resolveInboundAudioExtension,
  contentTypeForAudioPath,
} = require('../helpers/audioFormatSniffer')
const { _test } = require('../services/inboundMediaPersistenceService')

const ffmpegPath = require('ffmpeg-static')

/** Como cada formato é produzido a partir de um tom senoidal curto. */
const AMOSTRAS = {
  ogg: ['-c:a', 'libopus', '-f', 'ogg'],
  mp3: ['-c:a', 'libmp3lame', '-f', 'mp3'],
  wav: ['-c:a', 'pcm_s16le', '-f', 'wav'],
  m4a: ['-c:a', 'aac', '-f', 'ipod'],
  aac: ['-c:a', 'aac', '-f', 'adts'],
  webm: ['-c:a', 'libopus', '-f', 'webm'],
  amr: ['-c:a', 'libopencore_amrnb', '-ar', '8000', '-ac', '1', '-b:a', '12.2k', '-f', 'amr'],
  '3gp': ['-c:a', 'libopencore_amrnb', '-ar', '8000', '-ac', '1', '-b:a', '12.2k', '-f', '3gp'],
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaperp-audio-'))
/** @type {Record<string, Buffer>} */
const amostras = {}

beforeAll(() => {
  for (const [ext, args] of Object.entries(AMOSTRAS)) {
    const destino = path.join(tmpDir, `amostra.${ext}`)
    const r = spawnSync(
      ffmpegPath,
      ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-vn', ...args, destino],
      { windowsHide: true, encoding: 'utf8' }
    )
    if (r.status !== 0) {
      throw new Error(`ffmpeg falhou ao gerar amostra .${ext}: ${String(r.stderr || '').slice(-300)}`)
    }
    amostras[ext] = fs.readFileSync(destino)
  }
}, 120000)

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function nomeInbound({ tipo = 'voice', contentType = 'application/octet-stream', nome_arquivo = 'audio', buffer }) {
  return _test.pickStoredFilename({
    company_id: 7,
    mensagem_id: 99,
    contentType,
    nome_arquivo,
    tipo,
    buffer,
  })
}

function extensaoDe(filename) {
  return String(filename).match(/\.([a-z0-9]+)$/i)?.[1] ?? null
}

test('identifica pelos primeiros bytes todos os formatos suportados', () => {
  for (const ext of Object.keys(AMOSTRAS)) {
    assert.equal(sniffAudioExtension(amostras[ext]), ext, `assinatura de .${ext} não reconhecida`)
  }
})

test('MP3 com tag ID3 e MP3 sem tag caem os dois em .mp3', () => {
  const semTag = amostras.mp3
  const comTag = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'), semTag])
  assert.equal(sniffAudioExtension(semTag), 'mp3')
  assert.equal(sniffAudioExtension(comTag), 'mp3')
})

test('AAC em ADTS não é confundido com MP3 (mesmo sync de 11 bits)', () => {
  assert.equal(amostras.aac[0], 0xff)
  assert.equal(amostras.aac[1] & 0xe0, 0xe0)
  assert.equal(sniffAudioExtension(amostras.aac), 'aac')
  assert.equal(sniffAudioExtension(amostras.mp3), 'mp3')
})

test('nenhum formato suportado é gravado com extensão diferente do conteúdo real', () => {
  for (const ext of Object.keys(AMOSTRAS)) {
    const escolhido = nomeInbound({ buffer: amostras[ext] })
    assert.ok(escolhido, `.${ext} deveria ser persistido`)
    assert.equal(extensaoDe(escolhido.filename), ext)
    assert.equal(escolhido.extSource, 'magic-bytes')
  }
})

test('o conteúdo real vence Content-Type e nome de arquivo mentirosos', () => {
  for (const ext of Object.keys(AMOSTRAS)) {
    const escolhido = nomeInbound({
      buffer: amostras[ext],
      contentType: 'audio/ogg',
      nome_arquivo: 'gravacao.ogg',
    })
    assert.equal(extensaoDe(escolhido.filename), ext, `.${ext} foi sobrescrito por metadado errado`)
  }
})

test('regressão: octet-stream + nome sem extensão não vira .ogg', () => {
  for (const ext of ['m4a', 'aac', 'mp3', 'amr', '3gp', 'webm', 'wav']) {
    const escolhido = nomeInbound({
      buffer: amostras[ext],
      contentType: 'application/octet-stream',
      nome_arquivo: 'audio',
    })
    assert.equal(extensaoDe(escolhido.filename), ext)
    assert.notEqual(extensaoDe(escolhido.filename), 'ogg')
  }
})

test('sem assinatura reconhecida, o Content-Type é a fonte auxiliar', () => {
  const opaco = Buffer.alloc(64, 0x5a)
  const casos = {
    'audio/oga': 'ogg',
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/x-m4a': 'm4a',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/3gpp': '3gp',
    'audio/amr': 'amr',
    'audio/mpeg': 'mp3',
    'audio/webm': 'webm',
    'audio/wav': 'wav',
  }
  for (const [contentType, ext] of Object.entries(casos)) {
    assert.equal(audioExtensionFromContentType(contentType), ext, contentType)
    const escolhido = nomeInbound({ buffer: opaco, contentType, nome_arquivo: 'audio' })
    assert.equal(extensaoDe(escolhido.filename), ext)
    assert.equal(escolhido.extSource, 'content-type')
  }
})

test('Content-Type com charset e caixa alta continua sendo reconhecido', () => {
  assert.equal(audioExtensionFromContentType('Audio/OGG; codecs=opus'), 'ogg')
  assert.equal(audioExtensionFromContentType('AUDIO/X-M4A'), 'm4a')
})

test('tipos genéricos não decidem formato algum', () => {
  for (const ct of ['application/octet-stream', 'binary/octet-stream', 'text/plain', '', null, undefined]) {
    assert.equal(audioExtensionFromContentType(ct), null, String(ct))
  }
})

test('extensão do nome só é aceita quando é de áudio conhecida', () => {
  assert.equal(audioExtensionFromFilename('voz.oga'), 'ogg')
  assert.equal(audioExtensionFromFilename('voz.3gpp'), '3gp')
  assert.equal(audioExtensionFromFilename('VOZ.M4A'), 'm4a')
  assert.equal(audioExtensionFromFilename('audio'), null)
  assert.equal(audioExtensionFromFilename('audio.txt'), null)
  assert.equal(audioExtensionFromFilename(''), null)
})

test('nome do arquivo é a última fonte, depois de bytes e Content-Type', () => {
  const opaco = Buffer.alloc(64, 0x5a)
  const escolhido = nomeInbound({
    buffer: opaco,
    contentType: 'application/octet-stream',
    nome_arquivo: 'mensagem.amr',
  })
  assert.equal(extensaoDe(escolhido.filename), 'amr')
  assert.equal(escolhido.extSource, 'filename')
})

test('formato não confirmado não é persistido em vez de receber extensão chutada', () => {
  const opaco = Buffer.alloc(64, 0x5a)
  for (const tipo of ['audio', 'voice']) {
    assert.equal(nomeInbound({ tipo, buffer: opaco, contentType: 'application/octet-stream', nome_arquivo: 'audio' }), null)
    assert.equal(nomeInbound({ tipo, buffer: opaco, contentType: '', nome_arquivo: '' }), null)
    assert.equal(nomeInbound({ tipo, buffer: Buffer.alloc(0), contentType: 'application/octet-stream', nome_arquivo: 'audio' }), null)
  }
})

test('o padrão de nome inbound-c{empresa}-m{mensagem} é preservado', () => {
  const escolhido = nomeInbound({ buffer: amostras.ogg })
  assert.match(escolhido.filename, /^inbound-c7-m99-[0-9a-f]{12}\.ogg$/)
})

test('tipos que não são áudio mantêm a cascata anterior', () => {
  const imagem = _test.pickStoredFilename({
    company_id: 1,
    mensagem_id: 2,
    contentType: 'application/octet-stream',
    nome_arquivo: 'foto.jpeg',
    tipo: 'imagem',
    buffer: amostras.ogg,
  })
  assert.equal(extensaoDe(imagem.filename), 'jpg')

  const semPistas = _test.pickStoredFilename({
    company_id: 1,
    mensagem_id: 3,
    contentType: 'application/octet-stream',
    nome_arquivo: '',
    tipo: 'imagem',
    buffer: Buffer.alloc(0),
  })
  assert.equal(extensaoDe(semPistas.filename), 'jpg')

  const video = _test.pickStoredFilename({
    company_id: 1,
    mensagem_id: 4,
    contentType: 'video/mp4',
    nome_arquivo: '',
    tipo: 'video',
    buffer: Buffer.alloc(0),
  })
  assert.equal(extensaoDe(video.filename), 'mp4')
})

test('extFromContentType passou a cobrir os MIME de áudio ampliados', () => {
  assert.equal(_test.extFromContentType('audio/x-m4a'), '.m4a')
  assert.equal(_test.extFromContentType('audio/3gpp'), '.3gp')
  assert.equal(_test.extFromContentType('audio/amr'), '.amr')
  assert.equal(_test.extFromContentType('audio/oga'), '.ogg')
  assert.equal(_test.extFromContentType('application/octet-stream'), null)
  assert.equal(_test.extFromContentType('image/png'), '.png')
})

test('nome sem extensão passa a usar o nome em disco, que carrega o formato real', () => {
  assert.equal(_test.nomeArquivoFinal('audio', 'inbound-c7-m99-abc.m4a'), 'inbound-c7-m99-abc.m4a')
  assert.equal(_test.nomeArquivoFinal('', 'inbound-c7-m99-abc.ogg'), 'inbound-c7-m99-abc.ogg')
  assert.equal(_test.nomeArquivoFinal('recado da cliente.m4a', 'inbound-c7-m99-abc.m4a'), 'recado da cliente.m4a')
})

test('o servidor entrega Content-Type de áudio para extensões que só existem como áudio', () => {
  assert.equal(contentTypeForAudioPath('/uploads/x.ogg'), 'audio/ogg')
  assert.equal(contentTypeForAudioPath('/uploads/x.opus'), 'audio/ogg')
  assert.equal(contentTypeForAudioPath('/uploads/x.oga'), 'audio/ogg')
  assert.equal(contentTypeForAudioPath('/uploads/x.mp3'), 'audio/mpeg')
  assert.equal(contentTypeForAudioPath('/uploads/x.wav'), 'audio/wav')
  assert.equal(contentTypeForAudioPath('/uploads/x.m4a'), 'audio/mp4')
  assert.equal(contentTypeForAudioPath('/uploads/x.aac'), 'audio/aac')
  assert.equal(contentTypeForAudioPath('/uploads/x.amr'), 'audio/amr')
})

test('containers ambíguos e não-áudio ficam com o tipo padrão do express.static', () => {
  for (const p of ['/uploads/x.webm', '/uploads/x.3gp', '/uploads/x.mp4', '/uploads/x.jpg', '/uploads/x.pdf']) {
    assert.equal(contentTypeForAudioPath(p), null, p)
  }
})

/**
 * Fluxo completo com o Supabase e o download simulados: prova o que de fato vai parar no disco,
 * e não apenas a decisão de nome.
 */
function supabaseFake(row, capturado) {
  function builder() {
    const op = { payload: null, temOr: false, temIlike: false }
    const query = {
      select: () => query,
      eq: () => query,
      or() {
        op.temOr = true
        return query
      },
      ilike() {
        op.temIlike = true
        return query
      },
      update(fields) {
        op.payload = fields
        // Só a troca de URL interessa aqui; lock e estado de retentativa não são o objeto do teste.
        if (!op.temOr && 'url' in fields) capturado.update = fields
        return query
      },
      maybeSingle: async () => {
        if (op.temOr) return { data: { id: row.id }, error: null }
        return { data: capturado.update ? { ...row, ...capturado.update } : row, error: null }
      },
      then: (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
    }
    return query
  }
  return { from: () => builder() }
}

async function persistirAmostra({ buffer, contentType, nome_arquivo = 'audio', tipo = 'voice' }) {
  const uploadsAnterior = process.env.UPLOADS_DIR
  const fetchAnterior = global.fetch
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'zaperp-uploads-'))
  process.env.UPLOADS_DIR = uploads

  const remoto = 'https://s3.amazonaws.com/ultramsgmedia/instance1/media-sem-extensao'
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType, 'content-length': String(buffer.length) }),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  })

  const capturado = {}
  try {
    await _test.persistInboundMediaToUploads({
      supabase: supabaseFake(
        { id: 99, company_id: 7, conversa_id: 1, direcao: 'in', url: remoto, tipo, nome_arquivo },
        capturado
      ),
      io: null,
      company_id: 7,
      mensagem_id: 99,
      fromMe: false,
    })
    return { update: capturado.update || null, arquivos: fs.readdirSync(uploads), uploads }
  } finally {
    global.fetch = fetchAnterior
    if (uploadsAnterior === undefined) delete process.env.UPLOADS_DIR
    else process.env.UPLOADS_DIR = uploadsAnterior
    fs.rmSync(uploads, { recursive: true, force: true })
  }
}

test('grava em disco com a extensão do conteúdo real, não com a do Content-Type', async () => {
  for (const ext of Object.keys(AMOSTRAS)) {
    const r = await persistirAmostra({
      buffer: amostras[ext],
      contentType: 'application/octet-stream',
    })
    assert.equal(r.arquivos.length, 1, `.${ext} deveria gerar exatamente um arquivo`)
    assert.equal(extensaoDe(r.arquivos[0]), ext)
    assert.equal(r.update.url, `/uploads/${r.arquivos[0]}`)
    assert.equal(extensaoDe(r.update.nome_arquivo), ext)
  }
}, 30000)

test('áudio de formato desconhecido não é gravado e a URL remota é preservada', async () => {
  const r = await persistirAmostra({
    buffer: Buffer.alloc(64, 0x5a),
    contentType: 'application/octet-stream',
  })
  assert.equal(r.arquivos.length, 0)
  assert.equal(r.update, null)
})

test('resolveInboundAudioExtension informa de qual fonte veio a decisão', () => {
  assert.deepEqual(resolveInboundAudioExtension({ buffer: amostras.wav }), { ext: 'wav', source: 'magic-bytes' })
  assert.deepEqual(
    resolveInboundAudioExtension({ buffer: Buffer.alloc(4), contentType: 'audio/aac' }),
    { ext: 'aac', source: 'content-type' }
  )
  assert.deepEqual(
    resolveInboundAudioExtension({ buffer: null, contentType: '', filename: 'nota.opus' }),
    { ext: 'ogg', source: 'filename' }
  )
  assert.equal(resolveInboundAudioExtension({}), null)
})
