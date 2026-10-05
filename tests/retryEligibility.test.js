/**
 * Elegibilidade do reenvio manual (2ª auditoria do envio Whapi).
 * O caso crítico: na Whapi o whatsapp_id vem do POST e NÃO prova entrega — um ACK `failed`
 * posterior marca a linha como erro COM id real. O guard antigo ("id real → já confirmada")
 * fazia o botão Reenviar virar um no-op eterno exatamente na bolha de erro.
 */

const { avaliarElegibilidadeReenvio } = require('../services/chat/outbound/retryEligibility')

const base = { direcao: 'out', tipo: 'texto', texto: 'oi' }

describe('avaliarElegibilidadeReenvio', () => {
  test('erro COM whatsapp_id real (ACK failed Whapi) PERMITE reenvio', () => {
    const r = avaliarElegibilidadeReenvio({
      ...base,
      status: 'erro',
      status_mensagem: 'erro',
      whatsapp_id: 'PspVgQ5Hj3WhapiMessageId123',
    })
    expect(r.permitido).toBe(true)
  })

  test('failed COM provider_queue_id (provedor confirmou falha) PERMITE reenvio', () => {
    const r = avaliarElegibilidadeReenvio({
      ...base,
      status: 'erro',
      status_mensagem: 'failed',
      provider_queue_id: '35096',
    })
    expect(r.permitido).toBe(true)
  })

  test('pending COM whatsapp_id real continua bloqueado (já recebida; reenviar duplicaria)', () => {
    const r = avaliarElegibilidadeReenvio({
      ...base,
      status: 'pending',
      status_mensagem: 'sending',
      whatsapp_id: 'PspVgQ5Hj3WhapiMessageId123',
    })
    expect(r.permitido).toBe(false)
    expect(r.jaResolvida).toBe(true)
  })

  test('sent/delivered/read continuam "já resolvida"', () => {
    for (const status of ['sent', 'delivered', 'read']) {
      const r = avaliarElegibilidadeReenvio({ ...base, status, status_mensagem: status })
      expect(r.permitido).toBe(false)
      expect(r.jaResolvida).toBe(true)
    }
  })

  test('pending com queue id (UltraMSG aceitou, sem falha declarada) continua 409 aguarde', () => {
    const r = avaliarElegibilidadeReenvio({
      ...base,
      status: 'pending',
      status_mensagem: 'sending',
      provider_queue_id: '35096',
    })
    expect(r.permitido).toBe(false)
    expect(r.httpStatus).toBe(409)
  })

  test('erro sem nenhum id segue permitido (comportamento histórico)', () => {
    const r = avaliarElegibilidadeReenvio({ ...base, status: 'erro', status_mensagem: 'failed' })
    expect(r.permitido).toBe(true)
  })

  test('mensagem inbound nunca é reenviável', () => {
    const r = avaliarElegibilidadeReenvio({ ...base, direcao: 'in', status: 'erro' })
    expect(r.permitido).toBe(false)
    expect(r.httpStatus).toBe(400)
  })
})
