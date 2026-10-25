'use strict'

const crypto = require('crypto')

/**
 * Mapeador de erro da API WM para o envelope local do ZapERP (doc 36, seção 5).
 *
 * A WM devolve o código do erro na chave **`erro`** — não `codigo`, não `error`:
 * `{"erro": "SINCRONIZADOR_OFFLINE"}`. No `502` de `preparar` vem também `indice_item`
 * zero-based. O mapeamento completo dela vive em `shared/http/errors.ts`, que NÃO recebemos
 * (pendência 3 da seção 10), então todo ramo tem um **padrão por faixa de HTTP**: código
 * desconhecido nunca passa adiante cru, nunca vira mensagem técnica na tela.
 *
 * Envelope local (e só estas chaves):
 *   { ok: false, codigo, mensagem, estado, requestId, indice_item? }
 *
 * `estado` é a conclusão sobre a ESCRITA, no vocabulário da máquina de estados:
 *   · FALHA_SEGURA — está provado que nada foi gravado no ERP; repreparar é seguro;
 *   · INCERTO      — a gravação PODE ter acontecido; nunca gerar `comando_id` novo (D10).
 * Em leitura e preparação (que não escrevem) o estado é sempre FALHA_SEGURA; o valor só é
 * INCERTO em `criacao`, e aí por excesso de cautela sempre que a resposta não prove o contrário.
 *
 * DOIS PONTOS CRÍTICOS DE DESENHO
 *
 * (a) **O `401` da WM nunca vira `401` local.** O interceptor Axios do frontend faz logout em
 *     401 quando o request levou Bearer (`frontend/src/api/http.js`), então espelhar o 401 da WM
 *     deslogaria o atendente por um problema de credencial de integração. Vira `503` local com
 *     código de domínio e `alertaOperacional`.
 *
 * (b) **O `403` é ambíguo por desenho.** Pode ser contato inexistente/inativo OU
 *     `CONFLITO_EQUIVALENCIA_TELEFONE` (dois contatos equivalentes cadastrados), e o diagnóstico
 *     da WM omite o telefone de propósito (`docs/wm/14-normalizacao-telefones.md`). A mensagem ao
 *     usuário **não pode afirmar qual dos dois é** — fala de autorização da integração, e manda
 *     procurar o suporte.
 *
 * O que sai daqui para o navegador é só `envelope`. O `interno` é para log/auditoria
 * server-side (status local, código bruto já sanitizado, alerta operacional) e NÃO deve ser
 * serializado na resposta HTTP.
 */

/**
 * Espelha `services/wm/wmOrcamentoStateMachine.ESTADOS`. Repetido aqui de propósito para não
 * inverter camada (helper -> service); `tests/wmErrorMapper.test.js` prova que os dois valores
 * continuam idênticos aos da máquina de estados.
 */
const ESTADO = Object.freeze({
  FALHA_SEGURA: 'FALHA_SEGURA',
  INCERTO: 'INCERTO',
})

const OPERACAO = Object.freeze({
  LEITURA: 'leitura',
  PREPARACAO: 'preparacao',
  CRIACAO: 'criacao',
})

