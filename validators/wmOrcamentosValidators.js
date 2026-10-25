'use strict'

/**
 * Validadores dos DTOs do orçamento WM (doc 36, seção 5).
 *
 * Duas famílias, com propósitos diferentes e que não devem se misturar:
 *
 *   1. `validar*Body` — o que o NAVEGADOR manda para as nossas rotas locais. Schemas estritos
 *      (`additionalProperties: false` na prática: chave desconhecida é erro, não é ignorada) e
 *      recusa explícita das identidades proibidas.
 *   2. `validarPayload*` — o que NÓS mandamos para a WM. Última conferência antes de gastar
 *      chamada e, na criação, antes de gravar no ERP.
 *
 * Os limites vêm do `docs/wm/openapi.yaml`, não de memória. Validar aqui evita queimar uma
 * chamada (e dinheiro) num payload que a WM recusaria com 400.
 *
 * TRÊS REGRAS FÁCEIS DE VIOLAR, todas cobertas aqui:
 *
 *   (1) **Quantidade e preço são STRING decimal, sempre, nas duas chamadas.** `preparar` aceita
 *       `oneOf [number, string]`, mas mandar `number` abre porta para desvio de float — então
 *       aqui só string passa, inclusive na preparação.
 *   (2) **O padrão da criação `^\d+(?:\.\d+)?$` ACEITA `0`.** Recusar quantidade <= 0 é trabalho
 *       nosso; a WM não faz. A checagem é textual (`/[1-9]/`), nunca via `Number`.
 *   (3) **O preço vai copiado byte a byte.** A WM serializa `0.00##` invariant (ex.: `33.038`).
 *       Nada aqui reformata, arredonda, faz `trim` de zero, nem passa por `Number`/`parseFloat`.
 *       O valor validado é devolvido como veio.
 *
 * `tamanho_pagina` NUNCA é enviado (fixo em 30 do lado da WM) e `limite` de produtos é obsoleto
 * e ignorado — nenhum dos dois é aceito nem emitido. Página fora do intervalo é erro da WM
 * (`400 PAGINA_FORA_DO_INTERVALO`), sem clamp: aqui também não há clamp.
 *
 * O `openapi.yaml` é frouxo em dois pontos que corrigimos localmente:
 *   · `PrepararOrcamento.itens[]` exige só `quantidade` e NÃO declara `oneOf` entre
 *     `codigo_produto_erp` e `busca` — um item sem nenhum dos dois passaria no schema dela.
 *     Aqui exigimos exatamente um dos dois.
 *   · `cliente_codigo_erp`, `cliente_busca` e `itens[].codigo_produto_erp` são `type: string`
 *     sem limite em `preparar`. Aplicamos os limites do `criar`/`produtos/consultar`
 *     (20 / 100 / 7) por simetria — estreitar é seguro, alargar não.
 */

const LIMITES = Object.freeze({
  ITENS_MIN: 1,
  ITENS_MAX: 50,
  BUSCA_PRODUTO_MIN: 1,
  BUSCA_PRODUTO_MAX: 100,
  CODIGO_PRODUTO_MIN: 1,
  CODIGO_PRODUTO_MAX: 7,
  CODIGO_ERP_MIN: 1,
  CODIGO_ERP_MAX: 20,
  BUSCA_MIN: 1,
  BUSCA_MAX: 100,
  PAGINA_MIN: 1,
  PAGINA_MAX: 2147483647,
  // Escala máxima do decimal é a pendência 8 da seção 10 (ABERTA): a WM não publicou limite de
  // casas. O teto de 20 caracteres existe só para barrar entrada absurda, sem reformatar nada.
  DECIMAL_MAX_LEN: 20,
  TELEFONE_MIN: 8,
  TELEFONE_MAX: 30,
})

/**
 * Nunca aceitos do navegador (seção 5). `company_id`/`empresa_id`/`sincronizador_id` e
 * `telefone` são seletores de tenant — vêm do JWT e da config server-side, jamais do cliente
 * (seção 4 e pendência 13: o isolamento desta integração é 100% do ZapERP). `token` e
 * `base_url` são segredo de ambiente. `comando_id` é gerado e persistido pelo backend (seção 7).
 * `preco_confirmado` vem do snapshot server-side — se viesse da tela, daria para adulterar no
 * DevTools.
 */
