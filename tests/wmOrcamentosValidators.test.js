/**
 * DTOs do orçamento WM (doc 36, seção 5). Limites tirados do `docs/wm/openapi.yaml`.
 *
 * O que este arquivo protege:
 *   · identidades proibidas não entram pelo navegador (tenant, telefone, token, comando_id, preço);
 *   · quantidade e preço são string decimal, sempre, e quantidade zero é recusada AQUI
 *     (o padrão `^\d+(?:\.\d+)?$` da WM aceita `0`);
 *   · o preço sai byte a byte igual ao que entrou — nada de reformatar o `0.00##` invariant;
 *   · `tamanho_pagina` e `limite` nunca são aceitos nem emitidos.
 */
const v = require('../validators/wmOrcamentosValidators')

const { LIMITES, CAMPOS_PROIBIDOS } = v

const UUID = '3f2a1c5e-9b8d-4a7f-8e21-0c6d5b4a3f21'
const TELEFONE = '5511999990000'

function prepararBodyValido(extra = {}) {
  return {
    conversa_id: 42,
    cliente_busca: 'João da Silva',
    vendedor_busca: 'Carlos',
    itens: [{ busca: 'notebook', quantidade: '1' }],
    ...extra,
  }
}

function criarPayloadValido(extra = {}) {
  return {
    telefone: TELEFONE,
    comando_id: UUID,
    cliente_codigo_erp: '000123',
    vendedor_codigo_erp: '77',
    itens: [{ codigo_produto_erp: '1234567', quantidade: '2', preco_confirmado: '33.038' }],
    ...extra,
  }
}

describe('validarConsultarProdutosBody', () => {
  it('aceita busca e devolve só o recorte permitido', () => {
    const r = v.validarConsultarProdutosBody({ busca: 'notebook', pagina: 2 })
    expect(r.ok).toBe(true)
    expect(r.value).toEqual({ busca: 'notebook', pagina: 2 })
  })

  it('aceita código e não inventa página', () => {
    const r = v.validarConsultarProdutosBody({ codigo_produto_erp: '1234567' })
    expect(r.ok).toBe(true)
    expect(r.value).toEqual({ codigo_produto_erp: '1234567' })
    expect(r.value).not.toHaveProperty('pagina')
  })

  it('exige exatamente um entre busca e codigo_produto_erp', () => {
    expect(v.validarConsultarProdutosBody({}).ok).toBe(false)
    expect(v.validarConsultarProdutosBody({ busca: 'x', codigo_produto_erp: '1' }).ok).toBe(false)
  })

  it('recusa `limite` (obsoleto e ignorado pela WM) e `tamanho_pagina` (fixo em 30)', () => {
    const limite = v.validarConsultarProdutosBody({ busca: 'x', limite: 10 })
    expect(limite.ok).toBe(false)
    expect(limite.error).toMatch(/limite/)

    const tamanho = v.validarConsultarProdutosBody({ busca: 'x', tamanho_pagina: 30 })
    expect(tamanho.ok).toBe(false)
    expect(tamanho.error).toMatch(/tamanho_pagina/)
  })

  it('aplica os limites do contrato para busca (1–100) e código (1–7)', () => {
    expect(v.validarConsultarProdutosBody({ busca: 'a'.repeat(LIMITES.BUSCA_PRODUTO_MAX) }).ok).toBe(true)
    expect(v.validarConsultarProdutosBody({ busca: 'a'.repeat(LIMITES.BUSCA_PRODUTO_MAX + 1) }).ok).toBe(false)
    expect(v.validarConsultarProdutosBody({ busca: '' }).ok).toBe(false)
    expect(v.validarConsultarProdutosBody({ busca: '   ' }).ok).toBe(false)
    expect(v.validarConsultarProdutosBody({ codigo_produto_erp: '1234567' }).ok).toBe(true)
    expect(v.validarConsultarProdutosBody({ codigo_produto_erp: '12345678' }).ok).toBe(false)
  })

  it('recusa corpo que não é objeto', () => {
    for (const ruim of [null, undefined, 'x', 7, [], true]) {
      expect(v.validarConsultarProdutosBody(ruim).ok).toBe(false)
    }
  })
})

