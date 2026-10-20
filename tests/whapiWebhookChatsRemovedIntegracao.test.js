/**
 * Integração PONTA A PONTA do webhook Whapi `chats`/`delete`: corpo cru do provedor →
 * handleWebhookWhapi → chatDeletionSyncService → cascata no banco → realtime.
 *
 * Os outros arquivos testam as peças; aqui o alvo é a FIAÇÃO (o que quebra quando alguém mexe
 * no handler): o evento chega ao serviço, a conversa some, o socket sai, o HTTP responde o
 * código certo e nenhum outro caminho do webhook é acionado por engano.
 */

jest.mock('../controllers/webhookZapiController', () => ({
  receberZapi: jest.fn(async (req, res) => res.status(200).json({ ok: true })),
  statusZapi: jest.fn(async (req, res) => res.status(200).json({ ok: true })),
}))
jest.mock('../services/whatsappInstanceService', () => ({
  listWhatsappInstances: jest.fn().mockResolvedValue({ instances: [{ id: 7, ativo: true, is_default: true }] }),
}))
jest.mock('../services/chat/realtime/chatRealtimeGateway', () => ({
  emitirEventoEmpresaConversa: jest.fn(),
  emitirConversaAtualizada: jest.fn(),
}))

const supabase = require('../config/supabase')
const { emitirEventoEmpresaConversa } = require('../services/chat/realtime/chatRealtimeGateway')
const webhookCore = require('../controllers/webhookZapiController')
const sync = require('../services/chat/sync/chatDeletionSyncService')
const { handleWebhookWhapi } = require('../controllers/webhookWhapiController')

const COMPANY = 1
const INSTANCIA = 7
const CHANNEL = 'NEBULA-AER3B'

let conversas
let deletes
let erroSelectConversas
let emitsEmpresa

function fakeSupabase() {
  supabase.from.mockImplementation((table) => {
    const state = { op: 'select', filtros: {} }
    const q = {}
    for (const m of ['select', 'order', 'limit', 'not', 'or', 'gte', 'lte', 'gt', 'lt', 'neq']) q[m] = jest.fn(() => q)
    q.eq = jest.fn((col, val) => { state.filtros[col] = val; return q })
    q.is = jest.fn((col, val) => { state.filtros[col] = val; return q })
    q.in = jest.fn((col, vals) => { state.filtros[`${col}__in`] = vals; return q })
    q.update = jest.fn(() => { state.op = 'update'; return q })
    q.insert = jest.fn(() => { state.op = 'insert'; return q })
    q.delete = jest.fn(() => { state.op = 'delete'; return q })
    const run = () => {
      if (state.op === 'delete') {
        deletes.push({ table, filtros: { ...state.filtros } })
        if (table === 'conversas') conversas = conversas.filter((c) => c.id !== Number(state.filtros.id))
        return Promise.resolve({ data: null, error: null })
      }
      if (table === 'conversas' && state.op === 'select') {
        if (erroSelectConversas) return Promise.resolve({ data: null, error: { message: erroSelectConversas } })
        const telefones = state.filtros.telefone__in || null
        const data = conversas.filter((c) => {
          if (Number(c.company_id) !== Number(state.filtros.company_id)) return false
          if (telefones && !telefones.includes(String(c.telefone))) return false
          if (state.filtros.chat_lid !== undefined && String(c.chat_lid || '') !== String(state.filtros.chat_lid)) return false
          return true
        })
        return Promise.resolve({ data, error: null })
      }
      return Promise.resolve({ data: [], error: null })
    }
    q.single = run
    q.maybeSingle = () => run().then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error }))
    q.then = (ok, fail) => run().then(ok, fail)
    return q
  })
}

/** `req` como o middleware de webhook entrega: contexto do CANAL, nunca do corpo. */
function reqComCorpo(body) {
  const io = {
    to: jest.fn((room) => ({
      emit: jest.fn((evento, payload) => emitsEmpresa.push({ room, evento, payload })),
    })),
  }
  return {
    body,
    webhookContext: {
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      provider: 'whapi',
      provider_instance_id: CHANNEL,
      instanceId: CHANNEL,
    },
    app: { get: (k) => (k === 'io' ? io : null) },
  }
}

function resposta() {
  const r = { statusCode: 200, body: null }
  r.status = jest.fn((c) => { r.statusCode = c; return r })
  r.json = jest.fn((b) => { r.body = b; return r })
  return r
}

beforeEach(() => {
  jest.clearAllMocks()
  sync._test.resetEco()
  delete process.env.WHATSAPP_CHAT_DELETE_SYNC_INBOUND
  delete process.env.WHATSAPP_CHAT_DELETE_SYNC_MAX_BATCH
  erroSelectConversas = null
  deletes = []
  emitsEmpresa = []
  conversas = [
    { id: 10, company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '5534999887766', tipo: 'cliente', cliente_id: 99, status_atendimento: 'aberta', chat_lid: null },
  ]
  fakeSupabase()
})

const CORPO_DELETE = {
  chats_removed: ['5534999887766@s.whatsapp.net'],
  event: { type: 'chats', event: 'delete' },
  channel_id: CHANNEL,
}

