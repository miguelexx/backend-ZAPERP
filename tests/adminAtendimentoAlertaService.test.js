function currentHmInTimezone(timeZone = 'America/Sao_Paulo') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  const get = (type) => parts.find((p) => p.type === type)?.value || '00'
  const hour = String(get('hour')).replace(/\D/g, '').slice(0, 2).padStart(2, '0')
  const minute = String(get('minute')).replace(/\D/g, '').slice(0, 2).padStart(2, '0')
  return `${hour === '24' ? '00' : hour}:${minute}`
}

function createSupabaseMock({ lockRow = null, duplicateOnInsert = false } = {}) {
  const inserts = []
  const updates = []

  function createQuery(table) {
    const state = { table, selectCols: '', patch: null, payload: null }
    const resolve = () => {
      if (table === 'admin_atendimento_alerta_envios') {
        if (state.payload && duplicateOnInsert) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
        }
        if (state.payload) return { data: null, error: null }
        return { data: lockRow, error: null }
      }
      if (table === 'avaliacoes_atendimento') {
        return { data: [{ nota: 8 }, { nota: 10 }], error: null }
      }
      return { data: null, error: null }
    }

    const chain = {
      select(cols) {
        state.selectCols = cols
        return chain
      },
      eq() {
        return chain
      },
      gte() {
        return chain
      },
      limit() {
        return chain
      },
      update(patch) {
        state.patch = patch
        updates.push({ table, patch })
        return chain
      },
      insert(payload) {
        state.payload = payload
        inserts.push({ table, payload })
        return Promise.resolve(resolve())
      },
      maybeSingle() {
        return Promise.resolve(resolve())
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve(resolve()).then(onFulfilled, onRejected)
      },
    }

    return chain
  }

  return {
    inserts,
    updates,
    from: jest.fn((table) => createQuery(table)),
  }
}

describe('adminAtendimentoAlertaService', () => {
  afterEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it('mantem o alerta controlado pela configuracao da tela', () => {
    const { normalizeAdminAtendimentoAlerta } = require('../services/adminAtendimentoAlertaService')

    expect(normalizeAdminAtendimentoAlerta({ ativo: true }).ativo).toBe(true)
    expect(normalizeAdminAtendimentoAlerta({ ativo: false }).ativo).toBe(false)
  })

  it('enviar teste agora ignora janela/idempotencia e nao grava slot diario', async () => {
    const supabase = createSupabaseMock()
    jest.resetModules()
    jest.doMock('../config/supabase', () => supabase)
    jest.doMock('../services/supervisaoService', () => ({
      getAguardandoFuncionarioParaAlertaAdmin: jest.fn(),
    }))

    const { processCompanyAdminAlert } = require('../services/adminAtendimentoAlertaService')
    const sendText = jest.fn().mockResolvedValue({ ok: true })
    const result = await processCompanyAdminAlert({
      company_id: 7,
      provider: { sendText },
      forceSend: true,
      fullConfig: {
        admin_atendimento_alerta: {
          ativo: true,
          telefone_admin: '5534999999999',
          horario_envio: '03:00',
          incluir_nota_media: true,
          incluir_conversas_sem_resposta: false,
        },
      },
    })

    expect(result.sent).toBe(true)
    expect(sendText).toHaveBeenCalledTimes(1)
    expect(supabase.inserts.some((x) => x.table === 'admin_atendimento_alerta_envios')).toBe(false)
  })

  it('bloqueia envio duplicado quando ja existe reserva recente no dia', async () => {
    const supabase = createSupabaseMock({
      lockRow: {
        sucesso: false,
        detalhes: { reservado: true, reservado_em: new Date().toISOString() },
        criado_em: new Date().toISOString(),
      },
    })
    jest.resetModules()
    jest.doMock('../config/supabase', () => supabase)
    jest.doMock('../services/supervisaoService', () => ({
      getAguardandoFuncionarioParaAlertaAdmin: jest.fn(),
    }))

    const { processCompanyAdminAlert } = require('../services/adminAtendimentoAlertaService')
    const sendText = jest.fn().mockResolvedValue({ ok: true })
    const result = await processCompanyAdminAlert({
      company_id: 7,
      provider: { sendText },
      fullConfig: {
        admin_atendimento_alerta: {
          ativo: true,
          telefone_admin: '5534999999999',
          horario_envio: currentHmInTimezone(),
          incluir_nota_media: true,
          incluir_conversas_sem_resposta: false,
        },
      },
    })

    expect(result.sent).toBe(false)
    expect(result.reason).toBe('send_in_progress')
    expect(sendText).not.toHaveBeenCalled()
    expect(supabase.updates.some((x) => x.table === 'admin_atendimento_alerta_envios')).toBe(false)
  })
})
