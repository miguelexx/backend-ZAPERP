const supabase = require('../config/supabase')
const { createTriageSendGuard } = require('../services/triageConversationGuard')
const { processIncomingMessage, transferToDepartment, invalidateChatbotConfigCache, resetChatbotStateForConversa } = require('../services/chatbotTriageService')
const { handleWhapiTriageInbound } = require('../services/whapiTriage/whapiTriageService')
const { fetchWithRetry } = require('../helpers/retryWithBackoff')

// Banco em memória que aplica os filtros também no UPDATE: reproduz disputa pelo claim.
function database({ conversa = {}, config = {}, menuSent = false, users = [], persistHistory = false, onRead = () => {}, onUpdate = () => {} } = {}) {
  const state = { id: 901, company_id: 77, atendente_id: null, departamento_id: null, status_atendimento: 'aberta', ...conversa }
  const writes = []
  let reads = 0
  const sb = { from: jest.fn((table) => {
    let filters = [], patch = null, inserted = null
    const q = {}
    for (const method of ['select', 'order', 'limit', 'gte', 'gt', 'not', 'lt', 'ilike']) q[method] = () => q
    q.eq = q.is = (key, value) => { filters.push((r) => r[key] === value); return q }
    q.in = (key, values) => { filters.push((r) => values.includes(r[key])); return q }
    q.update = (value) => { patch = value; return q }
    q.insert = (value) => { inserted = value; return q }
    q.delete = () => q
    const execute = (single) => {
      if (table === 'conversas') {
        if (patch) onUpdate(state)
        else onRead(state, ++reads)
        if (sb.stateError) return { data: null, error: { message: 'indisponível' } }
        if (!filters.every((f) => f(state))) return { data: single ? null : [] }
        if (patch) { Object.assign(state, patch); writes.push({ table, value: patch }) }
        return { data: single ? { ...state } : [{ ...state }] }
      }
      if (inserted) { writes.push({ table, value: inserted }); return { data: { id: 2, ...inserted } } }
      if (table === 'ia_config') return { data: { config: { chatbot_triage: {
        enabled: true, welcomeMessage: 'Olá! Selecione o setor.', intervaloEnvioSegundos: 0,
        options: [{ key: '1', label: 'Suporte', departamento_id: 5, active: true }], ...config,
      } } } }
      if (table === 'departamentos') return { data: { id: 5, nome: 'Suporte' } }
      if (table === 'usuarios') return { data: users.map((id) => ({ id })) }
      if (persistHistory && ['mensagens', 'bot_logs'].includes(table)) {
        const seed = table === 'mensagens' ? [{ company_id: 77, conversa_id: state.id, direcao: 'in', texto: 'oi' }] : []
        const rows = [...seed, ...writes.filter((w) => w.table === table).map((w) => w.value)]
          .filter((r) => filters.every((f) => f(r)))
        return { data: single ? rows[0] || null : rows, count: rows.length }
      }
      if (table === 'bot_logs' && menuSent) {
        const rows = [{ id: 1, company_id: 77, conversa_id: state.id, tipo: 'menu_enviado', criado_em: new Date(Date.now() - 60000).toISOString() }]
          .filter((r) => filters.every((f) => f(r)))
        return { data: single ? rows[0] || null : rows, count: rows.length }
      }
      return { data: single ? null : [], count: 0 }
    }
    q.maybeSingle = q.single = () => Promise.resolve(execute(true))
    q.then = (resolve, reject) => Promise.resolve(execute(false)).then(resolve, reject)
    return q
  }) }
  return { sb, state, writes }
}

let cid = 1000
function context(db, extra = {}) {
  db.state.id = ++cid
  supabase.from.mockImplementation(db.sb.from)
  invalidateChatbotConfigCache(77)
  return { company_id: 77, conversa_id: cid, telefone: '5534999999999', texto: 'oi',
    supabase: db.sb, sendMessage: jest.fn().mockResolvedValue({ ok: true, messageId: 'ABCDEF1234567890' }), ...extra }
}

afterEach(() => jest.restoreAllMocks())

