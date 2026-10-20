/**
 * Sincronização da EXCLUSÃO de conversa entre ZapERP e WhatsApp (doc 34).
 *
 * Cobre:
 *  - Whapi: webhook `chats`/`delete` (`chats_removed[]`) apaga a conversa aqui e avisa por socket;
 *  - anti-loop: o eco da exclusão que partiu do ZapERP não dispara uma segunda exclusão;
 *  - identificação por company_id + instância + telefone/LID (±9º dígito), NUNCA por nome;
 *  - isolamento: conversa de outra empresa/instância nunca é tocada;
 *  - `chats.post` / `chats.patch` não podem virar exclusão;
 *  - teto de lote: `chats_removed` grande (resync de canal) é recusado inteiro;
 *  - reconciliação (fallback UltraMSG): simulação por padrão e aborto com lista vazia do provedor.
 */

jest.mock('../services/whatsappInstanceService', () => ({
  listWhatsappInstances: jest.fn().mockResolvedValue({ instances: [{ id: 7, ativo: true, is_default: true }] }),
}))
jest.mock('../services/chat/realtime/chatRealtimeGateway', () => ({
  emitirEventoEmpresaConversa: jest.fn(),
  emitirConversaAtualizada: jest.fn(),
}))

const supabase = require('../config/supabase')
const { emitirEventoEmpresaConversa } = require('../services/chat/realtime/chatRealtimeGateway')
const { listWhatsappInstances } = require('../services/whatsappInstanceService')
const sync = require('../services/chat/sync/chatDeletionSyncService')

const COMPANY = 1
const INSTANCIA = 7

/** Linhas de `conversas` disponíveis no "banco" fake. */
let conversas
/** Registro de DELETEs aplicados: { table, filtros } */
let deletes
/** Quando setado, todo SELECT em `conversas` devolve erro (simula falha de infra). */
let erroSelectConversas

