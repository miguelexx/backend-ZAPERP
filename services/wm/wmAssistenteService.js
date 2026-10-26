'use strict'

const wmApiClient = require('./wmApiClient')
const wmConsultaCache = require('./wmConsultaCache')
const configService = require('./wmIntegrationConfigService')
const { mapearErroWm, OPERACAO, CODIGOS } = require('../../helpers/wmErrorMapper')
const { LIMITES } = require('../../validators/wmOrcamentosValidators')

/**
 * Leitura do Assistente WM para o orçamento manual — Sessão 3A do doc 36.
 *
 * Esta é a camada que resolve a IDENTIDADE da empresa. É aqui, e só aqui, que o
 * `company_id` do JWT se transforma no `telefone` que a WM usa como seletor de tenant:
 *
 *   req.user.company_id → wm_orcamento_integracoes (mesma company_id) → telefone_autorizado → WM
 *
 * Por que isso é o ponto mais sensível do módulo: `docs/wm/09-seguranca.md` declara que o
 * Bearer do ZapERP **não restringe a credencial a uma única empresa** e que a WM confia em nós
 * para informar o telefone certo (pendência 13 da seção 10 do doc 36). Ou seja: o telefone é o
 * ÚNICO seletor de empresa e a WM não tem nenhuma defesa se o errado for enviado. O isolamento
 * entre empresas desta integração é inteiramente responsabilidade do ZapERP, e mora nestas
 * linhas. Três regras que não se negociam:
 *
 *   1. `company_id` vem do JWT. Esta função recebe `company_id` como argumento e NUNCA lê body,
 *      query ou header — ela não tem acesso ao `req`.
 *   2. O telefone é resolvido no servidor a partir desse `company_id`. O navegador não envia,
 *      não recebe e não consegue influenciar esse valor: `telefone` está em `CAMPOS_PROIBIDOS`
 *      do validador, então um body que o traga é recusado antes de chegar aqui.
 *   3. A chave do cache carrega `company_id` + a versão da config. Cache sem `company_id`
 *      vazaria catálogo entre empresas tão bem quanto uma query sem filtro.
 *
 * O QUE SAI DAQUI PARA A UI é uma projeção com lista branca de campos, nunca a resposta crua —
 * e a lista branca é DIFERENTE nos dois ramos, porque o contrato também é:
 *
 *   · **lista** (`multiplos_produtos`): pelo contrato, APENAS `codigo_produto_erp`,
 *     `descricao`, `marca` e `unidade` — **sem preço e sem estoque** — e a descoberta de
 *     candidatos vem do **cache cloud** da WM (`docs/wm/04-contratos-api.md`). Nada aqui
 *     inventa preço ou estoque, e nada é rotulado como "atual": `candidatos_origem:
 *     'cache_cloud'` sai junto justamente para a tela não poder escrever "estoque atual".
 *     Se um dia a WM mandar preço nesta lista, a lista branca o DESCARTA.
 *   · **resolvido** (`produto`): medido no ERP real em 22/10, a WM devolve aqui
 *     `preco_unitario`, `estoque_previsto`, `ativo`, `codigo_barras`, `codigo_fabricante`,
 *     `grupo` e `subgrupo`, com `meta.fonte: 'tempo_real'`. Esse dado já chegava e era
 *     descartado, e a atendente escolhia o produto sem ver preço nem estoque. Agora atravessa
 *     — como STRING, byte a byte, sem recálculo e sem reformatação (§8.1 do guia) — e a
 *     procedência vai no `meta`: `cache_cloud` jamais pode ser falado como "atual".
 *
 * Reaproveitar o preço do resolvido para os itens da lista seria inventar dado, e é proibido:
 * card sem preço é card sem preço.
 *
 * CORRESPONDÊNCIA EXATA QUE ESCONDE OS IRMÃOS — ver
 * `revelarIrmaosDaCorrespondenciaExata`. Resumo: `filtro` devolvia 1 produto e `filtr`, 468.
 *
 * Página além da última é `400 PAGINA_FORA_DO_INTERVALO` e atravessa como 400: sem clamp, sem
 * "corrigir" para a última página, nem aqui nem na resposta ao frontend. O contrato é explícito
 * em não corrigir silenciosamente, e corrigir faria o atendente achar que viu o fim da lista.
 *
 * Nada de `limite` (obsoleto e ignorado pela WM) e nada de `tamanho_pagina` (fixo em 30 do
 * lado dela, recusado na entrada).
 */

/** Identificador curto do endpoint na chave do cache. */
const ENDPOINT_PRODUTOS = 'produtos/consultar'

/**
 * Origem dos candidatos deste endpoint, fixada pelo contrato: a descoberta é do cache cloud da
 * WM, que "pode estar defasado" (`docs/wm/04-contratos-api.md`). Viaja até a UI para que a tela
 * NÃO possa apresentar isso como dado atual.
 */
const CANDIDATOS_ORIGEM = 'cache_cloud'

/**
 * Mínimo de caracteres do termo encurtado que revela os irmãos escondidos. Mesmo piso do
 * picker: abaixo disso a busca deixa de ter intenção e passa a varrer o catálogo.
 */
