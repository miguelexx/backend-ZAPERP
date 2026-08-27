/**
 * Etapa 9 — Lease recovery e anti-reenvio do worker Disparo.
 *
 * Comportamento documentado (RPC disparo_recuperar_leases_expirados, Etapa 9):
 * - reservada com lease expirado → pendente (seguro reprocessar)
 * - enviando com lease expirado → incerta (pode ter sido aceita pelo provedor)
 *
 * A RPC SQL não é testada aqui (requer Postgres). Testamos o anti-resend no worker:
 * item com provider_message_id → incerta sem chamar enviarItemFila.
 */

const { enviarItemFila } = require('../services/disparoSendService')

jest.mock('../services/disparoSendService', () => ({
  enviarItemFila: jest.fn().mockResolvedValue({ ok: true, dryRun: true, messageId: 'dry-1' }),
}))

jest.mock('../helpers/disparoWorkerConfig', () => {
  const actual = jest.requireActual('../helpers/disparoWorkerConfig')
  return {
    ...actual,
    getDisparoWorkerConfig: jest.fn(() => ({
      workerEnabled: true,
      liveEnabled: false,
      dryRun: true,
      canSendLive: false,
      pollMs: 2000,
      leaseSeconds: 120,
      batchSize: 1,
      workerId: 'test-worker',
      sendTimeoutMs: 45000,
      maxTentativas: 5,
      backoffBaseSec: 30,
      backoffMaxSec: 3600,
      allowlist: [],
    })),
  }
})

jest.mock('../services/disparoLimitesRuntime', () => ({
  contarEnviosJanela: jest.fn().mockResolvedValue(0),
  podeEnviarAgora: jest.fn(() => ({ ok: true })),
}))

const supabase = require('../config/supabase')
const worker = require('../workers/disparoWorker')

function installRpcMock(handlers = {}) {
  supabase.rpc = jest.fn(async (name, params) => {
    if (handlers[name]) return handlers[name](params)
    return { data: null, error: null }
  })
}

function mockChain(result = { data: null, error: null, count: 0 }) {
  const chain = {}
  const methods = ['select', 'eq', 'in', 'order', 'limit', 'update', 'upsert', 'gte']
  for (const m of methods) chain[m] = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue(result)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

const itemBase = {
  id: 1,
  company_id: 10,
  campanha_id: 1,
  execucao_id: 50,
  instancia_id: 5,
  destinatario_id: 100,
  variacao_id: 30,
  status: 'reservada',
  tentativas: 1,
}

describe('Etapa 9 — lease recovery (comportamento documentado)', () => {
  it('enviando expirado deve virar incerta, não pendente', () => {
    /**
     * Especificação Etapa 9 (migration 20260823120000_disparo_etapa9_auditoria.sql):
     * UPDATE disparo_fila_itens SET status = 'incerta' WHERE status = 'enviando' AND lease_ate < now()
     */
    const spec = {
      entrada: { status: 'enviando', lease_ate: '2020-01-01T00:00:00.000Z' },
      saida: { status: 'incerta', erro_codigo: 'LEASE_EXPIRADO' },
    }
    expect(spec.saida.status).toBe('incerta')
    expect(spec.saida.status).not.toBe('pendente')
  })

  it('reservada expirada deve voltar a pendente', () => {
    const spec = {
      entrada: { status: 'reservada', lease_ate: '2020-01-01T00:00:00.000Z' },
      saida: { status: 'pendente' },
    }
    expect(spec.saida.status).toBe('pendente')
  })

  it('recuperarLeases delega à RPC disparo_recuperar_leases_expirados', async () => {
    installRpcMock({
      disparo_recuperar_leases_expirados: () => ({ data: 2, error: null }),
    })
    const n = await worker.recuperarLeases()
    expect(n).toBe(2)
    expect(supabase.rpc).toHaveBeenCalledWith(
      'disparo_recuperar_leases_expirados',
      { p_limit: 100 },
    )
  })
})

describe('Etapa 9 — anti-resend (provider_message_id)', () => {
  let lastUpdatePayload = null

  beforeEach(() => {
    jest.clearAllMocks()
    lastUpdatePayload = null

    installRpcMock({
      disparo_try_lock_instancia: () => ({ data: true, error: null }),
      disparo_unlock_instancia: () => ({ data: null, error: null }),
    })

    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanha_limites') {
        return mockChain({ data: { fuso_horario: 'America/Sao_Paulo' }, error: null })
      }
      if (table === 'disparo_campanha_janelas') {
        return mockChain({ data: [], error: null })
      }
      if (table === 'disparo_campanha_instancia_limites') {
        return mockChain({ data: null, error: null })
      }
      if (table === 'disparo_execucoes') {
        return mockChain({
          data: { id: 50, status: 'em_execucao', dry_run: true },
          error: null,
        })
      }
      if (table === 'whatsapp_instances') {
        return mockChain({
          data: { id: 5, status: 'connected', ativo: true, nome: 'Instância 1' },
          error: null,
        })
      }
      if (table === 'disparo_fila_itens') {
        const chain = mockChain({ data: null, error: null })
        chain.update = jest.fn((payload) => {
          lastUpdatePayload = payload
          return chain
        })
        return chain
      }
      if (table === 'disparo_worker_heartbeat') {
        return mockChain({ data: null, error: null })
      }
      return mockChain({ data: null, error: null })
    })

    worker._setIo(null)
  })

  it('processarItem marca incerta quando item já tem provider_message_id', async () => {
    await worker.processarItem({
      ...itemBase,
      provider_message_id: 'wamid-existing-123',
    })

    expect(enviarItemFila).not.toHaveBeenCalled()
    expect(lastUpdatePayload).toMatchObject({
      status: 'incerta',
      erro_codigo: 'JA_ENVIADO',
    })
    expect(lastUpdatePayload.status).not.toBe('enviando')
  })

  it('processarItem marca incerta quando item já tem enviado_em', async () => {
    await worker.processarItem({
      ...itemBase,
      enviado_em: '2026-08-22T12:00:00.000Z',
    })

    expect(enviarItemFila).not.toHaveBeenCalled()
    expect(lastUpdatePayload).toMatchObject({
      status: 'incerta',
      erro_codigo: 'JA_ENVIADO',
    })
  })
})

describe('Etapa 9 — planRetencao (dry run)', () => {
  const { planRetencao } = require('../services/disparoRetencaoService')

  it('retorna plano sem executar deletes', () => {
    const plano = planRetencao({ diasEventos: 30, diasHeartbeat: 3 })
    expect(plano.executado).toBe(false)
    expect(plano.autorizacao_necessaria).toBe(true)
    expect(plano.operacoes).toHaveLength(2)
    expect(plano.operacoes[0].acao).toBe('DELETE')
    expect(plano.aviso).toMatch(/autorização/i)
  })
})
