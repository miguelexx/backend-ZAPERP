/**
 * Mensagem fora do horário comercial com a Triagem Interativa (Whapi) ligada + cliente que volta.
 *
 * Regressões cobertas:
 *  1) Com a Triagem Interativa ligada o webhook pulava o chatbot de texto inteiro — e era lá que
 *     morava a mensagem fora do horário. O cliente escrevia às 22h e recebia o MENU, nunca o aviso.
 *  2) Cliente que volta depois de um atendimento finalizado (conversa reaberta) não recebia o aviso:
 *     a última fala do atendente do atendimento ANTIGO contava como "operador conversando agora".
 */
const supabase = require('../config/supabase')
const {
  processIncomingMessage,
  invalidateChatbotConfigCache,
  avaliarForaHorario,
  validateChatbotConfig,
} = require('../services/chatbotTriageService')
const { handleWhapiTriageInbound } = require('../services/whapiTriage/whapiTriageService')

const TODOS_OS_DIAS = [0, 1, 2, 3, 4, 5, 6]
const SEMPRE_FORA = { diasSemanaDesativados: TODOS_OS_DIAS }
const SEMPRE_DENTRO = { diasSemanaDesativados: [], horarioInicio: '00:00', horarioFim: '23:59' }
const minutosAtras = (min) => new Date(Date.now() - min * 60_000).toISOString()

/**
 * Banco em memória com filtros reais (eq/in/gte/gt) para mensagens e bot_logs — a janela de
 * "humano interveio" depende de filtrar por criado_em.
 */
function database({ chatbot = {}, mensagens = [], botLogs = [] } = {}) {
  const state = { id: 0, company_id: 77, atendente_id: null, departamento_id: null, status_atendimento: 'aberta' }
  const tables = { mensagens: [...mensagens], bot_logs: [...botLogs], conversa_tags: [] }
  const writes = []
  const sb = { from: jest.fn((table) => {
    const filters = []
    let patch = null, inserted = null, del = false
    const q = {}
    for (const m of ['select', 'order', 'limit', 'not', 'lt', 'ilike']) q[m] = () => q
    q.eq = q.is = (k, v) => { filters.push((r) => r[k] === v); return q }
    q.in = (k, vs) => { filters.push((r) => vs.includes(r[k])); return q }
    q.gte = (k, v) => { filters.push((r) => String(r[k] || '') >= String(v)); return q }
    q.gt = (k, v) => { filters.push((r) => String(r[k] || '') > String(v)); return q }
    q.update = (v) => { patch = v; return q }
    q.insert = (v) => { inserted = v; return q }
    q.delete = () => { del = true; return q }
    const execute = (single) => {
      if (table === 'conversas') {
        if (!filters.every((f) => f(state))) return { data: single ? null : [] }
        if (patch) { Object.assign(state, patch); writes.push({ table, value: patch }) }
        return { data: single ? { ...state } : [{ ...state }] }
      }
      if (table === 'ia_config') {
        return { data: { config: { chatbot_triage: {
          enabled: false, intervaloEnvioSegundos: 0,
          foraHorarioEnabled: true,
          mensagemForaHorario: 'Estamos fora do horário. Retornamos às 08:30.',
          estado: 'MG', horarioInicio: '08:30', horarioFim: '17:30',
          ...chatbot,
        } } } }
      }
      if (table === 'departamentos') return { data: { id: 5, nome: 'Financeiro' } }
      if (table === 'usuarios' || table === 'usuario_departamentos') return { data: [] }
      if (inserted) {
        const row = { id: writes.length + 100, criado_em: new Date().toISOString(), ...inserted }
        if (tables[table]) tables[table].push(row)
        writes.push({ table, value: row })
        return { data: row }
      }
      if (del) return { data: null }
      const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)))
      return { data: single ? rows[0] || null : rows, count: rows.length }
    }
    q.maybeSingle = q.single = () => Promise.resolve(execute(true))
    q.then = (resolve, reject) => Promise.resolve(execute(false)).then(resolve, reject)
    return q
  }) }
  return { sb, state, writes, tables }
}

