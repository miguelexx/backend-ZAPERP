/**
 * Leitura do payload de GET /instance/status da UltraMsg.
 *
 * BUG REPRODUZIDO: o banner "WhatsApp desconectado — mensagens não serão entregues" aparecia
 * com o WhatsApp funcionando normalmente (recebendo e enviando). Causa: a UltraMsg responde
 * ANINHADO ({status:{accountStatus:{status:'authenticated'}}}) e o código fazia String() no
 * campo direto — viravam os oito caracteres "[object object]", que não batem com estado
 * nenhum, e o sistema concluía desconectado.
 */
const {
  lerStatusUltramsg,
  resumirPayloadStatus,
} = require('../helpers/ultramsgStatusPayload')

describe('lerStatusUltramsg — formato aninhado (o que quebrava o banner)', () => {
  test('status.accountStatus.status = authenticated → CONECTADO', () => {
    const data = { status: { accountStatus: { status: 'authenticated', substatus: 'normal' } } }
    const r = lerStatusUltramsg(data)
    expect(r.connected).toBe(true)
    expect(r.indefinido).toBe(false)
    expect(r.statusText).toBe('authenticated')
  })

  test('o String() antigo produzia "[object object]" — é exatamente o que não podia acontecer', () => {
    const data = { status: { accountStatus: { status: 'authenticated' } } }
    // Reproduz o comportamento antigo para deixar o defeito documentado no teste.
    const antigo = String(data.status).toLowerCase().trim()
    expect(antigo).toBe('[object object]')
    expect(['authenticated', 'connected', 'standby'].includes(antigo)).toBe(false)
    // E a leitura nova acerta.
    expect(lerStatusUltramsg(data).connected).toBe(true)
  })

  test('aninhado com QR pendente → DESCONECTADO de verdade', () => {
    const data = { status: { accountStatus: { status: 'got qr code' } } }
    const r = lerStatusUltramsg(data)
    expect(r.connected).toBe(false)
    expect(r.indefinido).toBe(false)
  })

  test('accountStatus na raiz também é entendido', () => {
    expect(lerStatusUltramsg({ accountStatus: { status: 'authenticated' } }).connected).toBe(true)
    expect(lerStatusUltramsg({ accountStatus: { status: 'disconnected' } }).connected).toBe(false)
  })
})

describe('lerStatusUltramsg — formatos planos (não podem regredir)', () => {
  test.each([
    [{ status: 'authenticated' }, true],
    [{ status: 'connected' }, true],
    [{ status: 'standby' }, true],
    [{ state: 'connected' }, true],
    [{ instance: { status: 'authenticated' } }, true],
    [{ response: { status: 'authenticated' } }, true],
    [{ status: 'got qr code' }, false],
    [{ status: 'disconnected' }, false],
    [{ status: 'loading' }, false],
  ])('%j → connected=%s', (data, esperado) => {
    const r = lerStatusUltramsg(data)
    expect(r.connected).toBe(esperado)
    expect(r.indefinido).toBe(false)
  })

  test('campo booleano connected manda quando existe', () => {
    expect(lerStatusUltramsg({ connected: true, status: 'qualquer-coisa' }).connected).toBe(true)
    expect(lerStatusUltramsg({ connected: false, status: 'authenticated' }).connected).toBe(false)
  })

  test('resposta em texto puro (não-JSON) é aceita', () => {
    expect(lerStatusUltramsg(null, 'authenticated').connected).toBe(true)
    expect(lerStatusUltramsg(null, 'disconnected').connected).toBe(false)
  })
})

describe('lerStatusUltramsg — formato desconhecido não pode virar alarme falso', () => {
  test.each([
    [{}],
    [null],
    [undefined],
    [{ foo: 'bar' }],
    [{ status: { algo: { novo: true } } }],
    [{ status: 'estado-que-a-ultramsg-inventou' }],
  ])('%j → indefinido (quem chama trata como "não acuse desconexão")', (data) => {
    const r = lerStatusUltramsg(data)
    expect(r.indefinido).toBe(true)
  })
})

describe('resumirPayloadStatus', () => {
  test('serializa objeto para o log, truncando', () => {
    const s = resumirPayloadStatus({ status: { accountStatus: { status: 'authenticated' } } })
    expect(s).toContain('accountStatus')
    expect(s.length).toBeLessThanOrEqual(300)
  })

  test('aceita texto cru e payload circular sem lançar', () => {
    expect(resumirPayloadStatus(null, 'texto puro')).toBe('texto puro')
    const circular = {}
    circular.self = circular
    expect(() => resumirPayloadStatus(circular)).not.toThrow()
  })
})