const CAMPOS_PROIBIDOS = Object.freeze([
  'company_id',
  'empresa_id',
  'sincronizador_id',
  'telefone',
  'token',
  'base_url',
  'comando_id',
  'preco_confirmado',
])

/**
 * `bloquear_apos_criar` também não é aceito do navegador, mas por outro motivo: é política por
 * empresa, com o MESMO valor em preparar e criar, guardado no snapshot (pendência 10). Fica fora
 * das chaves permitidas, então cai na recusa de chave desconhecida.
 */

const PADRAO_DECIMAL = /^\d+(?:\.\d+)?$/

function erro(mensagem, campo) {
  return { ok: false, error: mensagem, campo: campo || null }
}

function ehObjetoSimples(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/** Chave fora da lista permitida é ERRO, não é ignorada. */
function conferirChaves(obj, permitidas, contexto) {
  const extras = Object.keys(obj).filter((k) => !permitidas.includes(k))
  if (!extras.length) return null
  const proibida = extras.find((k) => CAMPOS_PROIBIDOS.includes(k))
  if (proibida) {
    return erro(`Campo não aceito nesta requisição: ${proibida}`, contexto ? `${contexto}.${proibida}` : proibida)
  }
  return erro(`Campo desconhecido: ${extras[0]}`, contexto ? `${contexto}.${extras[0]}` : extras[0])
}

function validarTexto(valor, { min, max, campo }) {
  if (typeof valor !== 'string') return erro(`${campo} deve ser texto`, campo)
  // Sem `trim` silencioso que mude o valor enviado: só rejeita o que é só espaço.
  if (valor.trim().length === 0) return erro(`${campo} não pode ser vazio`, campo)
  if (valor.length < min) return erro(`${campo} deve ter ao menos ${min} caractere(s)`, campo)
  if (valor.length > max) return erro(`${campo} excede ${max} caracteres`, campo)
  if (valor.includes('\u0000')) return erro(`${campo} contém caractere inválido`, campo)
  return { ok: true, value: valor }
}

/** Página: inteiro >= 1 até Int32. Sem clamp, sem aceitar string, sem fracionário. */
function validarPagina(valor, campo) {
  if (typeof valor !== 'number' || !Number.isInteger(valor)) {
    return erro(`${campo} deve ser um número inteiro`, campo)
  }
  if (valor < LIMITES.PAGINA_MIN) return erro(`${campo} deve ser >= ${LIMITES.PAGINA_MIN}`, campo)
  if (valor > LIMITES.PAGINA_MAX) return erro(`${campo} excede o máximo permitido`, campo)
  return { ok: true, value: valor }
}

/**
 * Decimal como string, copiado byte a byte. `exigirPositivo` recusa `0`, `0.0`, `0.000` — a
 * checagem é textual porque `Number('0.000')` seria uma conversão desnecessária num valor que
 * precisa sair daqui idêntico ao que entrou.
 */
function validarDecimalString(valor, { campo, exigirPositivo }) {
  if (typeof valor !== 'string') {
    return erro(`${campo} deve ser texto decimal (ex.: "1" ou "1.500")`, campo)
  }
  if (valor.length === 0) return erro(`${campo} não pode ser vazio`, campo)
  if (valor.length > LIMITES.DECIMAL_MAX_LEN) return erro(`${campo} excede ${LIMITES.DECIMAL_MAX_LEN} caracteres`, campo)
  if (!PADRAO_DECIMAL.test(valor)) {
    return erro(`${campo} tem formato inválido`, campo)
  }
  if (exigirPositivo && !/[1-9]/.test(valor)) {
    return erro(`${campo} deve ser maior que zero`, campo)
  }
  return { ok: true, value: valor }
}

/** Exatamente um entre dois campos (o `oneOf` que o contrato tem — ou que falta nele). */
function exigirExatamenteUm(obj, a, b, contexto) {
  const temA = obj[a] !== undefined
  const temB = obj[b] !== undefined
  const onde = contexto ? `${contexto}: ` : ''
  if (temA && temB) return erro(`${onde}informe ${a} OU ${b}, não os dois`, contexto || a)
  if (!temA && !temB) return erro(`${onde}informe ${a} ou ${b}`, contexto || a)
  return null
}

function validarConversaId(valor) {
  const ehInteiro = typeof valor === 'number' && Number.isInteger(valor)
  const ehDigitos = typeof valor === 'string' && /^[0-9]+$/.test(valor.trim())
  if (!ehInteiro && !ehDigitos) return erro('conversa_id inválido', 'conversa_id')
  const n = Number(ehInteiro ? valor : valor.trim())
  if (!Number.isSafeInteger(n) || n <= 0) return erro('conversa_id inválido', 'conversa_id')
  return { ok: true, value: n }
}

/* ------------------------------------------------------------------ *
 * 1. Corpos aceitos do navegador
 * ------------------------------------------------------------------ */

const CHAVES_CONSULTAR_PRODUTOS = ['busca', 'codigo_produto_erp', 'pagina']

/**
 * `POST /api/orcamentos/produtos/consultar`.
 * Devolve o recorte já normalizado para virar payload da WM (sem `telefone`, que o serviço
 * injeta a partir da config da empresa; sem `limite`; sem `tamanho_pagina`).
 */
function validarConsultarProdutosBody(body) {
  if (!ehObjetoSimples(body)) return erro('Corpo da requisição inválido')
  const chaves = conferirChaves(body, CHAVES_CONSULTAR_PRODUTOS)
  if (chaves) return chaves

  const um = exigirExatamenteUm(body, 'busca', 'codigo_produto_erp')
  if (um) return um

  const value = {}
  if (body.busca !== undefined) {
    const r = validarTexto(body.busca, { min: LIMITES.BUSCA_PRODUTO_MIN, max: LIMITES.BUSCA_PRODUTO_MAX, campo: 'busca' })
    if (!r.ok) return r
    value.busca = r.value
  } else {
    const r = validarTexto(body.codigo_produto_erp, { min: LIMITES.CODIGO_PRODUTO_MIN, max: LIMITES.CODIGO_PRODUTO_MAX, campo: 'codigo_produto_erp' })
    if (!r.ok) return r
    value.codigo_produto_erp = r.value
  }

  if (body.pagina !== undefined) {
    const r = validarPagina(body.pagina, 'pagina')
    if (!r.ok) return r
    value.pagina = r.value
  }

  return { ok: true, value }
}

const CHAVES_CONSULTAR_CLIENTES = ['busca', 'codigo_cliente_erp', 'pagina']

/**
 * `POST /api/orcamentos/clientes/consultar`.
 *
 * ESTA ROTA É AUXÍLIO DE BUSCA, NÃO AUTORIDADE DE RESOLUÇÃO. A decisão D11 do doc 36 continua
 * valendo: quem resolve cliente para o orçamento é `preparar`. O motivo está no contrato
 * (`docs/wm/04-contratos-api.md`): `/clientes/consultar` **não aplica** os filtros Inativo e
 * Bloqueado, e `preparar` aplica — então um cliente encontrado aqui ainda pode ser recusado no
 * Calcular com `CLIENTE_INVALIDO`. Serve para o atendente DESCOBRIR o nome canônico (a busca do
 * ERP é por PREFIXO: "SILVA" não acha "JOSE DA SILVA"), não para fechar a escolha.
 *
 * Mesmo recorte do irmão de produtos: sem `telefone` (o serviço injeta a partir da empresa),
 * sem `limite` (obsoleto e ignorado pela WM), sem `tamanho_pagina` (não aceito).
 */
function validarConsultarClientesBody(body) {
  if (!ehObjetoSimples(body)) return erro('Corpo da requisição inválido')
  const chaves = conferirChaves(body, CHAVES_CONSULTAR_CLIENTES)
  if (chaves) return chaves

  const um = exigirExatamenteUm(body, 'busca', 'codigo_cliente_erp')
  if (um) return um

  const value = {}
  if (body.busca !== undefined) {
    const r = validarTexto(body.busca, { min: LIMITES.BUSCA_MIN, max: LIMITES.BUSCA_MAX, campo: 'busca' })
    if (!r.ok) return r
    // ÚNICO lugar do módulo que apara as bordas, e é de propósito. O `validarTexto` preserva o
    // valor byte a byte porque a busca de PRODUTO casa trecho e a correspondência exata depende
    // do que foi enviado. Cliente é outra semântica: o ERP casa por PREFIXO
    // (`dbo.Clientes`, `Latin1_General_CI_AI` — `docs/wm/04-contratos-api.md`), então um espaço
    // à esquerda torna o prefixo impossível e devolve zero resultado SEM dizer por quê. Nome
    // colado da conversa quase sempre vem com borda. Aparar aqui é a diferença entre achar e
    // não achar; o miolo e a caixa continuam intocados.
    value.busca = r.value.trim()
  } else {
    // Código de cliente usa o teto de 20 do `cliente_codigo_erp` de `criar`, não o de 7 dos
    // produtos: são numerações diferentes no ERP. Também aparado — o ERP casa por igualdade.
    const r = validarTexto(body.codigo_cliente_erp, { min: LIMITES.CODIGO_ERP_MIN, max: LIMITES.CODIGO_ERP_MAX, campo: 'codigo_cliente_erp' })
    if (!r.ok) return r
    value.codigo_cliente_erp = r.value.trim()
  }

  if (body.pagina !== undefined) {
    const r = validarPagina(body.pagina, 'pagina')
    if (!r.ok) return r
    value.pagina = r.value
  }

  return { ok: true, value }
}

const CHAVES_PREPARAR = [
  'conversa_id',
  'cliente_codigo_erp',
  'cliente_busca',
  'cliente_pagina',
  'vendedor_codigo_erp',
  'vendedor_busca',
  'vendedor_pagina',
  'itens',
]
/**
 * `preco_negociado` NÃO ENTRA NESTAS LISTAS, e a ausência é deliberada — não esquecimento.
 *
 * O `openapi.yaml` da 2ª remessa (20/10/2026) acrescentou o campo aos itens de `preparar` E de
 * `criar` (schema `PrecoNegociadoOrcamento`), mas o guia da MESMA remessa afirma em §7.1 ("a
 * preparação não aceita preco_confirmado nem preco_negociado") e em §9.1 ("não recebe busca,
 * paginação ou preço negociado") que nenhuma das duas o aceita. A precedência declarada pela WM
 * é o OpenAPI, então isto é divergência real do contrato — registrada como pendência aberta na
 * seção 10 do doc 36.
 *
 * Por que não implementar enquanto a divergência existir: o campo é OPCIONAL, logo não enviá-lo
 * é seguro e concorda com o guia; e o próprio schema avisa que só um "Worker compatível revalida
 * a referência e aplica a negociação". Num Worker antigo o desconto seria **ignorado em
 * silêncio** e o ERP gravaria o preço cheio — inaceitável sem forma de detectar o suporte.
 *
 * Consequência prática: `preco_negociado` é chave desconhecida, e `conferirChaves` recusa chave
 * desconhecida (o `additionalProperties: false` desta camada). Se vier do navegador, é erro de
 * validação — exatamente o comportamento desejado enquanto a negociação não existir de fato.
 */
const CHAVES_ITEM_PREPARAR = ['codigo_produto_erp', 'busca', 'quantidade', 'produto_pagina']

/** `POST /api/orcamentos/preparar`. `conversa_id` é obrigatório: a rota revalida o acesso à
 * conversa por `assertPermissaoConversa` (D9) antes de qualquer chamada externa. */
function validarPrepararBody(body) {
  if (!ehObjetoSimples(body)) return erro('Corpo da requisição inválido')
  const chaves = conferirChaves(body, CHAVES_PREPARAR)
  if (chaves) return chaves

  if (body.conversa_id === undefined) return erro('conversa_id é obrigatório', 'conversa_id')
  const conv = validarConversaId(body.conversa_id)
  if (!conv.ok) return conv

  const umCliente = exigirExatamenteUm(body, 'cliente_codigo_erp', 'cliente_busca')
  if (umCliente) return umCliente
  const umVendedor = exigirExatamenteUm(body, 'vendedor_codigo_erp', 'vendedor_busca')
  if (umVendedor) return umVendedor

  const value = { conversa_id: conv.value }

  if (body.cliente_codigo_erp !== undefined) {
    const r = validarTexto(body.cliente_codigo_erp, { min: LIMITES.CODIGO_ERP_MIN, max: LIMITES.CODIGO_ERP_MAX, campo: 'cliente_codigo_erp' })
    if (!r.ok) return r
    value.cliente_codigo_erp = r.value
  } else {
    const r = validarTexto(body.cliente_busca, { min: LIMITES.BUSCA_MIN, max: LIMITES.BUSCA_MAX, campo: 'cliente_busca' })
    if (!r.ok) return r
    value.cliente_busca = r.value
  }

  if (body.vendedor_codigo_erp !== undefined) {
    const r = validarTexto(body.vendedor_codigo_erp, { min: LIMITES.CODIGO_ERP_MIN, max: LIMITES.CODIGO_ERP_MAX, campo: 'vendedor_codigo_erp' })
    if (!r.ok) return r
    value.vendedor_codigo_erp = r.value
  } else {
    const r = validarTexto(body.vendedor_busca, { min: LIMITES.BUSCA_MIN, max: LIMITES.BUSCA_MAX, campo: 'vendedor_busca' })
    if (!r.ok) return r
    value.vendedor_busca = r.value
  }

  for (const campo of ['cliente_pagina', 'vendedor_pagina']) {
    if (body[campo] !== undefined) {
      const r = validarPagina(body[campo], campo)
      if (!r.ok) return r
      value[campo] = r.value
    }
  }

  const itens = validarItensPreparar(body.itens)
  if (!itens.ok) return itens
  value.itens = itens.value

  return { ok: true, value }
}

function validarItensPreparar(itens) {
  if (!Array.isArray(itens)) return erro('itens deve ser uma lista', 'itens')
  if (itens.length < LIMITES.ITENS_MIN) return erro(`Informe ao menos ${LIMITES.ITENS_MIN} item`, 'itens')
  if (itens.length > LIMITES.ITENS_MAX) return erro(`O orçamento aceita no máximo ${LIMITES.ITENS_MAX} itens`, 'itens')

  const saida = []
  for (let i = 0; i < itens.length; i++) {
    const item = itens[i]
    const ctx = `itens[${i}]`
    if (!ehObjetoSimples(item)) return erro(`${ctx} inválido`, ctx)

    const chaves = conferirChaves(item, CHAVES_ITEM_PREPARAR, ctx)
    if (chaves) return chaves

    // O schema da WM NÃO declara este oneOf — é nosso.
    const um = exigirExatamenteUm(item, 'codigo_produto_erp', 'busca', ctx)
    if (um) return um

    const normalizado = {}
    if (item.codigo_produto_erp !== undefined) {
      const r = validarTexto(item.codigo_produto_erp, { min: LIMITES.CODIGO_PRODUTO_MIN, max: LIMITES.CODIGO_PRODUTO_MAX, campo: `${ctx}.codigo_produto_erp` })
      if (!r.ok) return r
      normalizado.codigo_produto_erp = r.value
    } else {
      const r = validarTexto(item.busca, { min: LIMITES.BUSCA_PRODUTO_MIN, max: LIMITES.BUSCA_PRODUTO_MAX, campo: `${ctx}.busca` })
      if (!r.ok) return r
      normalizado.busca = r.value
    }

    if (item.quantidade === undefined) return erro(`${ctx}.quantidade é obrigatória`, `${ctx}.quantidade`)
    const q = validarDecimalString(item.quantidade, { campo: `${ctx}.quantidade`, exigirPositivo: true })
    if (!q.ok) return q
    normalizado.quantidade = q.value

    if (item.produto_pagina !== undefined) {
      const r = validarPagina(item.produto_pagina, `${ctx}.produto_pagina`)
      if (!r.ok) return r
      normalizado.produto_pagina = r.value
    }

    saida.push(normalizado)
  }
  return { ok: true, value: saida }
}

/** `confirmar` e `verificar` não recebem nada: o estado todo está no servidor (seção 7). */
function validarCorpoVazio(body) {
  if (body === undefined || body === null) return { ok: true, value: {} }
  if (!ehObjetoSimples(body)) return erro('Esta requisição não aceita corpo')
  const chaves = Object.keys(body)
  if (chaves.length === 0) return { ok: true, value: {} }
  const proibida = chaves.find((k) => CAMPOS_PROIBIDOS.includes(k))
  if (proibida) return erro(`Campo não aceito nesta requisição: ${proibida}`, proibida)
  return erro(`Esta requisição não aceita corpo (recebido: ${chaves[0]})`, chaves[0])
}

/* ------------------------------------------------------------------ *
 * 2. Payloads que saem para a WM
 * ------------------------------------------------------------------ */

function validarTelefoneAutorizado(valor) {
  if (typeof valor !== 'string' || valor.trim().length === 0) {
    // Mensagem genérica de propósito: nada que descreva o valor do telefone.
    return erro('Integração da empresa sem contato autorizado', 'telefone')
  }
  if (valor.length < LIMITES.TELEFONE_MIN || valor.length > LIMITES.TELEFONE_MAX) {
    return erro('Contato autorizado da integração fora do formato aceito', 'telefone')
  }
  return { ok: true, value: valor }
}

const CHAVES_PAYLOAD_PREPARAR = [
  'telefone',
  'cliente_codigo_erp',
  'cliente_busca',
  'cliente_pagina',
  'vendedor_codigo_erp',
  'vendedor_busca',
  'vendedor_pagina',
  'bloquear_apos_criar',
  'itens',
]

/**
 * Última conferência do payload de `POST /orcamentos/preparar` antes de gastar a chamada.
 * `bloquear_apos_criar` é OBRIGATÓRIO no contrato (não dá para "não decidir") e precisa ser o
 * mesmo valor usado depois em `criar` — quem monta guarda isso no snapshot (pendência 10).
 */
function validarPayloadPreparar(payload) {
  if (!ehObjetoSimples(payload)) return erro('Payload inválido')
  const chaves = conferirChaves(payload, CHAVES_PAYLOAD_PREPARAR)
  if (chaves) return chaves

  const tel = validarTelefoneAutorizado(payload.telefone)
  if (!tel.ok) return tel

  const umCliente = exigirExatamenteUm(payload, 'cliente_codigo_erp', 'cliente_busca')
  if (umCliente) return umCliente
  const umVendedor = exigirExatamenteUm(payload, 'vendedor_codigo_erp', 'vendedor_busca')
  if (umVendedor) return umVendedor

  if (typeof payload.bloquear_apos_criar !== 'boolean') {
    return erro('bloquear_apos_criar é obrigatório e booleano', 'bloquear_apos_criar')
  }

  const itens = validarItensPreparar(payload.itens)
  if (!itens.ok) return itens

  const value = { telefone: tel.value, bloquear_apos_criar: payload.bloquear_apos_criar, itens: itens.value }
  for (const campo of ['cliente_codigo_erp', 'cliente_busca', 'vendedor_codigo_erp', 'vendedor_busca']) {
    if (payload[campo] === undefined) continue
    const limites = campo.endsWith('_codigo_erp')
      ? { min: LIMITES.CODIGO_ERP_MIN, max: LIMITES.CODIGO_ERP_MAX }
      : { min: LIMITES.BUSCA_MIN, max: LIMITES.BUSCA_MAX }
    const r = validarTexto(payload[campo], { ...limites, campo })
    if (!r.ok) return r
    value[campo] = r.value
  }
  for (const campo of ['cliente_pagina', 'vendedor_pagina']) {
    if (payload[campo] === undefined) continue
    const r = validarPagina(payload[campo], campo)
    if (!r.ok) return r
    value[campo] = r.value
  }
  return { ok: true, value }
}

const CHAVES_PAYLOAD_CRIAR = [
  'telefone',
  'comando_id',
  'cliente_codigo_erp',
  'vendedor_codigo_erp',
  'bloquear_apos_criar',
  'itens',
]
const CHAVES_ITEM_CRIAR = ['codigo_produto_erp', 'quantidade', 'preco_confirmado']
// `preco_negociado` fica fora aqui pelo mesmo motivo registrado junto de CHAVES_ITEM_PREPARAR.
const PADRAO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Conferência do payload de `POST /orcamentos/criar` — o único que ESCREVE no ERP.
 *
 * Validar aqui é defesa em profundidade: este payload é montado pelo servidor a partir do
 * snapshot (seção 7), nunca do navegador, e uma vez despachado não pode ser repetido. Um erro
 * de formato que a WM recusasse com 400 depois do despacho já teria consumido o `comando_id`.
 *
 * O valor devolvido é o mesmo que entrou, campo por campo: `preco_confirmado` não passa por
 * nenhuma transformação.
 */
function validarPayloadCriar(payload) {
  if (!ehObjetoSimples(payload)) return erro('Payload inválido')
  const chaves = conferirChaves(payload, CHAVES_PAYLOAD_CRIAR)
  if (chaves) return chaves

  const tel = validarTelefoneAutorizado(payload.telefone)
  if (!tel.ok) return tel

  if (typeof payload.comando_id !== 'string' || !PADRAO_UUID.test(payload.comando_id)) {
    return erro('comando_id inválido', 'comando_id')
  }

  const cliente = validarTexto(payload.cliente_codigo_erp, { min: LIMITES.CODIGO_ERP_MIN, max: LIMITES.CODIGO_ERP_MAX, campo: 'cliente_codigo_erp' })
  if (!cliente.ok) return cliente
  const vendedor = validarTexto(payload.vendedor_codigo_erp, { min: LIMITES.CODIGO_ERP_MIN, max: LIMITES.CODIGO_ERP_MAX, campo: 'vendedor_codigo_erp' })
  if (!vendedor.ok) return vendedor

  if (payload.bloquear_apos_criar !== undefined && typeof payload.bloquear_apos_criar !== 'boolean') {
    return erro('bloquear_apos_criar deve ser booleano', 'bloquear_apos_criar')
  }

  if (!Array.isArray(payload.itens)) return erro('itens deve ser uma lista', 'itens')
  if (payload.itens.length < LIMITES.ITENS_MIN) return erro(`Informe ao menos ${LIMITES.ITENS_MIN} item`, 'itens')
  if (payload.itens.length > LIMITES.ITENS_MAX) return erro(`O orçamento aceita no máximo ${LIMITES.ITENS_MAX} itens`, 'itens')

  const itens = []
  for (let i = 0; i < payload.itens.length; i++) {
    const item = payload.itens[i]
    const ctx = `itens[${i}]`
    if (!ehObjetoSimples(item)) return erro(`${ctx} inválido`, ctx)

    const extras = Object.keys(item).filter((k) => !CHAVES_ITEM_CRIAR.includes(k))
    if (extras.length) return erro(`Campo desconhecido: ${ctx}.${extras[0]}`, `${ctx}.${extras[0]}`)

    const cod = validarTexto(item.codigo_produto_erp, { min: LIMITES.CODIGO_PRODUTO_MIN, max: LIMITES.CODIGO_PRODUTO_MAX, campo: `${ctx}.codigo_produto_erp` })
    if (!cod.ok) return cod

    const q = validarDecimalString(item.quantidade, { campo: `${ctx}.quantidade`, exigirPositivo: true })
    if (!q.ok) return q

    // Preço pode ser zero pelo contrato (o padrão aceita `0`); só quantidade é que não pode.
    const p = validarDecimalString(item.preco_confirmado, { campo: `${ctx}.preco_confirmado`, exigirPositivo: false })
    if (!p.ok) return p

    itens.push({ codigo_produto_erp: cod.value, quantidade: q.value, preco_confirmado: p.value })
  }

  const value = {
    telefone: tel.value,
    comando_id: payload.comando_id,
    cliente_codigo_erp: cliente.value,
    vendedor_codigo_erp: vendedor.value,
    itens,
  }
  if (payload.bloquear_apos_criar !== undefined) value.bloquear_apos_criar = payload.bloquear_apos_criar
  return { ok: true, value }
}

module.exports = {
  LIMITES,
  CAMPOS_PROIBIDOS,
  PADRAO_DECIMAL,
  validarConsultarProdutosBody,
  validarConsultarClientesBody,
  validarPrepararBody,
  validarCorpoVazio,
  validarPayloadPreparar,
  validarPayloadCriar,
  // expostos para teste e reuso interno
  validarTelefoneAutorizado,
  validarDecimalString,
  validarPagina,
  validarConversaId,
}
