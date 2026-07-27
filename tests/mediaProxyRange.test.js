const { parseSingleByteRange } = require('../controllers/mediaProxyController')

describe('mediaProxy: Range para <audio>/<video>', () => {
  const SIZE = 1000

  test('sem header Range → corpo inteiro (200)', () => {
    expect(parseSingleByteRange(undefined, SIZE)).toBeNull()
    expect(parseSingleByteRange('', SIZE)).toBeNull()
  })

  test('bytes=0- (pedido inicial do player) → arquivo todo como 206', () => {
    expect(parseSingleByteRange('bytes=0-', SIZE)).toEqual({ start: 0, end: 999 })
  })

  test('intervalo fechado', () => {
    expect(parseSingleByteRange('bytes=100-199', SIZE)).toEqual({ start: 100, end: 199 })
  })

  test('fim além do arquivo é truncado (Chrome pede bytes=0-1048575)', () => {
    expect(parseSingleByteRange('bytes=0-1048575', SIZE)).toEqual({ start: 0, end: 999 })
  })

  test('sufixo bytes=-N (últimos bytes; usado para ler o cabeçalho final)', () => {
    expect(parseSingleByteRange('bytes=-200', SIZE)).toEqual({ start: 800, end: 999 })
  })

  test('início fora do arquivo → 416', () => {
    expect(parseSingleByteRange('bytes=1000-', SIZE)).toBe('invalid')
    expect(parseSingleByteRange('bytes=500-100', SIZE)).toBe('invalid')
    expect(parseSingleByteRange('bytes=-0', SIZE)).toBe('invalid')
  })

  test('formas não suportadas (multi-range / unidade estranha) → corpo inteiro', () => {
    expect(parseSingleByteRange('bytes=0-99,200-299', SIZE)).toBeNull()
    expect(parseSingleByteRange('itens=0-99', SIZE)).toBeNull()
    expect(parseSingleByteRange('bytes=-', SIZE)).toBeNull()
  })

  test('corpo vazio nunca vira 206', () => {
    expect(parseSingleByteRange('bytes=0-', 0)).toBeNull()
  })
})
