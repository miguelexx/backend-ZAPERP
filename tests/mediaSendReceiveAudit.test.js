/**
 * Auditoria envio/recebimento de mídia (2026-09-11). Trava os bugs corrigidos:
 *  - Whapi POST /media responde `{ media: [{ id }] }` (array) → upload não pode falhar por formato;
 *  - Whapi upload manda MIME real de documento e usa timeout próprio;
 *  - Whapi inbound `gif` / `short` (vídeo-recado) chegam como vídeo com link;
 *  - configureWebhooks liga media.auto_download (sem ele mídia inbound chega sem link);
 *  - POST /chats/:id/arquivo sem telefone não deixa a mídia em pending eterno;
 *  - imagem convertida para JPEG não deixa o upload original órfão no disco.
 * Sem rede, sem token real, sem número de cliente.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

describe('Whapi uploadMedia — contrato oficial e MIME', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    jest.resetModules()
  })

  function mockDeps(responseBody) {
    const fetchWithRetry = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(responseBody),
    }))
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn(() => ({})),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry,
      sleep: jest.fn(async () => {}),
      isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async () => ({
        instance: { id: 10, company_id: 1, provider: 'whapi', instance_id: 'CH-1', instance_token: 'TESTTOKEN', ativo: true },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    return { fetchWithRetry }
  }

  function withTempFile(name, fn) {
    const tmp = path.join(os.tmpdir(), `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${name}`)
    fs.writeFileSync(tmp, Buffer.from('conteudo'))
    return Promise.resolve(fn(tmp)).finally(() => { try { fs.unlinkSync(tmp) } catch { /* ignore */ } })
  }

  test('resposta oficial { media: [{ id }] } vira referência do envio (antes: upload "falhava" e vídeo não saía)', async () => {
    const { fetchWithRetry } = mockDeps({ media: [{ id: 'mp4-5f1c0a2e-4b7d-4c8e-9a1b-0c2d3e4f5a6b' }] })
    const whapi = require('../services/providers/whapi')
    await withTempFile('video.mp4', async (tmp) => {
      const r = await whapi.uploadMedia(tmp, 'video.mp4', { companyId: 1, whatsappInstanceId: 10 })
      expect(r).toEqual({ ok: true, url: 'mp4-5f1c0a2e-4b7d-4c8e-9a1b-0c2d3e4f5a6b', error: null })
      const sent = JSON.parse(fetchWithRetry.mock.calls[0][1].body)
      expect(String(sent.media).startsWith('data:video/mp4;base64,')).toBe(true)
    })
  })

  test('extractUploadedMediaRef aceita array oficial e formatos em objeto', () => {
    mockDeps({})
    const { extractUploadedMediaRef } = require('../services/providers/whapi/upload')
    expect(extractUploadedMediaRef({ media: [{ id: 'jpeg-abc' }] })).toBe('jpeg-abc')
    expect(extractUploadedMediaRef({ media: [{ id: 'jpeg-abc', link: 'https://s3.wasabisys.com/x.jpg' }] })).toBe('https://s3.wasabisys.com/x.jpg')
    expect(extractUploadedMediaRef({ id: 'media-1', link: 'https://cdn.example/x.jpg' })).toBe('https://cdn.example/x.jpg')
    expect(extractUploadedMediaRef({ media: { id: 'obj-1' } })).toBe('obj-1')
    expect(extractUploadedMediaRef({ media: [] })).toBeNull()
    expect(extractUploadedMediaRef(null)).toBeNull()
  })

  test('documento .docx sobe com MIME real (não octet-stream)', async () => {
    const { fetchWithRetry } = mockDeps({ media: [{ id: 'docx-1' }] })
    const whapi = require('../services/providers/whapi')
    await withTempFile('contrato.docx', async (tmp) => {
      await whapi.uploadMedia(tmp, 'contrato.docx', { companyId: 1, whatsappInstanceId: 10 })
      const sent = JSON.parse(fetchWithRetry.mock.calls[0][1].body)
      expect(String(sent.media)).toMatch(/^data:application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document;base64,/)
    })
  })

  test('extensão desconhecida usa opts.mimeType do multer; genérico/malformado é ignorado', async () => {
    const { fetchWithRetry } = mockDeps({ media: [{ id: 'x-1' }] })
    const whapi = require('../services/providers/whapi')
    await withTempFile('arquivo.odt', async (tmp) => {
      await whapi.uploadMedia(tmp, 'arquivo.odt', { companyId: 1, whatsappInstanceId: 10, mimeType: 'application/vnd.oasis.opendocument.text' })
      await whapi.uploadMedia(tmp, 'arquivo.odt', { companyId: 1, whatsappInstanceId: 10, mimeType: 'bad mime;x' })
      const first = JSON.parse(fetchWithRetry.mock.calls[0][1].body)
      const second = JSON.parse(fetchWithRetry.mock.calls[1][1].body)
      expect(String(first.media)).toMatch(/^data:application\/vnd\.oasis\.opendocument\.text;base64,/)
      expect(String(second.media)).toMatch(/^data:application\/octet-stream;base64,/)
    })
  })

  test('extensão conhecida prevalece sobre MIME do navegador', async () => {
    const { fetchWithRetry } = mockDeps({ media: [{ id: 'ogg-1' }] })
    const whapi = require('../services/providers/whapi')
    await withTempFile('voz.ogg', async (tmp) => {
      await whapi.uploadMedia(tmp, 'voz.ogg', { companyId: 1, whatsappInstanceId: 10, mimeType: 'video/webm' })
      const sent = JSON.parse(fetchWithRetry.mock.calls[0][1].body)
      expect(String(sent.media)).toMatch(/^data:audio\/ogg;base64,/)
    })
  })
})