const BUSCA_IRMAOS_MIN = 3

/** Teto defensivo do `meta` repassado (o contrato não o modela: é só `type: object`). */
const META_MAX_CHAVES = 20
const META_MAX_TAMANHO_VALOR = 200

function ehObjetoSimples(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Erro local no formato que o controller já sabe responder. Reusa o mapeador para que a UI veja
 * sempre o mesmo envelope, venha o problema da WM ou da nossa configuração.
 */
function erroLocal({ motivo, requestId }) {
  const { envelope, interno } = mapearErroWm({
    resultado: { configuracaoInvalida: motivo, operacao: OPERACAO.LEITURA },
    operacao: OPERACAO.LEITURA,
    requestId,
  })
  return { ok: false, httpStatus: interno.httpStatusLocal, envelope, interno }
}

function erroDeResultado({ resultado, requestId }) {
  const { envelope, interno } = mapearErroWm({ resultado, operacao: OPERACAO.LEITURA, requestId })
  return { ok: false, httpStatus: interno.httpStatusLocal, envelope, interno }
}

/**
 * Resolve o contato autorizado da empresa. Lê a linha interna (que contém o segredo) e devolve
 * só o que esta camada precisa: o telefone, para o payload, e o `atualizado_em`, para a chave do
 * cache. Nada disso sobe para o controller — o controller nunca vê o telefone.
 */
async function resolverContatoAutorizado(companyId) {
  const row = await configService.obterConfigInterna(companyId)
  if (!row) return { erro: 'integracao_empresa_ausente' }
  if (!row.ativo) return { erro: 'integracao_empresa_inativa' }

  const telefone = String(row.telefone_autorizado ?? '').trim()
  if (!telefone) return { erro: 'telefone_autorizado_ausente' }
  // Mesmos limites do `ConsultarProduto.telefone` do openapi.yaml (8–30). Validar aqui evita
  // gastar chamada num vínculo mal provisionado — e a mensagem de erro jamais cita o valor.
  if (telefone.length < LIMITES.TELEFONE_MIN || telefone.length > LIMITES.TELEFONE_MAX) {
    return { erro: 'telefone_autorizado_invalido' }
  }
  return { telefone, configVersao: String(row.atualizado_em ?? '') }
}

/**
 * Normalização usada APENAS para comparar o termo pesquisado com a descrição devolvida — ela
 * nunca toca no que é enviado à WM nem na chave do cache (lá o termo vai exatamente como
 * digitado, de propósito; ver `wmConsultaCache`).
 *
 * Espelha o que a WM faz na correspondência: `docs/wm/04-contratos-api.md` diz que descrição e
 * marca casam "sem diferenciar caixa e os acentos portugueses mapeados por
 * `translate(lower(...))`", e que a correspondência exata de produto mantém
 * Trim/OrdinalIgnoreCase. Daí: minúsculas, acentos removidos, espaços colapsados e aparados.
 */
function normalizarParaComparacao(texto) {
  if (typeof texto !== 'string') return ''
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Texto curto e sem byte nulo, ou null. `descricao`/`marca`/`unidade` são nullable no contrato. */
function textoOpcional(valor) {
  if (valor === null || valor === undefined) return null
  if (typeof valor !== 'string') return null
  const limpo = valor.replace(/\u0000/g, '')
  return limpo.length ? limpo : null
}

/**
 * Lista branca de um produto. É esta função que garante que preço e estoque NÃO passam: o que
 * não está escrito aqui não sai daqui, por mais que a WM mande.
 * @returns {object|null} null quando falta o código (sem código não há como selecionar)
 */
function projetarProduto(p) {
  if (!ehObjetoSimples(p)) return null
  const codigo = typeof p.codigo_produto_erp === 'string' ? p.codigo_produto_erp.trim() : ''
  if (!codigo) return null
  return {
    codigo_produto_erp: codigo,
    descricao: textoOpcional(p.descricao),
    marca: textoOpcional(p.marca),
    unidade: textoOpcional(p.unidade),
  }
}

/**
 * Decimal textual da WM, repassado BYTE A BYTE. Preço é `0.00##` invariant e estoque é
 * `0.000` invariant com negativo permitido — e a regra de ouro do módulo é não recalcular nem
 * reformatar (§8.1 do guia). Número, notação científica, vírgula decimal ou texto livre viram
 * `null`, e `null` a tela imprime como "—", nunca como zero.
 */
function decimalTextual(valor) {
  if (typeof valor !== 'string') return null
  const limpo = valor.trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(limpo)) return null
  return limpo
}

/**
 * Lista branca do produto RESOLVIDO (`dados.status === 'produto'`).
 *
 * Medido ao vivo em 22/10 contra o ERP da empresa 20: quando a WM resolve, ela devolve muito
 * mais do que a lista de candidatos — `preco_unitario`, `estoque_previsto`, `ativo`,
 * `codigo_barras`, `codigo_fabricante`, `grupo`, `subgrupo` — com `meta.fonte: 'tempo_real'`.
 * Esse dado já chegou e era descartado aqui, então a atendente escolhia o produto sem ver
 * preço nem estoque. Agora passa, e continua sendo lista branca: o que não está escrito aqui
 * não sai daqui.
 *
 * Isto **não** vale para a lista (`multiplos_produtos`): ali o contrato dá só os 4 campos, e
 * inventar preço para o resto da lista — ou reaproveitar o do resolvido — seria mentira. Card
 * sem preço é card sem preço.
 *
 * A procedência viaja junto, no `meta` da resposta: `tempo_real` pode ser falado como agora,
 * `cache_cloud` **nunca** pode ser rotulado como atual.
 */
/**
 * Instante ISO-8601, ou null. Validado de verdade (`Date.parse`) e **reemitido** pelo próprio
 * `Date`, para que nenhuma string arbitrária da origem atravesse como se fosse data.
 */
function instanteIso(valor) {
  if (typeof valor !== 'string') return null
  const t = Date.parse(valor.trim())
  if (!Number.isFinite(t)) return null
  return new Date(t).toISOString()
}

function projetarProdutoResolvido(p) {
  const base = projetarProduto(p)
  if (!base) return null
  return {
    ...base,
    codigo_barras: textoOpcional(p.codigo_barras),
    codigo_fabricante: textoOpcional(p.codigo_fabricante),
    grupo: textoOpcional(p.grupo),
    subgrupo: textoOpcional(p.subgrupo),
    preco_unitario: decimalTextual(p.preco_unitario),
    estoque_previsto: decimalTextual(p.estoque_previsto),
    // `ativo` só atravessa como booleano de verdade: consulta por código explícito pode trazer
    // produto inativo (contrato), e "indefinido" não pode virar "ativo" por omissão.
    ativo: typeof p.ativo === 'boolean' ? p.ativo : null,
    // QUÃO VELHO É O NÚMERO QUE ESTAMOS MOSTRANDO.
    //
    // `meta.fonte: "tempo_real"` diz que a CONSULTA foi ao vivo — não que o valor seja de agora.
    // Medido em 26/10/2026 na base da MARGRE: a mediana de `estoque_sincronizado_em` era de
    // **86,4 h** (3,6 dias), com alguns produtos em 0,1 h. Ou seja, o atendente vê "352,5 em
    // estoque" sem saber se isso é de seis minutos ou de três dias atrás, e promete prazo em
    // cima disso. A API sempre soube a idade; nós é que a descartávamos.
    //
    // São dois carimbos distintos e não intercambiáveis: um é do SALDO, outro do CADASTRO
    // (descrição, preço, grupo). Quem exibe decide o que fazer com cada um.
    estoque_sincronizado_em: instanteIso(p.estoque_sincronizado_em),
    sincronizado_em: instanteIso(p.sincronizado_em),
  }
}

/**
 * Paginação, se vier no formato do contrato (`PaginacaoConsulta`: os 5 campos obrigatórios).
 *
 * Fora do formato → `null`, e o chamador segue com a lista mas sem navegação. É leniente de
 * propósito: o rollout da WM é "Worker primeiro, API depois", então existe a janela em que a
 * paginação ainda não está implantada (confirmar isso é item da Sessão 3B). Preferimos a lista
 * da página 1 sem botões a um módulo quebrado — o que NÃO fazemos é inventar `tem_mais`.
 */
function projetarPaginacao(pag) {
  if (!ehObjetoSimples(pag)) return null
  const { pagina, tamanho_pagina, total, tem_mais, tem_anterior } = pag
  if (!Number.isInteger(pagina) || pagina < 1) return null
  if (!Number.isInteger(tamanho_pagina) || tamanho_pagina < 1) return null
  if (!Number.isInteger(total) || total < 0) return null
  if (typeof tem_mais !== 'boolean' || typeof tem_anterior !== 'boolean') return null
  return { pagina, tamanho_pagina, total, tem_mais, tem_anterior }
}

/**
 * `meta` defensivo. O `openapi.yaml` declara `meta: { type: object }` e nada mais — sem
 * contrato para `fonte` nem `sincronizado_em` (fragilidade registrada na seção 10 do doc 36).
 * Então: só objeto simples, só escalares no topo, chave e valor com teto, e `telefoneProibido`
 * removido por paranoia (o telefone autorizado não deveria voltar da WM; se voltar, não passa).
 * Vindo vazio ou ausente, devolve `null` e nada quebra.
 */
function projetarMeta(meta, telefoneProibido) {
  if (!ehObjetoSimples(meta)) return null
  const saida = {}
  let n = 0
  for (const [chave, valor] of Object.entries(meta)) {
    if (n >= META_MAX_CHAVES) break
    if (!/^[A-Za-z0-9_]{1,40}$/.test(chave)) continue
    if (valor === null) { saida[chave] = null; n++; continue }
    const t = typeof valor
    if (t === 'number' && Number.isFinite(valor)) { saida[chave] = valor; n++; continue }
    if (t === 'boolean') { saida[chave] = valor; n++; continue }
    if (t === 'string') {
      if (valor.length > META_MAX_TAMANHO_VALOR) continue
      if (telefoneProibido && valor.includes(telefoneProibido)) continue
      saida[chave] = valor.replace(/\u0000/g, '')
      n++
    }
    // objeto/array/função no `meta`: descartado. Nada aninhado atravessa sem contrato.
  }
  return Object.keys(saida).length ? saida : null
}

/**
 * Traduz a resposta de `/produtos/consultar` na forma que a UI consome.
 *
 * Dois ramos, e a diferença entre eles é contratual:
 *
 *   · **ambíguo** — `dados.status === 'multiplos_produtos'` com `produtos[]` e `paginacao`.
 *     É o caminho principal do picker por nome, e é o único totalmente modelado no OpenAPI.
 *   · **resolvido** — a WM diz que "produto resolvido mantém a resposta cache/realtime
 *     anterior", e essa resposta anterior **não está no `openapi.yaml`**. Procuramos o produto
 *     nos dois lugares plausíveis (`dados.produto` e o próprio `dados`) e, não reconhecendo a
 *     forma, devolvemos `respostaInvalida` em vez de adivinhar campo. Não inventar aqui é
 *     deliberado: a forma exata é conferência da Sessão 3B contra a WM real.
 *
 * @returns {{ ok: true, dados: object }|{ ok: false, respostaInvalida: true }}
 */
function projetarRespostaProdutos(data, telefoneProibido) {
  if (!ehObjetoSimples(data)) return { ok: false, respostaInvalida: true }
  const dados = data.dados
  if (!ehObjetoSimples(dados)) return { ok: false, respostaInvalida: true }

  const meta = projetarMeta(data.meta, telefoneProibido)

  if (dados.status === 'multiplos_produtos') {
    if (!Array.isArray(dados.produtos)) return { ok: false, respostaInvalida: true }
    const produtos = []
    for (const bruto of dados.produtos) {
      const p = projetarProduto(bruto)
      // Candidato sem código não é selecionável. Descartar em silêncio esconderia uma mudança
      // de contrato e deixaria a lista com buraco — melhor recusar a resposta inteira.
      if (!p) return { ok: false, respostaInvalida: true }
      produtos.push(p)
    }
    return {
      ok: true,
      dados: {
        status: 'multiplos_produtos',
        produtos,
        paginacao: projetarPaginacao(dados.paginacao),
        candidatos_origem: CANDIDATOS_ORIGEM,
        meta,
      },
    }
  }

  const resolvido = projetarProdutoResolvido(dados.produto) || projetarProdutoResolvido(dados)
  if (resolvido) {
    return {
      ok: true,
      dados: {
        status: 'produto',
        produto: resolvido,
        paginacao: null,
        candidatos_origem: CANDIDATOS_ORIGEM,
        meta,
      },
    }
  }

  return { ok: false, respostaInvalida: true }
}

/**
 * Uma página de candidatos, com cache e coalescência. É o único lugar que fala com a WM neste
 * arquivo — tanto a consulta que o atendente pediu quanto a que revela os irmãos escondidos
 * passam por aqui, e portanto pelo MESMO cache e pela MESMA coalescência.
 *
 * @returns {Promise<{ ok: true, dados: object, origem_resposta: string }|{ ok: false, httpStatus: number, envelope: object, interno: object }>}
 */
async function buscarPaginaDeProdutos({ cid, contato, modo, termo, pagina, requestId }) {
  // Payload da WM: o telefone PRIMEIRO, resolvido no servidor, e só os campos validados.
  // Nenhuma chave extra — nem `limite` (obsoleto/ignorado), nem `tamanho_pagina` (não aceito).
  const payload = { telefone: contato.telefone }
  if (modo === 'busca') payload.busca = termo
  else payload.codigo_produto_erp = termo
  if (pagina !== undefined) payload.pagina = pagina

  const chave = wmConsultaCache.montarChave({
    companyId: cid,
    configVersao: contato.configVersao,
    endpoint: ENDPOINT_PRODUTOS,
    modo,
    termo,
    pagina,
  })

  const { valor, origem } = await wmConsultaCache.resolverComCoalescencia(
    chave,
    async () => {
      const resultado = await wmApiClient.consultarProdutos(payload)
      if (!resultado.ok) return erroDeResultado({ resultado, requestId })

      const projetado = projetarRespostaProdutos(resultado.data, contato.telefone)
      if (!projetado.ok) {
        // 2xx com forma fora do contrato: trata como resposta inválida, nunca como lista vazia.
        return erroDeResultado({
          resultado: { ...resultado, ok: false, respostaInvalida: true },
          requestId,
        })
      }
      return { ok: true, dados: projetado.dados }
    },
    // Só sucesso entra no cache. Erro cacheado transformaria uma falha de 1 s em 3 min.
    (v) => Boolean(v && v.ok === true),
  )

  if (!valor || valor.ok !== true) {
    // O erro já vem no envelope do mapeador; `requestId` do primeiro requisitante é preservado
    // em respostas coalescidas, e isso é aceitável: o log server-side correlaciona pelo mesmo id.
    return valor || erroLocal({ motivo: 'resposta_ausente', requestId })
  }

  return { ok: true, dados: valor.dados, origem_resposta: origem }
}

/**
 * Revela os produtos que a correspondência exata escondeu.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * O PROBLEMA, MEDIDO NO ERP REAL DA EMPRESA 20 (22/10)
 * ────────────────────────────────────────────────────────────────────────────
 *   busca `filtro`   → 1 produto (status `produto`)   ·  busca `filtr`   → 468
 *   busca `parafuso` → 1 produto (status `produto`)   ·  busca `parafus` → 285
 *
 * O contrato explica: *"uma única correspondência exata global de descrição normalizada ou
 * identificador também pode resolver"* (`docs/wm/04-contratos-api.md`). Existe um produto
 * chamado literalmente "FILTRO", então a WM resolve nele e **não lista** os outros 467 que
 * contêm a palavra. Para a atendente, o sistema parecia não puxar todos os produtos.
 *
 * A correção: ao detectar exatamente esse caso, consultar de novo com o termo encurtado em um
 * caractere e devolver a lista inteira, com o produto exato em primeiro e marcado.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * QUANDO **NÃO** DISPARA — e por quê
 * ────────────────────────────────────────────────────────────────────────────
 *   · o termo apenas APARECE na descrição (`cimento` → "CIMENTO CAMPEAO AZUL CP 2 E 32 50KG"):
 *     aí a WM resolveu porque o resultado é único de verdade, não há irmão escondido, e gastar
 *     chamada seria desperdício. Medido: `piso` devolve 1 e é esse caso;
 *   · consulta por código (`codigo_produto_erp`): casa por igualdade, não por trecho;
 *   · termo encurtado com menos de `BUSCA_IRMAOS_MIN` caracteres;
 *   · a segunda consulta falha, volta vazia, resolve de novo ou não acrescenta ninguém.
 *
 * Em todos esses casos devolve `null` e o chamador responde o resultado ORIGINAL. A melhoria
 * nunca pode piorar o caso que já funciona — inclusive se a segunda chamada lançar.
 *
 * @returns {Promise<object|null>} resposta expandida, ou `null` para manter a original
 */
async function revelarIrmaosDaCorrespondenciaExata({ cid, contato, busca, pagina, resultado, requestId }) {
  const dados = resultado?.dados
  if (!dados || dados.status !== 'produto' || !dados.produto) return null

  const termo = String(busca).trim()
  const alvo = normalizarParaComparacao(termo)
  if (!alvo) return null
  // O caso patológico é EXATAMENTE este: o termo digitado É a descrição do produto.
  if (normalizarParaComparacao(dados.produto.descricao) !== alvo) return null

  const encurtado = termo.slice(0, -1).trim()
  if (encurtado.length < BUSCA_IRMAOS_MIN) return null

  let segunda = null
  try {
    segunda = await buscarPaginaDeProdutos({ cid, contato, modo: 'busca', termo: encurtado, pagina, requestId })
  } catch {
    // Exceção de transporte na consulta EXTRA não derruba a resposta que já temos.
    return null
  }
  if (!segunda || segunda.ok !== true) return null

  const lista = segunda.dados
  if (!lista || lista.status !== 'multiplos_produtos' || !Array.isArray(lista.produtos)) return null
  if (lista.produtos.length === 0) return null

  const exato = dados.produto
  const outros = lista.produtos.filter((p) => p.codigo_produto_erp !== exato.codigo_produto_erp)
  if (outros.length === 0) return null

  // Página > 1: a lista é a continuação do termo encurtado e o exato já apareceu na primeira.
  // Repeti-lo no topo da página 2 faria parecer que ele existe duas vezes no catálogo.
  const primeiraPagina = pagina === undefined || pagina === 1
  if (!primeiraPagina) {
    return {
      ok: true,
      dados: { ...lista, termo_dos_outros: encurtado },
      origem_resposta: resultado.origem_resposta,
    }
  }

  return {
    ok: true,
    dados: {
      status: 'multiplos_produtos',
      // Lista única para quem só sabe ler `produtos` — o exato sempre em primeiro.
      produtos: [exato, ...outros],
      // E os dois grupos nomeados, para a tela não precisar adivinhar qual é qual.
      correspondencia_exata: exato,
      // A procedência do EXATO é a da primeira resposta (de onde vêm o preço e o estoque dele);
      // a do `meta` abaixo é a da lista. Misturar as duas rotularia o preço com a fonte errada.
      correspondencia_exata_meta: dados.meta,
      outros_com_a_palavra: outros,
      termo_dos_outros: encurtado,
      paginacao: lista.paginacao,
      candidatos_origem: CANDIDATOS_ORIGEM,
      meta: lista.meta,
    },
    origem_resposta: resultado.origem_resposta,
  }
}

/**
 * Consulta candidatos de produto na WM.
 *
 * @param {object} args
 * @param {number} args.company_id  **sempre** de `req.user.company_id`
 * @param {object} args.consulta    saída de `validarConsultarProdutosBody` (busca XOR código, pagina)
 * @param {string} [args.requestId] correlação de log
 * @returns {Promise<{ ok: true, dados: object, origem_resposta: string }|{ ok: false, httpStatus: number, envelope: object, interno: object }>}
 */
async function consultarProdutos({ company_id, consulta, requestId } = {}) {
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) {
    // Não deveria acontecer: `auth` já exige company_id no token. Se acontecer, é bug local —
    // e um bug local não pode virar chamada externa com tenant indefinido.
    return erroLocal({ motivo: 'company_id_invalido', requestId })
  }
  if (!ehObjetoSimples(consulta)) return erroLocal({ motivo: 'consulta_invalida', requestId })

  const temBusca = typeof consulta.busca === 'string' && consulta.busca.length > 0
  const temCodigo = typeof consulta.codigo_produto_erp === 'string' && consulta.codigo_produto_erp.length > 0
  if (temBusca === temCodigo) return erroLocal({ motivo: 'consulta_invalida', requestId })

  const contato = await resolverContatoAutorizado(cid)
  if (contato.erro) return erroLocal({ motivo: contato.erro, requestId })

  const resultado = await buscarPaginaDeProdutos({
    cid,
    contato,
    modo: temBusca ? 'busca' : 'codigo',
    termo: temBusca ? consulta.busca : consulta.codigo_produto_erp,
    pagina: consulta.pagina,
    requestId,
  })
  if (!resultado.ok || !temBusca) return resultado

  const expandido = await revelarIrmaosDaCorrespondenciaExata({
    cid,
    contato,
    busca: consulta.busca,
    pagina: consulta.pagina,
    resultado,
    requestId,
  })
  return expandido || resultado
}