function fakeSupabase() {
  supabase.from.mockImplementation((table) => {
    const state = { op: 'select', filtros: {}, ins: [] }
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
        if (table === 'conversas') {
          const id = Number(state.filtros.id)
          conversas = conversas.filter((c) => c.id !== id)
        }
        return Promise.resolve({ data: null, error: null })
      }
      if (table === 'conversas' && state.op === 'select') {
        if (erroSelectConversas) return Promise.resolve({ data: null, error: { message: erroSelectConversas } })
        const cid = Number(state.filtros.company_id)
        const telefones = state.filtros.telefone__in || null
        const chatLid = state.filtros.chat_lid
        const instancia = state.filtros.whatsapp_instance_id
        const data = conversas.filter((c) => {
          if (Number(c.company_id) !== cid) return false
          if (telefones && !telefones.includes(String(c.telefone))) return false
          if (chatLid !== undefined && String(c.chat_lid || '') !== String(chatLid)) return false
          if (instancia !== undefined && Number(c.whatsapp_instance_id) !== Number(instancia)) return false
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

const io = () => ({ to: jest.fn(() => ({ emit: jest.fn() })) })

beforeEach(() => {
  jest.clearAllMocks()
  sync._test.resetEco()
  delete process.env.WHATSAPP_CHAT_DELETE_SYNC_INBOUND
  delete process.env.WHATSAPP_CHAT_DELETE_SYNC_MAX_BATCH
  listWhatsappInstances.mockResolvedValue({ instances: [{ id: INSTANCIA, ativo: true, is_default: true }] })
  erroSelectConversas = null
  deletes = []
  conversas = [
    { id: 10, company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '5534999887766', tipo: 'cliente', cliente_id: 99, status_atendimento: 'aberta', chat_lid: null, ultima_atividade: '2026-01-01T00:00:00Z' },
    { id: 11, company_id: 2, whatsapp_instance_id: 8, telefone: '5534999887766', tipo: 'cliente', cliente_id: 77, status_atendimento: 'aberta', chat_lid: null, ultima_atividade: '2026-01-01T00:00:00Z' },
  ]
  fakeSupabase()
})

// =====================================================================================
// Identidade do chat
// =====================================================================================

describe('identidade do chat', () => {
  test('normaliza os formatos de endereço que os provedores usam', () => {
    expect(sync.chaveIdentidadeDeChat('5534999887766@s.whatsapp.net')).toBe('5534999887766')
    expect(sync.chaveIdentidadeDeChat('5534999887766@c.us')).toBe('5534999887766')
    expect(sync.chaveIdentidadeDeChat('123456789012345@lid')).toBe('lid:123456789012345')
    expect(sync.chaveIdentidadeDeChat('lid:123456789012345')).toBe('lid:123456789012345')
    expect(sync.chaveIdentidadeDeChat('120363000000000000@g.us')).toBe('120363000000000000@g.us')
    expect(sync.chaveIdentidadeDeChat('')).toBeNull()
    expect(sync.chaveIdentidadeDeChat('status@broadcast')).toBeNull()
  })

  test('parte do LID fica CRUA, igual ao que o inbound grava em telefone/chat_lid', () => {
    // webhookInbound/payload.js grava `lid:${raw.replace(/@lid$/i,'')}` — sem tirar não-dígitos.
    // Normalizar aqui faria a chave divergir da do banco num LID com sufixo de device.
    expect(sync.chaveIdentidadeDeChat('123456789012345:12@lid')).toBe('lid:123456789012345:12')
  })

  test('variantes cobrem o 9º dígito (o provedor pode ecoar a outra forma)', () => {
    const v = sync.variantesDeIdentidade('5534999887766')
    expect(v).toContain('5534999887766')
    expect(v).toContain('553499887766')
  })
})

// =====================================================================================
// WhatsApp → ZapERP
// =====================================================================================

describe('exclusão vinda do WhatsApp', () => {
  test('apaga a conversa da instância certa e emite conversa_apagada', async () => {
    const r = await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      telefone: '5534999887766@s.whatsapp.net',
      io: io(),
    })
    expect(r.aplicadas).toEqual([10])
    expect(deletes.some((d) => d.table === 'conversas' && d.filtros.id === 10)).toBe(true)
    expect(emitirEventoEmpresaConversa).toHaveBeenCalledWith(
      expect.anything(), COMPANY, 10, 'conversa_apagada',
      expect.objectContaining({ id: 10, origem: 'whatsapp', whatsapp_apagado: true, cliente_apagado: false }),
    )
  })

  test('NUNCA apaga o cadastro do cliente (contato/CRM/tags preservados)', async () => {
    await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      telefone: '5534999887766',
      io: io(),
    })
    expect(deletes.some((d) => d.table === 'clientes')).toBe(false)
    expect(deletes.some((d) => d.table === 'cliente_tags')).toBe(false)
    expect(deletes.some((d) => d.table === 'campanha_envios')).toBe(false)
  })

  test('conversa de outra empresa nunca é tocada', async () => {
    await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      telefone: '5534999887766',
      io: io(),
    })
    expect(conversas.some((c) => c.id === 11)).toBe(true)
  })

  test('conversa de outra instância da MESMA empresa não é apagada', async () => {
    conversas.push({ id: 12, company_id: COMPANY, whatsapp_instance_id: 9, telefone: '5511988887777', tipo: 'cliente', cliente_id: null, status_atendimento: 'aberta', chat_lid: null })
    const r = await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      telefone: '5511988887777',
      io: io(),
    })
    expect(r.aplicadas).toEqual([])
    expect(r.ignorado).toBe('conversa_nao_encontrada')
    expect(conversas.some((c) => c.id === 12)).toBe(true)
  })

  test('casa pelo ±9º dígito (conversa gravada sem o 9)', async () => {
    conversas = [{ id: 20, company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '553499887766', tipo: 'cliente', cliente_id: null, status_atendimento: 'aberta', chat_lid: null }]
    const r = await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      telefone: '5534999887766@s.whatsapp.net',
      io: io(),
    })
    expect(r.aplicadas).toEqual([20])
  })

  test('grupo é ignorado (sair de grupo é outro fluxo)', async () => {
    const r = await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      telefone: '120363000000000000@g.us',
      io: io(),
    })
    expect(r.ignorado).toBe('grupo')
    expect(deletes).toHaveLength(0)
  })

  test('erro de banco NÃO é "não achei": sinaliza para o webhook pedir reentrega', async () => {
    erroSelectConversas = 'connection reset'
    const r = await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      telefone: '5534999887766',
      io: io(),
    })
    expect(r.ignorado).toBe('erro_de_banco')
    expect(r.erroDeBanco).toBe('connection reset')
    expect(deletes).toHaveLength(0)
  })

  test('conversa legada sem instância: apaga só quando a empresa tem UM número', async () => {
    conversas = [{ id: 50, company_id: COMPANY, whatsapp_instance_id: null, telefone: '5534999887766', tipo: 'cliente', cliente_id: null, status_atendimento: 'aberta', chat_lid: null }]
    const r = await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '5534999887766', io: io(),
    })
    expect(r.aplicadas).toEqual([50])
  })

  test('conversa legada sem instância NÃO é apagada se a empresa tem vários números', async () => {
    listWhatsappInstances.mockResolvedValue({
      instances: [{ id: INSTANCIA, ativo: true }, { id: 8, ativo: true }],
    })
    conversas = [{ id: 51, company_id: COMPANY, whatsapp_instance_id: null, telefone: '5534999887766', tipo: 'cliente', cliente_id: null, status_atendimento: 'aberta', chat_lid: null }]
    const r = await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '5534999887766', io: io(),
    })
    expect(r.aplicadas).toEqual([])
    expect(conversas.some((c) => c.id === 51)).toBe(true)
  })

  test('canal sem instância resolvida não apaga em empresa multi-número', async () => {
    listWhatsappInstances.mockResolvedValue({
      instances: [{ id: INSTANCIA, ativo: true }, { id: 8, ativo: true }],
    })
    const r = await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY, whatsapp_instance_id: null, telefone: '5534999887766', io: io(),
    })
    expect(r.aplicadas).toEqual([])
    expect(conversas.some((c) => c.id === 10)).toBe(true)
  })

  test('casa a conversa espelhada por LID pelo chat_lid (parte crua)', async () => {
    conversas = [{ id: 60, company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '5534999887766', tipo: 'cliente', cliente_id: null, status_atendimento: 'aberta', chat_lid: '280396956696801' }]
    const r = await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '280396956696801@lid', io: io(),
    })
    expect(r.aplicadas).toEqual([60])
  })

  test('chave mestra desligada não apaga nada', async () => {
    process.env.WHATSAPP_CHAT_DELETE_SYNC_INBOUND = 'false'
    const r = await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      telefone: '5534999887766',
      io: io(),
    })
    expect(r.ignorado).toBe('sync_desligado')
    expect(conversas.some((c) => c.id === 10)).toBe(true)
  })
})

