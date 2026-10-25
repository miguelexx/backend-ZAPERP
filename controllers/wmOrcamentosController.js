'use strict'

const crypto = require('crypto')

const wmAssistenteService = require('../services/wm/wmAssistenteService')
const wmOrcamentoService = require('../services/wm/wmOrcamentoService')
const {
  validarConsultarProdutosBody,
  validarConsultarClientesBody,
  validarPrepararBody,
  validarCorpoVazio,
} = require('../validators/wmOrcamentosValidators')
const { assertPermissaoConversa } = require('../services/chat/access/conversationPolicy')
const { isGroupConversation } = require('../helpers/conversaHelper')

/**
 * HTTP local do orçamento WM — Sessão 3A do doc 36.
 *
 * Fronteira estreita de propósito: aqui só mora o que é HTTP (ler `req.user`, validar o body,
 * escolher o status, serializar o envelope). Nenhuma regra da WM, nenhuma montagem de payload
 * externo, nenhuma leitura de banco — isso é do `services/wm/wmAssistenteService`.
 *
 * REGRAS QUE ESTE ARQUIVO EXISTE PARA GARANTIR
 *
 * 1. **`company_id` vem de `req.user.company_id`, sempre.** Nunca de body, query ou header.
 *    O `middleware/auth` já recusa token sem `company_id` válido, então aqui não há fallback:
 *    sem ele a requisição não teria chegado.
 * 2. **Identidade nenhuma atravessa do navegador.** `telefone`, `company_id`, `empresa_id`,
 *    `sincronizador_id`, `token`, `base_url`, `comando_id` e `preco_confirmado` estão em
 *    `CAMPOS_PROIBIDOS` do validador: um body que traga qualquer um deles é **recusado com
 *    400**, não sanitizado em silêncio. Recusar é melhor que ignorar — ignorar deixaria um
 *    frontend errado (ou malicioso) acreditando que mandou o tenant.
 * 3. **Nada de erro cru da WM na resposta.** O que sai é o envelope de `helpers/wmErrorMapper`
 *    (`{ ok, codigo, mensagem, estado, requestId }`), em português comum, sem HTTP, sem código
 *    da WM, sem stack. O detalhe técnico fica no log server-side (`interno`).
 * 4. **Segredo nenhum em log.** Não se registra body, não se registra resposta da WM e o
 *    telefone autorizado nunca chega a esta camada — o service não o devolve.
 */

/** Envelope local de erro de validação. Mesmo formato do mapeador, para a UI tratar num lugar. */
const CODIGO_DADOS_INVALIDOS = 'ORCAMENTO_DADOS_INVALIDOS'
const CODIGO_CONVERSA_NEGADA = 'ORCAMENTO_CONVERSA_NEGADA'
const CODIGO_CONVERSA_NAO_INDIVIDUAL = 'ORCAMENTO_CONVERSA_NAO_INDIVIDUAL'
const CODIGO_ERRO_INTERNO = 'ORCAMENTO_ERRO_INTERNO'