/* ================================================================== *
 * Clientes — AUXÍLIO DE BUSCA, não autoridade de resolução
 *
 * A decisão D11 do doc 36 continua valendo: quem resolve o cliente do orçamento é `preparar`.
 * Esta consulta existe porque a busca de cliente do ERP é **por prefixo**
 * (`dbo.Clientes`, `Latin1_General_CI_AI`, conforme `docs/wm/04-contratos-api.md`), e isso é
 * invisível para quem digita: "SILVA" não encontra "JOSE DA SILVA", e o atendente conclui que o
 * cliente não está cadastrado. Medido: `DINIZ` → nenhum, `SILVA` → nenhum,
 * `MARIA APARECIDA AMADEI` → 3 candidatos.
 *
 * O que ela NÃO pode virar: a palavra final sobre o cliente. `/clientes/consultar` não aplica
 * Inativo/Bloqueado e `preparar` aplica — então um cliente listado aqui ainda pode ser recusado
 * no Calcular com `CLIENTE_INVALIDO`. Quem chama precisa deixar isso claro na tela.
 * ================================================================== */

/** Identificador curto do endpoint na chave do cache. Separado do de produtos de propósito. */
const ENDPOINT_CLIENTES = 'clientes/consultar'

/**
 * Lista branca de um candidato de cliente. Os campos são os do contrato
 * (`CandidatoCliente`): código, nome e os documentos que distinguem homônimos — sem eles, duas
 * "MARIA SILVA" são indistinguíveis na tela e o atendente escolhe no escuro.
 *
 * @returns {object|null} null quando falta código ou nome (sem os dois não há como escolher)
 */