describe('triagem respeita atendimento humano', () => {
  test.each([
    { atendente_id: 8 }, { status_atendimento: 'em_atendimento' },
    { status_atendimento: 'aguardando_cliente' }, { status_atendimento: 'aguardando_pagamento' },
    { status_atendimento: 'fechada' }, { status_atendimento: 'finalizada' },
  ])('não envia nem altera conversa bloqueada %j', async (conversa) => {
    const db = database({ conversa })
    const ctx = context(db, { texto: '1', conversaReabertaAposFinalizacao: true })
    await processIncomingMessage(ctx)
    expect(ctx.sendMessage).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })

  test('erro ao consultar estado não permite envio', async () => {
    const db = database(); db.sb.stateError = true
    const ctx = context(db)
    await processIncomingMessage(ctx)
    expect(ctx.sendMessage).not.toHaveBeenCalled()
  })

  test.each([
    ['boas-vindas', {}, 'oi'], ['comando de menu', {}, '0'],
    ['fora do horário', { foraHorarioEnabled: true, mensagemForaHorario: 'Fechado', diasSemanaDesativados: [0, 1, 2, 3, 4, 5, 6] }, 'oi'],
  ])('assumir durante %s cancela envio e bolha', async (_, config, texto) => {
    const db = database({ config, onRead: (s, n) => { if (n >= 2) s.atendente_id = 8 } })
    const ctx = context(db, { texto })
    await processIncomingMessage(ctx)
    expect(ctx.sendMessage).not.toHaveBeenCalled()
    expect(db.writes.filter((w) => w.table === 'mensagens')).toEqual([])
  })

  test('tomada humana no transporte cancela sem gravar mensagem falsa', async () => {
    const db = database()
    const ctx = context(db, { sendMessage: jest.fn(async (_, __, opts) => {
      db.state.atendente_id = 8
      try { await opts.beforeRequest() } catch (_) { return { ok: false } }
      throw new Error('Não deveria chegar ao envio')
    }) })
    await processIncomingMessage(ctx)
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
    expect(db.writes.filter((w) => w.table === 'mensagens')).toEqual([])
  })

  test('opção inválida pendente não interrompe quem assumiu', async () => {
    const db = database({ menuSent: true, onRead: (s, n) => { if (n >= 2) s.atendente_id = 8 } })
    const ctx = context(db, { texto: '99', mensagemClienteCriadoEm: new Date().toISOString() })
    await processIncomingMessage(ctx)
    expect(ctx.sendMessage).not.toHaveBeenCalled()
    expect(db.writes.filter((w) => w.table === 'mensagens')).toEqual([])
  })

  test('conversa aberta nova ou reaberta por cliente continua recebendo boas-vindas', async () => {
    for (const reaberta of [false, true]) {
      const db = database()
      const ctx = context(db, { conversaReabertaAposFinalizacao: reaberta })
      await processIncomingMessage(ctx)
      expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
      expect(db.writes.some((w) => w.table === 'mensagens')).toBe(true)
    }
  })

  test.each([
    ['menu', {}, 'oi', 'menu_enviado'],
    ['boas-vindas única', { usarMenuSetores: false }, 'oi', 'menu_enviado'],
    ['reenvio do menu', {}, '0', 'menu_reenviado'],
    ['fora do horário', { foraHorarioEnabled: true, mensagemForaHorario: 'Fechado', diasSemanaDesativados: [0, 1, 2, 3, 4, 5, 6] }, 'oi', 'fora_horario'],
  ])('%s recusado não é registrado como entregue e permite próximo inbound', async (_, config, texto, logTipo) => {
    const db = database({ config, persistHistory: true })
    const ctx = context(db, { texto, sendMessage: jest.fn()
      .mockResolvedValueOnce({ ok: false, error: 'Instância desconectada' })
      .mockResolvedValue({ ok: true, messageId: 'ABCDEF1234567890' }) })
    await processIncomingMessage(ctx)
    expect(db.writes.some((w) => w.table === 'bot_logs' && w.value.tipo === logTipo)).toBe(false)
    expect(db.writes.some((w) => w.table === 'mensagens' && w.value.status === 'erro')).toBe(true)
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 20000)
    await processIncomingMessage({ ...ctx, hints: { menuAlreadySent: true } })
    expect(ctx.sendMessage).toHaveBeenCalledTimes(2)
    expect(db.writes.some((w) => w.table === 'bot_logs' && w.value.tipo === logTipo)).toBe(true)
  })

  test('menu aceito na fila do provedor continua contando como enviado, sem duplicar', async () => {
    const db = database({ persistHistory: true })
    const ctx = context(db, { sendMessage: jest.fn().mockResolvedValue({ ok: true, messageId: '123456' }) })
    await processIncomingMessage(ctx)
    expect(db.writes.some((w) => w.table === 'mensagens' && w.value.status === 'pending')).toBe(true)
    await processIncomingMessage(ctx)
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
  })

  test.each([{ atendente_id: 8 }, { status_atendimento: 'fechada' }])('claim de setor não sobrescreve mudança concorrente %j', async (change) => {
    const db = database({ onUpdate: (s) => Object.assign(s, change) })
    const result = await transferToDepartment(db.sb, 77, 901, 5)
    expect(result.ok).toBe(false)
    expect(db.state).toMatchObject({ departamento_id: null, ...change })
    expect(db.writes).toEqual([])
  })

  test('seleção válida direciona e confirma quando ninguém assumiu', async () => {
    const db = database()
    const ctx = context(db, { texto: '1' })
    await processIncomingMessage(ctx)
    expect(db.state.departamento_id).toBe(5)
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
  })

  test('não confirma seleção se atendente assumir após atribuir setor', async () => {
    const db = database({ onRead: (s) => { if (s.departamento_id) s.atendente_id = 8 } })
    const ctx = context(db, { texto: '1' })
    await processIncomingMessage(ctx)
    expect(ctx.sendMessage).not.toHaveBeenCalled()
    expect(db.state.atendente_id).toBe(8)
  })

  test('não confirma setor antigo se alguém transferir durante a seleção', async () => {
    const db = database({ onRead: (s) => { if (s.departamento_id === 5) s.departamento_id = 7 } })
    const ctx = context(db, { texto: '1' })
    await processIncomingMessage(ctx)
    expect(db.state.departamento_id).toBe(7)
    expect(ctx.sendMessage).not.toHaveBeenCalled()
  })

  test('Whapi mantém debounce na mesma sessão mas permite menu após reabertura rápida', async () => {
    const db = database()
    const ctx = context(db)
    const sendPoll = jest.fn().mockResolvedValue({ ok: true, messageId: 'ABCDEF1234567890' })
    jest.spyOn(require('../services/providers'), 'getProvider').mockReturnValue({ sendPoll })
    const whapiCtx = { ...ctx, supabaseClient: db.sb, config: {
      mode: 'poll', body_text: 'Escolha', options: [
        { id: 'a', label: 'Suporte', departamento_id: 5, active: true },
        { id: 'b', label: 'Vendas', departamento_id: 7, active: true },
      ],
    } }
    await handleWhapiTriageInbound(whapiCtx)
    await handleWhapiTriageInbound(whapiCtx)
    expect(sendPoll).toHaveBeenCalledTimes(1)
    await resetChatbotStateForConversa(db.sb, ctx.company_id, ctx.conversa_id)
    await handleWhapiTriageInbound(whapiCtx)
    expect(sendPoll).toHaveBeenCalledTimes(2)
  })

  test.each(['round_robin', 'menor_carga'])('mantém confirmação da distribuição automática %s', async (tipo_distribuicao) => {
    const db = database({ config: { tipo_distribuicao }, users: [8] })
    const ctx = context(db, { texto: '1' })
    await processIncomingMessage(ctx)
    expect(db.state).toMatchObject({ atendente_id: 8, departamento_id: 5, status_atendimento: 'em_atendimento' })
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
    // A exceção é apenas para a confirmação desta seleção. Outra entrada permanece bloqueada.
    await processIncomingMessage({ ...ctx, texto: '0' })
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
  })

  test.each([8, 9])('cancela confirmação automática se usuário %s assumir depois do bot', async (user) => {
    const db = database({ config: { tipo_distribuicao: 'round_robin' }, users: [8], onRead: (s) => {
      if (s.departamento_id) {
        s.atendente_id = user
        s.atendente_atribuido_em = new Date(Date.parse(s.atendente_atribuido_em) + 1000).toISOString()
      }
    } })
    const ctx = context(db, { texto: '1' })
    await processIncomingMessage(ctx)
    expect(ctx.sendMessage).not.toHaveBeenCalled()
  })

  test('Whapi cancela menu se atendente assumir entre leitura e envio', async () => {
    const db = database({ onRead: (s, n) => { if (n >= 2) s.atendente_id = 8 } })
    const ctx = context(db)
    const result = await handleWhapiTriageInbound({ ...ctx, supabaseClient: db.sb, config: { mode: 'list', body_text: 'Escolha', options: [] } })
    expect(result).toEqual({ handled: true })
    expect(db.writes).toEqual([])
  })

  test('cada retry revalida o atendimento antes de acessar a rede', async () => {
    const db = database()
    const guard = createTriageSendGuard(db.sb, 77, 901)
    const originalFetch = global.fetch
    global.fetch = jest.fn(async () => {
      db.state.atendente_id = 8
      throw Object.assign(new Error('conexão recusada'), { cause: { code: 'ECONNREFUSED' } })
    })
    try {
      await expect(fetchWithRetry('https://example.invalid', { method: 'POST' }, {
        maxAttempts: 3, baseDelayMs: 0, retryConnectionErrors: true, beforeRequest: guard,
      })).rejects.toMatchObject({ code: 'TRIAGE_CANCELLED' })
      expect(global.fetch).toHaveBeenCalledTimes(1)
    } finally { global.fetch = originalFetch }
  })

  test.each(['ultramsg', 'whapi'])('%s propaga a guarda até o transporte e não acessa rede ao cancelar', async (provider) => {
    const { buildSendMeta } = require('../services/whatsappSendGuardService')
    const http = require(`../services/providers/${provider}/http`)
    const db = database({ conversa: { atendente_id: 8 } })
    const beforeRequest = createTriageSendGuard(db.sb, 77, 901)
    const originalFetch = global.fetch
    global.fetch = jest.fn()
    try {
      const send = provider === 'ultramsg' ? http.postJson : http.post
      await expect(send({
        basePath: 'https://example.invalid', token: 'test-only', companyId: 77,
        endpoint: '/messages/text', body: { to: '5534999999999', body: 'Olá' },
        meta: buildSendMeta('text', '5534999999999', { companyId: 77, sendOrigin: 'chatbot_triage', beforeRequest }),
      })).rejects.toMatchObject({ code: 'TRIAGE_CANCELLED' })
      expect(global.fetch).not.toHaveBeenCalled()
    } finally { global.fetch = originalFetch }
  })
})