describe('Whapi configureWebhooks — media.auto_download', () => {
  let prevToken
  beforeEach(() => {
    jest.resetModules()
    process.env.WHAPI_BASE_URL = 'https://gate.whapi.test'
    prevToken = process.env.WHATSAPP_WEBHOOK_TOKEN
    process.env.WHATSAPP_WEBHOOK_TOKEN = 'webhook-secret-test'
  })
  afterEach(() => {
    delete process.env.WHAPI_BASE_URL
    if (prevToken === undefined) delete process.env.WHATSAPP_WEBHOOK_TOKEN
    else process.env.WHATSAPP_WEBHOOK_TOKEN = prevToken
    jest.resetModules()
  })

  function mockDeps(fetchImpl) {
    const fetchWithRetry = jest.fn(fetchImpl)
    jest.doMock('../services/whatsappSendGuardService', () => ({
      beforeWhatsAppSend: jest.fn(async () => ({ allow: true })),
      afterWhatsAppSend: jest.fn(),
      buildSendMeta: jest.fn(() => ({})),
    }))
    jest.doMock('../helpers/retryWithBackoff', () => ({
      fetchWithRetry,
      sleep: jest.fn(async () => {}),
      isConnectionLevelError: jest.fn(() => false),
    }))
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async () => ({
        instance: { id: 10, company_id: 1, provider: 'whapi', instance_id: 'CH-1', instance_token: 'TESTTOKEN', ativo: true },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'not found' })),
    }))
    return fetchWithRetry
  }

  test('liga auto_download de todos os tipos de mídia junto com o webhook', async () => {
    const fetchWithRetry = mockDeps(async () => ({ ok: true, status: 200, text: async () => '{}' }))
    const whapi = require('../services/providers/whapi')
    const r = await whapi.configureWebhooks('https://app.example.com', { companyId: 1, whatsappInstanceId: 10 })
    expect(r[0].ok).toBe(true)
    expect(fetchWithRetry).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(fetchWithRetry.mock.calls[0][1].body)
    expect(sent.media.auto_download).toEqual(['image', 'audio', 'voice', 'video', 'document', 'sticker'])
    expect(sent.webhooks[0].url).toBe('https://app.example.com/webhooks/whapi')
  })

  test('canal que recusa `media` (400) ainda recebe o webhook (2º PATCH só webhooks)', async () => {
    let call = 0
    const fetchWithRetry = mockDeps(async () => {
      call += 1
      if (call === 1) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'media invalid' } }) }
      return { ok: true, status: 200, text: async () => '{}' }
    })
    const whapi = require('../services/providers/whapi')
    const r = await whapi.configureWebhooks('https://app.example.com', { companyId: 1, whatsappInstanceId: 10 })
    expect(r[0].ok).toBe(true)
    expect(fetchWithRetry).toHaveBeenCalledTimes(2)
    const second = JSON.parse(fetchWithRetry.mock.calls[1][1].body)
    expect(second.media).toBeUndefined()
    expect(second.webhooks).toHaveLength(1)
  })

  test('401 não repete o PATCH (credencial ruim não é problema do campo media)', async () => {
    const fetchWithRetry = mockDeps(async () => ({ ok: false, status: 401, text: async () => '{}' }))
    const whapi = require('../services/providers/whapi')
    const r = await whapi.configureWebhooks('https://app.example.com', { companyId: 1, whatsappInstanceId: 10 })
    expect(r[0].ok).toBe(false)
    expect(fetchWithRetry).toHaveBeenCalledTimes(1)
  })
})

