/**
 * Testes unitários — classificação de erros, backoff e progressão de status (Etapa 7).
 */

const {
  classificarErro,
  calcularProximaTentativa,
  podeAvancarStatusFila,
  PERMANENTE_CODES,
} = require('../helpers/disparoFilaRetryHelper')

describe('disparoFilaRetryHelper — classificarErro', () => {
  it('códigos permanentes conhecidos', () => {
    for (const code of PERMANENTE_CODES) {
      const r = classificarErro({ code })
      expect(r.classificacao).toBe('permanente')
    }
  })

  it('HTTP 429/5xx → temporario', () => {
    expect(classificarErro({ httpStatus: 429 }).classificacao).toBe('temporario')
    expect(classificarErro({ httpStatus: 503 }).classificacao).toBe('temporario')
    expect(classificarErro({ httpStatus: 408 }).classificacao).toBe('temporario')
  })

  it('mensagem de credencial inválida → permanente', () => {
    const r = classificarErro({ message: 'Invalid token for instance' })
    expect(r.classificacao).toBe('permanente')
    expect(r.code).toBe('CREDENCIAL_INVALIDA')
  })

  it('telefone inválido na mensagem → permanente', () => {
    const r = classificarErro({ message: 'not a whatsapp user' })
    expect(r.classificacao).toBe('permanente')
    expect(r.code).toBe('TELEFONE_INVALIDO')
  })

  it('timeout antes do envio → temporario REDE', () => {
    const r = classificarErro({ message: 'fetch failed', beforeSend: true })
    expect(r.classificacao).toBe('temporario')
    expect(r.code).toBe('REDE')
  })

  it('timeout após chamada iniciada → temporario com incerto', () => {
    const r = classificarErro({ message: 'network timeout', beforeSend: false })
    expect(r.classificacao).toBe('temporario')
    expect(r.code).toBe('TIMEOUT_POS_CHAMADA')
    expect(r.incerto).toBe(true)
  })

  it('rate limit na mensagem → temporario', () => {
    const r = classificarErro({ message: 'Too many requests — rate limit' })
    expect(r.classificacao).toBe('temporario')
    expect(r.code).toBe('RATE_LIMIT')
  })

  it('erro genérico → temporario', () => {
    const r = classificarErro({ httpStatus: 400, message: 'bad request' })
    expect(r.classificacao).toBe('temporario')
  })
})

describe('disparoFilaRetryHelper — calcularProximaTentativa', () => {
  const agora = Date.parse('2026-08-22T12:00:00.000Z')

  beforeEach(() => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    Math.random.mockRestore()
  })

  it('respeita Retry-After quando informado', () => {
    const prox = calcularProximaTentativa({
      tentativas: 3,
      baseSec: 30,
      maxSec: 3600,
      retryAfterSec: 120,
      agora,
    })
    expect(prox).toBe(new Date(agora + 120 * 1000).toISOString())
  })

  it('Retry-After acima do max é limitado', () => {
    const prox = calcularProximaTentativa({
      tentativas: 1,
      baseSec: 30,
      maxSec: 300,
      retryAfterSec: 9999,
      agora,
    })
    expect(prox).toBe(new Date(agora + 300 * 1000).toISOString())
  })

  it('backoff exponencial na 1ª tentativa usa baseSec', () => {
    const prox = calcularProximaTentativa({
      tentativas: 1,
      baseSec: 30,
      maxSec: 3600,
      agora,
    })
    expect(prox).toBe(new Date(agora + 30 * 1000).toISOString())
  })

  it('backoff exponencial dobra a cada tentativa', () => {
    const prox = calcularProximaTentativa({
      tentativas: 3,
      baseSec: 30,
      maxSec: 3600,
      agora,
    })
    // tentativas=3 → 30 * 2^(3-1) = 120s, jitter=0
    expect(prox).toBe(new Date(agora + 120 * 1000).toISOString())
  })

  it('backoff respeita maxSec', () => {
    const prox = calcularProximaTentativa({
      tentativas: 10,
      baseSec: 30,
      maxSec: 300,
      agora,
    })
    expect(prox).toBe(new Date(agora + 300 * 1000).toISOString())
  })
})

describe('disparoFilaRetryHelper — podeAvancarStatusFila', () => {
  it('permite progressão normal pendente → enviada → entregue → lida', () => {
    expect(podeAvancarStatusFila('pendente', 'enviada')).toBe(true)
    expect(podeAvancarStatusFila('enviada', 'entregue')).toBe(true)
    expect(podeAvancarStatusFila('entregue', 'lida')).toBe(true)
  })

  it('não regride entregue → enviada', () => {
    expect(podeAvancarStatusFila('entregue', 'enviada')).toBe(false)
  })

  it('lida é terminal — não avança nem regride', () => {
    expect(podeAvancarStatusFila('lida', 'entregue')).toBe(false)
    expect(podeAvancarStatusFila('lida', 'enviada')).toBe(false)
    expect(podeAvancarStatusFila('lida', 'lida')).toBe(false)
  })

  it('incerta pode avançar para enviada/entregue/lida/falhou', () => {
    expect(podeAvancarStatusFila('incerta', 'enviada')).toBe(true)
    expect(podeAvancarStatusFila('incerta', 'entregue')).toBe(true)
    expect(podeAvancarStatusFila('incerta', 'lida')).toBe(true)
    expect(podeAvancarStatusFila('incerta', 'falhou')).toBe(true)
  })

  it('falhou/cancelada/ignorada são terminais', () => {
    expect(podeAvancarStatusFila('falhou', 'enviada')).toBe(false)
    expect(podeAvancarStatusFila('cancelada', 'pendente')).toBe(false)
    expect(podeAvancarStatusFila('ignorada', 'enviada')).toBe(false)
  })

  it('status desconhecido → false', () => {
    expect(podeAvancarStatusFila('xyz', 'enviada')).toBe(false)
    expect(podeAvancarStatusFila('enviada', 'xyz')).toBe(false)
  })

  it('webhook fora de ordem: entregue não volta para enviada', () => {
    expect(podeAvancarStatusFila('entregue', 'enviada')).toBe(false)
    expect(podeAvancarStatusFila('lida', 'entregue')).toBe(false)
  })
})