describe('campos proibidos vindos do navegador', () => {
  it('a lista é exatamente a da seção 5', () => {
    expect([...CAMPOS_PROIBIDOS].sort()).toEqual([
      'base_url',
      'comando_id',
      'company_id',
      'empresa_id',
      'preco_confirmado',
      'sincronizador_id',
      'telefone',
      'token',
    ])
  })

  it.each(CAMPOS_PROIBIDOS)('recusa %s no corpo de produtos/consultar', (campo) => {
    const r = v.validarConsultarProdutosBody({ busca: 'x', [campo]: 'qualquer' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/não aceito/i)
    expect(r.error).toContain(campo)
  })

  it.each(CAMPOS_PROIBIDOS)('recusa %s no corpo de preparar', (campo) => {
    const r = v.validarPrepararBody(prepararBodyValido({ [campo]: 'qualquer' }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/não aceito/i)
  })

  it.each(CAMPOS_PROIBIDOS)('recusa %s DENTRO de um item', (campo) => {
    const r = v.validarPrepararBody(prepararBodyValido({
      itens: [{ busca: 'notebook', quantidade: '1', [campo]: 'qualquer' }],
    }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/não aceito/i)
  })

  it.each(CAMPOS_PROIBIDOS)('recusa %s onde o corpo deve ser vazio', (campo) => {
    const r = v.validarCorpoVazio({ [campo]: 'qualquer' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/não aceito/i)
  })

  it('recusa bloquear_apos_criar do navegador (é política por empresa, pendência 10)', () => {
    const r = v.validarPrepararBody(prepararBodyValido({ bloquear_apos_criar: false }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/desconhecido/i)
  })

  it('recusa qualquer chave desconhecida (additionalProperties: false)', () => {
    expect(v.validarPrepararBody(prepararBodyValido({ xyz: 1 })).ok).toBe(false)
    expect(v.validarPrepararBody(prepararBodyValido({ itens: [{ busca: 'x', quantidade: '1', xyz: 1 }] })).ok).toBe(false)
  })

  it('recusa preco_negociado nos itens — pendência 14, e é intencional', () => {
    // O openapi.yaml da 2ª remessa aceita `preco_negociado` nos itens de preparar E de criar; o
    // guia diz em §7.1 e §9.1 que nenhuma das duas aceita. Enquanto a divergência existir não
    // implementamos: o campo é opcional (não enviar é seguro) e só um "Worker compatível" aplica
    // a negociação — num Worker antigo o desconto seria ignorado em silêncio e o ERP gravaria o
    // preço cheio. Como é chave desconhecida, a recusa é automática. Este teste trava isso para
    // que ninguém "conserte" a ausência sem resolver a pendência.
    const r = v.validarPrepararBody(prepararBodyValido({ itens: [{ busca: 'x', quantidade: '1', preco_negociado: '400.00' }] }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/desconhecido/i)
  })
})

describe('validarPrepararBody', () => {
  it('aceita o caminho comum e normaliza o conversa_id', () => {
    const r = v.validarPrepararBody(prepararBodyValido())
    expect(r.ok).toBe(true)
    expect(r.value).toEqual({
      conversa_id: 42,
      cliente_busca: 'João da Silva',
      vendedor_busca: 'Carlos',
      itens: [{ busca: 'notebook', quantidade: '1' }],
    })
    // Nada de telefone/tenant no valor normalizado: isso é injetado server-side.
    expect(r.value).not.toHaveProperty('telefone')
    expect(r.value).not.toHaveProperty('company_id')
  })

  it('exige conversa_id (a rota revalida acesso por assertPermissaoConversa — D9)', () => {
    const semConversa = prepararBodyValido()
    delete semConversa.conversa_id
    const r = v.validarPrepararBody(semConversa)
    expect(r.ok).toBe(false)
    expect(r.campo).toBe('conversa_id')
  })

  it('recusa conversa_id inválido', () => {
    for (const ruim of [0, -1, 1.5, 'abc', '', null, {}, '12a']) {
      expect(v.validarPrepararBody(prepararBodyValido({ conversa_id: ruim })).ok).toBe(false)
    }
    expect(v.validarPrepararBody(prepararBodyValido({ conversa_id: '42' })).value.conversa_id).toBe(42)
  })

  it('exige exatamente um de cliente e um de vendedor', () => {
    const semCliente = prepararBodyValido()
    delete semCliente.cliente_busca
    expect(v.validarPrepararBody(semCliente).ok).toBe(false)

    expect(v.validarPrepararBody(prepararBodyValido({ cliente_codigo_erp: '1' })).ok).toBe(false)

    const semVendedor = prepararBodyValido()
    delete semVendedor.vendedor_busca
    expect(v.validarPrepararBody(semVendedor).ok).toBe(false)

    expect(v.validarPrepararBody(prepararBodyValido({ vendedor_codigo_erp: '77' })).ok).toBe(false)
  })

  it('aplica limites de código (20) e busca (100) de cliente e vendedor', () => {
    const base = { conversa_id: 1, itens: [{ busca: 'x', quantidade: '1' }] }
    const ok = v.validarPrepararBody({
      ...base,
      cliente_codigo_erp: 'c'.repeat(LIMITES.CODIGO_ERP_MAX),
      vendedor_codigo_erp: 'v'.repeat(LIMITES.CODIGO_ERP_MAX),
    })
    expect(ok.ok).toBe(true)

    expect(v.validarPrepararBody({
      ...base,
      cliente_codigo_erp: 'c'.repeat(LIMITES.CODIGO_ERP_MAX + 1),
      vendedor_busca: 'x',
    }).ok).toBe(false)

    expect(v.validarPrepararBody({
      ...base,
      cliente_busca: 'c'.repeat(LIMITES.BUSCA_MAX + 1),
      vendedor_busca: 'x',
    }).ok).toBe(false)
  })

  it('exige entre 1 e 50 itens', () => {
    expect(v.validarPrepararBody(prepararBodyValido({ itens: [] })).ok).toBe(false)
    expect(v.validarPrepararBody(prepararBodyValido({ itens: 'nao-lista' })).ok).toBe(false)

    const cinquenta = Array.from({ length: LIMITES.ITENS_MAX }, () => ({ busca: 'x', quantidade: '1' }))
    expect(v.validarPrepararBody(prepararBodyValido({ itens: cinquenta })).ok).toBe(true)

    const cinquentaEUm = [...cinquenta, { busca: 'x', quantidade: '1' }]
    expect(v.validarPrepararBody(prepararBodyValido({ itens: cinquentaEUm })).ok).toBe(false)
  })

  it('exige exatamente um de codigo_produto_erp/busca por item — o oneOf que falta no contrato', () => {
    expect(v.validarPrepararBody(prepararBodyValido({ itens: [{ quantidade: '1' }] })).ok).toBe(false)
    expect(v.validarPrepararBody(prepararBodyValido({
      itens: [{ codigo_produto_erp: '1', busca: 'x', quantidade: '1' }],
    })).ok).toBe(false)
  })

  it('aponta o índice do item com problema', () => {
    const r = v.validarPrepararBody(prepararBodyValido({
      itens: [{ busca: 'ok', quantidade: '1' }, { busca: 'ruim', quantidade: '0' }],
    }))
    expect(r.ok).toBe(false)
    expect(r.campo).toBe('itens[1].quantidade')
  })

  it('aceita páginas de cliente, vendedor e produto como inteiros >= 1', () => {
    const r = v.validarPrepararBody(prepararBodyValido({
      cliente_pagina: 2,
      vendedor_pagina: 3,
      itens: [{ busca: 'x', quantidade: '1', produto_pagina: 4 }],
    }))
    expect(r.ok).toBe(true)
    expect(r.value.cliente_pagina).toBe(2)
    expect(r.value.itens[0].produto_pagina).toBe(4)
  })
})

describe('validarPagina — sem clamp, sem string, sem fracionário', () => {
  it('aceita 1 e o máximo Int32', () => {
    expect(v.validarPagina(1, 'pagina').ok).toBe(true)
    expect(v.validarPagina(LIMITES.PAGINA_MAX, 'pagina').ok).toBe(true)
  })

  it('recusa 0, negativo, fracionário, string e acima de Int32', () => {
    for (const ruim of [0, -1, 1.5, '2', null, undefined, NaN, Infinity, LIMITES.PAGINA_MAX + 1]) {
      expect(v.validarPagina(ruim, 'pagina').ok).toBe(false)
    }
  })

  it('não corrige silenciosamente a página fora do intervalo', () => {
    const r = v.validarConsultarProdutosBody({ busca: 'x', pagina: 0 })
    expect(r.ok).toBe(false)
    expect(r.value).toBeUndefined()
  })
})

describe('validarDecimalString — quantidade e preço', () => {
  it('aceita string decimal do padrão da WM', () => {
    for (const bom of ['1', '2', '0.5', '10.250', '33.038', '1.000']) {
      expect(v.validarDecimalString(bom, { campo: 'q', exigirPositivo: true }).ok).toBe(true)
    }
  })

  it('RECUSA number — mandar number abre porta para desvio de float', () => {
    for (const n of [1, 0.5, 2.0]) {
      const r = v.validarDecimalString(n, { campo: 'q', exigirPositivo: true })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/texto decimal/i)
    }
  })

  it('RECUSA zero disfarçado, que o padrão da WM aceitaria', () => {
    for (const zero of ['0', '0.0', '0.00', '0.000', '00', '000.000']) {
      const r = v.validarDecimalString(zero, { campo: 'q', exigirPositivo: true })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/maior que zero/i)
    }
  })

  it('aceita zero quando positivo não é exigido (preço pode ser 0 pelo contrato)', () => {
    expect(v.validarDecimalString('0.00', { campo: 'p', exigirPositivo: false }).ok).toBe(true)
  })

  it('recusa formatos fora do padrão', () => {
    for (const ruim of ['-1', '1,5', '1.', '.5', '1e3', ' 1', '1 ', 'abc', '1.2.3', '', '+1', '1_000']) {
      expect(v.validarDecimalString(ruim, { campo: 'q', exigirPositivo: true }).ok).toBe(false)
    }
  })

  it('limita o tamanho sem reformatar (escala máxima é a pendência 8)', () => {
    const grande = '1.' + '0'.repeat(LIMITES.DECIMAL_MAX_LEN)
    expect(v.validarDecimalString(grande, { campo: 'q', exigirPositivo: true }).ok).toBe(false)
  })

  it('devolve o valor IDÊNTICO ao recebido — nunca reformata, arredonda ou passa por Number', () => {
    for (const valor of ['33.038', '0.100', '007', '1.0000', '12345.678']) {
      const r = v.validarDecimalString(valor, { campo: 'p', exigirPositivo: false })
      expect(r.ok).toBe(true)
      expect(r.value).toBe(valor)
      expect(Object.is(r.value, valor)).toBe(true)
    }
  })
})

describe('validarCorpoVazio — confirmar e verificar', () => {
  it('aceita ausência de corpo e objeto vazio', () => {
    expect(v.validarCorpoVazio(undefined).ok).toBe(true)
    expect(v.validarCorpoVazio(null).ok).toBe(true)
    expect(v.validarCorpoVazio({}).ok).toBe(true)
  })

  it('recusa qualquer campo', () => {
    expect(v.validarCorpoVazio({ preco_confirmado: '1.00' }).ok).toBe(false)
    expect(v.validarCorpoVazio({ qualquer: 1 }).ok).toBe(false)
    expect(v.validarCorpoVazio('texto').ok).toBe(false)
    expect(v.validarCorpoVazio([]).ok).toBe(false)
  })
})

describe('validarPayloadPreparar — o que sai para a WM', () => {
  function payload(extra = {}) {
    return {
      telefone: TELEFONE,
      cliente_busca: 'João',
      vendedor_busca: 'Carlos',
      bloquear_apos_criar: true,
      itens: [{ busca: 'notebook', quantidade: '1' }],
      ...extra,
    }
  }

  it('aceita o payload completo', () => {
    const r = v.validarPayloadPreparar(payload())
    expect(r.ok).toBe(true)
    expect(r.value.telefone).toBe(TELEFONE)
    expect(r.value.bloquear_apos_criar).toBe(true)
  })

  it('exige bloquear_apos_criar booleano (obrigatório no contrato — não dá para não decidir)', () => {
    const sem = payload()
    delete sem.bloquear_apos_criar
    expect(v.validarPayloadPreparar(sem).ok).toBe(false)
    expect(v.validarPayloadPreparar(payload({ bloquear_apos_criar: 'true' })).ok).toBe(false)
  })

  it('exige telefone sem jamais repetir o valor na mensagem de erro', () => {
    const sem = payload()
    delete sem.telefone
    const r = v.validarPayloadPreparar(sem)
    expect(r.ok).toBe(false)
    expect(r.error).not.toContain(TELEFONE)

    const curto = v.validarPayloadPreparar(payload({ telefone: '123' }))
    expect(curto.ok).toBe(false)
    expect(curto.error).not.toContain('123')
  })

  it('nunca emite tamanho_pagina nem limite', () => {
    const r = v.validarPayloadPreparar(payload({ cliente_pagina: 2 }))
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r.value)).not.toContain('tamanho_pagina')
    expect(JSON.stringify(r.value)).not.toContain('limite')
  })

  it('recusa quantidade number também na preparação, embora a WM aceitasse', () => {
    const r = v.validarPayloadPreparar(payload({ itens: [{ busca: 'x', quantidade: 1 }] }))
    expect(r.ok).toBe(false)
  })
})

describe('validarPayloadCriar — o único payload que escreve no ERP', () => {
  it('aceita o payload do contrato e preserva o preço byte a byte', () => {
    const r = v.validarPayloadCriar(criarPayloadValido())
    expect(r.ok).toBe(true)
    expect(r.value.itens[0].preco_confirmado).toBe('33.038')
    expect(r.value.itens[0].quantidade).toBe('2')
    expect(r.value.comando_id).toBe(UUID)
  })

  it('exige comando_id UUID', () => {
    for (const ruim of [undefined, null, '', 'nao-uuid', 123, UUID.slice(0, -1)]) {
      const r = v.validarPayloadCriar(criarPayloadValido({ comando_id: ruim }))
      expect(r.ok).toBe(false)
      expect(r.campo).toBe('comando_id')
    }
  })

  it('exige cliente e vendedor por CÓDIGO (busca não existe na criação)', () => {
    expect(v.validarPayloadCriar(criarPayloadValido({ cliente_busca: 'João' })).ok).toBe(false)
    expect(v.validarPayloadCriar(criarPayloadValido({ cliente_codigo_erp: undefined })).ok).toBe(false)
    expect(v.validarPayloadCriar(criarPayloadValido({ vendedor_codigo_erp: '' })).ok).toBe(false)
    expect(v.validarPayloadCriar(criarPayloadValido({ cliente_codigo_erp: 'c'.repeat(21) })).ok).toBe(false)
  })

  it('exige codigo_produto_erp de até 7, quantidade e preco_confirmado em cada item', () => {
    expect(v.validarPayloadCriar(criarPayloadValido({
      itens: [{ codigo_produto_erp: '12345678', quantidade: '1', preco_confirmado: '1.00' }],
    })).ok).toBe(false)

    expect(v.validarPayloadCriar(criarPayloadValido({
      itens: [{ codigo_produto_erp: '1234567', quantidade: '1' }],
    })).ok).toBe(false)

    expect(v.validarPayloadCriar(criarPayloadValido({
      itens: [{ codigo_produto_erp: '1234567', preco_confirmado: '1.00' }],
    })).ok).toBe(false)

    expect(v.validarPayloadCriar(criarPayloadValido({
      itens: [{ codigo_produto_erp: '1234567', quantidade: '1', preco_confirmado: '1.00', busca: 'x' }],
    })).ok).toBe(false)
  })

  it('recusa quantidade zero na criação (o padrão da WM aceitaria)', () => {
    const r = v.validarPayloadCriar(criarPayloadValido({
      itens: [{ codigo_produto_erp: '1234567', quantidade: '0', preco_confirmado: '33.038' }],
    }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/maior que zero/i)
  })

  it('recusa quantidade e preço como number', () => {
    expect(v.validarPayloadCriar(criarPayloadValido({
      itens: [{ codigo_produto_erp: '1234567', quantidade: 2, preco_confirmado: '1.00' }],
    })).ok).toBe(false)

    expect(v.validarPayloadCriar(criarPayloadValido({
      itens: [{ codigo_produto_erp: '1234567', quantidade: '2', preco_confirmado: 33.038 }],
    })).ok).toBe(false)
  })

  it('bloquear_apos_criar é opcional aqui, mas booleano quando vem', () => {
    expect(v.validarPayloadCriar(criarPayloadValido()).value).not.toHaveProperty('bloquear_apos_criar')
    expect(v.validarPayloadCriar(criarPayloadValido({ bloquear_apos_criar: true })).value.bloquear_apos_criar).toBe(true)
    expect(v.validarPayloadCriar(criarPayloadValido({ bloquear_apos_criar: 'sim' })).ok).toBe(false)
  })

  it('recusa chave desconhecida no payload de criação', () => {
    expect(v.validarPayloadCriar(criarPayloadValido({ cliente_pagina: 1 })).ok).toBe(false)
    expect(v.validarPayloadCriar(criarPayloadValido({ company_id: 1 })).ok).toBe(false)
    // `preco_negociado` também não entra na criação — pendência 14, mesmo motivo de preparar.
    const item = { codigo_produto_erp: '1234567', quantidade: '1', preco_confirmado: '1.00', preco_negociado: '400.00' }
    expect(v.validarPayloadCriar(criarPayloadValido({ itens: [item] })).ok).toBe(false)
  })

  it('aceita de 1 a 50 itens', () => {
    const item = { codigo_produto_erp: '1234567', quantidade: '1', preco_confirmado: '1.00' }
    expect(v.validarPayloadCriar(criarPayloadValido({ itens: [] })).ok).toBe(false)
    expect(v.validarPayloadCriar(criarPayloadValido({ itens: Array.from({ length: 50 }, () => ({ ...item })) })).ok).toBe(true)
    expect(v.validarPayloadCriar(criarPayloadValido({ itens: Array.from({ length: 51 }, () => ({ ...item })) })).ok).toBe(false)
  })

  it('nenhuma mensagem de erro repete o telefone autorizado', () => {
    const casos = [
      criarPayloadValido({ comando_id: 'x' }),
      criarPayloadValido({ cliente_codigo_erp: '' }),
      criarPayloadValido({ itens: [{ codigo_produto_erp: '1234567', quantidade: '0', preco_confirmado: '1.00' }] }),
    ]
    for (const caso of casos) {
      const r = v.validarPayloadCriar(caso)
      expect(r.ok).toBe(false)
      expect(JSON.stringify(r)).not.toContain(TELEFONE)
    }
  })
})