let cid = 7000
function setup(db) {
  db.state.id = ++cid
  for (const t of ['mensagens', 'bot_logs']) {
    for (const r of db.tables[t]) { r.conversa_id = cid; r.company_id = 77 }
  }
  supabase.from.mockImplementation(db.sb.from)
  invalidateChatbotConfigCache(77)
  return {
    company_id: 77,
    conversa_id: cid,
    telefone: '5534999999999',
    texto: 'oi',
    sendMessage: jest.fn().mockResolvedValue({ ok: true, messageId: 'ABCDEF1234567890' }),
    mensagemClienteCriadoEm: new Date().toISOString(),
  }
}

const WHAPI_CONFIG = {
  enabled: true,
  mode: 'list',
  body_text: 'Como podemos ajudar?',
  button_label: 'Selecionar setor',
  fallback_to_text: true,
  options: [
    { id: 'uuid-sup', label: 'Suporte', departamento_id: 7, ordem: 0, active: true },
    { id: 'uuid-fin', label: 'Financeiro', departamento_id: 5, ordem: 1, active: true },
  ],
}

function mockWhapiProvider() {
  const sendInteractive = jest.fn().mockResolvedValue({ ok: true, messageId: 'MENU1234567890AB' })
  const sendPoll = jest.fn().mockResolvedValue({ ok: true, messageId: 'POLL1234567890AB' })
  jest.spyOn(require('../services/providers'), 'getProvider').mockReturnValue({ sendInteractive, sendPoll })
  return { sendInteractive, sendPoll }
}

const whapi = (db, ctx, extra = {}) =>
  handleWhapiTriageInbound({ ...ctx, supabaseClient: db.sb, config: WHAPI_CONFIG, ...extra })

const logsDoTipo = (db, tipo) => db.writes.filter((w) => w.table === 'bot_logs' && w.value.tipo === tipo)

afterEach(() => jest.restoreAllMocks())

