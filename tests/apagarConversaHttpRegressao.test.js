/**
 * Regressão do DELETE /chats/:id depois da extração da cascata para
 * services/chat/deletion/conversationDeletionService (compartilhada com a exclusão vinda do
 * WhatsApp). O contrato HTTP tinha que ficar IDÊNTICO: mesmos códigos, mesmos campos na resposta,
 * mesma ordem (provedor antes da cascata) e contato preservado sem `apagar_cliente`.
 *
 * Cobre também a guarda anti-loop: apagar aqui precisa registrar a identidade para o eco do
 * provedor não virar uma segunda exclusão.
 */

jest.mock('../services/chat/access/conversationPolicy', () => ({ assertPermissaoConversa: jest.fn() }))
jest.mock('../services/chat/unread/conversationUnreadService', () => ({ marcarComoLidaPorUsuario: jest.fn() }))
jest.mock('../services/chat/realtime/chatRealtimeGateway', () => ({
  emitirEventoEmpresaConversa: jest.fn(),
  emitirConversaAtualizada: jest.fn(),
}))
jest.mock('../services/chat/identity/conversationAddressService', () => ({
  resolveConversationWhatsappInstance: jest.fn(),
  resolveConversationProvider: jest.fn(),
  resolveCompanyWhatsappProvider: jest.fn(),
}))
jest.mock('../services/providers', () => ({ getProvider: jest.fn() }))

const supabase = require('../config/supabase')
const { assertPermissaoConversa } = require('../services/chat/access/conversationPolicy')
const { getProvider } = require('../services/providers')
const {
  resolveConversationWhatsappInstance,
  resolveConversationProvider,
  resolveCompanyWhatsappProvider,
} = require('../services/chat/identity/conversationAddressService')
const { emitirEventoEmpresaConversa } = require('../services/chat/realtime/chatRealtimeGateway')
const sync = require('../services/chat/sync/chatDeletionSyncService')
const { apagarConversa } = require('../controllers/chat/conversationCleanupController')

const COMPANY = 1
const CONVERSA = { id: 10, tipo: 'cliente', cliente_id: 99, telefone: '5534999887766', whatsapp_instance_id: 7 }

let conversaRow
let clienteRow
let deletes
let deleteChat
let ordem

function fakeSupabase() {
  supabase.from.mockImplementation((table) => {
    const state = { op: 'select', filtros: {} }
    const q = {}
    for (const m of ['select', 'order', 'limit', 'not', 'or', 'in', 'is', 'gte', 'lte']) q[m] = jest.fn(() => q)
    q.eq = jest.fn((col, val) => { state.filtros[col] = val; return q })
    q.update = jest.fn(() => { state.op = 'update'; return q })
    q.delete = jest.fn(() => { state.op = 'delete'; return q })
    const run = () => {
      if (state.op === 'delete') {
        deletes.push(table)
        if (table === 'conversas') { ordem.push('cascata'); conversaRow = null }
        if (table === 'clientes') clienteRow = null
        return Promise.resolve({ data: null, error: null })
      }
      if (table === 'conversas') return Promise.resolve({ data: conversaRow, error: null })
      if (table === 'clientes') return Promise.resolve({ data: clienteRow, error: null })
      return Promise.resolve({ data: null, error: null })
    }
    q.single = run
    q.maybeSingle = run
    q.then = (ok, fail) => run().then(ok, fail)
    return q
  })
}

const req = (query = {}) => ({
  user: { id: 2, company_id: COMPANY, perfil: 'admin', departamento_ids: [] },
  params: { id: '10' },
  query,
  body: {},
  app: { get: () => ({ to: () => ({ emit: () => {} }) }) },
})
const res = () => {
  const r = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}

beforeEach(() => {
  jest.clearAllMocks()
  sync._test.resetEco()
  deletes = []
  ordem = []
  conversaRow = { ...CONVERSA }
  clienteRow = { id: 99 }
  resolveConversationWhatsappInstance.mockResolvedValue(7)
  resolveConversationProvider.mockResolvedValue('whapi')
  resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
  deleteChat = jest.fn(async () => { ordem.push('provider'); return true })
  getProvider.mockReturnValue({ deleteChat })
  assertPermissaoConversa.mockResolvedValue({ ok: true })
  fakeSupabase()
})

test('caminho feliz: 200 com os mesmos campos de sempre e contato preservado', async () => {
  const r = res()
  await apagarConversa(req(), r)

  expect(r.status).not.toHaveBeenCalledWith(500)
  expect(r.json).toHaveBeenCalledWith(expect.objectContaining({
    ok: true,
    id: 10,
    contato_preservado: true,
    cliente_apagado: false,
    cliente_id: 99,
    cliente_id_preservado: 99,
    whatsapp_apagado: true,
  }))
})

test('apaga no WhatsApp ANTES da cascata (depois não haveria telefone/instância)', async () => {
  await apagarConversa(req(), res())
  expect(deleteChat).toHaveBeenCalledWith('5534999887766', expect.objectContaining({ companyId: COMPANY, whatsappInstanceId: 7 }))
  expect(ordem[0]).toBe('provider')
  expect(ordem).toContain('cascata')
})

test('registra a guarda anti-loop: o eco do provedor não apaga de novo', async () => {
  await apagarConversa(req(), res())
  expect(sync.foiExclusaoLocalRecente({ company_id: COMPANY, telefone: '5534999887766@s.whatsapp.net' })).toBe(true)
})

