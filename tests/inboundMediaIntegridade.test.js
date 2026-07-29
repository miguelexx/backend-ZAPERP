/**
 * Integridade do ÁUDIO RECEBIDO ao ser copiado da UltraMsg para /uploads.
 *
 * Contraparte inbound do defeito de envio: se o corpo da resposta chegar cortado
 * (conexão caiu, proxy truncou), gravar o pedaço em /uploads faria duas coisas ruins —
 * o atendente passaria a ouvir um áudio do cliente truncado, e a cópia local
 * SOBRESCREVERIA no banco a URL remota que ainda funcionava. Nesse caso a mensagem tem
 * de continuar apontando para a URL da UltraMsg, deixando a varredura de retry tentar
 * de novo mais tarde.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { Readable } = require('stream')

const tmpUploads = fs.mkdtempSync(path.join(os.tmpdir(), 'zaperp-inbound-'))
process.env.UPLOADS_DIR = tmpUploads

const { _test } = require('../services/inboundMediaPersistenceService')
const { persistInboundMediaToUploads } = _test

const URL_REMOTA = 'https://s3.amazonaws.com/ultramsgmedia/instance1/audio.ogg'

/** Supabase mínimo: devolve a linha da mensagem e registra o update. */
function fakeSupabase(row, updates) {
  return {
    from() {
      const q = {
        select: () => q,
        eq: () => q,
        ilike: () => q,
        maybeSingle: async () => ({ data: q.__updating ? { ...row, ...q.__payload } : row, error: null }),
        update(payload) {
          q.__updating = true
          q.__payload = payload
          updates.push(payload)
          return q
        },
      }
      return q
    },
  }
}

const linhaAudio = {
  id: 77,
  conversa_id: 5,
  company_id: 1,
  tipo: 'audio',
  url: URL_REMOTA,
  direcao: 'in',
  nome_arquivo: null,
  criado_em: new Date().toISOString(),
}

const CORPO = Buffer.from('OggS-conteudo-de-audio-completo-para-teste')

function respostaFake({ body, contentLength }) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (h) => {
        const k = String(h).toLowerCase()
        if (k === 'content-length') return contentLength == null ? null : String(contentLength)
        if (k === 'content-type') return 'audio/ogg'
        return null
      },
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }
}

let fetchOriginal
beforeAll(() => { fetchOriginal = global.fetch })
afterAll(() => {
  global.fetch = fetchOriginal
  try { fs.rmSync(tmpUploads, { recursive: true, force: true }) } catch { /* ignore */ }
})

function arquivosSalvos() {
  try {
    return fs.readdirSync(tmpUploads).filter((f) => f.startsWith('inbound-'))
  } catch {
    return []
  }
}

beforeEach(() => {
  for (const f of arquivosSalvos()) {
    try { fs.unlinkSync(path.join(tmpUploads, f)) } catch { /* ignore */ }
  }
})

test('download COMPLETO é persistido e a URL passa a apontar para /uploads', async () => {
  global.fetch = async () => respostaFake({ body: CORPO, contentLength: CORPO.byteLength })
  const updates = []

  await persistInboundMediaToUploads({
    supabase: fakeSupabase(linhaAudio, updates),
    io: null,
    company_id: 1,
    mensagem_id: 77,
    fromMe: false,
  })

  expect(updates).toHaveLength(1)
  expect(String(updates[0].url)).toMatch(/^\/uploads\/inbound-c1-m77-/)
  const salvos = arquivosSalvos()
  expect(salvos).toHaveLength(1)
  expect(fs.statSync(path.join(tmpUploads, salvos[0])).size).toBe(CORPO.byteLength)
})

test('resposta real do fetch é persistida por streaming, sem arrayBuffer', async () => {
  const arrayBuffer = jest.fn(async () => {
    throw new Error('não deve materializar o arquivo inteiro na memória')
  })
  global.fetch = async () => ({
    ...respostaFake({ body: CORPO, contentLength: CORPO.byteLength }),
    body: Readable.toWeb(Readable.from([CORPO])),
    arrayBuffer,
  })
  const updates = []

  await persistInboundMediaToUploads({
    supabase: fakeSupabase(linhaAudio, updates),
    io: null,
    company_id: 1,
    mensagem_id: 77,
    fromMe: false,
  })

  expect(updates).toHaveLength(1)
  expect(arquivosSalvos()).toHaveLength(1)
  expect(arrayBuffer).not.toHaveBeenCalled()
})

test('download CORTADO não é persistido — mensagem continua na URL remota', async () => {
  const parcial = CORPO.subarray(0, 10)
  global.fetch = async () => respostaFake({ body: parcial, contentLength: CORPO.byteLength })
  const updates = []

  await persistInboundMediaToUploads({
    supabase: fakeSupabase(linhaAudio, updates),
    io: null,
    company_id: 1,
    mensagem_id: 77,
    fromMe: false,
  })

  expect(updates).toHaveLength(0)
  expect(arquivosSalvos()).toHaveLength(0)
})

test('corpo vazio não é persistido', async () => {
  global.fetch = async () => respostaFake({ body: Buffer.alloc(0), contentLength: 0 })
  const updates = []

  await persistInboundMediaToUploads({
    supabase: fakeSupabase(linhaAudio, updates),
    io: null,
    company_id: 1,
    mensagem_id: 77,
    fromMe: false,
  })

  expect(updates).toHaveLength(0)
  expect(arquivosSalvos()).toHaveLength(0)
})

test('sem content-length (chunked) o corpo recebido é aceito', async () => {
  global.fetch = async () => respostaFake({ body: CORPO, contentLength: null })
  const updates = []

  await persistInboundMediaToUploads({
    supabase: fakeSupabase(linhaAudio, updates),
    io: null,
    company_id: 1,
    mensagem_id: 77,
    fromMe: false,
  })

  expect(updates).toHaveLength(1)
  expect(arquivosSalvos()).toHaveLength(1)
})