describe('Triagem Interativa ligada: fora do horário continua funcionando', () => {
  test('fora do horário: envia o aviso e NÃO envia o menu interativo', async () => {
    const db = database({ chatbot: SEMPRE_FORA })
    const ctx = setup(db)
    const provider = mockWhapiProvider()

    const res = await whapi(db, ctx)

    expect(res).toEqual({ handled: true })
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
    expect(ctx.sendMessage.mock.calls[0][1]).toBe('Estamos fora do horário. Retornamos às 08:30.')
    expect(provider.sendInteractive).not.toHaveBeenCalled()
    expect(provider.sendPoll).not.toHaveBeenCalled()
    const log = logsDoTipo(db, 'fora_horario')
    expect(log).toHaveLength(1)
    expect(log[0].value.detalhes).toMatchObject({ motivo: 'fora_horario', origem: 'whapi_triage' })
    // bolha do aviso gravada no ZapERP
    expect(db.tables.mensagens.some((m) => m.direcao === 'out' && m.texto.startsWith('Estamos fora'))).toBe(true)
  })

  test('funciona mesmo com o Chatbot de Triagem (texto) desligado', async () => {
    const db = database({ chatbot: { ...SEMPRE_FORA, enabled: false, options: [], welcomeMessage: '' } })
    const ctx = setup(db)
    mockWhapiProvider()
    await whapi(db, ctx)
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
  })

  test('dentro do horário: envia o menu interativo e nenhum aviso', async () => {
    const db = database({ chatbot: SEMPRE_DENTRO })
    const ctx = setup(db)
    const provider = mockWhapiProvider()

    await whapi(db, ctx)

    expect(ctx.sendMessage).not.toHaveBeenCalled()
    expect(provider.sendInteractive).toHaveBeenCalledTimes(1)
    expect(logsDoTipo(db, 'fora_horario')).toHaveLength(0)
    expect(logsDoTipo(db, 'menu_enviado')).toHaveLength(1)
  })

  test('recurso desligado: segue a triagem normal mesmo fora do horário', async () => {
    const db = database({ chatbot: { ...SEMPRE_FORA, foraHorarioEnabled: false } })
    const ctx = setup(db)
    const provider = mockWhapiProvider()
    await whapi(db, ctx)
    expect(ctx.sendMessage).not.toHaveBeenCalled()
    expect(provider.sendInteractive).toHaveBeenCalledTimes(1)
  })

  test('pausa de almoço: envia a mensagem de almoço no lugar do menu', async () => {
    const db = database({ chatbot: {
      ...SEMPRE_DENTRO, almocoAtivo: true, almocoInicio: '00:00', almocoFim: '23:59',
      mensagemAlmoco: 'Estamos no almoço, voltamos às 14h.',
    } })
    const ctx = setup(db)
    const provider = mockWhapiProvider()
    await whapi(db, ctx)
    expect(ctx.sendMessage.mock.calls[0][1]).toBe('Estamos no almoço, voltamos às 14h.')
    expect(provider.sendInteractive).not.toHaveBeenCalled()
    expect(logsDoTipo(db, 'fora_horario')[0].value.detalhes.motivo).toBe('almoco')
  })

  test('rajada fora do horário: o aviso sai uma vez só', async () => {
    const db = database({ chatbot: SEMPRE_FORA })
    const ctx = setup(db)
    mockWhapiProvider()
    await whapi(db, ctx)
    await whapi(db, { ...ctx, texto: 'alguém aí?' })
    await whapi(db, { ...ctx, texto: '???' })
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
  })

  test('opção tocada em menu recebido no expediente: aviso + direciona o setor (escolha não se perde)', async () => {
    const db = database({
      chatbot: SEMPRE_FORA,
      botLogs: [{ id: 1, tipo: 'menu_enviado', criado_em: minutosAtras(15) }],
    })
    const ctx = setup(db)
    mockWhapiProvider()

    const res = await whapi(db, ctx, { texto: '', payload: { interactiveReplyId: 'uuid-fin' } })

    expect(res).toMatchObject({ handled: true, departamento_id: 5 })
    expect(db.state.departamento_id).toBe(5)
    const textos = ctx.sendMessage.mock.calls.map((c) => c[1])
    expect(textos[0]).toBe('Estamos fora do horário. Retornamos às 08:30.')
    expect(textos[1]).toMatch(/Financeiro/)
  })

  test('atendente assume entre a leitura e o envio: aviso cancelado, nada gravado como enviado', async () => {
    const db = database({ chatbot: SEMPRE_FORA })
    const ctx = setup(db)
    mockWhapiProvider()
    // O transporte real chama beforeRequest logo antes da rede (após os delays do provedor).
    ctx.sendMessage.mockImplementation(async (_ph, _msg, o) => {
      db.state.atendente_id = 9
      db.state.status_atendimento = 'em_atendimento'
      await o.beforeRequest()
      return { ok: true, messageId: 'ABCDEF1234567890' }
    })
    await whapi(db, ctx)
    expect(logsDoTipo(db, 'fora_horario')).toHaveLength(0)
    expect(db.tables.mensagens.some((m) => m.direcao === 'out')).toBe(false)
  })
})