function novoRequestId() {
  try { return crypto.randomUUID() } catch { return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}` }
}

function responderErroLocal(res, { status, codigo, mensagem, campo, requestId }) {
  const corpo = { ok: false, codigo, mensagem, estado: 'FALHA_SEGURA', requestId }
  if (campo) corpo.campo = campo
  return res.status(status).json(corpo)
}

/**
 * Tipos de conversa que não iniciam orçamento. Um orçamento tem UM comprador; grupo,
 * comunidade, canal e lista de transmissão não têm cliente único, e a WM não tem como receber
 * "vários compradores". `isGroupConversation` cobre `@g.us`, `isGroup` e `tipo` grupo/group —
 * mas **não** cobre comunidade (`controllers/chat/contactController.js` cria conversas com
 * `tipo: 'comunidade'`), então a checagem é somada aqui em vez de alterada no helper
 * compartilhado.
 */
const TIPOS_NAO_INDIVIDUAIS = Object.freeze(['grupo', 'group', 'comunidade', 'community', 'canal', 'newsletter', 'broadcast'])

function conversaEhIndividual(conv) {
  if (!conv) return false
  if (isGroupConversation(conv)) return false
  const tipo = String(conv.tipo || '').toLowerCase().trim()
  if (TIPOS_NAO_INDIVIDUAIS.includes(tipo)) return false
  const jid = String(conv.remoteJid ?? conv.telefone ?? '').toLowerCase()
  if (jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return false
  return true
}

/**
 * Revalida o acesso do usuário à conversa pela política canônica (D9) e exige conversa
 * individual.
 *
 * `assertPermissaoConversa` é **chamada**, nunca reimplementada: é a mesma função usada por 10
 * controllers e já cobre visibilidade por número WhatsApp, setor, grupo por departamento,
 * responsável, participante ativo e transferência. Permissão de orçamento NÃO concede acesso a
 * conversa de outro setor nem de outro número — são gates independentes, e os dois valem.
 *
 * Nenhuma rota da Sessão 3A recebe `conversa_id` (o picker de produto não precisa de conversa:
 * `validarConsultarProdutosBody` recusa a chave). Este helper é o choke point já pronto e
 * testado para `preparar`, na Sessão 4 — que é onde a conversa entra.
 *
 * @returns {Promise<{ ok: true, conv: object }|{ ok: false, status: number, codigo: string, mensagem: string }>}
 */
async function garantirAcessoConversa({ company_id, conversa_id, user_id, role, user_dep_ids }) {
  const perm = await assertPermissaoConversa({ company_id, conversa_id, user_id, role, user_dep_ids })
  if (!perm.ok) {
    return {
      ok: false,
      status: perm.status === 404 ? 404 : (perm.status === 500 ? 503 : 403),
      codigo: CODIGO_CONVERSA_NEGADA,
      // A política já devolve uma mensagem adequada ao usuário; não acrescentamos detalhe
      // técnico nem revelamos por qual das regras ele foi barrado.
      mensagem: perm.status === 404 ? 'Conversa não encontrada.' : 'Você não tem acesso a esta conversa.',
    }
  }
  if (!conversaEhIndividual(perm.conv)) {
    return {
      ok: false,
      status: 422,
      codigo: CODIGO_CONVERSA_NAO_INDIVIDUAL,
      mensagem: 'Orçamento só pode ser criado a partir de uma conversa individual.',
    }
  }
  return { ok: true, conv: perm.conv }
}

/**
 * `GET /api/orcamentos/erp/status`
 *
 * "Dá para orçar agora?" — responde 200 inclusive quando a resposta é NÃO. Indisponibilidade do
 * ERP é o conteúdo, não um erro: a tela que pergunta isso não pode ter de tratar 503 para saber
 * que a loja está fora do ar.
 *
 * Existe porque a busca de produto vem do acervo da WM e continua funcionando com o
 * sincronizador da loja desligado, enquanto cliente e `preparar` não. Sem este aviso o atendente
 * monta a cesta inteira e só descobre no Calcular.
 */
async function statusErp(req, res) {
  const requestId = novoRequestId()
  const company_id = req.user?.company_id

  try {
    const r = await wmAssistenteService.verificarDisponibilidadeErp({ company_id })
    return res.json({ ok: true, requestId, ...r })
  } catch (err) {
    // O serviço promete não lançar; se lançar, o honesto é dizer que não sabemos.
    console.error('[wmOrcamentos] erp/status falha inesperada', requestId, err?.message || err)
    return res.json({
      ok: true,
      requestId,
      erp_alcancavel: false,
      motivo: 'indisponivel',
      verificado_em: new Date().toISOString(),
      origem_resposta: 'local',
    })
  }
}

/**
 * `POST /api/orcamentos/clientes/consultar`
 *
 * Candidatos de cliente por nome (`busca`) ou por código exato (`codigo_cliente_erp`), um dos
 * dois. Existe porque a busca de cliente do ERP é **por prefixo**: quem digita o sobrenome não
 * encontra nada, e sem esta consulta não há como descobrir o nome canônico antes do Calcular.
 *
 * A resposta carrega `resolucao_definitiva: false` de propósito: esta rota NÃO decide o cliente
 * do orçamento. `/clientes/consultar` não aplica Inativo/Bloqueado e `preparar` aplica, então a
 * palavra final continua sendo do Calcular (D11). A tela tem de refletir isso.
 */
async function consultarClientes(req, res) {
  const requestId = novoRequestId()
  const company_id = req.user?.company_id

  const validado = validarConsultarClientesBody(req.body)
  if (!validado.ok) {
    return responderErroLocal(res, {
      status: 400,
      codigo: CODIGO_DADOS_INVALIDOS,
      mensagem: validado.error,
      campo: validado.campo,
      requestId,
    })
  }

  try {
    const r = await wmAssistenteService.consultarClientes({
      company_id,
      consulta: validado.value,
      requestId,
    })

    if (!r.ok) {
      if (r.interno?.alertaOperacional) {
        console.warn('[wmOrcamentos] clientes/consultar', JSON.stringify({
          requestId,
          company_id,
          httpLocal: r.interno.httpStatusLocal,
          httpWm: r.interno.httpStatusWm,
          codigo: r.envelope?.codigo || null,
        }))
      }
      return res.status(r.httpStatus).json(r.envelope)
    }

    return res.json({ ok: true, requestId, ...r.dados })
  } catch (err) {
    console.error('[wmOrcamentos] clientes/consultar falha inesperada', requestId, err?.message || err)
    return responderErroLocal(res, {
      status: 503,
      codigo: CODIGO_ERRO_INTERNO,
      mensagem: 'Não foi possível consultar os clientes agora. Tente de novo.',
      requestId,
    })
  }
}

/**
 * `POST /api/orcamentos/produtos/consultar`
 *
 * Candidatos de produto por nome (`busca`) ou por código exato (`codigo_produto_erp`), um dos
 * dois. Paginado de 30 pela WM; página além da última volta 400 **sem clamp** — a resposta
 * repassa o erro, não "conserta" a página.
 *
 * Sem preço e sem estoque: o contrato não os traz neste endpoint e o service não os inventa.
 */
async function consultarProdutos(req, res) {
  const requestId = novoRequestId()
  // Única fonte de tenant. Não há leitura de body/query para isto, em nenhuma circunstância.
  const company_id = req.user?.company_id

  const validado = validarConsultarProdutosBody(req.body)
  if (!validado.ok) {
    return responderErroLocal(res, {
      status: 400,
      codigo: CODIGO_DADOS_INVALIDOS,
      mensagem: validado.error,
      campo: validado.campo,
      requestId,
    })
  }

  try {
    const r = await wmAssistenteService.consultarProdutos({
      company_id,
      consulta: validado.value,
      requestId,
    })

    if (!r.ok) {
      if (r.interno?.alertaOperacional) {
        // Só metadado: status local, status da WM e o código já sanitizado. Nunca body,
        // nunca resposta, nunca telefone, nunca token.
        console.warn('[wmOrcamentos] produtos/consultar', JSON.stringify({
          requestId,
          company_id,
          httpLocal: r.interno.httpStatusLocal,
          httpWm: r.interno.httpStatusWm,
          codigo: r.envelope?.codigo || null,
        }))
      }
      return res.status(r.httpStatus).json(r.envelope)
    }

    return res.json({ ok: true, requestId, ...r.dados })
  } catch (err) {
    console.error('[wmOrcamentos] produtos/consultar falha inesperada', requestId, err?.message || err)
    return responderErroLocal(res, {
      status: 503,
      codigo: CODIGO_ERRO_INTERNO,
      mensagem: 'Não foi possível consultar os produtos agora. Tente de novo.',
      requestId,
    })
  }
}

/* ================================================================== *
 * Sessão 4A — preparação, confirmação, verificação e leitura
 * ================================================================== */

const PADRAO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Resposta de serviço (`{ ok, httpStatus, envelope }` ou `{ ok: true, resultado }`). */
function responderServico(res, r, requestId) {
  if (!r?.ok) return res.status(r?.httpStatus || 503).json(r?.envelope || {
    ok: false, codigo: CODIGO_ERRO_INTERNO, mensagem: 'Não foi possível concluir a operação.', estado: 'FALHA_SEGURA', requestId,
  })
  return res.json({ ok: true, requestId: r.requestId || requestId, ...r.resultado })
}

/** UUID de rota. Inválido é 404 (e não 400): não se confirma formato de id que não existe. */
function lerUuidDeRota(valor) {
  const v = String(valor ?? '')
  return PADRAO_UUID.test(v) ? v : null
}

/**
 * `POST /api/orcamentos/preparar`
 *
 * Único ponto do módulo que recebe `conversa_id` — e por isso o único que revalida acesso por
 * `assertPermissaoConversa` (D9). Permissão de orçamento não concede acesso a conversa de
 * outro setor nem de outro número: os dois gates valem, nesta ordem.
 *
 * Chama a WM uma vez e devolve OU a ambiguidade a resolver (com o rascunho intacto) OU a
 * preparação pronta (só `preparacao_id` opaco + prévia sanitizada). Nenhum candidato é
 * escolhido automaticamente e nenhuma página é corrigida.
 */
async function preparar(req, res) {
  const requestId = novoRequestId()
  const company_id = req.user?.company_id

  const validado = validarPrepararBody(req.body)
  if (!validado.ok) {
    return responderErroLocal(res, {
      status: 400,
      codigo: CODIGO_DADOS_INVALIDOS,
      mensagem: validado.error,
      campo: validado.campo,
      requestId,
    })
  }

  try {
    const acesso = await garantirAcessoConversa({
      company_id,
      conversa_id: validado.value.conversa_id,
      user_id: req.user?.id,
      role: req.user?.perfil,
      // Mesmo nome que os 10 controllers vizinhos leem de `req.user` — a política canônica
      // usa isso para o acesso por departamento.
      user_dep_ids: req.user?.departamento_ids || [],
    })
    if (!acesso.ok) {
      return responderErroLocal(res, { ...acesso, requestId })
    }

    const r = await wmOrcamentoService.preparar({
      company_id,
      usuario_id: req.user?.id ?? null,
      rascunho: validado.value,
      requestId,
    })
    if (!r.ok && r.interno?.alertaOperacional) {
      console.warn('[wmOrcamentos] preparar', JSON.stringify({
        requestId,
        company_id,
        httpLocal: r.interno.httpStatusLocal,
        httpWm: r.interno.httpStatusWm,
        codigo: r.envelope?.codigo || null,
      }))
    }
    return responderServico(res, r, requestId)
  } catch (err) {
    console.error('[wmOrcamentos] preparar falha inesperada', requestId, err?.message || err)
    return responderErroLocal(res, {
      status: 503,
      codigo: CODIGO_ERRO_INTERNO,
      mensagem: 'Não foi possível calcular o orçamento agora. Tente de novo.',
      requestId,
    })
  }
}

/**
 * `POST /api/orcamentos/:preparacaoId/confirmar` — corpo VAZIO.
 *
 * O estado todo está no servidor: preço e códigos canônicos vêm do snapshot, nunca do
 * navegador. Um corpo com qualquer chave é recusado — e `preco_confirmado`/`comando_id` são
 * recusados nominalmente, não ignorados em silêncio.
 *
 * ⚠️ NÃO DESPACHA PARA A WM nesta sessão: faz a transição atômica `PREPARADO → ENVIANDO`,
 * persiste o `comando_id` e para. O despacho é a Sessão 6.
 */
async function confirmar(req, res) {
  const requestId = novoRequestId()
  const vazio = validarCorpoVazio(req.body)
  if (!vazio.ok) {
    return responderErroLocal(res, {
      status: 400, codigo: CODIGO_DADOS_INVALIDOS, mensagem: vazio.error, campo: vazio.campo, requestId,
    })
  }
  const preparacao_id = lerUuidDeRota(req.params?.preparacaoId)
  if (!preparacao_id) {
    return responderErroLocal(res, {
      status: 404,
      codigo: wmOrcamentoService.CODIGOS.PREPARACAO_NAO_ENCONTRADA,
      mensagem: wmOrcamentoService.MENSAGENS[wmOrcamentoService.CODIGOS.PREPARACAO_NAO_ENCONTRADA],
      requestId,
    })
  }

  try {
    const r = await wmOrcamentoService.confirmar({
      company_id: req.user?.company_id,
      usuario_id: req.user?.id ?? null,
      preparacao_id,
      requestId,
    })
    return responderServico(res, r, requestId)
  } catch (err) {
    console.error('[wmOrcamentos] confirmar falha inesperada', requestId, err?.message || err)
    return responderErroLocal(res, {
      status: 503,
      codigo: CODIGO_ERRO_INTERNO,
      mensagem: 'Não foi possível confirmar o orçamento agora. Tente de novo.',
      requestId,
    })
  }
}

/**
 * `POST /api/orcamentos/:operacaoId/verificar` — corpo VAZIO.
 *
 * Verificar um `INCERTO` é reenviar o payload idêntico com o MESMO `comando_id` (D10) — ação
 * sempre explícita, nunca automática, nunca em laço. Nesta sessão a função faz todo o trabalho
 * local (exige `INCERTO`, reusa o `comando_id` persistido, remonta o payload e barra
 * divergência de hash) e **não despacha**.
 */
async function verificar(req, res) {
  const requestId = novoRequestId()
  const vazio = validarCorpoVazio(req.body)
  if (!vazio.ok) {
    return responderErroLocal(res, {
      status: 400, codigo: CODIGO_DADOS_INVALIDOS, mensagem: vazio.error, campo: vazio.campo, requestId,
    })
  }
  const operacao_id = lerUuidDeRota(req.params?.operacaoId)
  if (!operacao_id) {
    return responderErroLocal(res, {
      status: 404,
      codigo: wmOrcamentoService.CODIGOS.PREPARACAO_NAO_ENCONTRADA,
      mensagem: wmOrcamentoService.MENSAGENS[wmOrcamentoService.CODIGOS.PREPARACAO_NAO_ENCONTRADA],
      requestId,
    })
  }

  try {
    const r = await wmOrcamentoService.verificar({
      company_id: req.user?.company_id,
      usuario_id: req.user?.id ?? null,
      operacao_id,
      requestId,
    })
    return responderServico(res, r, requestId)
  } catch (err) {
    console.error('[wmOrcamentos] verificar falha inesperada', requestId, err?.message || err)
    return responderErroLocal(res, {
      status: 503,
      codigo: CODIGO_ERRO_INTERNO,
      mensagem: 'Não foi possível verificar o orçamento agora. Tente de novo.',
      requestId,
    })
  }
}

/**
 * `GET /api/orcamentos/:operacaoId` — leitura da operação da PRÓPRIA empresa.
 * Operação de outra empresa é 404, não 403: um 403 confirmaria que o UUID existe.
 */
async function obterOperacao(req, res) {
  const requestId = novoRequestId()
  const operacao_id = lerUuidDeRota(req.params?.operacaoId)
  if (!operacao_id) {
    return responderErroLocal(res, {
      status: 404,
      codigo: wmOrcamentoService.CODIGOS.PREPARACAO_NAO_ENCONTRADA,
      mensagem: wmOrcamentoService.MENSAGENS[wmOrcamentoService.CODIGOS.PREPARACAO_NAO_ENCONTRADA],
      requestId,
    })
  }

  try {
    const r = await wmOrcamentoService.obterOperacao({
      company_id: req.user?.company_id,
      operacao_id,
      requestId,
    })
    return responderServico(res, r, requestId)
  } catch (err) {
    console.error('[wmOrcamentos] obter falha inesperada', requestId, err?.message || err)
    return responderErroLocal(res, {
      status: 503,
      codigo: CODIGO_ERRO_INTERNO,
      mensagem: 'Não foi possível ler o orçamento agora.',
      requestId,
    })
  }
}

module.exports = {
  CODIGO_DADOS_INVALIDOS,
  CODIGO_CONVERSA_NEGADA,
  CODIGO_CONVERSA_NAO_INDIVIDUAL,
  consultarProdutos,
  consultarClientes,
  statusErp,
  preparar,
  confirmar,
  verificar,
  obterOperacao,
  // Choke point de acesso à conversa — usado por `preparar` e testado direto.
  garantirAcessoConversa,
  conversaEhIndividual,
}
