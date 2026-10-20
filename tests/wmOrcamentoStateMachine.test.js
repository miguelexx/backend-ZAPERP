/**
 * Máquina de estados do orçamento WM + hash canônico do payload (doc 36, seção 7 e D4).
 * Módulo puro: nada de banco, nada de rede.
 */
const sm = require('../services/wm/wmOrcamentoStateMachine')

const { ESTADOS, TODOS_OS_ESTADOS } = sm

// Fonte da verdade do teste: escrita à mão a partir do diagrama do doc 36, NÃO derivada
// de TRANSICOES — senão o teste concordaria com qualquer regressão no módulo.
const PERMITIDAS = [
  [ESTADOS.PREPARADO, ESTADOS.ENVIANDO],
  [ESTADOS.PREPARADO, ESTADOS.EXPIRADO],
  [ESTADOS.ENVIANDO, ESTADOS.CRIADO],
  [ESTADOS.ENVIANDO, ESTADOS.FALHA_SEGURA],
  [ESTADOS.ENVIANDO, ESTADOS.INCERTO],
  [ESTADOS.ENVIANDO, ESTADOS.PREPARADO],
]

function ehPermitida(de, para) {
  return PERMITIDAS.some(([a, b]) => a === de && b === para)
}

describe('wmOrcamentoStateMachine — transições', () => {
  it('conhece exatamente os 6 estados do doc', () => {
    expect([...TODOS_OS_ESTADOS].sort()).toEqual(
      ['CRIADO', 'ENVIANDO', 'EXPIRADO', 'FALHA_SEGURA', 'INCERTO', 'PREPARADO']
    )
  })

  it('aceita as 6 transições permitidas e REJEITA todas as outras combinações', () => {
    for (const de of TODOS_OS_ESTADOS) {
      for (const para of TODOS_OS_ESTADOS) {
        const esperado = ehPermitida(de, para)
        expect({ de, para, ok: sm.transicaoPermitida(de, para) }).toEqual({ de, para, ok: esperado })
      }
    }
  })

  it('rejeita auto-transição em todos os estados', () => {
    for (const estado of TODOS_OS_ESTADOS) {
      expect(sm.transicaoPermitida(estado, estado)).toBe(false)
    }
  })

  it('rejeita estado desconhecido, vazio, nulo e de outro tipo', () => {
    const lixo = ['', 'preparado', 'CRIADA', 'VERIFICANDO', null, undefined, 0, {}, []]
    for (const v of lixo) {
      expect(sm.transicaoPermitida(v, ESTADOS.ENVIANDO)).toBe(false)
      expect(sm.transicaoPermitida(ESTADOS.PREPARADO, v)).toBe(false)
      expect(sm.estadoValido(v)).toBe(false)
    }
  })

  it('CRIADO, FALHA_SEGURA, INCERTO e EXPIRADO são terminais', () => {
    expect([...sm.ESTADOS_TERMINAIS].sort()).toEqual(
      ['CRIADO', 'EXPIRADO', 'FALHA_SEGURA', 'INCERTO']
    )
    for (const terminal of sm.ESTADOS_TERMINAIS) {
      expect(sm.isTerminal(terminal)).toBe(true)
      expect(sm.proximosEstados(terminal)).toEqual([])
      for (const para of TODOS_OS_ESTADOS) {
        expect(sm.transicaoPermitida(terminal, para)).toBe(false)
      }
    }
    expect(sm.isTerminal(ESTADOS.PREPARADO)).toBe(false)
    expect(sm.isTerminal(ESTADOS.ENVIANDO)).toBe(false)
  })

  it('INCERTO não volta para ENVIANDO nem para PREPARADO (D10: nunca refazer um incerto)', () => {
    expect(sm.transicaoPermitida(ESTADOS.INCERTO, ESTADOS.ENVIANDO)).toBe(false)
    expect(sm.transicaoPermitida(ESTADOS.INCERTO, ESTADOS.PREPARADO)).toBe(false)
    expect(sm.transicaoPermitida(ESTADOS.INCERTO, ESTADOS.CRIADO)).toBe(false)
  })

  it('EXPIRADO não vira ENVIANDO (preparação vencida exige nova preparação)', () => {
    expect(sm.transicaoPermitida(ESTADOS.EXPIRADO, ESTADOS.ENVIANDO)).toBe(false)
  })

  it('assertTransicao passa na válida e lança TRANSICAO_INVALIDA na inválida', () => {
    expect(sm.assertTransicao(ESTADOS.PREPARADO, ESTADOS.ENVIANDO)).toBe(true)
    expect.assertions(5)
    try {
      sm.assertTransicao(ESTADOS.CRIADO, ESTADOS.ENVIANDO)
    } catch (err) {
      expect(err.code).toBe('TRANSICAO_INVALIDA')
      expect(err.de).toBe('CRIADO')
      expect(err.para).toBe('ENVIANDO')
      expect(String(err.message)).toMatch(/CRIADO → ENVIANDO/)
    }
  })

  it('TRANSICOES é imutável (ninguém adiciona uma aresta em runtime)', () => {
    expect(() => { sm.TRANSICOES[ESTADOS.INCERTO].push(ESTADOS.ENVIANDO) }).toThrow()
    expect(sm.transicaoPermitida(ESTADOS.INCERTO, ESTADOS.ENVIANDO)).toBe(false)
  })
})

