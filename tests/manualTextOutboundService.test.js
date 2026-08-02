const {
  classifyManualTextProviderResult,
  executeManualTextProviderAttempt,
  manualTextHasProviderAcceptance,
  lookupManualTextAtProvider,
  decideManualTextRetry,
  buildManualTextProviderAuditPatch,
  buildManualTextProviderConfirmationPatch,
  manualTextResponseFromClassification,
  classifyProviderLookupRows,
} = require('../services/manualTextOutboundService')
const fs = require('fs')
const path = require('path')

describe('envio de texto manual - contrato UltraMsg e idempotência', () => {
  test('envio aceito com ID rastreável vira sent e responde ok=true', async () => {
    const provider = {
      sendText: jest.fn().mockResolvedValue({
        ok: true,
        messageId: '3EB0A123456789ABCDEF',
        httpStatus: 200,
        rawResponse: { sent: true, id: '3EB0A123456789ABCDEF' },
      }),
    }

    const result = await executeManualTextProviderAttempt(
      provider,
      '+5534999999999',
      'Olá',
      {
        companyId: 7,
        conversaId: 42,
        whatsappInstanceId: 11,
        referenceId: 'crm-900',
      }
    )

    expect(provider.sendText).toHaveBeenCalledTimes(1)
    expect(provider.sendText).toHaveBeenCalledWith(
      '+5534999999999',
      'Olá',
      expect.objectContaining({
        companyId: 7,
        conversaId: 42,
        whatsappInstanceId: 11,
        referenceId: 'crm-900',
      })
    )
    expect(result).toMatchObject({
      ok: true,
      accepted: true,
      queued: false,
      state: 'accepted',
      status: 'sent',
      whatsapp_id: '3EB0A123456789ABCDEF',
    })
  })

  test('rejeição explícita do provedor vira erro e nunca produz ok=true', () => {
    const classification = classifyManualTextProviderResult({
      ok: false,
      httpStatus: 400,
      error: 'invalid phone',
      rawResponse: { sent: false, error: 'invalid phone' },
    })
    const response = manualTextResponseFromClassification(classification, {
      id: 900,
      conversa_id: 42,
      client_temp_id: 'manual-900',
    })

    expect(classification).toMatchObject({
      ok: false,
      accepted: false,
      state: 'rejected',
      status: 'erro',
      status_mensagem: 'failed',
      retryable: false,
    })
    expect(response.ok).toBe(false)
    expect(response.id).toBe(900)
    expect(response.status).toBe('erro')
    expect(response.error).toContain('invalid phone')
  })

  test('timeout é tentativa incerta, persistível e passível de reenvio seguro', async () => {
    const timeout = new Error('request timeout after 30000ms')
    timeout.name = 'AbortError'
    const provider = { sendText: jest.fn().mockRejectedValue(timeout) }

    const result = await executeManualTextProviderAttempt(provider, '+5534999999999', 'Olá', {})
    const patch = buildManualTextProviderAuditPatch({
      row: { id: 900 },
      classification: result,
      referenceId: 'crm-900',
      request: { text: 'Olá' },
      attemptedAt: '2026-07-30T12:00:00.000Z',
    })

    expect(result).toMatchObject({
      ok: false,
      state: 'uncertain',
      timeout: true,
      retryable: true,
    })
    expect(patch).toMatchObject({
      provider_reference_id: 'crm-900',
      provider_delivery_state: 'uncertain',
      provider_retryable: true,
      provider_last_attempt_at: '2026-07-30T12:00:00.000Z',
    })
    expect(patch.provider_error).toContain('request timeout')
  })

  test('falha de rede é incerta e não é confundida com aceite', async () => {
    const networkError = new Error('socket hang up')
    networkError.code = 'ECONNRESET'
    const provider = { sendText: jest.fn().mockRejectedValue(networkError) }

    const result = await executeManualTextProviderAttempt(provider, '+5534999999999', 'Olá', {})

    expect(result).toMatchObject({
      ok: false,
      accepted: false,
      state: 'uncertain',
      network: true,
      retryable: true,
    })
  })

  test('resposta em fila é aceite, grava provider_queue_id e permanece pending', () => {
    const result = classifyManualTextProviderResult({
      ok: true,
      messageId: '35096',
      httpStatus: 200,
      rawResponse: { sent: true, id: '35096' },
    })

    expect(result).toMatchObject({
      ok: true,
      accepted: true,
      queued: true,
      traceable: false,
      state: 'queued',
      status: 'pending',
      status_mensagem: 'sending',
      provider_queue_id: '35096',
    })
  })

  test('reinício do backend não perde idempotência: linha aceita no banco não é reenviada', () => {
    // Não há cache/map em memória neste teste: a decisão usa somente estado persistido.
    const persistedAfterRestart = {
      id: 900,
      status: 'pending',
      status_mensagem: 'sending',
      provider_delivery_state: 'queued',
      provider_queue_id: '35096',
      provider_reference_id: 'crm-900',
    }

    expect(manualTextHasProviderAcceptance(persistedAfterRestart)).toBe(true)
    expect(decideManualTextRetry({
      row: persistedAfterRestart,
      retryRequested: true,
      providerLookup: { kind: 'none' },
    })).toMatchObject({
      action: 'do_not_send',
      reason: 'already_accepted',
      ok: true,
    })
  })

  test('reenvio só é liberado após falha confirmada e usa a mesma referência', async () => {
    const row = {
      id: 900,
      company_id: 7,
      conversa_id: 42,
      status: 'erro',
      status_mensagem: 'failed',
      provider_delivery_state: 'rejected',
      provider_reference_id: 'crm-900',
      provider_last_attempt_at: '2026-07-30T12:00:00.000Z',
    }
    const provider = {
      getMessages: jest.fn().mockResolvedValue({ ok: true, data: [] }),
    }

    const lookup = await lookupManualTextAtProvider(provider, row, {
      companyId: 7,
      conversaId: 42,
      whatsappInstanceId: 11,
    })
    const decision = decideManualTextRetry({
      row,
      retryRequested: true,
      providerLookup: lookup,
      now: Date.parse('2026-07-30T12:00:01.000Z'),
    })

    expect(lookup.kind).toBe('none')
    expect(decision).toMatchObject({
      action: 'send',
      reason: 'provider_rejected_previous_attempt',
    })
    expect(provider.getMessages).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 7,
      conversaId: 42,
      whatsappInstanceId: 11,
      referenceId: 'crm-900',
    }))
  })

  test('tentativa incerta dentro da janela de segurança não é reenviada', () => {
    const decision = decideManualTextRetry({
      row: {
        id: 900,
        status: 'erro',
        provider_delivery_state: 'uncertain',
        provider_last_attempt_at: '2026-07-30T12:00:00.000Z',
      },
      retryRequested: true,
      providerLookup: { kind: 'none' },
      now: Date.parse('2026-07-30T12:00:10.000Z'),
      graceMs: 60_000,
    })

    expect(decision).toMatchObject({
      action: 'do_not_send',
      reason: 'uncertain_attempt_in_grace_period',
      httpStatus: 409,
      retryable: true,
    })
    expect(decision.retryAfterMs).toBe(50_000)
  })

  test('consulta direta por referenceId confirma mensagem nova sem depender de pendências antigas', async () => {
    const provider = {
      getMessages: jest.fn().mockResolvedValue({
        ok: true,
        data: [{
          id: '3EB0A123456789ABCDEF',
          status: 'sent',
          referenceId: 'crm-900',
        }],
      }),
    }
    const row = {
      id: 900,
      provider_reference_id: 'crm-900',
    }

    const lookup = await lookupManualTextAtProvider(provider, row, {
      companyId: 7,
      conversaId: 42,
      whatsappInstanceId: 11,
    })
    const patch = buildManualTextProviderConfirmationPatch(lookup)

    expect(provider.getMessages).toHaveBeenCalledTimes(1)
    expect(provider.getMessages).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: 'crm-900',
      companyId: 7,
      whatsappInstanceId: 11,
    }))
    expect(lookup.kind).toBe('accepted')
    expect(patch).toMatchObject({
      status: 'sent',
      status_mensagem: 'sent',
      provider_delivery_state: 'accepted',
      whatsapp_id: '3EB0A123456789ABCDEF',
    })
  })

  test('status explícito invalid/queue prevalece sobre o formato do ID retornado', () => {
    expect(classifyProviderLookupRows([{
      id: '3EB0A123456789ABCDEF',
      status: 'invalid',
      referenceId: 'crm-900',
    }], 'crm-900')).toMatchObject({ kind: 'failed' })

    expect(classifyProviderLookupRows([{
      id: '3EB0A123456789ABCDEF',
      status: 'queue',
      referenceId: 'crm-900',
    }], 'crm-900')).toMatchObject({ kind: 'queued' })
  })

  test('consulta não aceita uma mensagem antiga sem o referenceId esperado', () => {
    expect(classifyProviderLookupRows([{
      id: '3EB0A123456789ABCDEF',
      status: 'sent',
      referenceId: 'crm-100',
    }], 'crm-900')).toMatchObject({ kind: 'none' })
  })

  test('sent/delivered/read nunca são candidatos a reenvio ou regressão', () => {
    for (const status of ['sent', 'delivered', 'read', 'played']) {
      const row = { id: 900, status, status_mensagem: status }
      expect(manualTextHasProviderAcceptance(row)).toBe(true)
      expect(decideManualTextRetry({
        row,
        retryRequested: true,
        providerLookup: { kind: 'failed' },
      })).toMatchObject({
        action: 'do_not_send',
        reason: 'already_accepted',
      })
    }
  })

  test('auditoria remove token da resposta do provedor', () => {
    const classification = classifyManualTextProviderResult({
      ok: false,
      httpStatus: 401,
      error: 'unauthorized',
      rawResponse: { token: 'segredo', nested: { authorization: 'Bearer segredo' } },
    })
    const patch = buildManualTextProviderAuditPatch({
      row: { id: 900 },
      classification,
      referenceId: 'crm-900',
      request: { text: 'Olá' },
    })

    expect(patch.provider_response).toEqual({
      token: '[REDACTED]',
      nested: { authorization: '[REDACTED]' },
    })
  })

  test('migration mantém auditoria e referência idempotente no banco', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20260730120000_manual_text_outbound_audit.sql'),
      'utf8'
    )
    for (const column of [
      'provider_reference_id',
      'provider_request',
      'provider_delivery_state',
      'provider_http_status',
      'provider_response',
      'provider_error',
      'provider_retryable',
      'provider_attempts',
      'provider_last_attempt_at',
    ]) {
      expect(migration).toContain(column)
    }
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_company_provider_reference_unique')
    expect(migration).toContain('(company_id, provider_reference_id)')
  })
})