test('corpo oficial de chats.delete apaga a conversa e responde 200', async () => {
  const req = reqComCorpo(CORPO_DELETE)
  const res = resposta()
  await handleWebhookWhapi(req, res)

  expect(res.statusCode).toBe(200)
  expect(conversas).toHaveLength(0)
  expect(deletes.some((d) => d.table === 'conversas' && d.filtros.id === 10)).toBe(true)
  expect(deletes.some((d) => d.table === 'mensagens' && d.filtros.conversa_id === 10)).toBe(true)
  expect(req.webhookLogData.counts.chats_removed).toBe(1)
  expect(req.webhookLogData.counts.chats_apagados).toBe(1)
})

test('emite conversa_apagada e o atualizar_conversa{removida} da empresa', async () => {
  await handleWebhookWhapi(reqComCorpo(CORPO_DELETE), resposta())

  expect(emitirEventoEmpresaConversa).toHaveBeenCalledWith(
    expect.anything(), COMPANY, 10, 'conversa_apagada',
    expect.objectContaining({ id: 10, origem: 'whatsapp' }),
  )
  const broadcast = emitsEmpresa.find((e) => e.evento === 'atualizar_conversa')
  expect(broadcast).toBeTruthy()
  expect(broadcast.room).toBe(`empresa_${COMPANY}`)
  expect(broadcast.payload).toEqual(expect.objectContaining({ id: 10, removida: true, origem: 'whatsapp' }))
})

test('não aciona o pipeline de mensagens nem o de ACK', async () => {
  await handleWebhookWhapi(reqComCorpo(CORPO_DELETE), resposta())
  expect(webhookCore.receberZapi).not.toHaveBeenCalled()
  expect(webhookCore.statusZapi).not.toHaveBeenCalled()
})

test('chats.post (chat novo) não apaga nada', async () => {
  const res = resposta()
  await handleWebhookWhapi(reqComCorpo({
    chats: [{ id: '5534999887766@s.whatsapp.net', type: 'contact', timestamp: 1747660332 }],
    event: { type: 'chats', event: 'post' },
    channel_id: CHANNEL,
  }), res)
  expect(res.statusCode).toBe(200)
  expect(conversas).toHaveLength(1)
  expect(deletes).toHaveLength(0)
})

test('chats.patch (mute/label) não apaga nada', async () => {
  await handleWebhookWhapi(reqComCorpo({
    chats_updates: [{ before_update: { id: '5534999887766@s.whatsapp.net' }, after_update: { id: '5534999887766@s.whatsapp.net', mute: true }, changes: ['mute'] }],
    event: { type: 'chats', event: 'patch' },
    channel_id: CHANNEL,
  }), resposta())
  expect(conversas).toHaveLength(1)
  expect(deletes).toHaveLength(0)
})

test('eco da própria exclusão: webhook responde 200 sem apagar de novo', async () => {
  sync.registrarExclusaoLocal({ company_id: COMPANY, telefone: '5534999887766' })
  const req = reqComCorpo(CORPO_DELETE)
  const res = resposta()
  await handleWebhookWhapi(req, res)

  expect(res.statusCode).toBe(200)
  expect(deletes).toHaveLength(0)
  expect(conversas).toHaveLength(1)
  expect(req.webhookLogData.chats_removed_ignorados).toEqual({ eco_da_propria_exclusao: 1 })
})

test('falha de banco devolve 500 para o Whapi reentregar o evento', async () => {
  erroSelectConversas = 'connection reset by peer'
  const res = resposta()
  await handleWebhookWhapi(reqComCorpo(CORPO_DELETE), res)

  expect(res.statusCode).toBe(500)
  expect(deletes).toHaveLength(0)
  expect(conversas).toHaveLength(1)
})

test('chave mestra desligada: 200 e conversa intacta', async () => {
  process.env.WHATSAPP_CHAT_DELETE_SYNC_INBOUND = 'false'
  const res = resposta()
  await handleWebhookWhapi(reqComCorpo(CORPO_DELETE), res)
  expect(res.statusCode).toBe(200)
  expect(conversas).toHaveLength(1)
})

test('lote acima do teto: nada apagado e motivo no log do webhook', async () => {
  process.env.WHATSAPP_CHAT_DELETE_SYNC_MAX_BATCH = '2'
  const req = reqComCorpo({
    chats_removed: ['5534999887766@s.whatsapp.net', '5511111111111@s.whatsapp.net', '5522222222222@s.whatsapp.net'],
    event: { type: 'chats', event: 'delete' },
    channel_id: CHANNEL,
  })
  const res = resposta()
  await handleWebhookWhapi(req, res)

  expect(res.statusCode).toBe(200)
  expect(conversas).toHaveLength(1)
  expect(req.webhookLogData.chats_removed_ignorados).toEqual({ lote_acima_do_teto: 3 })
})

test('webhook sem contexto de canal não apaga (tenant nunca vem do corpo)', async () => {
  const req = reqComCorpo(CORPO_DELETE)
  req.webhookContext = null
  req.zapiContext = null
  const res = resposta()
  await handleWebhookWhapi(req, res)

  expect(res.statusCode).toBe(200)
  expect(deletes).toHaveLength(0)
  expect(conversas).toHaveLength(1)
})