describe('cliente que volta (atendimento anterior) recebe o aviso', () => {
  const historicoAntigo = () => [
    { id: 1, direcao: 'in', texto: 'Quero um orçamento', criado_em: minutosAtras(3 * 24 * 60 + 10) },
    { id: 2, direcao: 'out', texto: 'Claro, segue o valor. Qualquer coisa estou à disposição!', criado_em: minutosAtras(3 * 24 * 60) },
  ]

  test('chatbot de texto: conversa reaberta pelo cliente → aviso enviado', async () => {
    const db = database({ chatbot: SEMPRE_FORA, mensagens: historicoAntigo() })
    const ctx = setup(db)
    await processIncomingMessage({ ...ctx, supabase: db.sb, conversaReabertaAposFinalizacao: true })
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
  })

  test('triagem interativa: conversa reaberta pelo cliente → aviso enviado', async () => {
    const db = database({ chatbot: SEMPRE_FORA, mensagens: historicoAntigo() })
    const ctx = setup(db)
    mockWhapiProvider()
    await whapi(db, ctx, { conversaReabertaAposFinalizacao: true })
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
  })

  test('fala de atendente de dias atrás não cala o aviso (mesmo sem flag de reabertura)', async () => {
    const db = database({ chatbot: SEMPRE_FORA, mensagens: historicoAntigo() })
    const ctx = setup(db)
    await processIncomingMessage({ ...ctx, supabase: db.sb })
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
  })

  test('atendente respondendo AGORA pelo celular: o bot não se intromete', async () => {
    const db = database({
      chatbot: SEMPRE_FORA,
      mensagens: [
        { id: 1, direcao: 'in', texto: 'oi', criado_em: minutosAtras(20) },
        { id: 2, direcao: 'out', texto: 'Oi! Já te ajudo, um minuto.', criado_em: minutosAtras(10) },
      ],
    })
    const ctx = setup(db)
    mockWhapiProvider()
    await whapi(db, ctx)
    await processIncomingMessage({ ...ctx, supabase: db.sb })
    expect(ctx.sendMessage).not.toHaveBeenCalled()
  })
})

describe('avaliarForaHorario — Minas Gerais 08:30–17:30, seg–sex (fuso de Brasília)', () => {
  const cfg = validateChatbotConfig({
    foraHorarioEnabled: true,
    mensagemForaHorario: 'Fora do horário',
    estado: 'MG',
    horarioInicio: '08:30',
    horarioFim: '17:30',
    diasSemanaDesativados: [0, 6],
    almocoAtivo: false,
  })
  // 2026-11-24 é terça-feira. Horários em BRT (-03:00), servidor em qualquer fuso.
  const at = (iso) => avaliarForaHorario(cfg, new Date(iso))

  test('fuso derivado da UF', () => {
    expect(cfg.timezone).toBe('America/Sao_Paulo')
  })
  test('antes de abrir (08:29) → fora', () => {
    expect(at('2026-11-24T08:29:00-03:00')).toMatchObject({ deveEnviar: true, motivo: 'fora_horario' })
  })
  test('abertura (08:30) e meio do dia → dentro', () => {
    expect(at('2026-11-24T08:30:00-03:00').deveEnviar).toBe(false)
    expect(at('2026-11-24T12:45:00-03:00').deveEnviar).toBe(false)
  })
  test('17:30 ainda dentro; 17:31 fora', () => {
    expect(at('2026-11-24T17:30:00-03:00').deveEnviar).toBe(false)
    expect(at('2026-11-24T17:31:00-03:00').deveEnviar).toBe(true)
  })
  test('madrugada → fora', () => {
    expect(at('2026-11-24T02:00:00-03:00').deveEnviar).toBe(true)
  })
  test('sábado em horário comercial → fora (dia desativado)', () => {
    expect(at('2026-11-28T10:00:00-03:00')).toMatchObject({ deveEnviar: true, foraDia: true })
  })
  test('recurso desligado → nunca aplica', () => {
    expect(avaliarForaHorario({ ...cfg, foraHorarioEnabled: false }, new Date('2026-11-24T02:00:00-03:00')).deveEnviar).toBe(false)
  })
  test('almoço ligado: 12:30 envia mensagem de almoço; sem mensagem própria cai na padrão', () => {
    const comAlmoco = { ...cfg, almocoAtivo: true, almocoInicio: '12:00', almocoFim: '14:00', mensagemAlmoco: 'Almoço' }
    expect(avaliarForaHorario(comAlmoco, new Date('2026-11-24T12:30:00-03:00'))).toMatchObject({ deveEnviar: true, motivo: 'almoco', mensagem: 'Almoço' })
    expect(avaliarForaHorario({ ...comAlmoco, mensagemAlmoco: '' }, new Date('2026-11-24T12:30:00-03:00')).mensagem).toBe('Fora do horário')
    expect(avaliarForaHorario(comAlmoco, new Date('2026-11-24T14:00:00-03:00')).deveEnviar).toBe(false)
  })
})