test('sem apagar_cliente a cascata NÃO toca o cadastro do cliente', async () => {
  await apagarConversa(req(), res())
  expect(deletes).toContain('mensagens')
  expect(deletes).toContain('atendimentos')
  expect(deletes).toContain('conversas')
  expect(deletes).not.toContain('clientes')
})

test('apagar_cliente=1 apaga o cadastro e responde cliente_apagado', async () => {
  const r = res()
  await apagarConversa(req({ apagar_cliente: '1' }), r)
  expect(deletes).toContain('clientes')
  expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ cliente_apagado: true, cliente_id_preservado: null }))
})

test('conversa de grupo continua recusada com 400', async () => {
  conversaRow = { ...CONVERSA, tipo: 'grupo', telefone: '120363000000000000@g.us' }
  const r = res()
  await apagarConversa(req(), r)
  expect(r.status).toHaveBeenCalledWith(400)
  expect(deletes).toHaveLength(0)
  expect(deleteChat).not.toHaveBeenCalled()
})

test('conversa inexistente continua 404', async () => {
  conversaRow = null
  const r = res()
  await apagarConversa(req(), r)
  expect(r.status).toHaveBeenCalledWith(404)
  expect(deletes).toHaveLength(0)
})

test('sem permissão continua com o status da política e não apaga', async () => {
  assertPermissaoConversa.mockResolvedValue({ ok: false, status: 403, error: 'Sem permissão' })
  const r = res()
  await apagarConversa(req(), r)
  expect(r.status).toHaveBeenCalledWith(403)
  expect(deletes).toHaveLength(0)
  expect(deleteChat).not.toHaveBeenCalled()
})

test('id inválido continua 400', async () => {
  const r = res()
  const bad = req()
  bad.params.id = 'abc'
  await apagarConversa(bad, r)
  expect(r.status).toHaveBeenCalledWith(400)
})

test('falha no provedor não impede a exclusão local (best-effort)', async () => {
  deleteChat = jest.fn(async () => { throw new Error('canal fora do ar') })
  getProvider.mockReturnValue({ deleteChat })
  const r = res()
  await apagarConversa(req(), r)
  expect(deletes).toContain('conversas')
  expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, whatsapp_apagado: false }))
})

test('emite conversa_apagada com origem=usuario', async () => {
  await apagarConversa(req(), res())
  expect(emitirEventoEmpresaConversa).toHaveBeenCalledWith(
    expect.anything(), COMPANY, 10, 'conversa_apagada',
    expect.objectContaining({ id: 10, origem: 'usuario', whatsapp_apagado: true }),
  )
})

// =====================================================================================
// Regressão do motivo pelo qual "apaguei no ZapERP e não sumiu do WhatsApp" (20/10)
// =====================================================================================

describe('conversa sem whatsapp_instance_id', () => {
  test('resolve a instância mesmo com o campo nulo (antes pulava e caía no UltraMSG)', async () => {
    conversaRow = { ...CONVERSA, whatsapp_instance_id: null }
    const r = res()
    await apagarConversa(req(), r)

    expect(resolveConversationWhatsappInstance).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ id: 10 }))
    expect(deleteChat).toHaveBeenCalled()
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ whatsapp_apagado: true, whatsapp_motivo: null }))
  })

  test('empresa só-Whapi sem instância na conversa usa o provider DA EMPRESA, não ultramsg', async () => {
    conversaRow = { ...CONVERSA, whatsapp_instance_id: null }
    resolveConversationWhatsappInstance.mockResolvedValue(null)
    resolveCompanyWhatsappProvider.mockResolvedValue('whapi')
    await apagarConversa(req(), res())

    expect(resolveCompanyWhatsappProvider).toHaveBeenCalledWith(COMPANY)
    expect(getProvider).toHaveBeenCalledWith({ provider: 'whapi' })
    expect(deleteChat).toHaveBeenCalled()
  })
})

describe('motivo quando não sai do WhatsApp', () => {
  test('provedor recusa → whatsapp_motivo=provedor_recusou (antes era silêncio)', async () => {
    deleteChat = jest.fn(async () => false)
    getProvider.mockReturnValue({ deleteChat })
    const r = res()
    await apagarConversa(req(), r)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ whatsapp_apagado: false, whatsapp_motivo: 'provedor_recusou' }))
  })

  test('adapter sem deleteChat → provider_sem_suporte', async () => {
    getProvider.mockReturnValue({})
    const r = res()
    await apagarConversa(req(), r)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ whatsapp_motivo: 'provider_sem_suporte' }))
  })

  test('conversa por LID → conversa_por_lid e nada é chamado no provedor', async () => {
    conversaRow = { ...CONVERSA, telefone: 'lid:280396956696801' }
    const r = res()
    await apagarConversa(req(), r)
    expect(deleteChat).not.toHaveBeenCalled()
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ whatsapp_motivo: 'conversa_por_lid' }))
  })

  test('erro de conexão → erro_de_conexao e a conversa some do sistema mesmo assim', async () => {
    deleteChat = jest.fn(async () => { throw new Error('ECONNRESET') })
    getProvider.mockReturnValue({ deleteChat })
    const r = res()
    await apagarConversa(req(), r)
    expect(deletes).toContain('conversas')
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, whatsapp_motivo: 'erro_de_conexao' }))
  })
})
