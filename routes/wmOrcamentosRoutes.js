'use strict'

const express = require('express')
const auth = require('../middleware/auth')
const requireOrcamentoWm = require('../middleware/requireOrcamentoWm')
const requirePermissao = require('../middleware/requirePermissao')
const { destructiveLimiter } = require('../middleware/rateLimit')
const wmOrcamentosController = require('../controllers/wmOrcamentosController')

/**
 * Rotas do orçamento manual × API WM (ERP Icthus) — Sessão 3A do doc 36.
 *
 * CADEIA, NESTA ORDEM, E A ORDEM IMPORTA:
 *
 *   auth → requireOrcamentoWm → requirePermissao('orcamentos.ver') → controller
 *
 *   · `auth` primeiro porque os dois gates seguintes dependem de `req.user.company_id`;
 *   · `requireOrcamentoWm` antes da permissão porque "módulo desligado" é resposta de empresa,
 *     não de usuário: um atendente com permissão numa empresa sem o módulo tem de receber o
 *     mesmo 403 de módulo que todo mundo, e a resposta não deve diferenciar os dois casos;
 *   · `requirePermissao` por último, imediatamente antes do controller.
 *
 * MONTAR ESTAS ROTAS NÃO ABRE SUPERFÍCIE. `requireOrcamentoWm` é fail-closed e a flag efetiva é
 * `WM_ORCAMENTOS_ENABLED` (env, hoje `false`) **E** `wm_orcamento_integracoes.ativo` da empresa.
 * Com a env desligada nem há consulta ao banco: toda requisição responde 403 `ORCAMENTO_WM_OFF`.
 * Erro de leitura da flag, tabela ausente (migration não aplicada) ou empresa sem linha também
 * dão 403. `tests/wmOrcamentosIsolamento.test.js` prova exatamente isso: rota montada e fechada.
 *
 * `apiLimiter` vem do mount em `app.js`, igual aos vizinhos — não há limiter novo (D3). Quando a
 * Sessão 6 trouxer `confirmar`, o limiter dela é o `destructiveLimiter`, que já existe.
 */

const router = express.Router()

router.use(auth)
router.use(requireOrcamentoWm)

/**
 * `POST /produtos/consultar` — candidatos de produto para o picker.
 *
 * Body: `busca` XOR `codigo_produto_erp`, mais `pagina` opcional. Nada além disso: chave
 * desconhecida é 400, e identidade (`telefone`, `company_id`, `token`, …) é recusada
 * explicitamente. Sem preço e sem estoque na resposta — o contrato não os traz aqui.
 */
router.post(
  '/produtos/consultar',
  requirePermissao('orcamentos.ver'),
  wmOrcamentosController.consultarProdutos
)

/**
 * `GET /erp/status` — "dá para orçar agora?".
 *
 * Responde 200 inclusive quando a resposta é NÃO: indisponibilidade do ERP é o conteúdo, não um
 * erro. Corpo: `{ erp_alcancavel, motivo, verificado_em, origem_resposta }`, com `motivo` num
 * vocabulário fechado (`sincronizador_offline`, `lento`, `indisponivel`, `nao_configurado`) —
 * a frase exibida é escolha da tela, não do servidor.
 *
 * Sonda de 30 s em cache e coalescida: várias abas abrindo o drawer custam UMA pergunta à WM.
 */
router.get(
  '/erp/status',
  requirePermissao('orcamentos.ver'),
  wmOrcamentosController.statusErp
)

/**
 * `POST /clientes/consultar` — auxílio para achar o cliente no ERP.
 *
 * Body: `busca` XOR `codigo_cliente_erp`, mais `pagina` opcional. Mesma permissão e mesmo
 * formato do irmão de produtos.
 *
 * Existe por causa de um detalhe do ERP que o atendente não tem como adivinhar: a busca de
 * cliente é **por prefixo**, então "SILVA" não encontra "JOSE DA SILVA". Sem esta rota, a
 * única forma de descobrir o nome canônico era tentar no Calcular e ver dar errado.
 *
 * NÃO decide o cliente do orçamento: a resposta vem com `resolucao_definitiva: false`, porque
 * `/clientes/consultar` não aplica Inativo/Bloqueado e `preparar` aplica (D11).
 */
