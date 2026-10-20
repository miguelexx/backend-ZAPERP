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
 * O QUE SAI DAQUI PARA A UI é uma projeção com lista branca de campos, nunca a resposta crua:
 *
 *   · `/produtos/consultar` devolve, pelo contrato, APENAS `codigo_produto_erp`, `descricao`,
 *     `marca` e `unidade` — **sem preço e sem estoque** — e a descoberta de candidatos vem do
 *     **cache cloud** da WM (`docs/wm/04-contratos-api.md`). Então nada aqui inventa preço ou
 *     estoque, e nada é rotulado como "atual": `candidatos_origem: 'cache_cloud'` sai junto
 *     justamente para a Sessão 5 não poder escrever "estoque atual" na tela.
 *   · Se um dia a WM passar a mandar `preco_unitario`/`estoque_previsto` neste endpoint, a
 *     lista branca DESCARTA os dois. Preço e estoque só aparecem adiante, nos candidatos de
 *     `produto_ambiguo` da preparação e na prévia, onde são realtime.
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

  const resolvido = projetarProduto(dados.produto) || projetarProduto(dados)
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

  // Payload da WM: o telefone PRIMEIRO, resolvido no servidor, e só os campos validados.
  // Nenhuma chave extra — nem `limite` (obsoleto/ignorado), nem `tamanho_pagina` (não aceito).
  const payload = { telefone: contato.telefone }
  if (temBusca) payload.busca = consulta.busca
  else payload.codigo_produto_erp = consulta.codigo_produto_erp
  if (consulta.pagina !== undefined) payload.pagina = consulta.pagina

  const chave = wmConsultaCache.montarChave({
    companyId: cid,
    configVersao: contato.configVersao,
    endpoint: ENDPOINT_PRODUTOS,
    modo: temBusca ? 'busca' : 'codigo',
    termo: temBusca ? consulta.busca : consulta.codigo_produto_erp,
    pagina: consulta.pagina,
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

module.exports = {
  ENDPOINT_PRODUTOS,
  CANDIDATOS_ORIGEM,
  CODIGOS,
  consultarProdutos,
  // expostos para teste — projeções puras, sem efeito
  projetarProduto,
  projetarPaginacao,
  projetarMeta,
  projetarRespostaProdutos,
}