function projetarCliente(c) {
  if (!ehObjetoSimples(c)) return null
  const codigo = typeof c.codigo_cliente_erp === 'string' ? c.codigo_cliente_erp.trim() : ''
  const nome = typeof c.nome === 'string' ? c.nome.trim() : ''
  if (!codigo || !nome) return null
  return {
    codigo_cliente_erp: codigo,
    nome,
    cpf: textoOpcional(c.cpf),
    cnpj: textoOpcional(c.cnpj),
    inscricao_estadual: textoOpcional(c.inscricao_estadual),
  }
}

/**
 * Traduz `/clientes/consultar` na forma que a UI consome. Dois ramos, ambos no `openapi.yaml`
 * (`ConsultarClientesResposta`), ao contrário do irmão de produtos:
 *
 *   · `multiplos_clientes` — `candidatos[]` + `paginacao`;
 *   · `cliente`            — `cliente` único já resolvido.
 *
 * @returns {{ ok: true, dados: object }|{ ok: false, respostaInvalida: true }}
 */
function projetarRespostaClientes(data, telefoneProibido) {
  if (!ehObjetoSimples(data)) return { ok: false, respostaInvalida: true }
  const dados = data.dados
  if (!ehObjetoSimples(dados)) return { ok: false, respostaInvalida: true }

  const meta = projetarMeta(data.meta, telefoneProibido)

  if (dados.status === 'multiplos_clientes') {
    if (!Array.isArray(dados.candidatos)) return { ok: false, respostaInvalida: true }
    const candidatos = []
    for (const bruto of dados.candidatos) {
      const c = projetarCliente(bruto)
      // Mesma regra do picker de produtos: candidato inselecionável não é descartado em
      // silêncio — recusamos a resposta inteira, para que mudança de contrato apareça.
      if (!c) return { ok: false, respostaInvalida: true }
      candidatos.push(c)
    }
    return {
      ok: true,
      dados: {
        status: 'multiplos_clientes',
        candidatos,
        paginacao: projetarPaginacao(dados.paginacao),
        // O ERP não filtra Inativo/Bloqueado nesta rota: a tela precisa saber que a palavra
        // final é do `preparar`, e não pode apresentar isto como escolha fechada.
        resolucao_definitiva: false,
        meta,
      },
    }
  }

  if (dados.status === 'cliente') {
    const cliente = projetarCliente(dados.cliente)
    if (!cliente) return { ok: false, respostaInvalida: true }
    return {
      ok: true,
      dados: {
        status: 'cliente',
        cliente,
        paginacao: null,
        resolucao_definitiva: false,
        meta,
      },
    }
  }

  return { ok: false, respostaInvalida: true }
}

