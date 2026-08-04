/**
 * Regressão do parse de Range no /media/proxy (seek/resume de áudio).
 */
const { parseBytesRangeHeader } = require('../controllers/mediaProxyController')

describe('parseBytesRangeHeader', () => {
  test('ausente ou inválido → null (serve 200 completo)', () => {
    expect(parseBytesRangeHeader(undefined, 100)).toBeNull()
    expect(parseBytesRangeHeader('', 100)).toBeNull()
    expect(parseBytesRangeHeader('bytes=', 100)).toBeNull()
    expect(parseBytesRangeHeader('bytes=0-1,2-3', 100)).toBeNull()
    expect(parseBytesRangeHeader('items=0-10', 100)).toBeNull()
  })

  test('bytes=start-end', () => {
    expect(parseBytesRangeHeader('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseBytesRangeHeader('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
  })

  test('bytes=start- (até o fim)', () => {
    expect(parseBytesRangeHeader('bytes=50-', 100)).toEqual({ start: 50, end: 99 })
  })

  test('bytes=-suffix (últimos N)', () => {
    expect(parseBytesRangeHeader('bytes=-20', 100)).toEqual({ start: 80, end: 99 })
  })

  test('end além do tamanho é limitado', () => {
    expect(parseBytesRangeHeader('bytes=90-999', 100)).toEqual({ start: 90, end: 99 })
  })

  test('start >= size → unsatisfiable', () => {
    expect(parseBytesRangeHeader('bytes=100-', 100)).toEqual({ unsatisfiable: true })
    expect(parseBytesRangeHeader('bytes=200-300', 100)).toEqual({ unsatisfiable: true })
  })
})