describe('Whapi inbound — GIF e vídeo-recado (short/PTV)', () => {
  let controller
  beforeEach(() => {
    jest.resetModules()
    jest.doMock('../controllers/webhookZapiController', () => ({
      receberZapi: jest.fn(),
      statusZapi: jest.fn(),
    }))
    controller = require('../controllers/webhookWhapiController')
  })
  afterEach(() => jest.resetModules())

  test('type gif vira vídeo com gif.link e legenda', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'gif.1', from_me: false, type: 'gif', chat_id: '5534988887777@s.whatsapp.net', gif: { link: 'https://s3.wasabisys.com/in-files/a.mp4', mime_type: 'video/mp4', caption: 'kkk' }, timestamp: 1700000000 },
      { channelId: 'CH-1' }
    )
    expect(m.type).toBe('video')
    expect(m.videoUrl).toBe('https://s3.wasabisys.com/in-files/a.mp4')
    expect(m.body).toBe('kkk')
  })

  test('type short (vídeo-recado circular) vira vídeo com short.link', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'short.1', from_me: false, type: 'short', chat_id: '5534988887777@s.whatsapp.net', short: { link: 'https://s3.wasabisys.com/in-files/b.mp4', mime_type: 'video/mp4' }, timestamp: 1700000000 },
      { channelId: 'CH-1' }
    )
    expect(m.type).toBe('video')
    expect(m.videoUrl).toBe('https://s3.wasabisys.com/in-files/b.mp4')
  })

  test('vídeo comum segue igual', () => {
    const m = controller._test.normalizeWhapiMessageToInternal(
      { id: 'vid.1', from_me: false, type: 'video', chat_id: '5534988887777@s.whatsapp.net', video: { link: 'https://s3.wasabisys.com/in-files/c.mp4' }, timestamp: 1700000000 },
      { channelId: 'CH-1' }
    )
    expect(m.type).toBe('video')
    expect(m.videoUrl).toBe('https://s3.wasabisys.com/in-files/c.mp4')
  })

  test('gif normalizado passa pelo extractMessage como vídeo com URL', () => {
    const { extractMessage } = require('../controllers/webhookInbound/payload')
    const normalized = controller._test.normalizeWhapiMessageToInternal(
      { id: 'gif.2', from_me: false, type: 'gif', chat_id: '5534988887777@s.whatsapp.net', gif: { link: 'https://s3.wasabisys.com/in-files/d.mp4' }, timestamp: 1700000000 },
      { channelId: 'CH-1' }
    )
    const r = extractMessage(normalized)
    expect(r.type).toBe('video')
    expect(r.videoUrl).toBe('https://s3.wasabisys.com/in-files/d.mp4')
    expect(r.texto).toBe('(vídeo)')
  })
})