/** Códigos locais. Estáveis: frontend e runbook dependem deles. */
const CODIGOS = Object.freeze({
  INTEGRACAO_NAO_CONFIGURADA: 'WM_INTEGRACAO_NAO_CONFIGURADA',
  CREDENCIAL_INVALIDA: 'WM_CREDENCIAL_INVALIDA',
  ACESSO_NAO_AUTORIZADO: 'WM_ACESSO_NAO_AUTORIZADO',
  PAYLOAD_INVALIDO: 'WM_PAYLOAD_INVALIDO',
  PERIODO_INVALIDO: 'WM_PERIODO_INVALIDO',
  PAGINA_FORA_DO_INTERVALO: 'WM_PAGINA_FORA_DO_INTERVALO',
  NAO_ENCONTRADO: 'WM_NAO_ENCONTRADO',
  CLIENTE_INVALIDO: 'WM_CLIENTE_INVALIDO',
  VENDEDOR_NAO_ENCONTRADO: 'WM_VENDEDOR_NAO_ENCONTRADO',
  PRODUTO_NAO_ENCONTRADO: 'WM_PRODUTO_NAO_ENCONTRADO',
  PRODUTO_INATIVO: 'WM_PRODUTO_INATIVO',
  ERRO_ORIGEM: 'WM_ERRO_ORIGEM',
  SINCRONIZADOR_OFFLINE: 'WM_SINCRONIZADOR_OFFLINE',
  TIMEOUT: 'WM_TIMEOUT',
  INDISPONIVEL: 'WM_INDISPONIVEL',
  RESPOSTA_INVALIDA: 'WM_RESPOSTA_INVALIDA',
  ORCAMENTO_DADOS_ALTERADOS: 'WM_ORCAMENTO_DADOS_ALTERADOS',
  COMANDO_ID_REUTILIZADO: 'WM_COMANDO_ID_REUTILIZADO',
  COMANDO_EM_ANDAMENTO: 'WM_COMANDO_EM_ANDAMENTO',
  RESULTADO_INCERTO: 'WM_RESULTADO_INCERTO',
  CONFLITO: 'WM_CONFLITO',
  RECUSADO: 'WM_RECUSADO',
  ERRO_DESCONHECIDO: 'WM_ERRO_DESCONHECIDO',
})

/** Mensagens ao usuário: português comum, sem HTTP, sem código, sem jargão, sem culpa. */
const MENSAGENS = Object.freeze({
  [CODIGOS.INTEGRACAO_NAO_CONFIGURADA]: 'A integração com o ERP não está configurada. Avise o suporte.',
  [CODIGOS.CREDENCIAL_INVALIDA]: 'A integração com o ERP está indisponível. Avise o suporte.',
  // Ambíguo por desenho (ponto (b) do cabeçalho): não afirma a causa.
  [CODIGOS.ACESSO_NAO_AUTORIZADO]: 'A integração com o ERP não está autorizada para esta empresa. Procure o suporte.',
  [CODIGOS.PAYLOAD_INVALIDO]: 'Não foi possível validar os dados do orçamento. Revise e tente de novo.',
  [CODIGOS.PERIODO_INVALIDO]: 'O período informado não é aceito pelo ERP.',
  [CODIGOS.PAGINA_FORA_DO_INTERVALO]: 'Essa página de resultados não existe mais. Refaça a busca.',
  [CODIGOS.NAO_ENCONTRADO]: 'Nenhum resultado encontrado no ERP para essa busca.',
  [CODIGOS.CLIENTE_INVALIDO]: 'O cliente escolhido não está liberado para orçamento no ERP. Escolha outro.',
  [CODIGOS.VENDEDOR_NAO_ENCONTRADO]: 'Vendedor não encontrado no ERP. Confira o nome e tente de novo.',
  [CODIGOS.PRODUTO_NAO_ENCONTRADO]: 'Um dos produtos do orçamento não foi encontrado no ERP.',
  [CODIGOS.PRODUTO_INATIVO]: 'Um dos produtos do orçamento está inativo no ERP.',
  [CODIGOS.ERRO_ORIGEM]: 'O ERP recusou a operação. Tente de novo em instantes.',
  // Não é a WM que caiu: é o sincronizador instalado na máquina da PRÓPRIA loja que não está
  // alcançável — e isso se resolve lá (máquina ligada, internet, serviço rodando), não com o
  // suporte do ZapERP. A frase diz o que fazer porque quem lê é o atendente, não o técnico.
  // O estado é FALHA_SEGURA: nada foi gravado no ERP, então o orçamento pode ser refeito.
  [CODIGOS.SINCRONIZADOR_OFFLINE]: 'O sistema da sua loja está fora do ar, então o orçamento não pôde ser calculado. Nada foi gravado. Confira se o computador do ERP está ligado e com internet, e tente de novo.',
  [CODIGOS.TIMEOUT]: 'O ERP demorou para responder. Tente de novo.',
  [CODIGOS.INDISPONIVEL]: 'Não foi possível falar com o ERP agora. Tente de novo em instantes.',
  [CODIGOS.RESPOSTA_INVALIDA]: 'O ERP respondeu de um jeito inesperado. Avise o suporte.',
  // "Tente de novo" seria errado aqui: o MESMO comando nunca vai passar. O caminho é
  // recalcular a prévia e confirmar outra vez — e a frase tem de dizer isso.
  [CODIGOS.ORCAMENTO_DADOS_ALTERADOS]: 'Os dados deste orçamento mudaram no ERP. Calcule a prévia de novo e confirme.',
  [CODIGOS.COMANDO_ID_REUTILIZADO]: 'Este orçamento não pode ser reenviado. Procure o suporte.',
  [CODIGOS.COMANDO_EM_ANDAMENTO]: 'A criação deste orçamento ainda está sendo apurada no ERP. Não crie outro.',
  [CODIGOS.RESULTADO_INCERTO]: 'Não foi possível confirmar se o orçamento foi criado no ERP. Não crie outro — procure o suporte.',
  [CODIGOS.CONFLITO]: 'Esta operação está em conflito com outra já registrada no ERP. Procure o suporte.',
  [CODIGOS.RECUSADO]: 'O ERP recusou a operação.',
  [CODIGOS.ERRO_DESCONHECIDO]: 'Não foi possível concluir a operação no ERP. Tente de novo.',
})