router.post(
  '/clientes/consultar',
  requirePermissao('orcamentos.ver'),
  wmOrcamentosController.consultarClientes
)

/**
 * `POST /preparar` — Sessão 4A.
 *
 * Resolve cliente, vendedor e itens dentro da própria preparação (D11) e devolve OU a
 * ambiguidade a resolver, com o rascunho intacto, OU a preparação pronta (só `preparacao_id`
 * opaco + prévia sanitizada; preço e códigos canônicos ficam no servidor).
 *
 * É a ÚNICA rota do módulo que recebe `conversa_id`, e por isso a única que revalida acesso
 * por `assertPermissaoConversa` (D9) — dentro do controller, antes de qualquer chamada
 * externa. Fica em `orcamentos.ver` porque preparar não escreve no ERP: a WM calcula a prévia
 * sem gravar. Quem só pode ver monta e calcula; quem grava precisa de `orcamentos.criar`.
 */
router.post(
  '/preparar',
  requirePermissao('orcamentos.ver'),
  wmOrcamentosController.preparar
)

/**
 * `POST /:preparacaoId/confirmar` — corpo VAZIO.
 *
 * `destructiveLimiter` (300/min, já existente — D3, nenhum limiter novo). O rate limit NÃO é a
 * proteção de concorrência: a trava real é a transição atômica `PREPARADO → ENVIANDO` no banco
 * (seção 7), e é ela que garante que duplo clique, duas abas e F5 produzam UM `comando_id`.
 *
 * ⚠️ NESTA SESSÃO O `confirmar` NÃO DESPACHA PARA A WM. Ele faz a transição atômica, persiste
 * o `comando_id` e para — a resposta diz `despachado: false`. O despacho é a Sessão 6; as
 * pendências 1 e 2 (schema da prévia e do sucesso da criação) já foram respondidas pela 2ª
 * remessa do contrato e traduzidas na 4B, mas ligar o POST continua sendo trabalho da 6.
 * `tests/wmOrcamentoIdempotencia.test.js` prova que `wmApiClient.criarOrcamento` não é chamado.
 */
router.post(
  '/:preparacaoId/confirmar',
  destructiveLimiter,
  requirePermissao('orcamentos.criar'),
  wmOrcamentosController.confirmar
)

/**
 * `POST /:operacaoId/verificar` — corpo VAZIO.
 *
 * Verificar um `INCERTO` é reenviar o payload byte a byte idêntico com o MESMO `comando_id`
 * (D10) — jamais um UUID novo, jamais automático, jamais em laço. Nesta sessão faz todo o
 * trabalho local (exige `INCERTO`, reusa o `comando_id` persistido, remonta o payload pelo
 * snapshot e barra divergência de hash) e para antes do despacho.
 *
 * Exige `orcamentos.criar` porque, a partir da Sessão 6, é uma ação que pode concluir uma
 * gravação no ERP.
 */
router.post(
  '/:operacaoId/verificar',
  destructiveLimiter,
  requirePermissao('orcamentos.criar'),
  wmOrcamentosController.verificar
)

/**
 * `GET /:operacaoId` — leitura da operação da própria empresa. Sem `comando_id`, sem
 * `payload_criacao`, sem `payload_hash` na resposta. Operação de outra empresa é 404.
 */
router.get(
  '/:operacaoId',
  requirePermissao('orcamentos.ver'),
  wmOrcamentosController.obterOperacao
)

/*
 * NÃO existe rota de clientes (D11): cliente e vendedor resolvem dentro de `preparar`, porque
 * `/clientes/consultar` da WM não filtra Inativo/Bloqueado e `preparar` filtra — escolher ali
 * criaria um beco sem saída com `CLIENTE_INVALIDO` que o atendente não tem como prever.
 *
 * Também não existe rota de configuração: o vínculo com o telefone autorizado da WM é
 * provisionado por operação confiável, não por admin de tenant (seção 4 e pendência 13 — a WM
 * não prova vínculo de empresa, então um admin que pudesse digitar o telefone leria o ERP de
 * outra empresa).
 */

module.exports = router