/**
 * Consulta candidatos de cliente na WM. Mesmo cache e mesma coalescência dos produtos — chave
 * distinta pelo `ENDPOINT_CLIENTES`, então as duas consultas nunca se contaminam.
 *
 * @param {object} args
 * @param {number} args.company_id  **sempre** de `req.user.company_id`
 * @param {object} args.consulta    saída de `validarConsultarClientesBody` (busca XOR código, pagina)
 * @param {string} [args.requestId] correlação de log
 * @returns {Promise<{ ok: true, dados: object, origem_resposta: string }|{ ok: false, httpStatus: number, envelope: object, interno: object }>}
 */
async function consultarClientes({ company_id, consulta, requestId } = {}) {
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) return erroLocal({ motivo: 'company_id_invalido', requestId })
  if (!ehObjetoSimples(consulta)) return erroLocal({ motivo: 'consulta_invalida', requestId })

  const temBusca = typeof consulta.busca === 'string' && consulta.busca.length > 0
  const temCodigo = typeof consulta.codigo_cliente_erp === 'string' && consulta.codigo_cliente_erp.length > 0
  if (temBusca === temCodigo) return erroLocal({ motivo: 'consulta_invalida', requestId })

  const contato = await resolverContatoAutorizado(cid)
  if (contato.erro) return erroLocal({ motivo: contato.erro, requestId })

  const payload = { telefone: contato.telefone }
  if (temBusca) payload.busca = consulta.busca
  else payload.codigo_cliente_erp = consulta.codigo_cliente_erp
  if (consulta.pagina !== undefined) payload.pagina = consulta.pagina

  const chave = wmConsultaCache.montarChave({
    companyId: cid,
    configVersao: contato.configVersao,
    endpoint: ENDPOINT_CLIENTES,
    modo: temBusca ? 'busca' : 'codigo',
    termo: temBusca ? consulta.busca : consulta.codigo_cliente_erp,
    pagina: consulta.pagina,
  })

  const { valor, origem } = await wmConsultaCache.resolverComCoalescencia(
    chave,
    async () => {
      const resultado = await wmApiClient.consultarClientes(payload)
      if (!resultado.ok) return erroDeResultado({ resultado, requestId })

      const projetado = projetarRespostaClientes(resultado.data, contato.telefone)
      if (!projetado.ok) {
        return erroDeResultado({
          resultado: { ...resultado, ok: false, respostaInvalida: true },
          requestId,
        })
      }
      return { ok: true, dados: projetado.dados }
    },
    (v) => Boolean(v && v.ok === true),
  )

  if (!valor || valor.ok !== true) {
    return valor || erroLocal({ motivo: 'resposta_ausente', requestId })
  }

  return { ok: true, dados: valor.dados, origem_resposta: origem }
}

