const {
  DEFAULT_LIMIT_CONFIG,
  normalizeLimitConfig,
  mergeLimitConfig,
  validateAndConsumeForMessage,
  limitErrorResponse,
} = require('../services/atendimentoLimitsService')

describe('atendimentoLimitsService', () => {
  test('normaliza regras vazias como desativadas/sem limite', () => {
    const config = normalizeLimitConfig({
      messages_per_hour_enabled: true,
      messages_per_hour: '',
      allowed_days: [1, 2, 99],
    })

    expect(config.messages_per_hour_enabled).toBe(true)
    expect(config.messages_per_hour).toBeNull()
    expect(config.allowed_days).toEqual([1, 2])
    expect(config.timezone).toBe(DEFAULT_LIMIT_CONFIG.timezone)
  })

  test('mescla padrao da empresa com override do usuario', () => {
    const merged = mergeLimitConfig(
      { messages_per_day_enabled: true, messages_per_day: 100 },
      { messages_per_day: 25 }
    )

    expect(merged.messages_per_day_enabled).toBe(true)
    expect(merged.messages_per_day).toBe(25)
  })

  test('modulo desativado na RPC mantem envio permitido', async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: { allowed: true, consumed: false, module_enabled: false },
        error: null,
      }),
    }

    const result = await validateAndConsumeForMessage({
      company_id: 1,
      usuario_id: 2,
      conversa_id: 3,
      client_temp_id: 'tmp-1',
      message_type: 'texto',
    }, client)

    expect(result.allowed).toBe(true)
    expect(result.consumed).toBe(false)
    expect(client.rpc).toHaveBeenCalledWith('atendimento_limits_validate_and_consume', expect.objectContaining({
      p_company_id: 1,
      p_usuario_id: 2,
      p_conversa_id: 3,
      p_idempotency_key: 'tmp-1',
    }))
  })

  test('schema ausente falha aberto para preservar comportamento antigo', async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: null,
        error: { code: 'PGRST202', message: 'function atendimento_limits_validate_and_consume not found' },
      }),
    }

    const result = await validateAndConsumeForMessage({
      company_id: 1,
      usuario_id: 2,
      conversa_id: 3,
    }, client)

    expect(result.allowed).toBe(true)
    expect(result.skipped).toBe('schema_missing')
  })

  test('bloqueio retorna payload padronizado para controller/frontend', async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          allowed: false,
          code: 'MESSAGE_INTERVAL_ACTIVE',
          message: 'Aguarde 18 segundos para enviar outra mensagem.',
          limit: 30,
          retry_after_seconds: 18,
          release_at: '2026-07-15T13:00:30.000Z',
        },
        error: null,
      }),
    }

    const result = await validateAndConsumeForMessage({
      company_id: 1,
      usuario_id: 2,
      conversa_id: 3,
    }, client)
    const response = limitErrorResponse(result)

    expect(result.allowed).toBe(false)
    expect(result.status).toBe(429)
    expect(response.limit_code).toBe('MESSAGE_INTERVAL_ACTIVE')
    expect(response.limit.retry_after_seconds).toBe(18)
  })
})