function novoRequestId() {
  try { return crypto.randomUUID() } catch { return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}` }
}

function ehCriacao(operacao) {
  return operacao === OPERACAO.CRIACAO
}

/**
 * Códigos nomeados nos documentos da WM, por faixa de HTTP. Fora desta tabela, o ramo padrão
 * da faixa decide — é a defesa contra o `shared/http/errors.ts` que não recebemos.
 */
const POR_CODIGO_WM = Object.freeze({
  TOKEN_ASSISTENTE_INVALIDO: { codigo: CODIGOS.CREDENCIAL_INVALIDA, httpLocal: 503, alerta: true },
  CONTATO_NAO_AUTORIZADO: { codigo: CODIGOS.ACESSO_NAO_AUTORIZADO, httpLocal: 503, alerta: true },
  payload_invalido: { codigo: CODIGOS.PAYLOAD_INVALIDO, httpLocal: 400, alerta: true },
  PERIODO_INVALIDO: { codigo: CODIGOS.PERIODO_INVALIDO, httpLocal: 400, alerta: false },
  PAGINA_FORA_DO_INTERVALO: { codigo: CODIGOS.PAGINA_FORA_DO_INTERVALO, httpLocal: 400, alerta: false },
  CLIENTE_INVALIDO: { codigo: CODIGOS.CLIENTE_INVALIDO, httpLocal: 422, alerta: false },
  VENDEDOR_NAO_ENCONTRADO: { codigo: CODIGOS.VENDEDOR_NAO_ENCONTRADO, httpLocal: 422, alerta: false },
  PRODUTO_NAO_ENCONTRADO: { codigo: CODIGOS.PRODUTO_NAO_ENCONTRADO, httpLocal: 422, alerta: false },
  PRODUTO_INATIVO: { codigo: CODIGOS.PRODUTO_INATIVO, httpLocal: 422, alerta: false },
  SINCRONIZADOR_OFFLINE: { codigo: CODIGOS.SINCRONIZADOR_OFFLINE, httpLocal: 503, alerta: false },
  REALTIME_TIMEOUT: { codigo: CODIGOS.TIMEOUT, httpLocal: 504, alerta: false, incertoNaCriacao: true },
  // Recusa ANTES da escrita (§11 do guia da 2ª remessa): os dados mudaram entre a prévia e a
  // criação, então nada foi gravado — `incerto: false` **mesmo na criação**, de propósito.
  // Mapeado por CÓDIGO e não por status: o guia descreve o erro sem fixar o HTTP (a tabela
  // dele põe recusa de ERP em 502 e conflito de comando em 409), e o ramo padrão de 409
  // marcaria INCERTO na criação. `alerta: false` porque é ocorrência normal de negócio.
  ORCAMENTO_DADOS_ALTERADOS: { codigo: CODIGOS.ORCAMENTO_DADOS_ALTERADOS, httpLocal: 409, alerta: false, incerto: false },
  COMANDO_ID_REUTILIZADO: { codigo: CODIGOS.COMANDO_ID_REUTILIZADO, httpLocal: 409, alerta: true },
  COMANDO_NAO_REEXECUTADO: { codigo: CODIGOS.COMANDO_EM_ANDAMENTO, httpLocal: 409, alerta: true, incerto: true },
  RESULTADO_INCERTO: { codigo: CODIGOS.RESULTADO_INCERTO, httpLocal: 409, alerta: true, incerto: true },
})

/** Ramo padrão por faixa de HTTP — obrigatório (pendência 3). */
function padraoPorFaixa(status, operacao) {
  const criacao = ehCriacao(operacao)
  if (status === 400) return { codigo: CODIGOS.PAYLOAD_INVALIDO, httpLocal: 400, alerta: true }
  if (status === 401) return { codigo: CODIGOS.CREDENCIAL_INVALIDA, httpLocal: 503, alerta: true }
  if (status === 403) return { codigo: CODIGOS.ACESSO_NAO_AUTORIZADO, httpLocal: 503, alerta: true }
  if (status === 404) return { codigo: CODIGOS.NAO_ENCONTRADO, httpLocal: 404, alerta: false }
  if (status === 409) {
    // Conflito desconhecido na criação: a escrita pode ter acontecido.
    return { codigo: CODIGOS.CONFLITO, httpLocal: 409, alerta: true, incerto: criacao }
  }
  if (status === 429) return { codigo: CODIGOS.INDISPONIVEL, httpLocal: 503, alerta: true }
  if (status === 502) {
    // 502 conhecido de resolução é recuperável (tabela acima). 502 desconhecido é erro técnico
    // de origem — não rotular como escolha do usuário.
    return { codigo: CODIGOS.ERRO_ORIGEM, httpLocal: 503, alerta: true }
  }
  if (status === 503) return { codigo: CODIGOS.SINCRONIZADOR_OFFLINE, httpLocal: 503, alerta: false }
  if (status === 504) {
    return { codigo: criacao ? CODIGOS.RESULTADO_INCERTO : CODIGOS.TIMEOUT, httpLocal: 504, alerta: criacao, incerto: criacao }
  }
  if (status >= 300 && status < 400) {
    // redirect: 'error' já impede seguir; se um 3xx chegar aqui, é resposta fora do contrato.
    return { codigo: CODIGOS.RESPOSTA_INVALIDA, httpLocal: 503, alerta: true, incerto: criacao }
  }
  if (status >= 400 && status < 500) return { codigo: CODIGOS.RECUSADO, httpLocal: 422, alerta: true }
  if (status >= 500) return { codigo: CODIGOS.INDISPONIVEL, httpLocal: 503, alerta: true, incerto: criacao }
  return { codigo: CODIGOS.ERRO_DESCONHECIDO, httpLocal: 503, alerta: true, incerto: criacao }
}

function montar({ codigo, httpLocal, estado, requestId, indiceItem, alerta, codigoWm, status, operacao, mensagem }) {
  const envelope = {
    ok: false,
    codigo,
    mensagem: mensagem || MENSAGENS[codigo] || MENSAGENS[CODIGOS.ERRO_DESCONHECIDO],
    estado,
    requestId,
  }
  if (typeof indiceItem === 'number' && Number.isInteger(indiceItem) && indiceItem >= 0) {
    envelope.indice_item = indiceItem
  }
  return {
    envelope,
    interno: {
      httpStatusLocal: httpLocal,
      httpStatusWm: Number(status) || 0,
      codigoWm: codigoWm || null,
      alertaOperacional: Boolean(alerta),
      operacao: operacao || null,
    },
  }
}

/**
 * Traduz um resultado de `services/wm/wmApiClient` (que nunca lança) no envelope local.
 *
 * @param {object} args
 * @param {object} args.resultado resultado normalizado do wmApiClient
 * @param {string} [args.operacao] 'leitura' | 'preparacao' | 'criacao'; default vem do resultado
 * @param {string} [args.requestId] correlação; gerado se ausente
 * @returns {{ envelope: object, interno: object }}
 */
function mapearErroWm({ resultado, operacao, requestId } = {}) {
  const r = resultado || {}
  const op = operacao || r.operacao || OPERACAO.LEITURA
  const criacao = ehCriacao(op)
  const rid = requestId || novoRequestId()
  const comum = { requestId: rid, operacao: op, status: r.status, codigoWm: r.erroWm || null }

  // 1. Configuração local inválida: NADA foi enviado. Falha segura mesmo na criação.
  if (r.configuracaoInvalida) {
    return montar({
      ...comum,
      status: 0,
      codigoWm: null,
      codigo: CODIGOS.INTEGRACAO_NAO_CONFIGURADA,
      httpLocal: 503,
      estado: ESTADO.FALHA_SEGURA,
      alerta: true,
    })
  }

  // 2. Falha de transporte: não houve resposta HTTP.
  if (r.transporte) {
    if (r.transporte === 'conexao') {
      // Erro de nível de conexão prova que a requisição não chegou — seguro até na criação.
      return montar({ ...comum, codigo: CODIGOS.INDISPONIVEL, httpLocal: 503, estado: ESTADO.FALHA_SEGURA, alerta: false })
    }
    if (criacao) {
      // Timeout ou falha não classificada DEPOIS do despacho: a escrita pode ter ocorrido.
      return montar({ ...comum, codigo: CODIGOS.RESULTADO_INCERTO, httpLocal: 504, estado: ESTADO.INCERTO, alerta: true })
    }
    const codigo = r.transporte === 'timeout' ? CODIGOS.TIMEOUT : CODIGOS.INDISPONIVEL
    return montar({ ...comum, codigo, httpLocal: r.transporte === 'timeout' ? 504 : 503, estado: ESTADO.FALHA_SEGURA, alerta: false })
  }

  // 3. 2xx com corpo fora do contrato (content-type, JSON ou tamanho).
  if (r.respostaInvalida) {
    return montar({
      ...comum,
      codigo: criacao ? CODIGOS.RESULTADO_INCERTO : CODIGOS.RESPOSTA_INVALIDA,
      httpLocal: criacao ? 504 : 503,
      estado: criacao ? ESTADO.INCERTO : ESTADO.FALHA_SEGURA,
      alerta: true,
    })
  }

  // 4. Chamado por engano com sucesso: não inventa erro, mas sinaliza para log.
  if (r.ok === true) {
    return montar({ ...comum, codigo: CODIGOS.ERRO_DESCONHECIDO, httpLocal: 503, estado: ESTADO.FALHA_SEGURA, alerta: true })
  }

  const status = Number(r.status) || 0
  const nomeado = r.erroWm ? POR_CODIGO_WM[r.erroWm] : null
  const regra = nomeado || padraoPorFaixa(status, op)
  const incerto = Boolean(regra.incerto) || (criacao && Boolean(regra.incertoNaCriacao))

  let codigo = regra.codigo
  // Timeout realtime na criação é INCERTO e a mensagem tem de dizer "não crie outro".
  if (incerto && codigo === CODIGOS.TIMEOUT) codigo = CODIGOS.RESULTADO_INCERTO

  return montar({
    ...comum,
    status,
    codigo,
    httpLocal: regra.httpLocal,
    estado: incerto ? ESTADO.INCERTO : ESTADO.FALHA_SEGURA,
    alerta: regra.alerta,
    indiceItem: r.indiceItem,
  })
}

module.exports = {
  ESTADO,
  OPERACAO,
  CODIGOS,
  MENSAGENS,
  POR_CODIGO_WM,
  mapearErroWm,
}