// =====================================================================================
// Anti-loop
// =====================================================================================

describe('anti-loop', () => {
  test('eco da própria exclusão não dispara nova exclusão', async () => {
    sync.registrarExclusaoLocal({ company_id: COMPANY, telefone: '5534999887766' })
    const r = await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      telefone: '5534999887766@s.whatsapp.net',
      io: io(),
    })
    expect(r.ignorado).toBe('eco_da_propria_exclusao')
    expect(deletes).toHaveLength(0)
  })

  test('eco reconhecido mesmo quando o provedor devolve a outra forma do número', async () => {
    sync.registrarExclusaoLocal({ company_id: COMPANY, telefone: '5534999887766' })
    expect(sync.foiExclusaoLocalRecente({ company_id: COMPANY, telefone: '553499887766@c.us' })).toBe(true)
  })

  test('guarda é por tenant — eco da empresa 1 não cobre a empresa 2', () => {
    sync.registrarExclusaoLocal({ company_id: COMPANY, telefone: '5534999887766' })
    expect(sync.foiExclusaoLocalRecente({ company_id: 2, telefone: '5534999887766' })).toBe(false)
  })

  test('mensagem nova depois da exclusão recria a conversa normalmente (nada bloqueia)', async () => {
    await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '5534999887766', io: io(),
    })
    // Não existe tombstone: o inbound recria a conversa e uma nova exclusão remota volta a valer.
    conversas.push({ id: 30, company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '5534999887766', tipo: 'cliente', cliente_id: 99, status_atendimento: 'aberta', chat_lid: null })
    sync._test.resetEco()
    const r2 = await sync.aplicarExclusaoRemotaDeChat({
      company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '5534999887766', io: io(),
    })
    expect(r2.aplicadas).toEqual([30])
  })
})

// =====================================================================================
// Lote
// =====================================================================================

describe('lote de chats removidos', () => {
  test('lote acima do teto é recusado inteiro (resync de canal)', async () => {
    process.env.WHATSAPP_CHAT_DELETE_SYNC_MAX_BATCH = '2'
    const r = await sync.aplicarExclusaoRemotaEmLote({
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      chats: ['5534999887766@s.whatsapp.net', '5511111111111@s.whatsapp.net', '5522222222222@s.whatsapp.net'],
      io: io(),
    })
    expect(r.recusadoPorLote).toBe(true)
    expect(r.aplicadas).toEqual([])
    expect(conversas.some((c) => c.id === 10)).toBe(true)
  })

  test('lote dentro do teto aplica e deduplica', async () => {
    const r = await sync.aplicarExclusaoRemotaEmLote({
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      chats: ['5534999887766@s.whatsapp.net', '5534999887766@c.us'],
      io: io(),
    })
    expect(r.aplicadas).toEqual([10])
  })
})

// =====================================================================================
// Reconciliação (fallback UltraMSG)
// =====================================================================================