describe('POST /chats/:id/arquivo — estados que antes ficavam em pending', () => {
  let updates
  let emits
  let provider
  let normalizeImageMock

  function makeSupabase({ conversa, insertedMsg }) {
    updates = []
    return {
      from(table) {
        const state = { table, op: 'select', payload: null }
        const builder = {
          select() { return builder },
          insert(p) { state.op = 'insert'; state.payload = p; return builder },
          update(p) { state.op = 'update'; state.payload = p; updates.push({ table, payload: p }); return builder },
          eq() { return builder },
          in() { return builder },
          order() { return builder },
          limit() { return builder },
          maybeSingle() { return builder.single() },
          async single() {
            if (table === 'conversas' && state.op === 'select') return { data: conversa, error: null }
            if (table === 'mensagens' && state.op === 'insert') return { data: { ...insertedMsg, ...state.payload, id: insertedMsg.id }, error: null }
            return { data: null, error: null }
          },
          then(resolve, reject) { return Promise.resolve({ data: null, error: null }).then(resolve, reject) },
        }
        return builder
      },
    }
  }

  function makeIo() {
    emits = []
    const target = {
      to() { return target },
      emit(ev, payload) { emits.push({ ev, payload }) },
    }
    return { EVENTS: { STATUS_MENSAGEM: 'status_mensagem', NOVA_MENSAGEM: 'nova_mensagem' }, to: () => target }
  }

  function loadController({ conversa }) {
    jest.resetModules()
    const supabase = makeSupabase({ conversa, insertedMsg: { id: 555, conversa_id: 9, criado_em: new Date().toISOString(), status: 'pending' } })
    jest.doMock('../config/supabase', () => supabase)
    provider = {
      uploadMedia: jest.fn(async () => ({ ok: true, url: 'https://cdn.example/file' })),
      sendFile: jest.fn(async () => ({ ok: true, messageId: 'true_5534988887777@c.us_ABCDEF123456' })),
      sendImage: jest.fn(async () => ({ ok: true, messageId: 'true_5534988887777@c.us_ABCDEF123457' })),
    }
    jest.doMock('../services/providers', () => ({ getProvider: jest.fn(() => provider) }))
    jest.doMock('../services/absenceFinalizationService', () => ({ tryMarkWaitingAfterHumanOutbound: jest.fn(async () => null) }))
    jest.doMock('../helpers/empresaModoSimplesFlag', () => ({ empresaModoSimplesAtivo: jest.fn(async () => false) }))
    jest.doMock('../services/pendingOutboundReconciliationService', () => ({ schedulePendingOutboundReconciliation: jest.fn() }))
    jest.doMock('../services/mediaR2MirrorService', () => ({ scheduleR2MirrorIfNeeded: jest.fn() }))
    jest.doMock('../services/chat/identity/conversationAddressService', () => ({
      resolveTelefoneFromLidSiblingConversation: jest.fn(async () => null),
      resolveConversationWhatsappInstance: jest.fn(async () => 7),
      resolveConversationProvider: jest.fn(async () => 'ultramsg'),
    }))
    jest.doMock('../services/chat/realtime/chatRealtimeGateway', () => ({
      emitirConversaAtualizada: jest.fn(),
      emitirEventoEmpresaConversa: jest.fn(),
    }))
    jest.doMock('../services/chat/access/conversationPolicy', () => ({ assertPodeEnviarMensagem: jest.fn(async () => ({ ok: true })) }))
    jest.doMock('../services/chat/presentation/messageAuthorEnrichment', () => ({
      getUsuarioParaEnvioCliente: jest.fn(async () => ({ nome: 'Atendente' })),
      enrichMensagemComAutorUsuario: jest.fn(async (_s, _c, p) => p),
    }))
    jest.doMock('../services/chat/outbound/modoSimplesOutbound', () => ({
      aplicarAguardandoClienteNoPayload: jest.fn((p) => p),
      anexarAssumirNoPayloadLista: jest.fn((p) => p),
      recalcularEMesclarModoSimples: jest.fn(async () => null),
    }))
    normalizeImageMock = jest.fn(async (file) => ({ file, converted: false, error: null }))
    jest.doMock('../services/chat/media/mediaNormalizers', () => ({
      normalizeAudioForUltraMsg: jest.fn(async (file) => ({ file, converted: false, required: false, error: null })),
      probeAudioDurationSec: jest.fn(async () => null),
      normalizeVideoForUltraMsg: jest.fn(async (file) => ({ file, converted: false, required: false, error: null })),
      normalizeImageForWhatsapp: (...args) => normalizeImageMock(...args),
    }))
    return require('../controllers/chat/mediaMessageController')
  }

  function makeReqRes(file, io) {
    const req = {
      params: { id: '9' },
      user: { company_id: 1, id: 3, perfil: 'atendente', departamento_ids: [] },
      body: {},
      files: [file],
      app: { get: (k) => (k === 'io' ? io : null) },
    }
    const res = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this },
      json(o) { this.body = o; return this },
    }
    return { req, res }
  }

  const flush = () => new Promise((r) => setImmediate(r))

  afterEach(() => jest.resetModules())

  test('conversa sem telefone: mídia vira erro (antes: relógio eterno) e provider não é chamado', async () => {
    const ctrl = loadController({ conversa: { id: 9, telefone: '', cliente_id: null, tipo: 'cliente', chat_lid: null, whatsapp_instance_id: 7 } })
    const io = makeIo()
    const { req, res } = makeReqRes({
      fieldname: 'file', originalname: 'nota.pdf', mimetype: 'application/pdf', filename: 'x-nota.pdf', path: path.join(os.tmpdir(), 'nao-existe.pdf'), size: 10,
    }, io)
    await ctrl.enviarArquivo(req, res)
    await flush()
    expect(res.statusCode).toBe(200)
    expect(provider.uploadMedia).not.toHaveBeenCalled()
    expect(provider.sendFile).not.toHaveBeenCalled()
    expect(updates).toContainEqual({ table: 'mensagens', payload: { status: 'erro', status_mensagem: 'erro' } })
    expect(emits).toContainEqual({ ev: 'status_mensagem', payload: expect.objectContaining({ mensagem_id: 555, status: 'erro' }) })
  })

  test('imagem convertida: original some do disco, JPEG sobe com mimeType e é enviado', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-img-'))
    const original = path.join(dir, 'foto.png')
    const converted = path.join(dir, 'foto-wa.jpg')
    fs.writeFileSync(original, Buffer.from('png'))
    fs.writeFileSync(converted, Buffer.from('jpg'))
    try {
      const ctrl = loadController({ conversa: { id: 9, telefone: '5534988887777', cliente_id: null, tipo: 'cliente', chat_lid: null, whatsapp_instance_id: 7 } })
      normalizeImageMock.mockImplementation(async (file) => ({
        file: { ...file, path: converted, filename: 'foto-wa.jpg', originalname: 'foto.jpg', mimetype: 'image/jpeg' },
        converted: true,
        error: null,
      }))
      const io = makeIo()
      const { req, res } = makeReqRes({
        fieldname: 'file', originalname: 'foto.png', mimetype: 'image/png', filename: 'foto.png', path: original, size: 3,
      }, io)
      await ctrl.enviarArquivo(req, res)
      for (let i = 0; i < 5; i++) await flush()
      expect(res.statusCode).toBe(200)
      expect(fs.existsSync(original)).toBe(false)
      expect(fs.existsSync(converted)).toBe(true)
      expect(provider.uploadMedia).toHaveBeenCalledWith(converted, 'foto.jpg', expect.objectContaining({ mimeType: 'image/jpeg', whatsappInstanceId: 7 }))
      expect(provider.sendImage).toHaveBeenCalledWith('5534988887777', 'https://cdn.example/file', expect.any(String), expect.objectContaining({ referenceId: 'crm-555' }))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
