/**
 * Invariante crítico do webhook: ACK sem REGRESSÃO. Trava `resolveEffectiveStatus`
 * (controllers/webhookInbound/statusApply.js), extraído do miolo de receberZapi na Fase 5 (doc 24).
 * Ranking real: pending<sent<delivered<read<played; erro/failed = -1.
 */

const { resolveEffectiveStatus } = require('../controllers/webhookInbound/statusApply')

describe('resolveEffectiveStatus — ACK sem regressão (caracterização)', () => {
  test('não rebaixa: read + delivered atrasado → read', () => {
    expect(resolveEffectiveStatus('read', 'delivered')).toBe('read')
  })

  test('promove: sent + delivered → delivered; delivered + read → read', () => {
    expect(resolveEffectiveStatus('sent', 'delivered')).toBe('delivered')
    expect(resolveEffectiveStatus('delivered', 'read')).toBe('read')
  })

  test('played é o topo: played + read → played', () => {
    expect(resolveEffectiveStatus('played', 'read')).toBe('played')
  })

  test('falha tardia NÃO apaga entrega/leitura: read/delivered + erro → mantém', () => {
    expect(resolveEffectiveStatus('read', 'erro')).toBe('read')
    expect(resolveEffectiveStatus('delivered', 'failed')).toBe('delivered')
  })

  test('falha antes de delivered vence: sent + erro → erro', () => {
    expect(resolveEffectiveStatus('sent', 'erro')).toBe('erro')
  })

  test('current nulo vira pending: null + sent → sent; null + erro → erro', () => {
    expect(resolveEffectiveStatus(null, 'sent')).toBe('sent')
    expect(resolveEffectiveStatus(null, 'erro')).toBe('erro')
  })
})