describe('reconciliação contra GET /chats', () => {
  const providerCom = (ids) => ({ getChats: jest.fn().mockResolvedValue(ids.map((id) => ({ id }))) })

  beforeEach(() => {
    conversas = [
      { id: 40, company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '5534999887766', tipo: 'cliente', cliente_id: null, status_atendimento: 'aberta', ultima_atividade: '2020-01-01T00:00:00Z' },
      { id: 41, company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '5511988887777', tipo: 'cliente', cliente_id: null, status_atendimento: 'aberta', ultima_atividade: '2020-01-01T00:00:00Z' },
      { id: 42, company_id: COMPANY, whatsapp_instance_id: INSTANCIA, telefone: '5521977776666', tipo: 'cliente', cliente_id: null, status_atendimento: 'em_atendimento', ultima_atividade: '2020-01-01T00:00:00Z' },
    ]
  })

  test('lista vazia do provedor ABORTA (não apaga por falha de leitura)', async () => {
    const r = await sync.reconciliarExclusoesDeChats({
      company_id: COMPANY, whatsapp_instance_id: INSTANCIA, provider: providerCom([]), aplicar: true, io: io(),
    })
    expect(r.ok).toBe(false)
    expect(deletes).toHaveLength(0)
  })

  test('simulação é o padrão: aponta candidatos sem apagar', async () => {
    const r = await sync.reconciliarExclusoesDeChats({
      company_id: COMPANY, whatsapp_instance_id: INSTANCIA, provider: providerCom(['5534999887766@c.us']), io: io(),
    })
    expect(r.ok).toBe(true)
    expect(r.simulacao).toBe(true)
    expect(r.candidatos.map((c) => c.conversa_id)).toEqual([41])
    expect(deletes).toHaveLength(0)
  })

  test('conversa em atendimento nunca entra como candidata', async () => {
    const r = await sync.reconciliarExclusoesDeChats({
      company_id: COMPANY, whatsapp_instance_id: INSTANCIA, provider: providerCom(['5534999887766@c.us']), io: io(),
    })
    expect(r.candidatos.map((c) => c.conversa_id)).not.toContain(42)
  })

  test('conversa com atividade recente não entra (chat novo pode não constar ainda)', async () => {
    conversas[1].ultima_atividade = new Date().toISOString()
    const r = await sync.reconciliarExclusoesDeChats({
      company_id: COMPANY, whatsapp_instance_id: INSTANCIA, provider: providerCom(['5534999887766@c.us']), io: io(),
    })
    expect(r.candidatos).toHaveLength(0)
  })

  test('aplicar=true apaga os candidatos e emite realtime', async () => {
    const r = await sync.reconciliarExclusoesDeChats({
      company_id: COMPANY, whatsapp_instance_id: INSTANCIA, provider: providerCom(['5534999887766@c.us']), aplicar: true, io: io(),
    })
    expect(r.aplicadas).toEqual([41])
    expect(emitirEventoEmpresaConversa).toHaveBeenCalledWith(
      expect.anything(), COMPANY, 41, 'conversa_apagada',
      expect.objectContaining({ origem: 'reconciliacao' }),
    )
  })

  test('lista PARCIAL do provedor aborta ao aplicar (GET /chats paginado não apaga a base)', async () => {
    // 12 conversas antigas, provedor só devolve 2 (1ª página) → 10 "candidatos" = 83% da amostra.
    conversas = Array.from({ length: 12 }, (_, i) => ({
      id: 100 + i,
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      telefone: `55349900000${String(i).padStart(2, '0')}`,
      tipo: 'cliente',
      cliente_id: null,
      status_atendimento: 'aberta',
      ultima_atividade: '2020-01-01T00:00:00Z',
    }))
    const provider = providerCom(['5534990000000@c.us', '5534990000001@c.us'])
    const r = await sync.reconciliarExclusoesDeChats({
      company_id: COMPANY, whatsapp_instance_id: INSTANCIA, provider, aplicar: true, io: io(),
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/incompleta|paginada/i)
    expect(r.aplicadas).toEqual([])
    expect(deletes).toHaveLength(0)
    expect(conversas).toHaveLength(12)
  })

  test('simulação informa o total de candidatos mesmo acima do limite', async () => {
    conversas = Array.from({ length: 6 }, (_, i) => ({
      id: 200 + i,
      company_id: COMPANY,
      whatsapp_instance_id: INSTANCIA,
      telefone: `55349911000${String(i).padStart(2, '0')}`,
      tipo: 'cliente',
      cliente_id: null,
      status_atendimento: 'aberta',
      ultima_atividade: '2020-01-01T00:00:00Z',
    }))
    const r = await sync.reconciliarExclusoesDeChats({
      company_id: COMPANY, whatsapp_instance_id: INSTANCIA, provider: providerCom(['5511999999999@c.us']), limite: 2, io: io(),
    })
    expect(r.ok).toBe(true)
    expect(r.total_candidatos).toBe(6)
    expect(r.candidatos).toHaveLength(2)
    expect(r.conversas_examinadas).toBe(6)
  })
})
