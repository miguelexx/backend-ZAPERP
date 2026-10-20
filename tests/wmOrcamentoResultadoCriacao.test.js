/**
 * Normalização do `200` de `POST /orcamentos/criar` — Sessão 4B do doc 36.
 *
 * `normalizarResultadoCriacao` é função **pura** e **não despacha nada**: o despacho continua
 * sendo a Sessão 6. Ela traduz o corpo de sucesso que a WM documentou em §10 do guia da 2ª
 * remessa (pendência 2, respondida) no `wm_resultado_sanitizado` que vai para o banco e, na 5B,
 * para a tela e para o resumo ao cliente.
 *
 * Os três invariantes que, se quebrarem, viram incidente:
 *
 *   1. **O número do orçamento é `dados.codigo_pedido_erp`.** Sem ele não há resultado
 *      utilizável — e nada aqui inventa, deriva ou substitui esse número.
 *   2. **NÃO EXISTE a distinção "criado agora" × "resultado idempotente".** §11.1 é explícito:
 *      o `200` não tem campo que diferencie os dois, os dois são sucesso da mesma ação de
 *      negócio, e é PROIBIDO inferir a diferença por `meta.criado_em`. Se a UI precisar dela,
 *      vem do NOSSO estado local (a operação já estava `CRIADO`?), nunca da resposta da WM.
 *   3. **`meta.resultado_comando` não é consumido.** §15 diz que é só sugestão de evolução e
 *      não existe na API. Ler agora criaria dependência de campo inexistente.
 *
 * Nenhum teste faz rede real: a função não chama nada.
 */
const service = require('../services/wm/wmOrcamentoService')
const fx = require('./fixtures/wmPreviaReal')

const CHAVES_ESPERADAS = [
  'bloqueado',
  'cliente',
  'codigo_pedido_erp',
  'documento_venda',
  'meta',
  'valor_total',
  'vendedor',
]

describe('normalizarResultadoCriacao — o shape documentado em §10', () => {
  it('o exemplo do guia atravessa byte a byte', () => {
    const corpo = fx.criacaoDocumentada()

    const r = service.normalizarResultadoCriacao(corpo)

    expect(r.ok).toBe(true)
    expect(r.resultado_sanitizado).toEqual({
      codigo_pedido_erp: '0000045979',
      documento_venda: '2 - Orçamento',
      cliente: { codigo_cliente_erp: '0000108', nome: 'JOAO DA SILVA' },
      vendedor: { codigo_vendedor_erp: '001', nome: 'VENDEDOR TESTE' },
      valor_total: '57.80',
      bloqueado: true,
      meta: { fonte: 'tempo_real', tempo_real: true, criado_em: '2026-10-20T15:40:00' },
    })
  })

  it('a saída tem só as chaves do contrato — nada do corpo cru passa adiante', () => {
    const corpo = fx.criacaoDocumentada()
    corpo.dados.campo_que_a_wm_inventou = 'xyz'
    corpo.dados.sincronizador_id = 77
    corpo.dados.telefone = '5534991847800'

    const r = service.normalizarResultadoCriacao(corpo)

    expect(Object.keys(r.resultado_sanitizado).sort()).toEqual(CHAVES_ESPERADAS)
    const texto = JSON.stringify(r.resultado_sanitizado)
    expect(texto).not.toContain('5534991847800')
    expect(texto).not.toContain('sincronizador')
    expect(texto).not.toContain('xyz')
  })

  it('valor_total e o número do pedido não são reformatados', () => {
    const corpo = fx.criacaoDocumentada()
    corpo.dados.valor_total = '1200.500'

    const r = service.normalizarResultadoCriacao(corpo)

    expect(r.resultado_sanitizado.valor_total).toBe('1200.500') // não virou '1200.5'
    // Zeros à esquerda do código do pedido são significativos no Icthus.
    expect(r.resultado_sanitizado.codigo_pedido_erp).toBe('0000045979')
  })
})

