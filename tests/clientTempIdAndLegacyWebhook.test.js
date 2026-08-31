describe('client_temp_id durable idempotency contract', () => {
  test('normalizes empty values and limits length', () => {
    const { normalizeClientTempId } = require('../controllers/chatController')._test

    expect(normalizeClientTempId(null)).toBeNull()
    expect(normalizeClientTempId('   ')).toBeNull()
    expect(normalizeClientTempId(' temp-123 ')).toBe('temp-123')
    expect(normalizeClientTempId('x'.repeat(80))).toHaveLength(64)
  })

  test('dedupe response preserves message identity and status', () => {
    const { buildClientTempIdDedupResponse } = require('../controllers/chatController')._test
    const response = buildClientTempIdDedupResponse(
      { id: 77, conversa_id: 12, status: 'sent', whatsapp_id: 'BAE543FE1CE17AFA' },
      12,
      'temp-abc'
    )

    expect(response).toMatchObject({
      ok: true,
      id: 77,
      conversa_id: 12,
      client_temp_id: 'temp-abc',
      status: 'sent',
      whatsapp_id: 'BAE543FE1CE17AFA',
      deduplicated: true,
    })
  })

  test('migration adds column and unique partial index', () => {
    const fs = require('fs')
    const path = require('path')
    const sql = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20260702090000_mensagens_client_temp_id_unique.sql'),
      'utf8'
    )

    expect(sql).toContain('add column if not exists client_temp_id text')
    expect(sql).toContain('idx_mensagens_client_temp_id_unique')
    expect(sql).toContain('on public.mensagens (company_id, conversa_id, client_temp_id)')
    expect(sql).toContain('where client_temp_id is not null')
  })

  // Guarda contra a regressão de mídia duplicada: o GET detalharChat (refresh de
  // consistência pós-envio, "carregar mais" e F5) DEVE trazer client_temp_id, senão a
  // linha do servidor não correlaciona com a bolha otimista e a mídia duplica no chat.
  test('detalharChat paginated select includes client_temp_id', () => {
    const fs = require('fs')
    const path = require('path')
    // detalharChat foi modularizado para controllers/chat/conversationDetailController.js.
    const src = fs.readFileSync(path.join(__dirname, '../controllers/chat/conversationDetailController.js'), 'utf8')

    // O select paginado do detalharChat termina em audio_duracao_sec, client_temp_id.
    expect(src).toContain('apagada_em, audio_duracao_sec, client_temp_id')

    // E o fallback de coluna ausente cobre client_temp_id (banco antigo sem a coluna).
    expect(src).toContain("String(errMsgs.message || '').includes('client_temp_id')")
  })
})

describe('legacy webhook controller', () => {
  test('fails closed instead of assuming a hard-coded company_id', async () => {
    const controller = require('../controllers/webhookController')
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }

    await controller.receberWebhook({}, res)

    expect(res.status).toHaveBeenCalledWith(410)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
    }))
  })
})
