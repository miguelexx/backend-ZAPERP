/**
 * Garantias de que "encerrar" encerra de verdade no caminho automático por ausência.
 *
 * Regressão coberta (print do Miguel, conversa parada em "Em atendimento" desde 09/10 com a
 * mensagem de encerramento automático como última): quando o provedor devolvia falha, o serviço
 * gravava a bolha de encerramento E revertia a conversa para "em atendimento". Como a mensagem de
 * ausência não conta como fala de atendente humano, nenhum ciclo seguinte reconhecia a conversa
 * como candidata — ela ficava presa para sempre.
 */

const CONVERSA_ID = 101
const COMPANY_ID = 7
const ABSENCE_MESSAGE = 'Seu atendimento foi encerrado automaticamente.'

function createSupabaseMock({
  lastMessage,
  absenceMessage = ABSENCE_MESSAGE,
  conversa = {},
  sendRow = { ausencia_mensagem_enviada_em: null, finalizacao_motivo: null, whatsapp_instance_id: 9 },
  inboundCount = 0,
}) {
  const updates = []
  const inserts = []
  const scans = []

  const conversaRow = {
    id: CONVERSA_ID,
    telefone: '5534999999999',
    status_atendimento: 'em_atendimento',
    atendente_id: 22,
    atendente_atribuido_em: '2026-05-30T09:00:00.000Z',
    aguardando_cliente_desde: null,
    finalizacao_motivo: null,
    ausencia_mensagem_enviada_em: null,
    tipo: 'cliente',
    departamento_id: 3,
    cliente_id: 44,
    ...conversa,
  }

  function createQuery(table) {
    const state = { table, selectCols: null, selectOptions: null, patch: null, filters: [] }

    const resolveState = () => {
      if (table === 'ia_config' && state.selectCols === 'company_id') {
        return { data: [{ company_id: COMPANY_ID }], error: null }
      }
      if (table === 'ia_config') {
        return {
          data: {
            config: {
              chatbot_triage: {
                finalizar_por_ausencia_ativo: true,
                finalizar_por_ausencia_prazo: 1,
                finalizar_por_ausencia_unidade: 'horas_corridas',
                finalizar_por_ausencia_mensagem: absenceMessage,
              },
            },
          },
          error: null,
        }
      }
      if (table === 'conversas' && state.patch) {
        // Lock de encerramento devolve a linha fechada; demais updates não devolvem nada.
        return {
          data: state.patch.status_atendimento === 'fechada'
            ? { ...conversaRow, ...state.patch }
            : null,
          error: null,
        }
      }
      if (table === 'conversas' && String(state.selectCols || '').startsWith('ausencia_mensagem_enviada_em')) {
        return { data: sendRow, error: null }
      }
      if (table === 'conversas') {
        scans.push({ selectCols: state.selectCols, filters: state.filters })
        return { data: [conversaRow], error: null }
      }
      if (table === 'mensagens' && state.selectOptions?.count === 'exact') {
        return { data: null, count: inboundCount, error: null }
      }
      if (table === 'mensagens' && state.patch === null && state.insertPayload) {
        return { data: { id: 900, ...state.insertPayload }, error: null }
      }
      if (table === 'mensagens') {
        return { data: lastMessage, error: null }
      }
      return { data: null, error: null }
    }

    const chain = {
      select(cols, options) {
        state.selectCols = cols
        state.selectOptions = options || null
        return chain
      },
    }
    for (const method of ['eq', 'neq', 'not', 'or', 'is', 'gt', 'gte', 'lt', 'lte', 'in', 'order', 'limit']) {
      chain[method] = (...args) => {
        state.filters.push([method, ...args])
        return chain
      }
    }
    chain.update = (patch) => {
      state.patch = patch
      updates.push({ table, patch, filters: state.filters })
      return chain
    }
    chain.insert = (payload) => {
      state.insertPayload = payload
      inserts.push({ table, payload })
      return chain
    }
    chain.maybeSingle = () => Promise.resolve(resolveState())
    chain.single = () => Promise.resolve(resolveState())
    chain.then = (ok, fail) => Promise.resolve(resolveState()).then(ok, fail)
    return chain
  }

  return { updates, inserts, scans, from: jest.fn((table) => createQuery(table)) }
}