/* ================================================================== *
 * Disponibilidade do ERP — a porta realtime está de pé?
 *
 * POR QUE ISTO EXISTE. As portas da WM falham SEPARADAMENTE, e a assimetria engana o
 * atendente. Medido em produção em 25/10/2026, com o sincronizador de uma loja fora do ar:
 *
 *   produtos/consultar  (acervo dentro da WM)   -> 200 em 166 ms
 *   clientes/consultar  (realtime, fala com a loja) -> 503 em 2478 ms
 *   orcamentos/preparar (realtime)              -> 503
 *
 * Ou seja: a busca de produto continua perfeita, o atendente monta a cesta inteira, digita o
 * cliente — e só descobre no Calcular que nada pode ser calculado. Esta sonda existe para a
 * tela poder avisar ANTES do trabalho perdido.
 *
 * A SONDA É A CONSULTA DE CLIENTE POR CÓDIGO, e a escolha foi medida: por código ela percorre o
 * mesmo caminho realtime da busca por nome (503 nas duas), mas é uma igualdade indexada em vez
 * de um LIKE com COUNT sobre `dbo.Clientes` — é a pergunta mais barata que prova que a loja
 * responde. O código é um sentinela que quase certamente não existe; se por acaso existir, a
 * resposta 200 é lida SÓ como "está viva" e nenhum dado de cliente sai daqui.
 *
 * 404 CONTA COMO VIVO. "Não encontrei esse código" só pode ter vindo de quem de fato consultou
 * a base da loja. Tratar 404 como falha diria "offline" numa loja saudável.
 *
 * CACHE PRÓPRIO, DE 30 s, E NÃO O `wmConsultaCache`. O cache de catálogo tem TTL de 2–5 min e
 * guarda só sucesso. Aqui os dois lados são diferentes: o veredito NEGATIVO é o que mais
 * precisa de cache (senão cada abertura de tela custa 2,5 s esperando o timeout da WM), e 3
 * minutos seria tempo demais — a loja volta e o atendente continuaria vendo o aviso.
 * ================================================================== */

