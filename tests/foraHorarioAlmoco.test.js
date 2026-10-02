/**
 * Mensagem fora do horário + pausa de almoço (chatbotTriageService).
 *
 * Cobre dois pontos:
 *  1) A mensagem fora do horário é INDEPENDENTE do chatbot master — deve chegar ao cliente
 *     mesmo com `enabled:false` e sem menu/boas-vindas (regressão: antes era barrada pelos gates).
 *  2) A pausa de almoço (almocoAtivo) trata o cliente como fora do expediente dentro da janela,
 *     enviando a mensagem de almoço (ou a de fora do horário, se vazia).
 */
const supabase = require('../config/supabase')
const {
  processIncomingMessage,
  invalidateChatbotConfigCache,
  isWithinLunchBreak,
} = require('../services/chatbotTriageService')

// Banco em memória mínimo: conversa sem dono e sem histórico; ia_config configurável.
function database(config = {}) {
  const state = { id: 901, company_id: 77, atendente_id: null, departamento_id: null, status_atendimento: 'aberta' }
  const writes = []
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
        if (!filters.every((f) => f(state))) return { data: single ? null : [] }
        if (patch) { Object.assign(state, patch); writes.push({ table, value: patch }) }
        return { data: single ? { ...state } : [{ ...state }] }
      }
      if (inserted) { writes.push({ table, value: inserted }); return { data: { id: 2, ...inserted } } }
      if (table === 'ia_config') {
        return { data: { config: { chatbot_triage: {
          enabled: true, welcomeMessage: 'Olá! Selecione o setor.', intervaloEnvioSegundos: 0,
          options: [{ key: '1', label: 'Suporte', departamento_id: 5, active: true }], ...config,
        } } } }
      }
      return { data: single ? null : [], count: 0 }
    }
    q.maybeSingle = q.single = () => Promise.resolve(execute(true))
    q.then = (resolve, reject) => Promise.resolve(execute(false)).then(resolve, reject)
    return q
  }) }
  return { sb, state, writes }
}

let cid = 5000
function context(db, extra = {}) {
  db.state.id = ++cid
  supabase.from.mockImplementation(db.sb.from)
  invalidateChatbotConfigCache(77)
  return {
    company_id: 77, conversa_id: cid, telefone: '5534999999999', texto: 'oi',
    supabase: db.sb, sendMessage: jest.fn().mockResolvedValue({ ok: true, messageId: 'ABCDEF1234567890' }),
    mensagemClienteCriadoEm: new Date().toISOString(), ...extra,
  }
}

afterEach(() => jest.restoreAllMocks())

const TODOS_OS_DIAS = [0, 1, 2, 3, 4, 5, 6]
const DIA_INTEIRO_HORARIO = { horarioInicio: '00:00', horarioFim: '23:59' }

describe('mensagem fora do horário é independente do chatbot master', () => {
  test('envia fora do horário mesmo com chatbot desativado (enabled:false)', async () => {
    const db = database({
      enabled: false,
      options: [],
      welcomeMessage: '',
      foraHorarioEnabled: true,
      mensagemForaHorario: 'Estamos fechados.',
      diasSemanaDesativados: TODOS_OS_DIAS, // sempre fora
    })
    const ctx = context(db)
    const res = await processIncomingMessage(ctx)
    expect(res).toEqual({ handled: true })
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
    expect(ctx.sendMessage.mock.calls[0][1]).toBe('Estamos fechados.')
    expect(db.writes.some((w) => w.table === 'bot_logs' && w.value.tipo === 'fora_horario' && w.value.detalhes.motivo === 'fora_horario')).toBe(true)
  })

  test('dentro do expediente e sem almoço: não envia nada e segue para os gates do menu', async () => {
    const db = database({
      enabled: false, // gate do menu barra depois; fora-horário não aplica
      foraHorarioEnabled: true,
      mensagemForaHorario: 'Estamos fechados.',
      diasSemanaDesativados: [], // nenhum dia desativado
      ...DIA_INTEIRO_HORARIO, // sempre dentro
    })
    const ctx = context(db)
    const res = await processIncomingMessage(ctx)
    expect(res).toEqual({ handled: false })
    expect(ctx.sendMessage).not.toHaveBeenCalled()
  })
})

describe('pausa de almoço', () => {
  test('dentro do expediente mas na janela de almoço: envia a mensagem de almoço', async () => {
    const db = database({
      enabled: false,
      foraHorarioEnabled: true,
      mensagemForaHorario: 'Estamos fechados.',
      almocoAtivo: true,
      almocoInicio: '00:00',
      almocoFim: '24:00', // cobre qualquer minuto do dia no teste
      mensagemAlmoco: 'Voltamos após o almoço.',
      diasSemanaDesativados: [],
      ...DIA_INTEIRO_HORARIO,
    })
    const ctx = context(db)
    const res = await processIncomingMessage(ctx)
    expect(res).toEqual({ handled: true })
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1)
    expect(ctx.sendMessage.mock.calls[0][1]).toBe('Voltamos após o almoço.')
    expect(db.writes.some((w) => w.table === 'bot_logs' && w.value.tipo === 'fora_horario' && w.value.detalhes.motivo === 'almoco')).toBe(true)
  })

  test('almoço sem mensagem própria cai na mensagem padrão de fora do horário', async () => {
    const db = database({
      foraHorarioEnabled: true,
      mensagemForaHorario: 'Estamos fechados.',
      almocoAtivo: true,
      almocoInicio: '00:00',
      almocoFim: '24:00',
      mensagemAlmoco: '',
      diasSemanaDesativados: [],
      ...DIA_INTEIRO_HORARIO,
    })
    const ctx = context(db)
    await processIncomingMessage(ctx)
    expect(ctx.sendMessage.mock.calls[0][1]).toBe('Estamos fechados.')
  })
})

describe('isWithinLunchBreak', () => {
  const now = (hhmm) => new Date(`2026-10-02T${hhmm}:00-03:00`) // America/Sao_Paulo
  const tz = 'America/Sao_Paulo'

  test('dentro da janela (início inclusivo)', () => {
    expect(isWithinLunchBreak('12:00', '14:00', now('12:00'), tz)).toBe(true)
    expect(isWithinLunchBreak('12:00', '14:00', now('13:30'), tz)).toBe(true)
  })
  test('fim é exclusivo — às 14:00 já voltou', () => {
    expect(isWithinLunchBreak('12:00', '14:00', now('14:00'), tz)).toBe(false)
  })
  test('fora da janela', () => {
    expect(isWithinLunchBreak('12:00', '14:00', now('11:59'), tz)).toBe(false)
    expect(isWithinLunchBreak('12:00', '14:00', now('15:00'), tz)).toBe(false)
  })
  test('janela inválida ou de duração zero = desligada', () => {
    expect(isWithinLunchBreak('', '', now('12:30'), tz)).toBe(false)
    expect(isWithinLunchBreak('12:00', '12:00', now('12:00'), tz)).toBe(false)
    expect(isWithinLunchBreak('abc', '14:00', now('12:30'), tz)).toBe(false)
  })
  test('janela que atravessa meia-noite', () => {
    expect(isWithinLunchBreak('23:30', '00:30', now('23:45'), tz)).toBe(true)
    expect(isWithinLunchBreak('23:30', '00:30', now('00:15'), tz)).toBe(true)
    expect(isWithinLunchBreak('23:30', '00:30', now('12:00'), tz)).toBe(false)
  })
})
