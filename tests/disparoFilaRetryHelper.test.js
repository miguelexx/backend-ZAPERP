/**
 * Testes unitários — classificação de erros, backoff e progressão de status (Etapa 7).
 */

const {
  classificarErro,
  calcularProximaTentativa,
  podeAvancarStatusFila,
  FILA_STATUS_RANK,
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

  it('errorCodigo EXCLUIDO/ALLOWLIST (como sendService) → permanente', () => {
    // sendService devolve errorCodigo; worker deve passar code: result.code || result.errorCodigo
    const excl = classificarErro({
      httpStatus: 403,
      code: undefined || 'EXCLUIDO',
      message: 'Telefone na lista de exclusão',
      beforeSend: true,
    })
    expect(excl.classificacao).toBe('permanente')
    expect(excl.code).toBe('EXCLUIDO')

    const allow = classificarErro({
      httpStatus: 403,
      code: undefined || 'ALLOWLIST',
      message: 'Telefone fora da allowlist',
      beforeSend: true,
    })
    expect(allow.classificacao).toBe('permanente')
    expect(allow.code).toBe('ALLOWLIST')
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

  it('lida pode avançar para respondida', () => {
    expect(podeAvancarStatusFila('lida', 'respondida')).toBe(true)
    expect(podeAvancarStatusFila('lida', 'entregue')).toBe(false)
  })

  it('respondida é terminal', () => {
    expect(podeAvancarStatusFila('respondida', 'lida')).toBe(false)
    expect(podeAvancarStatusFila('respondida', 'respondida')).toBe(true)
  })

  it('pendente pode ir para ignorada/optout', () => {
    expect(podeAvancarStatusFila('pendente', 'ignorada')).toBe(true)
    expect(podeAvancarStatusFila('pendente', 'optout')).toBe(true)
  })

  it('optout é terminal', () => {
    expect(podeAvancarStatusFila('optout', 'ignorada')).toBe(false)
  })

  it('incerta pode avançar para respondida', () => {
    expect(podeAvancarStatusFila('incerta', 'respondida')).toBe(true)
  })

  it('lida é terminal para webhook — não regride para entregue', () => {
    expect(podeAvancarStatusFila('lida', 'entregue')).toBe(false)
    expect(podeAvancarStatusFila('lida', 'enviada')).toBe(false)
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

describe('disparoFilaRetryHelper — FILA_STATUS_RANK respondida/optout', () => {
  it('respondida e optout têm rank terminal 6', () => {
    expect(FILA_STATUS_RANK.respondida).toBe(6)
    expect(FILA_STATUS_RANK.optout).toBe(6)
  })

  it('entregue/lida podem avançar para respondida', () => {
    expect(podeAvancarStatusFila('entregue', 'respondida')).toBe(true)
    expect(podeAvancarStatusFila('lida', 'respondida')).toBe(true)
  })

  it('respondida não regride para lida/entregue', () => {
    expect(podeAvancarStatusFila('respondida', 'lida')).toBe(false)
    expect(podeAvancarStatusFila('respondida', 'entregue')).toBe(false)
  })

  it('pendente pode ir para optout (Etapa 8)', () => {
    expect(podeAvancarStatusFila('pendente', 'optout')).toBe(true)
    expect(podeAvancarStatusFila('optout', 'pendente')).toBe(false)
  })
})
