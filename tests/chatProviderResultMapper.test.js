/**
 * Teste de caracterização do providerResultMapper (Fase 2 da modularização do chatController).
 *
 * Congela a máquina de estados de saída (ok/whatsapp_id → sent/pending/erro) que hoje aparece
 * inline e duplicada em vários endpoints de saída do chatController. Serve de rede de segurança
 * para a migração desses endpoints ao mapa único (Fase 6).
 *
 * Espelha os cenários já validados em envioManualMensagem.test.js, agora contra a fonte única.
 */

const { mapProviderSendResult } = require('../services/chat/outbound/providerResultMapper')

// Caminho de texto (enviarMensagemChat) grava 'failed' em caso de falha.
const asText = (result) => mapProviderSendResult(result, { failedStatusMensagem: 'failed' })

describe('providerResultMapper.mapProviderSendResult', () => {
  describe('ok=true com ID rastreável → sent + whatsapp_id salvável', () => {
    test('ID hex de 16 chars', () => {
      const r = mapProviderSendResult({ ok: true, messageId: 'BAE543FE1CE17AFA' })
      expect(r.nextStatus).toBe('sent')
      expect(r.nextStatusMensagem).toBe('sent')
      expect(r.hasValidId).toBe(true)
      expect(r.hasQueueId).toBe(false)
      expect(r.acceptedWithoutTrace).toBe(false)
      expect(r.waMessageId).toBe('BAE543FE1CE17AFA')
    })

    test('ID no formato WhatsApp com @', () => {
      const r = mapProviderSendResult({ ok: true, messageId: 'false_5511999999999@c.us_BAE543FE1CE17AFA' })
      expect(r.nextStatus).toBe('sent')
      expect(r.hasValidId).toBe(true)
    })
  })

  describe('ok=true sem ID rastreável → pending/sending', () => {
    test('ID numérico curto de fila ("35096") → pending + hasQueueId', () => {
      const r = mapProviderSendResult({ ok: true, messageId: '35096' })
      expect(r.nextStatus).toBe('pending')
      expect(r.nextStatusMensagem).toBe('sending')
      expect(r.hasValidId).toBe(false)
      expect(r.hasQueueId).toBe(true)
      expect(r.acceptedWithoutTrace).toBe(true)
    })

    test('messageId null → pending', () => {
      const r = mapProviderSendResult({ ok: true, messageId: null })
      expect(r.nextStatus).toBe('pending')
      expect(r.hasValidId).toBe(false)
      expect(r.hasQueueId).toBe(false)
    })

    test('boolean true legado → pending', () => {
      const r = mapProviderSendResult(true)
      expect(r.nextStatus).toBe('pending')
      expect(r.nextStatusMensagem).toBe('sending')
      expect(r.waMessageId).toBeNull()
    })
  })

  describe('ok=false → erro', () => {
    test('objeto de erro → erro + status de falha default "erro"', () => {
      const r = mapProviderSendResult({ ok: false, error: 'Instância desconectada' })
      expect(r.nextStatus).toBe('erro')
      expect(r.nextStatusMensagem).toBe('erro')
      expect(r.providerError).toBe('Instância desconectada')
    })

    test('blockedBy é exposto como providerError', () => {
      const r = mapProviderSendResult({ ok: false, blockedBy: 'guard' })
      expect(r.nextStatus).toBe('erro')
      expect(r.providerError).toBe('guard')
    })

    test('boolean false legado → erro', () => {
      const r = mapProviderSendResult(false)
      expect(r.nextStatus).toBe('erro')
      expect(r.nextStatusMensagem).toBe('erro')
    })
  })

  describe('divergência preservada: caminho de texto usa failedStatusMensagem="failed"', () => {
    test('ok=false no texto grava "failed" (não "erro")', () => {
      const r = asText({ ok: false, error: 'Token inválido' })
      expect(r.nextStatus).toBe('erro')
      expect(r.nextStatusMensagem).toBe('failed')
    })

    test('sucesso não é afetado pelo parâmetro de falha', () => {
      expect(asText({ ok: true, messageId: 'BAE543FE1CE17AFA' }).nextStatusMensagem).toBe('sent')
      expect(asText({ ok: true, messageId: '35096' }).nextStatusMensagem).toBe('sending')
    })
  })

  describe('invariante: ok=true exige ID rastreável para sent', () => {
    const casos = [
      { desc: 'com ID hex', result: { ok: true, messageId: 'BAE543FE1CE17AFA' }, expected: 'sent' },
      { desc: 'com ID numérico curto', result: { ok: true, messageId: '35096' }, expected: 'pending' },
      { desc: 'sem ID', result: { ok: true, messageId: null }, expected: 'pending' },
      { desc: 'com ID vazio', result: { ok: true, messageId: '' }, expected: 'pending' },
      { desc: 'com ID "null" string', result: { ok: true, messageId: 'null' }, expected: 'pending' },
      { desc: 'true booleano', result: true, expected: 'pending' },
    ]
    casos.forEach(({ desc, result, expected }) => {
      test(`"${desc}" → nextStatus='${expected}'`, () => {
        expect(mapProviderSendResult(result).nextStatus).toBe(expected)
      })
    })
  })

  describe('invariante: ok=false → nextStatus sempre erro', () => {
    const casos = [
      { desc: 'erro com mensagem', result: { ok: false, error: 'Token inválido' } },
      { desc: 'false booleano', result: false },
      { desc: 'erro com blockedBy', result: { ok: false, blockedBy: 'guard' } },
    ]
    casos.forEach(({ desc, result }) => {
      test(`"${desc}" → nextStatus='erro'`, () => {
        expect(mapProviderSendResult(result).nextStatus).toBe('erro')
      })
    })
  })
})