function setupModules(supabase, sendText) {
  jest.resetModules()
  jest.doMock('../config/supabase', () => supabase)
  jest.doMock('../services/providers', () => ({ getProvider: jest.fn(() => ({ sendText })) }))
  jest.doMock('../services/chat/identity/conversationAddressService', () => ({
    resolveConversationProvider: jest.fn().mockResolvedValue('whapi'),
  }))
  jest.doMock('../services/chatbotTriageService', () => {
    const real = jest.requireActual('../services/chatbotTriageService')
    return { ...real, logBotAction: jest.fn().mockResolvedValue(undefined) }
  })
  return require('../services/absenceFinalizationService')
}

const MENSAGEM_ATENDENTE = {
  id: 501,
  direcao: 'out',
  criado_em: '2026-05-30T08:00:00.000Z',
  autor_usuario_id: 22,
  texto: 'Fico no aguardo do seu retorno.',
}

describe('encerramento por ausência — falha de envio não pode prender a conversa', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ABSENCE_FINALIZATION_EMERGENCY_DISABLED: 'false' }
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('falha TRANSITÓRIA (timeout/rede) mantém a conversa encerrada e a mensagem pendente', async () => {
    const sendText = jest.fn().mockResolvedValue({ ok: false, transportError: true, error: 'ETIMEDOUT' })
    const supabase = createSupabaseMock({ lastMessage: MENSAGEM_ATENDENTE })
    const { finalizeConversationsByAbsence } = setupModules(supabase, sendText)

    const result = await finalizeConversationsByAbsence()

    expect(result.processadas).toBe(1)
    const reverteu = supabase.updates.some(
      (u) => u.table === 'conversas' && u.patch.status_atendimento === 'em_atendimento'
    )
    expect(reverteu).toBe(false)
    const msg = supabase.inserts.find((i) => i.table === 'mensagens')
    expect(msg?.payload.status).toBe('pending')
    expect(msg?.payload.status_mensagem).toBe('sending')
    expect(
      supabase.inserts.some(
        (i) => i.table === 'historico_atendimentos' && i.payload.acao === 'encerramento_ausencia_envio_pendente'
      )
    ).toBe(true)
  })

  it('exceção de transporte do adapter é tratada como transitória (não derruba o encerramento)', async () => {
    const sendText = jest.fn().mockRejectedValue(new Error('socket hang up'))
    const supabase = createSupabaseMock({ lastMessage: MENSAGEM_ATENDENTE })
    const { finalizeConversationsByAbsence } = setupModules(supabase, sendText)

    const result = await finalizeConversationsByAbsence()

    expect(result.processadas).toBe(1)
    expect(
      supabase.updates.some((u) => u.table === 'conversas' && u.patch.status_atendimento === 'em_atendimento')
    ).toBe(false)
  })

  it('recusa DEFINITIVA reverte sem deixar a bolha de ausência como última mensagem', async () => {
    const sendText = jest.fn().mockResolvedValue({ ok: false, httpStatus: 400, error: 'invalid to' })
    const supabase = createSupabaseMock({ lastMessage: MENSAGEM_ATENDENTE })
    const { finalizeConversationsByAbsence } = setupModules(supabase, sendText)

    const result = await finalizeConversationsByAbsence()

    expect(result.processadas).toBe(0)
    expect(
      supabase.updates.some((u) => u.table === 'conversas' && u.patch.status_atendimento === 'em_atendimento')
    ).toBe(true)
    // Sem a bolha gravada, o próximo ciclo ainda enxerga a fala do atendente e tenta de novo.
    expect(supabase.inserts.some((i) => i.table === 'mensagens')).toBe(false)
  })

  it('conversa com resíduo de encerramento (motivo ausencia_cliente ainda em atendimento) volta a ser candidata', async () => {
    // Resíduo real: `marcarAguardandoRespostaCampanha` leva fechada → aberta num novo disparo sem
    // limpar os campos de encerramento automático. O filtro antigo do scan excluía essa conversa
    // para sempre; agora ela entra e `markWaitingForClient` zera o resíduo antes do lock.
    const sendText = jest.fn().mockResolvedValue({ ok: true, messageId: 'ABCD1234EF5678', provider: 'whapi' })
    const supabase = createSupabaseMock({
      lastMessage: MENSAGEM_ATENDENTE,
      conversa: { finalizacao_motivo: 'ausencia_cliente' },
    })
    const { finalizeConversationsByAbsence } = setupModules(supabase, sendText)

    const result = await finalizeConversationsByAbsence()

    expect(result.processadas).toBe(1)
    const filtroExcludente = supabase.scans.some((s) =>
      (s.filters || []).some(([metodo, arg]) => metodo === 'or' && String(arg).includes('finalizacao_motivo'))
    )
    expect(filtroExcludente).toBe(false)
    const limpezaResiduo = supabase.updates.find(
      (u) => u.table === 'conversas' && u.patch.finalizacao_motivo === null && u.patch.aguardando_cliente_desde
    )
    expect(limpezaResiduo).toBeTruthy()
  })

  it('envio OK encerra normalmente', async () => {
    const sendText = jest.fn().mockResolvedValue({ ok: true, messageId: 'ABCD1234EF5678', provider: 'whapi' })
    const supabase = createSupabaseMock({ lastMessage: MENSAGEM_ATENDENTE })
    const { finalizeConversationsByAbsence } = setupModules(supabase, sendText)

    const result = await finalizeConversationsByAbsence()

    expect(result.processadas).toBe(1)
    expect(
      supabase.updates.some((u) => u.table === 'conversas' && u.patch.status_atendimento === 'fechada')
    ).toBe(true)
  })
})