/** Código sentinela da sonda. Formato plausível, existência improvável. */
const CODIGO_SONDA_ERP = '0000000'

/** TTL curto: longo o bastante para não martelar, curto o bastante para a volta ser percebida. */
const DISPONIBILIDADE_TTL_MS = 30_000

/** `company_id|configVersao` → `{ expiraEm, valor }` e as sondas em voo, para coalescer. */
const disponibilidadeCache = new Map()
const disponibilidadeEmVoo = new Map()

/** Só para teste: zera o cache da sonda sem mexer no cache de catálogo. */
function invalidarDisponibilidadeErp() {
  disponibilidadeCache.clear()
  disponibilidadeEmVoo.clear()
}

/**
 * Lê o resultado normalizado do cliente como veredito de disponibilidade.
 * `motivo` é vocabulário fechado — a tela decide a frase, o serviço não manda texto pronto.
 */
function lerDisponibilidade(resultado) {
  if (!resultado || typeof resultado !== 'object') {
    return { erp_alcancavel: false, motivo: 'indisponivel' }
  }
  if (resultado.configuracaoInvalida) return { erp_alcancavel: false, motivo: 'nao_configurado' }
  if (resultado.transporte) return { erp_alcancavel: false, motivo: 'indisponivel' }
  if (resultado.ok) return { erp_alcancavel: true, motivo: null }
  if (resultado.status === 404) return { erp_alcancavel: true, motivo: null }
  if (resultado.status === 503) return { erp_alcancavel: false, motivo: 'sincronizador_offline' }
  if (resultado.status === 504) return { erp_alcancavel: false, motivo: 'lento' }
  // 400 com o sentinela seria defeito nosso de formato, não da loja; 401/403 são configuração.
  if (resultado.status === 401 || resultado.status === 403) {
    return { erp_alcancavel: false, motivo: 'nao_configurado' }
  }
  return { erp_alcancavel: false, motivo: 'indisponivel' }
}