describe('normalizarResultadoCriacao — o número do orçamento é obrigatório', () => {
  it.each([
    ['ausente', undefined],
    ['nulo', null],
    ['vazio', ''],
    ['número em vez de string', 45979],
  ])('codigo_pedido_erp %s é recusado, sem inventar número', (_nome, valor) => {
    const corpo = fx.criacaoDocumentada()
    corpo.dados.codigo_pedido_erp = valor

    const r = service.normalizarResultadoCriacao(corpo)

    expect(r.ok).toBe(false)
    expect(r.motivo).toBe('resultado_sem_codigo_pedido')
    expect(r).not.toHaveProperty('resultado_sanitizado')
  })

  it('corpo sem `dados` é recusado', () => {
    for (const entrada of [undefined, {}, { dados: null }, { dados: 'texto' }, { dados: [] }]) {
      const r = service.normalizarResultadoCriacao(entrada)
      expect(r.ok).toBe(false)
      expect(r.motivo).toBe('resultado_ausente')
    }
  })
})

describe('normalizarResultadoCriacao — §11.1: criado agora × idempotente NÃO se distingue', () => {
  it('a saída não tem nenhum campo que afirme a distinção', () => {
    const r = service.normalizarResultadoCriacao(fx.criacaoDocumentada())
    const texto = JSON.stringify(r.resultado_sanitizado)

    for (const proibido of ['criado_agora', 'resultado_existente', 'novo', 'reaproveitado', 'idempotente', 'resultado_comando']) {
      expect(r.resultado_sanitizado).not.toHaveProperty(proibido)
      expect(texto).not.toContain(proibido)
    }
  })

  it('`meta.resultado_comando` da sugestão de evolução (§15) é IGNORADO', () => {
    const corpo = fx.criacaoDocumentada()
    corpo.meta.resultado_comando = 'criado_agora'

    const r = service.normalizarResultadoCriacao(corpo)

    expect(r.resultado_sanitizado.meta).toEqual({ fonte: 'tempo_real', tempo_real: true, criado_em: '2026-10-20T15:40:00' })
    expect(JSON.stringify(r.resultado_sanitizado)).not.toContain('criado_agora')
  })

  it('dois corpos idênticos dão resultados idênticos — nada depende de quando chegou', () => {
    // O replay idempotente devolve o resultado armazenado: a normalização não pode produzir
    // nada diferente só porque é a segunda vez.
    const primeiro = service.normalizarResultadoCriacao(fx.criacaoDocumentada())
    const segundo = service.normalizarResultadoCriacao(fx.criacaoDocumentada())
    expect(segundo).toEqual(primeiro)
  })

  it('`criado_em` é texto repassado, nunca convertido nem interpretado', () => {
    const corpo = fx.criacaoDocumentada()
    // §10 publica o carimbo SEM fuso: converter para Date aqui assumiria um fuso qualquer.
    expect(corpo.meta.criado_em).toBe('2026-10-20T15:40:00')

    const r = service.normalizarResultadoCriacao(corpo)

    expect(r.resultado_sanitizado.meta.criado_em).toBe('2026-10-20T15:40:00')
    expect(typeof r.resultado_sanitizado.meta.criado_em).toBe('string')

    // Carimbo ausente ou fora de forma não quebra nada e não vira "agora".
    const semCarimbo = fx.criacaoDocumentada()
    delete semCarimbo.meta.criado_em
    expect(service.normalizarResultadoCriacao(semCarimbo).resultado_sanitizado.meta.criado_em).toBeNull()

    const carimboNumero = fx.criacaoDocumentada()
    carimboNumero.meta.criado_em = Date.now()
    expect(service.normalizarResultadoCriacao(carimboNumero).resultado_sanitizado.meta.criado_em).toBeNull()
  })
})