describe('auto-reparo: encerramento por ausência interrompido', () => {
  const ORIGINAL_ENV = process.env

  const MENSAGEM_AUSENCIA = {
    id: 777,
    direcao: 'out',
    criado_em: '2026-05-30T08:30:00.000Z',
    autor_usuario_id: null,
    texto: ABSENCE_MESSAGE,
  }

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ABSENCE_FINALIZATION_EMERGENCY_DISABLED: 'false' }
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('conclui o encerramento da conversa presa sem reenviar a mensagem', async () => {
    const sendText = jest.fn()
    const supabase = createSupabaseMock({ lastMessage: MENSAGEM_AUSENCIA })
    const { finalizeConversationsByAbsence } = setupModules(supabase, sendText)

    const result = await finalizeConversationsByAbsence()

    expect(result.processadas).toBe(1)
    expect(sendText).not.toHaveBeenCalled()
    const fechamento = supabase.updates.find(
      (u) => u.table === 'conversas' && u.patch.status_atendimento === 'fechada'
    )
    expect(fechamento?.patch.finalizacao_motivo).toBe('ausencia_cliente')
    expect(fechamento?.patch.ausencia_mensagem_enviada_em).toBe(MENSAGEM_AUSENCIA.criado_em)
    expect(supabase.inserts.some((i) => i.table === 'mensagens')).toBe(false)
  })

  it('não conclui quando o cliente respondeu depois da mensagem de encerramento', async () => {
    const sendText = jest.fn()
    const supabase = createSupabaseMock({ lastMessage: MENSAGEM_AUSENCIA, inboundCount: 1 })
    const { finalizeConversationsByAbsence } = setupModules(supabase, sendText)

    const result = await finalizeConversationsByAbsence()

    expect(result.processadas).toBe(0)
    expect(
      supabase.updates.some((u) => u.table === 'conversas' && u.patch.status_atendimento === 'fechada')
    ).toBe(false)
  })

  it('não conclui quando a mensagem de encerramento já foi confirmada (conversa reaberta de verdade)', async () => {
    const sendText = jest.fn()
    const supabase = createSupabaseMock({
      lastMessage: MENSAGEM_AUSENCIA,
      conversa: { ausencia_mensagem_enviada_em: '2026-05-30T08:30:00.000Z' },
    })
    const { finalizeConversationsByAbsence } = setupModules(supabase, sendText)

    const result = await finalizeConversationsByAbsence()

    expect(result.processadas).toBe(0)
    expect(
      supabase.updates.some((u) => u.table === 'conversas' && u.patch.status_atendimento === 'fechada')
    ).toBe(false)
  })

  it('texto igual digitado por um atendente humano não é tratado como encerramento interrompido', async () => {
    const { ehEncerramentoAusenciaInterrompido } = require('../services/absenceFinalizationService')
    const conv = { status_atendimento: 'em_atendimento', ausencia_mensagem_enviada_em: null }
    expect(
      ehEncerramentoAusenciaInterrompido(conv, { ...MENSAGEM_AUSENCIA, autor_usuario_id: 22 }, { mensagem: ABSENCE_MESSAGE })
    ).toBe(false)
    expect(
      ehEncerramentoAusenciaInterrompido(conv, MENSAGEM_AUSENCIA, { mensagem: ABSENCE_MESSAGE })
    ).toBe(true)
  })
})
