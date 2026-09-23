const {
  PRAZOS_VALIDOS,
  calcularAguardarClientePrazoAte,
} = require('../helpers/aguardarClientePrazo')
const { nivelPara } = require('../services/aguardandoClienteMonitorService')

describe('aguardarClientePrazo - cálculo do vencimento', () => {
  it('reconhece os prazos válidos', () => {
    for (const p of ['1h', '2h', '4h', 'hoje', 'amanha', 'data']) {
      expect(PRAZOS_VALIDOS.has(p)).toBe(true)
    }
    expect(PRAZOS_VALIDOS.has('8h')).toBe(false)
  })

  it('1h/2h/4h caem à frente do agora, na ordem certa', () => {
    const now = Date.now()
    const h1 = calcularAguardarClientePrazoAte('1h').getTime()
    const h2 = calcularAguardarClientePrazoAte('2h').getTime()
    const h4 = calcularAguardarClientePrazoAte('4h').getTime()
    expect(h1).toBeGreaterThan(now)
    expect(h2).toBeGreaterThan(h1)
    expect(h4).toBeGreaterThan(h2)
    // ~1h de tolerância de execução
    expect(Math.abs(h1 - now - 3600_000)).toBeLessThan(60_000)
  })

  it('hoje termina no fim do dia local', () => {
    const d = calcularAguardarClientePrazoAte('hoje')
    expect(d.getHours()).toBe(23)
    expect(d.getMinutes()).toBe(59)
  })

  it('data exige YYYY-MM-DD e vira fim daquele dia', () => {
    expect(calcularAguardarClientePrazoAte('data', 'invalido')).toBeNull()
    const d = calcularAguardarClientePrazoAte('data', '2030-01-15')
    expect(d.getFullYear()).toBe(2030)
    expect(d.getHours()).toBe(23)
  })

  it('prazo desconhecido → null', () => {
    expect(calcularAguardarClientePrazoAte('nunca')).toBeNull()
  })
})

describe('aguardandoClienteMonitorService.nivelPara', () => {
  const now = 1_000_000_000_000

  it('antes do prazo → aguardando', () => {
    expect(nivelPara(now, now + 60_000)).toBe('aguardando')
  })

  it('logo após o prazo (< 24h) → atrasado', () => {
    expect(nivelPara(now, now - 60_000)).toBe('atrasado')
    expect(nivelPara(now, now - 23 * 3600_000)).toBe('atrasado')
  })

  it('mais de 24h após o prazo → sem_resposta', () => {
    expect(nivelPara(now, now - 25 * 3600_000)).toBe('sem_resposta')
  })

  it('sem prazo (NaN) → aguardando (não escala)', () => {
    expect(nivelPara(now, NaN)).toBe('aguardando')
  })
})