/**
 * A porta realtime do ERP está de pé para esta empresa?
 *
 * Nunca lança e nunca devolve erro HTTP: indisponibilidade é a RESPOSTA, não uma falha. A tela
 * que pergunta "dá para orçar agora?" não pode ter de tratar exceção para saber que não dá.
 *
 * @param {object} args
 * @param {number} args.company_id  **sempre** de `req.user.company_id`
 * @returns {Promise<{ erp_alcancavel: boolean, motivo: string|null, verificado_em: string, origem_resposta: string }>}
 */
async function verificarDisponibilidadeErp({ company_id } = {}) {
  const agora = () => new Date().toISOString()
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) {
    return { erp_alcancavel: false, motivo: 'nao_configurado', verificado_em: agora(), origem_resposta: 'local' }
  }

  const contato = await resolverContatoAutorizado(cid)
  if (contato.erro) {
    // Empresa sem vínculo/ativo: não é a loja que caiu, é o módulo que não está provisionado.
    return { erp_alcancavel: false, motivo: 'nao_configurado', verificado_em: agora(), origem_resposta: 'local' }
  }

  const chave = `${cid}|${contato.configVersao}`

  const emCache = disponibilidadeCache.get(chave)
  if (emCache && emCache.expiraEm > Date.now()) {
    return { ...emCache.valor, origem_resposta: 'cache' }
  }

  // Coalescência: várias abas abrindo o drawer ao mesmo tempo fazem UMA sonda só.
  const emVoo = disponibilidadeEmVoo.get(chave)
  if (emVoo) return { ...(await emVoo), origem_resposta: 'coalescido' }

  const promessa = (async () => {
    let veredito
    try {
      const resultado = await wmApiClient.consultarClientes({
        telefone: contato.telefone,
        codigo_cliente_erp: CODIGO_SONDA_ERP,
      })
      veredito = lerDisponibilidade(resultado)
    } catch {
      // Exceção de transporte não prevista: para esta pergunta é indisponibilidade, e ponto.
      veredito = { erp_alcancavel: false, motivo: 'indisponivel' }
    }
    const valor = { ...veredito, verificado_em: agora() }
    // Os DOIS vereditos entram no cache — o negativo é justamente o caro de reapurar.
    disponibilidadeCache.set(chave, { valor, expiraEm: Date.now() + DISPONIBILIDADE_TTL_MS })
    return valor
  })()

  disponibilidadeEmVoo.set(chave, promessa)
  try {
    const valor = await promessa
    return { ...valor, origem_resposta: 'wm' }
  } finally {
    disponibilidadeEmVoo.delete(chave)
  }
}

module.exports = {
  ENDPOINT_PRODUTOS,
  ENDPOINT_CLIENTES,
  CODIGO_SONDA_ERP,
  DISPONIBILIDADE_TTL_MS,
  verificarDisponibilidadeErp,
  invalidarDisponibilidadeErp,
  lerDisponibilidade,
  CANDIDATOS_ORIGEM,
  CODIGOS,
  consultarProdutos,
  consultarClientes,
  // expostos para teste — projeções puras, sem efeito
  projetarProduto,
  projetarProdutoResolvido,
  instanteIso,
  projetarCliente,
  normalizarParaComparacao,
  projetarPaginacao,
  projetarMeta,
  projetarRespostaProdutos,
  projetarRespostaClientes,
}
