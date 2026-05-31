function createSupabaseMock({ lastMessage }) {
  const updates = []
  const inserts = []

  function createQuery(table) {
    const state = {
      table,
      selectCols: null,
      selectOptions: null,
      patch: null,
      filters: [],
    }

    const resolveState = () => {
      if (table === 'ia_config' && state.selectCols === 'company_id') {
        return { data: [{ company_id: 7 }], error: null }
      }
      if (table === 'ia_config' && state.selectCols === 'config') {
        return {
          data: {
            config: {
              chatbot_triage: {
                finalizar_por_ausencia_ativo: true,
                finalizar_por_ausencia_prazo: 1,
                finalizar_por_ausencia_unidade: 'horas_corridas',
                finalizar_por_ausencia_mensagem: 'Encerrando por ausencia.',
              },
            },
          },
          error: null,
        }
      }
      if (table === 'conversas' && state.patch) {
        return { data: state.patch.status_atendimento === 'fechada' ? { id: 101 } : null, error: null }
      }
      if (table === 'conversas') {
        return {
          data: [
            {
              id: 101,
              telefone: '5534999999999',
              status_atendimento: 'em_atendimento',
              atendente_id: 22,
              atendente_atribuido_em: '2026-05-30T09:00:00.000Z',
              aguardando_cliente_desde: null,
              finalizacao_motivo: null,
              tipo: 'cliente',
              departamento_id: 3,
              cliente_id: 44,
            },
          ],
          error: null,
        }
      }
      if (table === 'mensagens' && state.selectOptions?.count === 'exact') {
        return { data: null, count: 0, error: null }
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
      eq(key, value) {
        state.filters.push(['eq', key, value])
        return chain
      },
      neq(key, value) {
        state.filters.push(['neq', key, value])
        return chain
      },
      not(key, op, value) {
        state.filters.push(['not', key, op, value])
        return chain
      },
      or(value) {
        state.filters.push(['or', value])
        return chain
      },
      is(key, value) {
        state.filters.push(['is', key, value])
        return chain
      },
      gt(key, value) {
        state.filters.push(['gt', key, value])
        return chain
      },
      order() {
        return chain
      },
      limit() {
        return chain
      },
      update(patch) {
        state.patch = patch
        updates.push({ table, patch, filters: state.filters })
        return chain
      },
      insert(payload) {
        inserts.push({ table, payload })
        return Promise.resolve({ data: null, error: null })
      },
      maybeSingle() {
        return Promise.resolve(resolveState())
      },
      single() {
        return Promise.resolve(resolveState())
      },
      then(resolve, reject) {
        return Promise.resolve(resolveState()).then(resolve, reject)
      },
    }

    return chain
  }

  return {
    updates,
    inserts,
    from: jest.fn((table) => createQuery(table)),
  }
}

describe('absenceFinalizationService - fluxo de seguranca', () => {
  const ORIGINAL_ENV = process.env

  afterEach(() => {
    process.env = ORIGINAL_ENV
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('kill switch emergencial bloqueia o processamento antes de consultar empresas', async () => {
    process.env = { ...ORIGINAL_ENV, ABSENCE_FINALIZATION_EMERGENCY_DISABLED: 'true' }
    const supabase = { from: jest.fn() }

    jest.resetModules()
    jest.doMock('../config/supabase', () => supabase)

    const { finalizeConversationsByAbsence } = require('../services/absenceFinalizationService')
    const result = await finalizeConversationsByAbsence()

    expect(result).toMatchObject({
      ok: true,
      processadas: 0,
      analisadas: 0,
      emergencyDisabled: true,
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('nao encerra conversa quando a ultima mensagem foi enviada pelo cliente', async () => {
    process.env = { ...ORIGINAL_ENV, ABSENCE_FINALIZATION_EMERGENCY_DISABLED: 'false' }
    const sendText = jest.fn().mockResolvedValue({ ok: true })
    const supabase = createSupabaseMock({
      lastMessage: {
        id: 501,
        direcao: 'in',
        criado_em: '2026-05-30T08:00:00.000Z',
        autor_usuario_id: null,
        texto: 'Ainda preciso de ajuda',
      },
    })

    jest.resetModules()
    jest.doMock('../config/supabase', () => supabase)
    jest.doMock('../services/providers', () => ({
      getProvider: jest.fn(() => ({ sendText })),
    }))

    const { finalizeConversationsByAbsence } = require('../services/absenceFinalizationService')
    const result = await finalizeConversationsByAbsence()

    expect(result.processadas).toBe(0)
    expect(sendText).not.toHaveBeenCalled()
    expect(supabase.updates.some((u) => u.patch.status_atendimento === 'fechada')).toBe(false)
  })
})