describe('normalizarResultadoCriacao — leitura defensiva do que o contrato não garante', () => {
  it('`meta` ausente ou vazio não quebra, e `fonte` desconhecida nunca é "atual"', () => {
    const casos = [
      [undefined, { fonte: null, tempo_real: false, criado_em: null }],
      [{}, { fonte: null, tempo_real: false, criado_em: null }],
      [{ fonte: 'cache_cloud' }, { fonte: 'cache_cloud', tempo_real: false, criado_em: null }],
      [{ fonte: 'rotulo_novo' }, { fonte: 'rotulo_novo', tempo_real: false, criado_em: null }],
      [{ fonte: 'tempo_real' }, { fonte: 'tempo_real', tempo_real: true, criado_em: null }],
    ]
    for (const [meta, esperado] of casos) {
      const r = service.normalizarResultadoCriacao({ dados: fx.criacaoDocumentada().dados, meta })
      expect(r.ok).toBe(true)
      expect(r.resultado_sanitizado.meta).toEqual(esperado)
    }
  })

  it('cliente/vendedor incompletos ou ausentes viram null, sem derrubar o resultado', () => {
    const corpo = fx.criacaoDocumentada()
    delete corpo.dados.cliente
    corpo.dados.vendedor = { nome: 'SEM CÓDIGO' }

    const r = service.normalizarResultadoCriacao(corpo)

    expect(r.ok).toBe(true)
    expect(r.resultado_sanitizado.codigo_pedido_erp).toBe('0000045979')
    expect(r.resultado_sanitizado.cliente).toBeNull()
    expect(r.resultado_sanitizado.vendedor).toBeNull()
  })

  it('valor_total fora do padrão decimal vira null — nunca texto solto num total', () => {
    for (const valor of ['57,80', 'R$ 57,80', '-57.80', 57.8, '', null, undefined]) {
      const corpo = fx.criacaoDocumentada()
      corpo.dados.valor_total = valor
      const r = service.normalizarResultadoCriacao(corpo)
      expect(r.ok).toBe(true) // o número do orçamento é o que importa; o total é exibição
      expect(r.resultado_sanitizado.valor_total).toBeNull()
    }
  })

  it('`bloqueado` só é booleano quando a WM manda booleano — nunca inferido', () => {
    for (const valor of [undefined, null, 'true', 1, 0, {}]) {
      const corpo = fx.criacaoDocumentada()
      corpo.dados.bloqueado = valor
      expect(service.normalizarResultadoCriacao(corpo).resultado_sanitizado.bloqueado).toBeNull()
    }
    const falso = fx.criacaoDocumentada()
    falso.dados.bloqueado = false
    expect(service.normalizarResultadoCriacao(falso).resultado_sanitizado.bloqueado).toBe(false)
  })

  it('texto hostil é truncado e sem NUL — nada de corpo cru na tela', () => {
    const corpo = fx.criacaoDocumentada()
    corpo.dados.documento_venda = `2 - Orçamento\u0000${'x'.repeat(500)}`
    corpo.dados.cliente.nome = 'A'.repeat(1000)

    const r = service.normalizarResultadoCriacao(corpo)

    expect(r.resultado_sanitizado.documento_venda).not.toContain('\u0000')
    expect(r.resultado_sanitizado.documento_venda.length).toBeLessThanOrEqual(60)
    expect(r.resultado_sanitizado.cliente.nome.length).toBeLessThanOrEqual(200)
  })

  it('código de pedido fora de formato é RECUSADO, nunca truncado nem limpado', () => {
    // Truncar ou "limpar" um número de orçamento daria um identificador ERRADO com cara de
    // válido — e é por ele que o orçamento vai ser procurado no Icthus.
    for (const valor of ['9'.repeat(80), '000004\u00005979', '00000\t45979']) {
      const corpo = fx.criacaoDocumentada()
      corpo.dados.codigo_pedido_erp = valor

      const r = service.normalizarResultadoCriacao(corpo)

      expect(r.ok).toBe(false)
      expect(r.motivo).toBe('resultado_codigo_pedido_invalido')
    }
  })

  it('o número cabe inteiro quando está no formato — nenhum corte silencioso', () => {
    const corpo = fx.criacaoDocumentada()
    corpo.dados.codigo_pedido_erp = '12345678901234567890' // exatamente o limite de 20

    const r = service.normalizarResultadoCriacao(corpo)

    expect(r.ok).toBe(true)
    expect(r.resultado_sanitizado.codigo_pedido_erp).toBe('12345678901234567890')
  })
})

describe('normalizarResultadoCriacao — não despacha, não toca a WM', () => {
  it('é função pura: nenhum fetch, nenhum cliente HTTP', () => {
    const espiao = jest.fn(() => { throw new Error('nenhum teste pode fazer rede real') })
    const original = global.fetch
    global.fetch = espiao

    const r = service.normalizarResultadoCriacao(fx.criacaoDocumentada())

    expect(r.ok).toBe(true)
    expect(espiao).not.toHaveBeenCalled()
    global.fetch = original
  })
})