describe('wmOrcamentoStateMachine — payload_hash', () => {
  it('é determinístico com as chaves em ordem diferente, em qualquer profundidade', () => {
    const a = {
      cliente: { codigo: '55', nome: 'João' },
      itens: [{ codigo: 'P1', quantidade: '2', preco_confirmado: '10.00' }],
      vendedor: '7',
    }
    const b = {
      vendedor: '7',
      itens: [{ preco_confirmado: '10.00', quantidade: '2', codigo: 'P1' }],
      cliente: { nome: 'João', codigo: '55' },
    }
    expect(sm.calcularPayloadHash(a)).toBe(sm.calcularPayloadHash(b))
    expect(sm.calcularPayloadHash(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('muda quando qualquer valor muda — inclusive o preço', () => {
    const base = { itens: [{ codigo: 'P1', quantidade: '2', preco_confirmado: '10.00' }] }
    const precoAdulterado = { itens: [{ codigo: 'P1', quantidade: '2', preco_confirmado: '1.00' }] }
    const quantidadeOutra = { itens: [{ codigo: 'P1', quantidade: '3', preco_confirmado: '10.00' }] }
    expect(sm.calcularPayloadHash(base)).not.toBe(sm.calcularPayloadHash(precoAdulterado))
    expect(sm.calcularPayloadHash(base)).not.toBe(sm.calcularPayloadHash(quantidadeOutra))
  })

  it('NÃO reordena arrays — ordem de item é significativa', () => {
    const um = { itens: ['A', 'B'] }
    const outro = { itens: ['B', 'A'] }
    expect(sm.calcularPayloadHash(um)).not.toBe(sm.calcularPayloadHash(outro))
  })

  it('distingue número de string decimal (transporte monetário é string)', () => {
    expect(sm.calcularPayloadHash({ q: 1 })).not.toBe(sm.calcularPayloadHash({ q: '1' }))
  })

  it('distingue chave ausente de chave com null', () => {
    expect(sm.calcularPayloadHash({ a: 1 })).not.toBe(sm.calcularPayloadHash({ a: 1, b: null }))
  })

  it('ignora chave com undefined, igual ao JSON.stringify', () => {
    expect(sm.calcularPayloadHash({ a: 1, b: undefined })).toBe(sm.calcularPayloadHash({ a: 1 }))
  })

  it('payloadHashIgual compara hash e recusa vazio', () => {
    const h = sm.calcularPayloadHash({ a: 1 })
    expect(sm.payloadHashIgual(h, sm.calcularPayloadHash({ a: 1 }))).toBe(true)
    expect(sm.payloadHashIgual(h, sm.calcularPayloadHash({ a: 2 }))).toBe(false)
    expect(sm.payloadHashIgual('', '')).toBe(false)
    expect(sm.payloadHashIgual(null, null)).toBe(false)
    expect(sm.payloadHashIgual(h, null)).toBe(false)
  })
})
