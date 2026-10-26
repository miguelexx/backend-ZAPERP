'use strict'

const crypto = require('crypto')

const supabase = require('../../config/supabase')
const wmApiClient = require('./wmApiClient')
const configService = require('./wmIntegrationConfigService')
const stateMachine = require('./wmOrcamentoStateMachine')
const { registrarEventoOrcamento, EVENTOS } = require('./wmOrcamentoAuditoria')
const { mapearErroWm, OPERACAO, ESTADO, CODIGOS: CODIGOS_WM } = require('../../helpers/wmErrorMapper')
const {
  LIMITES,
  PADRAO_DECIMAL,
  validarPayloadPreparar,
  validarPayloadCriar,
} = require('../../validators/wmOrcamentosValidators')

/**
 * Miolo do orçamento manual × API WM — Sessões 4A, 4B e 6 do doc 36.
 *
 * A Sessão 6 ligou o despacho: a partir dela este módulo **escreve em sistema de terceiro**.
 * Há exatamente UM ponto onde isso acontece (`despacharCriacao`, chamado por `confirmar` e por
 * `verificar`), ele chama `wmApiClient.criarOrcamento` SEM `retryOpts` — uma tentativa — e tudo
 * o que vem antes dele existe para que ele saia no máximo uma vez por confirmação de negócio.
 *
 *   1. LAÇO DE AMBIGUIDADE — recebe o rascunho inteiro (cliente por busca ou código, vendedor
 *      por busca ou código, itens com busca ou código + quantidade, páginas), chama `preparar`
 *      na WM e devolve ao controller OU a ambiguidade a resolver OU a preparação pronta.
 *   2. SNAPSHOT SERVER-SIDE — em `pronto_para_confirmacao`, monta e persiste o payload exato de
 *      `criar` em `payload_criacao` + `payload_hash`, e devolve à UI só um `preparacao_id`
 *      opaco e a prévia sanitizada. No `confirmar`, preço e códigos vindos do navegador são
 *      IGNORADOS — nem são lidos.
 *   3. IDEMPOTÊNCIA — `comando_id` gerado aqui (nunca no navegador), uma vez por confirmação de
 *      negócio, persistido pela própria transição atômica `PREPARADO → ENVIANDO`.
 *
 * O QUE NÃO SE FAZ, EM NENHUMA CIRCUNSTÂNCIA
 *
 *   · **Escolher candidato automaticamente.** Nem quando a página tem um único registro:
 *     `04-contratos-api.md` é explícito — "a última página com um único registro não resolve
 *     automaticamente se total>1". Aqui não existe caminho de código que selecione: a
 *     ambiguidade sempre volta para a tela.
 *   · **Corrigir página.** Página além da última é `400 PAGINA_FORA_DO_INTERVALO` da WM e
 *     atravessa como 400, sem clamp e sem "voltar para a última".
 *   · **Reformatar preço.** A WM serializa `0.00##` invariant (ex.: `33.038`). O valor é
 *     copiado byte a byte, sem `Number`, sem `parseFloat`, sem arredondar, sem cortar zero.
 *   · **Repetir POST.** `preparar` só repete erro de conexão (o cliente HTTP cuida);
 *     `criar` tem uma tentativa e só. Nada aqui chama a WM em laço.
 *   · **Gerar `comando_id` novo para um `INCERTO`.** D10: verificar é reenviar o payload
 *     IDÊNTICO com o MESMO `comando_id`, por ação explícita do usuário.
 *
 * ISOLAMENTO (pendência 13: a WM não prova vínculo de tenant — o isolamento é 100% nosso)
 *
 *   · `company_id` chega sempre por argumento, vindo de `req.user.company_id`. Este módulo não
 *     conhece `req` e não lê body, query nem header.
 *   · TODA query carrega `.eq('company_id', …)`. O cliente Supabase usa SERVICE_ROLE e ignora
 *     RLS: um filtro ausente vaza entre empresas sem nenhuma rede de proteção.
 *   · Uma preparação da empresa A é **inexistente** para a empresa B (404, não 403 — 403
 *     confirmaria que o UUID existe em algum lugar).
 *   · O telefone autorizado é resolvido aqui, no servidor, a partir do `company_id`, e nunca
 *     entra em resposta, log, auditoria **nem no snapshot** (ver `payload_criacao` abaixo).
 */

const TABELA = 'wm_orcamento_operacoes'

/**
 * Colunas devolvidas pelas escritas/leituras internas. `payload_criacao` só é lido onde é
 * necessário (despacho e verificação) — não entra nesta lista por descuido.
 */
const COLUNAS_OPERACAO = [
  'id',
  'company_id',
  'usuario_id',
  'conversa_id',
  'estado',
  'comando_id',
  'payload_hash',
  'previa_sanitizada',
  // Resultado sanitizado do `200` da criação: é por ele que a tela mostra o número do
  // orçamento (`codigo_pedido_erp`) depois de um F5. Sem ele nesta lista, `projetarOperacao`
  // devolveria `resultado: null` para uma operação já CRIADA.
  'wm_resultado_sanitizado',
  'http_status_ultimo',
  'erro_codigo_ultimo',
  'tentativas',
  'expira_em',
  'enviado_em',
  'concluido_em',
  'criado_em',
  'atualizado_em',
].join(', ')

/**
 * Prazo local da preparação. Curto de propósito: a prévia carrega preço e estoque realtime do
 * ERP, e confirmar uma prévia velha gravaria preço velho. A pendência 6 (SLA/timeout da WM)
 * está ABERTA, então este número é decisão local, não contrato.
 */
const TTL_PREPARACAO_PADRAO_MS = 10 * 60 * 1000
const TTL_PREPARACAO_MIN_MS = 60 * 1000
const TTL_PREPARACAO_MAX_MS = 60 * 60 * 1000

/** Códigos locais do envelope. Estáveis: frontend e runbook dependem deles. */
const CODIGOS = Object.freeze({
  PREPARACAO_NAO_ENCONTRADA: 'ORCAMENTO_PREPARACAO_NAO_ENCONTRADA',
  PREPARACAO_EXPIRADA: 'ORCAMENTO_PREPARACAO_EXPIRADA',
  JA_CRIADO: 'ORCAMENTO_JA_CRIADO',
  EM_ANDAMENTO: 'ORCAMENTO_EM_ANDAMENTO',
  ESTADO_INVALIDO: 'ORCAMENTO_ESTADO_INVALIDO',
  SNAPSHOT_DIVERGENTE: 'ORCAMENTO_SNAPSHOT_DIVERGENTE',
  SNAPSHOT_AUSENTE: 'ORCAMENTO_SNAPSHOT_AUSENTE',
  PERSISTENCIA_INDISPONIVEL: 'ORCAMENTO_PERSISTENCIA_INDISPONIVEL',
})

const MENSAGENS = Object.freeze({
  [CODIGOS.PREPARACAO_NAO_ENCONTRADA]: 'Este orçamento não está mais disponível. Monte o orçamento de novo.',
  [CODIGOS.PREPARACAO_EXPIRADA]: 'O tempo para confirmar este orçamento acabou. Calcule de novo para ver os valores atuais.',
  [CODIGOS.JA_CRIADO]: 'Este orçamento já foi criado no ERP.',
  [CODIGOS.EM_ANDAMENTO]: 'Este orçamento já está sendo criado. Aguarde — não crie outro.',
  [CODIGOS.ESTADO_INVALIDO]: 'Este orçamento não pode mais ser confirmado. Monte o orçamento de novo.',
  [CODIGOS.SNAPSHOT_DIVERGENTE]: 'Não foi possível confirmar este orçamento com segurança. Procure o suporte.',
  [CODIGOS.SNAPSHOT_AUSENTE]: 'Não foi possível confirmar este orçamento com segurança. Monte o orçamento de novo.',
  [CODIGOS.PERSISTENCIA_INDISPONIVEL]: 'Não foi possível registrar o orçamento agora. Tente de novo em instantes.',
})

const PADRAO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const STATUS_AMBIGUIDADE = Object.freeze({
  CLIENTE: 'multiplos_clientes',
  VENDEDOR: 'multiplos_vendedores',
  PRODUTO: 'produto_ambiguo',
})
const STATUS_PRONTO = 'pronto_para_confirmacao'

function ehObjetoSimples(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function agoraIso() {
  return new Date().toISOString()
}

function novoRequestId() {
  try { return crypto.randomUUID() } catch { return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}` }
}

function ttlPreparacaoMs() {
  const n = Number(process.env.WM_ORCAMENTOS_PREPARACAO_TTL_MS)
  if (!Number.isFinite(n) || n <= 0) return TTL_PREPARACAO_PADRAO_MS
  return Math.min(Math.max(Math.trunc(n), TTL_PREPARACAO_MIN_MS), TTL_PREPARACAO_MAX_MS)
}

/**
 * Política `bloquear_apos_criar` (pendência 10: obrigatória em `preparar`, default `true` em
 * `criar`, semântica funcional indocumentada). Decisão local do doc 36: default `true`, **o
 * mesmo valor** nas duas chamadas, guardado no snapshot — a prévia foi calculada sob aquela
 * política, então mudar entre preparar e criar mudaria o que o atendente aprovou.
 *
 * Hoje é interruptor de ambiente; quando virar coluna por empresa, só esta função muda.
 */
function politicaBloquearAposCriar() {
  const raw = String(process.env.WM_ORCAMENTOS_BLOQUEAR_APOS_CRIAR ?? '').trim().toLowerCase()
  if (raw === 'false' || raw === '0') return false
  return true
}

/** Envelope local, no mesmo formato do `wmErrorMapper` para a UI tratar num lugar só. */
function erroLocal({ codigo, httpStatus, requestId, estado = ESTADO.FALHA_SEGURA, mensagem }) {
  return {
    ok: false,
    httpStatus,
    envelope: {
      ok: false,
      codigo,
      mensagem: mensagem || MENSAGENS[codigo] || 'Não foi possível concluir a operação.',
      estado,
      requestId,
    },
    interno: { httpStatusLocal: httpStatus, codigoLocal: codigo },
  }
}

function erroDeResultadoWm({ resultado, operacao, requestId }) {
  const { envelope, interno } = mapearErroWm({ resultado, operacao, requestId })
  return { ok: false, httpStatus: interno.httpStatusLocal, envelope, interno }
}

/**
 * Resolve o contato autorizado da empresa (o seletor de tenant do lado da WM).
 *
 * GÊMEO INTENCIONAL de `resolverContatoAutorizado` em `wmAssistenteService.js`: os dois
 * caminhos (leitura e orçamento) resolvem a identidade de forma independente, com os mesmos
 * limites do `openapi.yaml` (`telefone` 8–30). `tests/wmOrcamentoPreparacao.test.js` prova que
 * os limites continuam iguais nos dois.
 *
 * A mensagem de erro NUNCA cita o valor do telefone, nem parcialmente.
 */
async function resolverContatoAutorizado(companyId) {
  const row = await configService.obterConfigInterna(companyId)
  if (!row) return { erro: 'integracao_empresa_ausente' }
  if (!row.ativo) return { erro: 'integracao_empresa_inativa' }
  const telefone = String(row.telefone_autorizado ?? '').trim()
  if (!telefone) return { erro: 'telefone_autorizado_ausente' }
  if (telefone.length < LIMITES.TELEFONE_MIN || telefone.length > LIMITES.TELEFONE_MAX) {
    return { erro: 'telefone_autorizado_invalido' }
  }
  return { telefone }
}

/* ================================================================== *
 * Extração prévia → payload de criação — schema REAL (2ª remessa)
 * ================================================================== */

/**
 * Decimal da WM: STRING, no padrão do contrato, devolvida IDÊNTICA. Nunca convertida.
 *
 * Fora do padrão ⇒ `null`. Em preço isso vira recusa da preparação (o chamador decide); em
 * campo de exibição, vira "—" na tela. O que não acontece em lugar nenhum é `Number`,
 * arredondamento ou reformatação: a WM confere o preço byte a byte e os totais são o que ela
 * calculou. `estoque_previsto` **não** passa por aqui — pode ser negativo e o padrão não aceita
 * sinal (ver `projetarCandidatoProduto`, mesma razão).
 */
function decimalExato(valor) {
  if (typeof valor !== 'string') return null
  if (valor.length === 0 || valor.length > LIMITES.DECIMAL_MAX_LEN) return null
  if (!PADRAO_DECIMAL.test(valor)) return null
  return valor
}

/**
 * Converte a prévia `pronto_para_confirmacao` no payload exato de `POST /orcamentos/criar` e
 * na prévia exibível que a UI recebe.
 *
 * **Fonte:** §8 (shape da prévia), §8.1 (campo de preço) e §9.2 (mapeamento obrigatório) do
 * guia `docs/wm/Integracao-ZapERP-API-WM-Atualizacao-2026-10-20`. A 2ª remessa do contrato
 * (20/10/2026) fechou a pendência 1 e a costura provisória da Sessão 4A — listas de nomes
 * plausíveis, tentados em ordem — saiu daqui inteira. O `openapi.yaml` ainda não modela a
 * prévia dentro de `PrepararOrcamentoResposta.dados`, então o shape do guia é a única fonte e
 * só os campos abaixo atravessam: tudo o mais que vier em `dados` é descartado.
 *
 * O mapeamento, literal (§9.2):
 *
 *   | prévia                                 | criação                       |
 *   |----------------------------------------|-------------------------------|
 *   | `dados.cliente.codigo_cliente_erp`     | `cliente_codigo_erp`          |
 *   | `dados.vendedor.codigo_vendedor_erp`   | `vendedor_codigo_erp`         |
 *   | `dados.itens[i].codigo_produto_erp`    | `itens[i].codigo_produto_erp` |
 *   | `dados.itens[i].quantidade`            | `itens[i].quantidade`         |
 *   | `dados.itens[i].preco_unitario`        | `itens[i].preco_confirmado`   |
 *   | `dados.bloquear_apos_criar`            | `bloquear_apos_criar`         |
 *
 * **O preço sai de `dados.itens[].preco_unitario` e de lugar nenhum mais.** §8.1 é explícito:
 * é PROIBIDO recalcular por `valor_total / quantidade`, buscar outra fonte ou mudar a escala.
 * Aqui isso é mecânico — se o valor não vier como STRING decimal, a extração FALHA
 * (`previa_preco_invalido`). `Number` introduziria desvio de float num valor que a WM confere
 * byte a byte, e a divisão ainda perderia a escala (`28.900` viraria `28.9`).
 *
 * **A quantidade da criação é a da PRÉVIA.** A WM devolve `"2.000"` mesmo quando enviamos
 * `"2"` (§8 contra §7.1) e §9.2 manda copiar a da prévia. O rascunho fica só como fallback
 * para o caso de a prévia não trazer a quantidade como string — nunca um número da prévia
 * convertido.
 *
 * **`bloquear_apos_criar` vem da prévia quando a prévia o traz** (§9.2), com a política da
 * empresa como fallback. Se os dois discordarem, a WM recalculou a prévia sob outra política:
 * o valor da prévia vence (é sob ele que o preço foi calculado) e a divergência sai no
 * `bloqueio_divergente` para quem chama registrar. Divergência silenciosa aqui seria pior.
 *
 * O que ela continua NÃO fazendo, e isso nunca foi provisório:
 *   · não deriva preço de nada;
 *   · não usa o preço do rascunho nem de candidato de ambiguidade como preço de criação;
 *   · não inventa cliente/vendedor canônico: sem código canônico na prévia, falha;
 *   · não inclui `telefone` nem `comando_id` no snapshot (ver `montarPayloadDespacho`);
 *   · não inclui CPF/CNPJ/IE na prévia sanitizada — nem do candidato escolhido (seção 6);
 *   · não envia `preco_negociado`. O `openapi.yaml` da 2ª remessa passou a aceitá-lo nos itens
 *     de `preparar` e de `criar`, mas o guia afirma em §7.1 e §9.1 que nenhuma das duas o
 *     aceita, e o próprio schema avisa que só um "Worker compatível" aplica a negociação — num
 *     Worker antigo o desconto seria ignorado em silêncio e o ERP gravaria o preço cheio. É
 *     campo opcional: não enviar é seguro e concorda com o guia. Pendência nova na seção 10.
 *
 * **Premissa explícita de ordem:** os itens da prévia correspondem 1:1, **por índice**, aos
 * itens enviados. É o que o contrato implica ao definir `indice_item` como "índice zero-based
 * no array itens enviado". Contagem diferente ⇒ `previa_itens_divergentes`, nunca casamento
 * por heurística de descrição.
 *
 * @param {object} args
 * @param {object} args.dados    `dados` da resposta 200 de `preparar` (status pronto)
 * @param {object} [args.meta]   `meta` da MESMA resposta; `fonte` é opcional no contrato
 * @param {object} args.rascunho rascunho validado que gerou a preparação
 * @param {boolean} args.bloquear_apos_criar política da empresa usada NA PREPARAÇÃO
 * @returns {{ ok: true, payload_criacao: object, previa_sanitizada: object, bloqueio_divergente: boolean }|{ ok: false, motivo: string }}
 */
function extrairPayloadCriacaoDaPrevia({ dados, meta, rascunho, bloquear_apos_criar } = {}) {
  if (!ehObjetoSimples(dados)) return { ok: false, motivo: 'previa_ausente' }
  if (!ehObjetoSimples(rascunho) || !Array.isArray(rascunho.itens)) {
    return { ok: false, motivo: 'rascunho_invalido' }
  }

  /**
   * Objeto canônico de cliente/vendedor: `{ <chaveCodigo>, nome }`, exatamente como §8.
   * Código achatado na raiz de `dados` **não** é aceito — era hipótese da costura provisória.
   */
  function canonico(objeto, chaveCodigo) {
    if (!ehObjetoSimples(objeto)) return null
    const codigo = objeto[chaveCodigo]
    if (typeof codigo !== 'string' || codigo.trim().length === 0) return null
    if (codigo.length > LIMITES.CODIGO_ERP_MAX) return null
    const nome = objeto.nome
    return { codigo, nome: typeof nome === 'string' && nome.trim() ? nome : null }
  }

  const itensPrevia = dados.itens
  if (!Array.isArray(itensPrevia) || itensPrevia.length === 0) {
    return { ok: false, motivo: 'previa_sem_itens' }
  }

  const cliente = canonico(dados.cliente, 'codigo_cliente_erp')
  if (!cliente) return { ok: false, motivo: 'previa_sem_cliente_canonico' }

  const vendedor = canonico(dados.vendedor, 'codigo_vendedor_erp')
  if (!vendedor) return { ok: false, motivo: 'previa_sem_vendedor_canonico' }

  if (itensPrevia.length !== rascunho.itens.length) {
    // Premissa de ordem quebrada: não casar por heurística.
    return { ok: false, motivo: 'previa_itens_divergentes' }
  }
  if (itensPrevia.length > LIMITES.ITENS_MAX) return { ok: false, motivo: 'previa_itens_divergentes' }

  const itensPayload = []
  const itensExibicao = []
  for (let i = 0; i < itensPrevia.length; i++) {
    const bruto = itensPrevia[i]
    if (!ehObjetoSimples(bruto)) return { ok: false, motivo: 'previa_item_invalido' }

    const codigoBruto = bruto.codigo_produto_erp
    if (typeof codigoBruto !== 'string' || codigoBruto.trim().length === 0) {
      return { ok: false, motivo: 'previa_item_sem_codigo' }
    }
    if (codigoBruto.length > LIMITES.CODIGO_PRODUTO_MAX) {
      return { ok: false, motivo: 'previa_item_codigo_longo' }
    }

    // §8.1: o preço oficial da prévia, e só ele. `number` é recusado de propósito.
    const preco = decimalExato(bruto.preco_unitario)
    if (preco === null) return { ok: false, motivo: 'previa_preco_invalido' }

    // §9.2: a quantidade da prévia (`"2.000"`), com a que NÓS enviamos (string já validada
    // `> 0`) como fallback. Nunca um número da prévia convertido.
    const quantidadePrevia = decimalExato(bruto.quantidade)
    const quantidade = quantidadePrevia ?? rascunho.itens[i]?.quantidade
    if (typeof quantidade !== 'string' || !PADRAO_DECIMAL.test(quantidade) || !/[1-9]/.test(quantidade)) {
      return { ok: false, motivo: 'previa_quantidade_invalida' }
    }

    itensPayload.push({ codigo_produto_erp: codigoBruto, quantidade, preco_confirmado: preco })
    itensExibicao.push({
      codigo_produto_erp: codigoBruto,
      descricao: textoCurto(bruto.descricao),
      quantidade,
      preco_unitario: preco,
      // `estoque_previsto` é `0.000` invariant e PODE SER NEGATIVO (`-2.125`), então não passa
      // pelo padrão decimal (que não aceita sinal) — é texto de exibição, nunca entra em conta.
      estoque_previsto: textoCurto(bruto.estoque_previsto, LIMITES.DECIMAL_MAX_LEN),
      valor_total: decimalExato(bruto.valor_total),
      // DESCONTO APLICADO PELO ERP. Hoje vem zerado na MARGRE (`valor_desconto_unit: "0.00"`,
      // `valor_total_bruto` igual ao `valor_total`), mas é o ERP que decide — tabela
      // promocional, política por cliente. Sem estes dois campos, um desconto real apareceria
      // só como um total menor, sem dizer de onde veio, e o atendente não teria como explicar
      // o preço ao cliente. São exibição: não entram em conta nenhuma e não vão para `criar`.
      valor_total_bruto: decimalExato(bruto.valor_total_bruto),
      valor_desconto_unit: decimalExato(bruto.valor_desconto_unit),
    })
  }

  const bloquearPolitica = bloquear_apos_criar === true
  const bloquearPrevia = typeof dados.bloquear_apos_criar === 'boolean' ? dados.bloquear_apos_criar : null
  const bloquearFinal = bloquearPrevia === null ? bloquearPolitica : bloquearPrevia

  // Payload de `criar` SEM `telefone` e SEM `comando_id` — os dois são injetados no despacho
  // (`montarPayloadDespacho`). Motivo: o telefone é segredo operacional e não precisa viver
  // numa segunda tabela, e o `comando_id` só nasce na confirmação, depois deste snapshot.
  const payload_criacao = {
    cliente_codigo_erp: cliente.codigo,
    vendedor_codigo_erp: vendedor.codigo,
    bloquear_apos_criar: bloquearFinal,
    itens: itensPayload,
  }

  // Prévia exibível. Sem CPF/CNPJ/IE: documento de candidato não selecionado nunca é
  // persistido (seção 6), e o do selecionado não é necessário para aprovar o orçamento.
  const previa_sanitizada = {
    cliente: { codigo_cliente_erp: cliente.codigo, nome: cliente.nome },
    vendedor: { codigo_vendedor_erp: vendedor.codigo, nome: vendedor.nome },
    itens: itensExibicao,
    valor_produtos: decimalExato(dados.valor_produtos),
    valor_total: decimalExato(dados.valor_total),
    bloquear_apos_criar: bloquearFinal,
    meta: projetarFonte(meta),
  }

  return { ok: true, payload_criacao, previa_sanitizada, bloqueio_divergente: bloquearPrevia !== null && bloquearPrevia !== bloquearPolitica }
}

/**
 * `meta.fonte` da resposta da WM, lido defensivamente.
 *
 * O `openapi.yaml` modela `meta` apenas como `type: object` — sem enum, sem obrigatoriedade —
 * então `fonte` PODE FALTAR e não pode quebrar nada. O guia só exibe `"tempo_real"`;
 * `04-contratos-api.md` fala em cache cloud para a descoberta de produtos.
 *
 * `tempo_real` é derivado aqui, e de propósito: a UI não pode escrever "atual"/"agora" a
 * partir de um rótulo que ela interpretou sozinha. Ele é `true` **só** com a prova explícita
 * `fonte === 'tempo_real'`. Ausente, desconhecido ou `cache_cloud` ⇒ `false` — é a mesma
 * regra da Sessão 3A (`candidatos_origem: 'cache_cloud'` viaja junto para a tela NÃO poder
 * dizer "estoque atual").
 */
function projetarFonte(meta) {
  const bruto = ehObjetoSimples(meta) ? meta.fonte : null
  const fonte = typeof bruto === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(bruto) ? bruto : null
  return { fonte, tempo_real: fonte === 'tempo_real' }
}

/* ================================================================== *
 * Normalização do 200 de `/orcamentos/criar` — schema REAL (2ª remessa)
 * ================================================================== */

/**
 * Traduz o `200` de `POST /orcamentos/criar` no resultado sanitizado que vai para
 * `wm_resultado_sanitizado` e, adiante, para a tela e para o resumo ao cliente.
 *
 * **Função PURA e que NÃO DESPACHA NADA.** O despacho continua sendo a Sessão 6; aqui só se
 * lê um corpo que alguém já recebeu. Fonte: §10 e §11.1 do guia da 2ª remessa (pendência 2,
 * agora respondida) — o `openapi.yaml` segue sem schema para este `200`.
 *
 * **O número do orçamento é `dados.codigo_pedido_erp`** (§10 e §13). Sem ele, não há resultado
 * utilizável: devolve `resultado_sem_codigo_pedido` em vez de inventar um número.
 *
 * ⚠️ **NÃO EXISTE, E NÃO SE INVENTA, A DISTINÇÃO "criado agora" × "resultado idempotente".**
 * §11.1 é explícito: o `200` não tem hoje campo que diferencie os dois, os dois são sucesso da
 * MESMA ação de negócio, e é PROIBIDO inferir a diferença por `meta.criado_em`. Se a interface
 * precisar dessa distinção, ela vem do NOSSO estado local — a operação já estava `CRIADO`
 * antes da chamada? — e nunca da resposta da WM. Por isso:
 *   · `criado_em` é repassado como carimbo informativo e nada o lê para decidir nada;
 *   · nenhum campo de saída se chama `criado_agora`/`novo`/`reaproveitado`;
 *   · `meta.resultado_comando` **não é consumido**: §15 diz que é só sugestão de evolução e
 *     não existe na API. Ler agora criaria dependência de um campo inexistente.
 *
 * `documento_venda` ("2 - Orçamento") é rótulo de exibição e `bloqueado` é o estado de
 * proteção do orçamento — não o campo técnico `Fechado` do ERP (§10).
 *
 * @param {object} args
 * @param {object} args.dados  `dados` do corpo 200
 * @param {object} [args.meta] `meta` do mesmo corpo
 * @returns {{ ok: true, resultado_sanitizado: object }|{ ok: false, motivo: string }}
 */
function normalizarResultadoCriacao({ dados, meta } = {}) {
  if (!ehObjetoSimples(dados)) return { ok: false, motivo: 'resultado_ausente' }

  // O número do orçamento é identificador: não é truncado, não é aparado, não é "limpado".
  // Truncar `9999…` a 20 caracteres produziria um número ERRADO com cara de válido, e é por ele
  // que o orçamento vai ser procurado no Icthus. Fora do formato ⇒ recusa.
  const codigoPedido = dados.codigo_pedido_erp
  if (typeof codigoPedido !== 'string' || codigoPedido.trim().length === 0) {
    return { ok: false, motivo: 'resultado_sem_codigo_pedido' }
  }
  if (codigoPedido.length > LIMITES.CODIGO_ERP_MAX || /[\u0000-\u001f\u007f]/.test(codigoPedido)) {
    return { ok: false, motivo: 'resultado_codigo_pedido_invalido' }
  }

  function canonicoExibicao(objeto, chaveCodigo) {
    if (!ehObjetoSimples(objeto)) return null
    const codigo = textoCurto(objeto[chaveCodigo], LIMITES.CODIGO_ERP_MAX)
    if (!codigo) return null
    return { [chaveCodigo]: codigo, nome: textoCurto(objeto.nome) }
  }

  const resultado_sanitizado = {
    codigo_pedido_erp: codigoPedido,
    documento_venda: textoCurto(dados.documento_venda, 60),
    cliente: canonicoExibicao(dados.cliente, 'codigo_cliente_erp'),
    vendedor: canonicoExibicao(dados.vendedor, 'codigo_vendedor_erp'),
    // Valor como veio: string decimal da WM, sem reformatar (mesma regra do preço). Fora do
    // padrão decimal ⇒ `null`, para a tela mostrar "—" em vez de texto solto num total.
    valor_total: decimalExato(dados.valor_total),
    bloqueado: typeof dados.bloqueado === 'boolean' ? dados.bloqueado : null,
    meta: {
      ...projetarFonte(meta),
      // Carimbo da WM, repassado como texto. `2026-10-20T15:40:00` não tem fuso, então não é
      // convertido para `Date` em lugar nenhum — e, por §11.1, não decide nada.
      criado_em: textoCurto(ehObjetoSimples(meta) ? meta.criado_em : null, 40),
    },
  }

  return { ok: true, resultado_sanitizado }
}

/* ================================================================== *
 * Projeção das ambiguidades (totalmente especificadas no contrato)
 * ================================================================== */

/**
 * Paginação de ambiguidade (`PaginacaoOrcamento`). Fora do formato → `null`: a lista ainda
 * serve, a UI fica sem navegação. É a mesma leniência da Sessão 3A, pelo mesmo motivo (o
 * rollout da WM é Worker → API → consumidor). O que não se faz é inventar `tem_mais`.
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

function textoCurto(valor, max = 200) {
  if (typeof valor !== 'string') return null
  const limpo = valor.replace(/\u0000/g, '').slice(0, max)
  return limpo.length ? limpo : null
}

/**
 * Candidato de cliente — `CandidatoCliente`: código, nome, cpf, cnpj, inscricao_estadual.
 *
 * Os documentos VÃO para a tela (é o que distingue dois homônimos, e é exatamente para isso
 * que a WM os enriqueceu), mas **nunca** para banco, log ou auditoria: a lista de candidatos
 * não é persistida em lugar nenhum deste módulo.
 */
function projetarCandidatoCliente(c) {
  if (!ehObjetoSimples(c)) return null
  const codigo = textoCurto(c.codigo_cliente_erp, LIMITES.CODIGO_ERP_MAX)
  if (!codigo) return null
  return {
    codigo_cliente_erp: codigo,
    nome: textoCurto(c.nome),
    cpf: textoCurto(c.cpf, 20),
    cnpj: textoCurto(c.cnpj, 20),
    inscricao_estadual: textoCurto(c.inscricao_estadual, 20),
  }
}

/** Candidato de vendedor — `{ codigo_vendedor_erp, nome }`. */
function projetarCandidatoVendedor(c) {
  if (!ehObjetoSimples(c)) return null
  const codigo = textoCurto(c.codigo_vendedor_erp, LIMITES.CODIGO_ERP_MAX)
  if (!codigo) return null
  return { codigo_vendedor_erp: codigo, nome: textoCurto(c.nome) }
}

/**
 * Candidato de produto — `CandidatoProdutoOrcamento`. Aqui preço e estoque EXISTEM e são
 * realtime (ao contrário de `/produtos/consultar`, que é cache cloud e não os traz). Strings
 * copiadas como vieram: preço `0.00##`, estoque `0.000` podendo ser negativo (ex.: `-2.125`),
 * e por isso o estoque **não** passa pelo padrão decimal (que não aceita sinal).
 */
function projetarCandidatoProduto(c) {
  if (!ehObjetoSimples(c)) return null
  const codigo = textoCurto(c.codigo_produto_erp, LIMITES.CODIGO_PRODUTO_MAX)
  if (!codigo) return null
  return {
    codigo_produto_erp: codigo,
    descricao: textoCurto(c.descricao),
    unidade: textoCurto(c.unidade, 20),
    preco_unitario: textoCurto(c.preco_unitario, LIMITES.DECIMAL_MAX_LEN),
    estoque_previsto: textoCurto(c.estoque_previsto, LIMITES.DECIMAL_MAX_LEN),
  }
}

/**
 * Traduz a ambiguidade da WM na forma que a UI consome, **devolvendo o rascunho inteiro**.
 *
 * Isto é o coração do laço: ao paginar, o navegador manda o mesmo rascunho com uma página
 * diferente, e o que muda na resposta é só a lista de `candidatos`. `indice_item` é zero-based
 * e sobrevive à ida e à volta sem deslocamento — `produto_ambiguo` sem ele é resposta fora do
 * contrato, não "item 0".
 *
 * NENHUM candidato é escolhido aqui, nem quando a lista tem um só: pelo `04-contratos-api.md`,
 * "a última página com um único registro não resolve automaticamente se total>1".
 */
function projetarAmbiguidade({ dados, rascunho }) {
  const status = dados?.status
  const candidatosBrutos = Array.isArray(dados?.candidatos) ? dados.candidatos : null
  if (!candidatosBrutos) return { ok: false, motivo: 'ambiguidade_sem_candidatos' }

  let projetar = null
  if (status === STATUS_AMBIGUIDADE.CLIENTE) projetar = projetarCandidatoCliente
  else if (status === STATUS_AMBIGUIDADE.VENDEDOR) projetar = projetarCandidatoVendedor
  else if (status === STATUS_AMBIGUIDADE.PRODUTO) projetar = projetarCandidatoProduto
  else return { ok: false, motivo: 'status_desconhecido' }

  const candidatos = []
  for (const bruto of candidatosBrutos) {
    const p = projetar(bruto)
    // Candidato sem código não é selecionável. Descartar em silêncio deixaria buraco na lista
    // e esconderia mudança de contrato — melhor recusar a resposta inteira.
    if (!p) return { ok: false, motivo: 'candidato_invalido' }
    candidatos.push(p)
  }

  const saida = {
    status,
    candidatos,
    paginacao: projetarPaginacao(dados.paginacao),
    // O rascunho volta intacto: é ele que o navegador reenvia com a escolha ou com a página
    // seguinte. A UI não precisa (e não deve) reconstruir estado de negócio.
    rascunho,
  }

  if (status === STATUS_AMBIGUIDADE.PRODUTO) {
    const idx = dados.indice_item
    if (!Number.isInteger(idx) || idx < 0 || idx >= rascunho.itens.length) {
      return { ok: false, motivo: 'indice_item_invalido' }
    }
    saida.indice_item = idx
  }

  return { ok: true, resultado: saida }
}

/* ================================================================== *
 * Persistência
 * ================================================================== */

/**
 * Invalida as preparações vivas do mesmo usuário na mesma conversa.
 *
 * É assim que "qualquer alteração de cliente, vendedor, produto, quantidade ou política
 * invalida a preparação anterior" fica garantido **sem depender de comparar campos**: existe
 * no máximo UMA preparação `PREPARADO` por usuário e conversa, e preparar de novo (com o que
 * for) aposenta a anterior. Comparar campo a campo deixaria escapar o campo que alguém
 * esquecesse de comparar; isto não deixa.
 *
 * `EXPIRADO` é transição válida de `PREPARADO` na máquina de estados, e só atinge `PREPARADO`
 * — `ENVIANDO`, `CRIADO`, `INCERTO` e `FALHA_SEGURA` nunca são tocados por aqui.
 */
async function invalidarPreparacoesAnteriores({ company_id, usuario_id, conversa_id }) {
  const patch = { estado: stateMachine.ESTADOS.EXPIRADO, atualizado_em: agoraIso() }
  let q = supabase
    .from(TABELA)
    .update(patch)
    .eq('company_id', company_id)
    .eq('estado', stateMachine.ESTADOS.PREPARADO)
  if (usuario_id != null) q = q.eq('usuario_id', usuario_id)
  if (conversa_id != null) q = q.eq('conversa_id', conversa_id)
  else q = q.is('conversa_id', null)
  const { error } = await q
  if (error) {
    // Não é fatal: a preparação nova nasce válida e a antiga, se sobreviver, ainda tem de
    // passar pela transição atômica. Mas é sinal de banco ruim e precisa aparecer no log.
    console.warn('[wmOrcamentoService] não foi possível expirar preparações anteriores', company_id)
  }
}

/** Lê uma operação da PRÓPRIA empresa. Sem linha ⇒ null (inexistente para quem perguntou). */
async function lerOperacao({ company_id, operacao_id, comPayload = false }) {
  const colunas = comPayload ? `${COLUNAS_OPERACAO}, payload_criacao` : COLUNAS_OPERACAO
  const { data, error } = await supabase
    .from(TABELA)
    .select(colunas)
    .eq('id', operacao_id)
    .eq('company_id', company_id)
    .maybeSingle()
  if (error) {
    console.warn('[wmOrcamentoService] leitura de operação indisponível', company_id)
    return { erro: 'persistencia' }
  }
  return { row: data || null }
}

/**
 * Projeção da operação para o navegador.
 *
 * O que NÃO sai, nunca: `comando_id` (idempotência é assunto do servidor; exposto, convidaria
 * o cliente a reenviá-lo), `payload_criacao` (tem o preço oficial e os códigos canônicos) e
 * `payload_hash`. O telefone autorizado não está em nenhuma dessas colunas — por desenho.
 */
function projetarOperacao(row) {
  if (!row) return null
  return {
    operacao_id: row.id,
    estado: row.estado,
    conversa_id: row.conversa_id ?? null,
    previa: row.previa_sanitizada ?? null,
    resultado: row.wm_resultado_sanitizado ?? null,
    expira_em: row.expira_em ?? null,
    enviado_em: row.enviado_em ?? null,
    concluido_em: row.concluido_em ?? null,
    criado_em: row.criado_em ?? null,
    erro_codigo: row.erro_codigo_ultimo ?? null,
    tentativas: Number(row.tentativas) || 0,
  }
}

function expirada(row, agora = Date.now()) {
  if (!row?.expira_em) return false
  const t = Date.parse(row.expira_em)
  if (!Number.isFinite(t)) return false
  return t <= agora
}

/* ================================================================== *
 * 1. preparar — laço de ambiguidade + snapshot
 * ================================================================== */

/**
 * Chama `orcamentos/preparar` na WM e devolve a ambiguidade a resolver OU a preparação pronta.
 *
 * Uma chamada por invocação: não há laço interno nem reexecução automática. O laço é do
 * usuário — ele escolhe um candidato (ou pede outra página), a UI reenvia o rascunho e a WM
 * eventualmente reporta a próxima ambiguidade. Pelo contrato, `dados.status` é um valor único e
 * `candidatos` é uma lista única: **uma ambiguidade por vez** (pendência 11, respondida).
 *
 * @param {object} args
 * @param {number} args.company_id  sempre de `req.user.company_id`
 * @param {number} [args.usuario_id]
 * @param {object} args.rascunho    saída de `validarPrepararBody` (inclui `conversa_id`)
 * @param {string} [args.requestId]
 */
async function preparar({ company_id, usuario_id = null, rascunho, requestId } = {}) {
  const rid = requestId || novoRequestId()
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) {
    // `auth` já exige company_id no token; chegar aqui é bug local, e bug local não vira
    // chamada externa com tenant indefinido.
    return erroDeResultadoWm({
      resultado: { configuracaoInvalida: 'company_id_invalido' },
      operacao: OPERACAO.PREPARACAO,
      requestId: rid,
    })
  }
  if (!ehObjetoSimples(rascunho) || !Array.isArray(rascunho.itens) || rascunho.itens.length === 0) {
    return erroLocal({ codigo: CODIGOS.SNAPSHOT_AUSENTE, httpStatus: 400, requestId: rid, mensagem: 'Monte o orçamento antes de calcular.' })
  }

  const contato = await resolverContatoAutorizado(cid)
  if (contato.erro) {
    return erroDeResultadoWm({
      resultado: { configuracaoInvalida: contato.erro },
      operacao: OPERACAO.PREPARACAO,
      requestId: rid,
    })
  }

  const bloquear_apos_criar = politicaBloquearAposCriar()

  // Payload da WM: telefone resolvido no servidor + só o que o validador aprovou. A política
  // vai aqui E no snapshot — a prévia é calculada sob ela (pendência 10).
  const payload = { telefone: contato.telefone, bloquear_apos_criar, itens: rascunho.itens }
  for (const campo of ['cliente_codigo_erp', 'cliente_busca', 'cliente_pagina', 'vendedor_codigo_erp', 'vendedor_busca', 'vendedor_pagina']) {
    if (rascunho[campo] !== undefined) payload[campo] = rascunho[campo]
  }

  const conferido = validarPayloadPreparar(payload)
  if (!conferido.ok) {
    // Conferência local antes de gastar chamada (e dinheiro) num payload que a WM recusaria.
    return erroLocal({ codigo: CODIGOS.SNAPSHOT_AUSENTE, httpStatus: 400, requestId: rid, mensagem: 'Revise os dados do orçamento e tente de novo.' })
  }

  const resultado = await wmApiClient.prepararOrcamento(conferido.value)
  if (!resultado.ok) {
    // Inclui `400 PAGINA_FORA_DO_INTERVALO` (sem clamp) e o `502` com `indice_item`, que o
    // mapeador já repassa no envelope.
    return erroDeResultadoWm({ resultado, operacao: OPERACAO.PREPARACAO, requestId: rid })
  }

  const dados = resultado.data?.dados
  if (!ehObjetoSimples(dados) || typeof dados.status !== 'string') {
    return erroDeResultadoWm({
      resultado: { ...resultado, ok: false, respostaInvalida: true },
      operacao: OPERACAO.PREPARACAO,
      requestId: rid,
    })
  }

  if (dados.status !== STATUS_PRONTO) {
    const amb = projetarAmbiguidade({ dados, rascunho })
    if (!amb.ok) {
      return erroDeResultadoWm({
        resultado: { ...resultado, ok: false, respostaInvalida: true },
        operacao: OPERACAO.PREPARACAO,
        requestId: rid,
      })
    }
    // Ambiguidade NÃO cria operação no banco: não há o que confirmar e persistir candidatos
    // guardaria CPF/CNPJ/IE de gente que o atendente nem escolheu.
    return { ok: true, resultado: amb.resultado, requestId: rid }
  }

  // ---- pronto_para_confirmacao: snapshot server-side ----
  const extraido = extrairPayloadCriacaoDaPrevia({ dados, meta: resultado.data?.meta, rascunho, bloquear_apos_criar })
  if (!extraido.ok) {
    // A prévia veio fora do shape documentado em §8 do guia. Falhar alto é o comportamento
    // certo — adivinhar de qual campo sai o preço é o único erro irreversível possível aqui.
    console.warn('[wmOrcamentoService] prévia fora do shape documentado', JSON.stringify({
      requestId: rid, company_id: cid, motivo: extraido.motivo,
    }))
    return erroDeResultadoWm({
      resultado: { ...resultado, ok: false, respostaInvalida: true },
      operacao: OPERACAO.PREPARACAO,
      requestId: rid,
    })
  }
  if (extraido.bloqueio_divergente) {
    // A WM ecoou `bloquear_apos_criar` diferente da política da empresa. O valor da prévia
    // vence (§9.2: é sob ele que o preço foi calculado), mas não passa calado.
    console.warn('[wmOrcamentoService] bloquear_apos_criar da prévia difere da política local', JSON.stringify({
      requestId: rid, company_id: cid, politica: bloquear_apos_criar === true,
    }))
  }

  // Defesa em profundidade: o payload do snapshot tem de passar pelo validador de `criar`
  // ANTES de ser guardado — com telefone e comando_id de prova, que NÃO são persistidos.
  const prova = validarPayloadCriar({
    ...extraido.payload_criacao,
    telefone: contato.telefone,
    comando_id: '00000000-0000-4000-8000-000000000000',
  })
  if (!prova.ok) {
    console.warn('[wmOrcamentoService] snapshot recusado pelo validador de criação', JSON.stringify({
      requestId: rid, company_id: cid, campo: prova.campo || null,
    }))
    return erroDeResultadoWm({
      resultado: { ...resultado, ok: false, respostaInvalida: true },
      operacao: OPERACAO.PREPARACAO,
      requestId: rid,
    })
  }

  const conversa_id = rascunho.conversa_id ?? null
  await invalidarPreparacoesAnteriores({ company_id: cid, usuario_id, conversa_id })

  const payload_hash = stateMachine.calcularPayloadHash(extraido.payload_criacao)
  const expira_em = new Date(Date.now() + ttlPreparacaoMs()).toISOString()

  const { data, error } = await supabase
    .from(TABELA)
    .insert({
      company_id: cid,
      usuario_id,
      conversa_id,
      estado: stateMachine.ESTADOS.PREPARADO,
      payload_criacao: extraido.payload_criacao,
      payload_hash,
      previa_sanitizada: extraido.previa_sanitizada,
      expira_em,
      criado_em: agoraIso(),
      atualizado_em: agoraIso(),
    })
    .select(COLUNAS_OPERACAO)
    .maybeSingle()

  if (error || !data?.id) {
    console.warn('[wmOrcamentoService] falha ao persistir preparação', cid)
    // Nada foi gravado no ERP: `preparar` não escreve. Falha segura, repreparar é seguro.
    return erroLocal({ codigo: CODIGOS.PERSISTENCIA_INDISPONIVEL, httpStatus: 503, requestId: rid })
  }

  await registrarEventoOrcamento({
    company_id: cid,
    usuario_id,
    acao: EVENTOS.PREPARADO,
    operacao_id: data.id,
    detalhes: {
      estado: stateMachine.ESTADOS.PREPARADO,
      payload_hash,
      conversa_id,
      itens_total: extraido.payload_criacao.itens.length,
    },
  })

  return {
    ok: true,
    requestId: rid,
    resultado: {
      status: STATUS_PRONTO,
      // Só o id opaco e a prévia sanitizada. Preço e códigos canônicos de criação ficam no
      // servidor; a UI não tem o que devolver na confirmação.
      preparacao_id: data.id,
      previa: extraido.previa_sanitizada,
      expira_em,
    },
  }
}

/* ================================================================== *
 * 2. confirmar — transição atômica + despacho
 * ================================================================== */

/**
 * Confirmação de negócio: gera o `comando_id`, persiste-o pela transição atômica
 * `PREPARADO → ENVIANDO` e só então despacha a criação ao ERP.
 *
 * A ORDEM É O DESENHO INTEIRO. O `comando_id` está no banco ANTES do POST, e o POST só sai
 * para quem venceu o UPDATE condicional. Duplo clique, duas abas, F5 e timeout disputam o
 * UPDATE, não a API da WM: quem perde recebe o estado atual e volta sem falar com ninguém.
 *
 * A TRAVA É O BANCO, não o rate limit e não o frontend. O SQL da seção 7 do doc 36:
 *
 *   UPDATE wm_orcamento_operacoes
 *      SET estado='ENVIANDO', comando_id=$uuid, enviado_em=now()
 *    WHERE id=$preparacao_id AND company_id=$jwt AND estado='PREPARADO' AND expira_em > now()
 *   RETURNING *
 *
 * Aqui ele é o mesmo UPDATE condicional via PostgREST (`.eq` + `.gt` + `.select()`). Única
 * diferença: `expira_em > now()` usa o relógio da API em vez do do banco, porque o PostgREST
 * não aceita `now()` em filtro. O TTL é de minutos e o desvio medido é de segundos, então não
 * muda decisão nenhuma — mas está registrado.
 *
 * Duplo clique, duas abas e F5 disputam o mesmo UPDATE: **uma** requisição casa a condição e
 * leva o `comando_id`; as outras recebem o estado atual e não chamam a WM. O UUID que o
 * perdedor gerou em memória é descartado sem nunca ter sido persistido nem despachado.
 */
async function confirmar({ company_id, usuario_id = null, preparacao_id, requestId } = {}) {
  const rid = requestId || novoRequestId()
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) {
    return erroLocal({ codigo: CODIGOS.PREPARACAO_NAO_ENCONTRADA, httpStatus: 404, requestId: rid })
  }
  if (typeof preparacao_id !== 'string' || !PADRAO_UUID.test(preparacao_id)) {
    return erroLocal({ codigo: CODIGOS.PREPARACAO_NAO_ENCONTRADA, httpStatus: 404, requestId: rid })
  }

  const atual = await lerOperacao({ company_id: cid, operacao_id: preparacao_id })
  if (atual.erro) return erroLocal({ codigo: CODIGOS.PERSISTENCIA_INDISPONIVEL, httpStatus: 503, requestId: rid })
  // Preparação de outra empresa é INEXISTENTE aqui: 404, não 403. Um 403 confirmaria a
  // existência do UUID e já seria vazamento entre empresas.
  if (!atual.row) return erroLocal({ codigo: CODIGOS.PREPARACAO_NAO_ENCONTRADA, httpStatus: 404, requestId: rid })

  const row = atual.row
  if (row.estado !== stateMachine.ESTADOS.PREPARADO) {
    return respostaEstadoNaoConfirmavel({ row, requestId: rid })
  }
  if (expirada(row)) {
    // Prazo local vencido: a prévia tem preço realtime e não pode virar gravação.
    await marcarExpirada({ company_id: cid, operacao_id: row.id })
    return erroLocal({ codigo: CODIGOS.PREPARACAO_EXPIRADA, httpStatus: 409, requestId: rid })
  }
  if (!row.payload_hash) {
    return erroLocal({ codigo: CODIGOS.SNAPSHOT_AUSENTE, httpStatus: 409, requestId: rid })
  }

  // A máquina de estados é a definição única das transições — nenhum caminho inventa a sua.
  stateMachine.assertTransicao(row.estado, stateMachine.ESTADOS.ENVIANDO)

  const comando_id = crypto.randomUUID()
  const agora = agoraIso()
  const { data, error } = await supabase
    .from(TABELA)
    .update({ estado: stateMachine.ESTADOS.ENVIANDO, comando_id, enviado_em: agora, atualizado_em: agora })
    .eq('id', preparacao_id)
    .eq('company_id', cid)
    .eq('estado', stateMachine.ESTADOS.PREPARADO)
    .gt('expira_em', agora)
    // `payload_criacao` entra SÓ aqui, e porque a linha seguinte é o despacho: a vencedora da
    // transição já leva o snapshot, sem um segundo SELECT entre persistir o comando e usá-lo.
    // Ele não atravessa para `projetarOperacao` — a projeção não o lê.
    .select(`${COLUNAS_OPERACAO}, payload_criacao`)
    .maybeSingle()

  if (error) {
    // Não houve despacho — `confirmar` não fala com a WM. Falha segura.
    console.warn('[wmOrcamentoService] transição PREPARADO→ENVIANDO indisponível', cid)
    return erroLocal({ codigo: CODIGOS.PERSISTENCIA_INDISPONIVEL, httpStatus: 503, requestId: rid })
  }

  if (!data) {
    // Perdeu a disputa (ou expirou entre a leitura e o UPDATE). Relê e devolve o estado atual,
    // SEM gerar outro comando e SEM chamar a WM. O `comando_id` gerado acima morre aqui.
    const relido = await lerOperacao({ company_id: cid, operacao_id: preparacao_id })
    if (relido.row) return respostaEstadoNaoConfirmavel({ row: relido.row, requestId: rid })
    return erroLocal({ codigo: CODIGOS.PREPARACAO_EXPIRADA, httpStatus: 409, requestId: rid })
  }

  await registrarEventoOrcamento({
    company_id: cid,
    usuario_id,
    acao: EVENTOS.CONFIRMADO,
    operacao_id: data.id,
    detalhes: {
      estado_anterior: stateMachine.ESTADOS.PREPARADO,
      estado: stateMachine.ESTADOS.ENVIANDO,
      // O comando_id vai para a auditoria server-side (é o rastro do runbook), nunca para a
      // resposta HTTP.
      comando_id,
      payload_hash: data.payload_hash || row.payload_hash,
      conversa_id: data.conversa_id ?? null,
    },
  })

  // Daqui para baixo existe escrita em sistema de terceiro. Tudo acima — a leitura, a
  // expiração, a exigência do snapshot e a transição atômica que persistiu o `comando_id` —
  // já aconteceu, e é o que garante que o despacho abaixo sai NO MÁXIMO uma vez por
  // confirmação de negócio: quem não venceu o UPDATE nem chega aqui.
  return despacharCriacao({ cid, usuario_id, row: data, comando_id, rid, reconciliacao: false })
}

/** Estado que não aceita (nova) confirmação. ENVIANDO/CRIADO respondem 200 idempotente. */
function respostaEstadoNaoConfirmavel({ row, requestId }) {
  const projetado = projetarOperacao(row)
  if (row.estado === stateMachine.ESTADOS.ENVIANDO) {
    // F5 em cima de um ENVIANDO: devolve o MESMO estado, sem comando novo, sem chamar a WM.
    return { ok: true, requestId, resultado: { ...projetado, despachado: false, ja_em_andamento: true } }
  }
  if (row.estado === stateMachine.ESTADOS.CRIADO) {
    return { ok: true, requestId, resultado: { ...projetado, despachado: false, ja_criado: true } }
  }
  if (row.estado === stateMachine.ESTADOS.EXPIRADO) {
    return erroLocal({ codigo: CODIGOS.PREPARACAO_EXPIRADA, httpStatus: 409, requestId })
  }
  if (row.estado === stateMachine.ESTADOS.INCERTO) {
    // Terminal por decisão (D10). Confirmar de novo geraria UUID novo — e isso é justamente o
    // que nunca pode acontecer com um incerto.
    return erroLocal({
      codigo: CODIGOS_WM.RESULTADO_INCERTO,
      httpStatus: 409,
      requestId,
      estado: ESTADO.INCERTO,
      mensagem: 'Não foi possível confirmar se este orçamento foi criado no ERP. Não crie outro — procure o suporte.',
    })
  }
  return erroLocal({ codigo: CODIGOS.ESTADO_INVALIDO, httpStatus: 409, requestId })
}

async function marcarExpirada({ company_id, operacao_id }) {
  const { error } = await supabase
    .from(TABELA)
    .update({ estado: stateMachine.ESTADOS.EXPIRADO, atualizado_em: agoraIso() })
    .eq('id', operacao_id)
    .eq('company_id', company_id)
    .eq('estado', stateMachine.ESTADOS.PREPARADO)
  if (error) console.warn('[wmOrcamentoService] não foi possível marcar preparação expirada', company_id)
}

/* ================================================================== *
 * 3. montarPayloadDespacho / verificar
 * ================================================================== */

/**
 * Monta o payload EXATO de `criar` a partir do snapshot, injetando o que não é persistido:
 * `telefone` (segredo operacional, resolvido do `company_id`) e `comando_id` (nasce na
 * confirmação, depois do snapshot).
 *
 * Por que o snapshot não guarda esses dois:
 *   · o telefone autorizado é segredo e não precisa viver numa segunda tabela — ampliar a
 *     superfície dele (retenção, dump, log de payload) não compra nada: ele é constante por
 *     empresa e já tem dono em `wm_orcamento_integracoes`;
 *   · o `comando_id` ainda não existe quando a prévia chega, e o `payload_hash` tem de ser
 *     estável entre preparação e confirmação para servir de detector de divergência.
 *
 * Logo `payload_hash` cobre cliente, vendedor, política e itens (códigos, quantidades e
 * preços) — exatamente o conjunto que "alterar qualquer campo" significa.
 *
 * **Barreira de hash:** mesmo `comando_id` com payload diferente nunca é despachado. Se o hash
 * recalculado não casa com o persistido, alguém (ou algum bug) mexeu no snapshot entre a
 * confirmação e o despacho — e aí a resposta é parar, não tentar.
 */
function montarPayloadDespacho({ payload_criacao, payload_hash, telefone, comando_id } = {}) {
  if (!ehObjetoSimples(payload_criacao)) return { ok: false, motivo: CODIGOS.SNAPSHOT_AUSENTE }
  if (typeof comando_id !== 'string' || !PADRAO_UUID.test(comando_id)) {
    return { ok: false, motivo: CODIGOS.SNAPSHOT_AUSENTE }
  }
  const recalculado = stateMachine.calcularPayloadHash(payload_criacao)
  if (!payload_hash || !stateMachine.payloadHashIgual(recalculado, payload_hash)) {
    return { ok: false, motivo: CODIGOS.SNAPSHOT_DIVERGENTE }
  }
  const conferido = validarPayloadCriar({ ...payload_criacao, telefone, comando_id })
  if (!conferido.ok) return { ok: false, motivo: CODIGOS.SNAPSHOT_DIVERGENTE }
  return { ok: true, payload: conferido.value }
}

/* ================================================================== *
 * 3.1 Despacho da criação — o ÚNICO ponto que escreve em sistema de terceiro
 * ================================================================== */

/**
 * Classifica a resposta de `POST /orcamentos/criar` em estado local.
 *
 * Função pura: não escreve, não decide sozinha o que fazer, só traduz. A tabela de retry da
 * seção 7 do doc 36, linha por linha:
 *
 *   | resposta da WM                           | estado local  | por quê                      |
 *   |------------------------------------------|---------------|------------------------------|
 *   | `200` com `codigo_pedido_erp` legível    | `CRIADO`      | gravou e sabemos o número    |
 *   | `200` sem número utilizável              | `INCERTO`     | gravou e NÃO sabemos o número|
 *   | `502` (recusa antes da escrita)          | `FALHA_SEGURA`| nada foi gravado             |
 *   | `503 SINCRONIZADOR_OFFLINE` (pré-envio)  | `FALHA_SEGURA`| nada foi gravado             |
 *   | `ORCAMENTO_DADOS_ALTERADOS`              | `FALHA_SEGURA`| recusa pré-escrita (§11)     |
 *   | `504` / timeout / falha não classificada | `INCERTO`     | pode ter gravado             |
 *   | erro de CONEXÃO                          | `FALHA_SEGURA`| provado que não chegou       |
 *   | `409 COMANDO_NAO_REEXECUTADO`/`RESULTADO_INCERTO` | `INCERTO` | a WM não reexecuta    |
 *   | `409 COMANDO_ID_REUTILIZADO`             | `FALHA_SEGURA`| recusa; erro crítico local   |
 *
 * Nada disso é decidido aqui de novo: quem decide FALHA_SEGURA × INCERTO é o `wmErrorMapper`,
 * que é o mesmo mapeamento usado na tela. Esta função só lê `envelope.estado`. O `200` sem
 * número utilizável é o único ramo que o mapeador não cobre (ele mapeia erro, não sucesso) —
 * e ele é INCERTO de propósito: a WM afirma que deu certo, então chamar de falha segura
 * convidaria a criar o mesmo orçamento outra vez.
 *
 * @param {object} args
 * @param {object} args.resposta  resultado normalizado do `wmApiClient` (nunca lança)
 * @param {string} args.requestId
 */
function classificarRespostaCriacao({ resposta, requestId }) {
  const http_status = Number(resposta?.status) || null

  if (resposta?.ok === true) {
    const normalizado = normalizarResultadoCriacao({
      dados: resposta.data?.dados,
      meta: resposta.data?.meta,
    })
    if (normalizado.ok) {
      return {
        estado: stateMachine.ESTADOS.CRIADO,
        resultado_sanitizado: normalizado.resultado_sanitizado,
        http_status,
        erro_codigo: null,
        erro: null,
      }
    }
    return {
      estado: stateMachine.ESTADOS.INCERTO,
      resultado_sanitizado: null,
      http_status,
      erro_codigo: normalizado.motivo,
      erro: erroDeResultadoWm({
        resultado: { ...resposta, ok: false, respostaInvalida: true },
        operacao: OPERACAO.CRIACAO,
        requestId,
      }),
    }
  }

  const erro = erroDeResultadoWm({ resultado: resposta, operacao: OPERACAO.CRIACAO, requestId })
  return {
    estado: erro.envelope?.estado === ESTADO.INCERTO
      ? stateMachine.ESTADOS.INCERTO
      : stateMachine.ESTADOS.FALHA_SEGURA,
    resultado_sanitizado: null,
    http_status,
    // Código da WM quando existe (é o que o runbook procura); senão o nosso código local.
    erro_codigo: resposta?.erroWm || erro.envelope?.codigo || null,
    erro,
  }
}

/**
 * Grava o desfecho do despacho. `estadoPara` `null` = só metadados (é o caso da reconciliação
 * que não virou `CRIADO`: o estado continua `INCERTO` e nada o move).
 *
 * `estadoDe` vai no filtro, então o UPDATE é condicional como o da confirmação: um desfecho
 * nunca sobrescreve um estado que mudou debaixo dele.
 */
async function gravarDesfecho({ cid, operacao_id, estadoDe, patch }) {
  const { data, error } = await supabase
    .from(TABELA)
    .update(patch)
    .eq('id', operacao_id)
    .eq('company_id', cid)
    .eq('estado', estadoDe)
    .select(COLUNAS_OPERACAO)
    .maybeSingle()
  if (error || !data) return { ok: false, row: null }
  return { ok: true, row: data }
}

/**
 * Persistência do desfecho, com um degrau de recuperação.
 *
 * A resposta da WM já chegou quando isto roda — então falhar aqui é perder o registro de uma
 * escrita que PODE ter acontecido no ERP. Daí o degrau: se o patch completo não passar (jsonb
 * recusado, coluna, qualquer coisa), tenta-se um UPDATE mínimo só de estado, porque uma
 * operação criada que ficasse presa em `ENVIANDO` não seria alcançável nem por `verificar`
 * (que só aceita `INCERTO`) — ou seja, ficaria sem caminho de reconciliação nenhum.
 *
 * No degrau, um `CRIADO` vira `INCERTO` de propósito: sem `wm_resultado_sanitizado` não há
 * número de orçamento para mostrar, e `INCERTO` é o único estado que o suporte consegue
 * reconciliar depois (reenvio idêntico, mesmo `comando_id`, D10).
 */
async function persistirDesfecho({ cid, operacao_id, estadoDe, estadoPara, desfecho, tentativas }) {
  const agora = agoraIso()
  const patch = {
    http_status_ultimo: desfecho.http_status,
    erro_codigo_ultimo: textoCurto(desfecho.erro_codigo, 64),
    tentativas,
    atualizado_em: agora,
  }
  if (estadoPara) patch.estado = estadoPara
  if (desfecho.estado === stateMachine.ESTADOS.CRIADO) {
    patch.wm_resultado_sanitizado = desfecho.resultado_sanitizado
    patch.concluido_em = agora
  }

  const completo = await gravarDesfecho({ cid, operacao_id, estadoDe, patch })
  if (completo.ok) return { ok: true, row: completo.row, degradado: false }
  if (!estadoPara) return { ok: false, row: null, degradado: false }

  const estadoMinimo = estadoPara === stateMachine.ESTADOS.CRIADO
    ? stateMachine.ESTADOS.INCERTO
    : estadoPara
  const minimo = await gravarDesfecho({
    cid,
    operacao_id,
    estadoDe,
    patch: { estado: estadoMinimo, atualizado_em: agoraIso() },
  })
  return { ok: false, row: minimo.row, degradado: minimo.ok, estadoMinimo }
}

/**
 * Despacha `POST /orcamentos/criar` **uma vez** e aplica o desfecho.
 *
 * ⚠️ `wmApiClient.criarOrcamento(payload)` é chamado SEM `retryOpts` — e isso não é estilo:
 * qualquer objeto ali (mesmo `{}`) liga o `fetchWithRetry` e abre a porta para dois orçamentos
 * no Icthus. Uma tentativa, e só. A reconciliação é explícita (D10) e vive em `verificar`.
 *
 * Pré-condições já garantidas pelo chamador: a operação é da empresa, o `comando_id` está
 * PERSISTIDO (confirmar: pela transição atômica; verificar: desde o despacho original), e o
 * estado é o esperado. Aqui ainda se barra, ANTES do POST:
 *   · configuração de integração inválida — nada foi enviado, prova de falha segura;
 *   · divergência de hash do snapshot — mesmo `comando_id` com payload diferente nunca sai.
 *
 * @param {object} args
 * @param {boolean} args.reconciliacao `true` em `verificar`: não cria, só confere (D10).
 */
async function despacharCriacao({ cid, usuario_id, row, comando_id, rid, reconciliacao = false }) {
  const estadoDe = row.estado
  const tentativas = (Number(row.tentativas) || 0) + 1

  const contato = await resolverContatoAutorizado(cid)
  if (contato.erro) {
    return barrarAntesDoDespacho({
      cid,
      usuario_id,
      row,
      comando_id,
      rid,
      reconciliacao,
      erro: erroDeResultadoWm({
        resultado: { configuracaoInvalida: contato.erro },
        operacao: OPERACAO.CRIACAO,
        requestId: rid,
      }),
      erro_codigo: 'integracao_invalida',
    })
  }

  const montado = montarPayloadDespacho({
    payload_criacao: row.payload_criacao,
    payload_hash: row.payload_hash,
    telefone: contato.telefone,
    comando_id,
  })
  if (!montado.ok) {
    // Mesmo comando com payload diferente: erro crítico local. Nunca despachado, nunca
    // "tentado de novo" — a diferença é entre gravar o orçamento certo e gravar outro.
    console.warn('[wmOrcamentoService] despacho barrado localmente', JSON.stringify({
      requestId: rid, company_id: cid, motivo: montado.motivo, reconciliacao,
    }))
    return barrarAntesDoDespacho({
      cid,
      usuario_id,
      row,
      comando_id,
      rid,
      reconciliacao,
      erro: erroLocal({
        codigo: montado.motivo,
        httpStatus: 409,
        requestId: rid,
        estado: reconciliacao ? ESTADO.INCERTO : ESTADO.FALHA_SEGURA,
      }),
      erro_codigo: montado.motivo,
    })
  }

  // ===== A ÚNICA LINHA DESTE REPOSITÓRIO QUE CRIA ORÇAMENTO NO ERP =====
  const resposta = await wmApiClient.criarOrcamento(montado.payload)
  // =====================================================================

  const desfecho = classificarRespostaCriacao({ resposta, requestId: rid })
  const criou = desfecho.estado === stateMachine.ESTADOS.CRIADO

  // Na reconciliação o estado só pode andar para CRIADO; qualquer outro desfecho deixa a
  // operação em INCERTO (D10: um incerto não vira falha segura por causa de um 409).
  const estadoPara = reconciliacao ? (criou ? stateMachine.ESTADOS.CRIADO : null) : desfecho.estado

  // Conferência não-lançante de propósito: a WM JÁ respondeu. Uma exceção aqui descartaria o
  // desfecho inteiro e deixaria a operação presa em ENVIANDO depois de uma possível escrita no
  // ERP. Transição impossível por construção (só saem CRIADO/INCERTO/FALHA_SEGURA daqui) —
  // mas, se alguém acrescentar um estado novo e esquecer da aresta, o caminho tem de ser o de
  // registro falho, que termina em INCERTO, e não um 503 genérico.
  const transicaoOk = !estadoPara || stateMachine.transicaoPermitida(estadoDe, estadoPara)
  const persistido = transicaoOk
    ? await persistirDesfecho({ cid, operacao_id: row.id, estadoDe, estadoPara, desfecho, tentativas })
    : { ok: false, row: null, degradado: false }

  if (!persistido.ok) {
    // A WM já respondeu e o nosso registro não acompanhou. Isso é um INCERTO, não um sucesso:
    // o número do orçamento (quando houve) vai para o log porque não vive em mais lugar nenhum.
    console.error('[wmOrcamentoService] desfecho do despacho NÃO registrado', JSON.stringify({
      requestId: rid,
      company_id: cid,
      operacao_id: row.id,
      comando_id,
      estado_pretendido: desfecho.estado,
      estado_gravado: persistido.degradado ? persistido.estadoMinimo : null,
      http_status: desfecho.http_status,
      codigo_pedido_erp: desfecho.resultado_sanitizado?.codigo_pedido_erp || null,
    }))
    await registrarEventoOrcamento({
      company_id: cid,
      usuario_id,
      acao: EVENTOS.RESULTADO_INCERTO,
      operacao_id: row.id,
      detalhes: {
        estado_anterior: estadoDe,
        estado: persistido.degradado ? persistido.estadoMinimo : estadoDe,
        comando_id,
        http_status: desfecho.http_status,
        erro_codigo: 'desfecho_nao_registrado',
        tentativas,
      },
    })
    return erroLocal({
      codigo: CODIGOS_WM.RESULTADO_INCERTO,
      httpStatus: 503,
      requestId: rid,
      estado: ESTADO.INCERTO,
      mensagem: 'Não foi possível confirmar se este orçamento foi criado no ERP. Não crie outro — procure o suporte.',
    })
  }

  const linha = persistido.row
  await registrarEventoOrcamento({
    company_id: cid,
    usuario_id,
    acao: criou
      ? EVENTOS.CRIADO
      : (desfecho.estado === stateMachine.ESTADOS.INCERTO ? EVENTOS.RESULTADO_INCERTO : EVENTOS.FALHA_SEGURA),
    operacao_id: row.id,
    detalhes: {
      estado_anterior: estadoDe,
      estado: linha.estado,
      comando_id,
      payload_hash: row.payload_hash,
      http_status: desfecho.http_status,
      erro_codigo: desfecho.erro_codigo,
      tentativas,
      conversa_id: row.conversa_id ?? null,
    },
  })

  if (criou) {
    return {
      ok: true,
      requestId: rid,
      resultado: {
        ...projetarOperacao(linha),
        despachado: true,
        // §11.1: a WM NÃO distingue "criado agora" de "resultado idempotente". Esta afirmação
        // sai do NOSSO estado anterior — reconciliar um INCERTO é, por definição, confirmar
        // algo que já tinha sido despachado.
        ja_criado: reconciliacao === true,
        reconciliado: reconciliacao === true,
      },
    }
  }

  return desfecho.erro
}

/**
 * Falha PROVADAMENTE anterior ao despacho (configuração inválida ou snapshot divergente).
 *
 * Em `confirmar` a operação está em `ENVIANDO` e precisa sair de lá: vira `FALHA_SEGURA`, que é
 * terminal e honesta — nada foi gravado no ERP, e o caminho é montar o orçamento de novo. A
 * máquina de estados também permitiria `ENVIANDO → PREPARADO` aqui, mas voltar manteria
 * confirmável uma preparação cujo `comando_id` já existe; `FALHA_SEGURA` fecha o assunto sem
 * nunca reusar comando.
 *
 * Em `verificar` nada muda de estado: o `INCERTO` continua `INCERTO` (só os metadados entram),
 * porque não despachar não prova nada sobre o despacho original.
 */
async function barrarAntesDoDespacho({ cid, usuario_id, row, comando_id, rid, reconciliacao, erro, erro_codigo }) {
  const estadoPara = reconciliacao ? null : stateMachine.ESTADOS.FALHA_SEGURA
  if (estadoPara) stateMachine.assertTransicao(row.estado, estadoPara)

  const persistido = await persistirDesfecho({
    cid,
    operacao_id: row.id,
    estadoDe: row.estado,
    estadoPara,
    desfecho: { estado: estadoPara || row.estado, http_status: null, erro_codigo, resultado_sanitizado: null },
    // A tentativa não chegou a sair: `tentativas` conta despacho, não intenção.
    tentativas: Number(row.tentativas) || 0,
  })

  await registrarEventoOrcamento({
    company_id: cid,
    usuario_id,
    acao: reconciliacao ? EVENTOS.RESULTADO_INCERTO : EVENTOS.FALHA_SEGURA,
    operacao_id: row.id,
    detalhes: {
      estado_anterior: row.estado,
      estado: persistido.row?.estado || row.estado,
      comando_id,
      erro_codigo,
      tentativas: Number(row.tentativas) || 0,
      conversa_id: row.conversa_id ?? null,
    },
  })

  return erro
}

/**
 * Verificação de um resultado INCERTO (D10).
 *
 * A WM não tem endpoint de status; a verificação oficial é **reenviar o payload byte a byte
 * idêntico com o MESMO `comando_id`** — o guia autoriza repetir assim depois de problema de
 * transporte (§11) e garante resposta idempotente sem recriar (§13). Três respostas possíveis,
 * e nenhuma delas é "tentar com UUID novo": `200` ⇒ `CRIADO`; `409 COMANDO_NAO_REEXECUTADO` /
 * `RESULTADO_INCERTO` ⇒ segue `INCERTO`; `409 COMANDO_ID_REUTILIZADO` ⇒ erro crítico local.
 *
 * **ISTO NÃO É UMA CRIAÇÃO NOVA, É UMA CONFERÊNCIA.** As garantias que fazem a diferença:
 *   · exige estado `INCERTO` (nada mais é "verificável": `ENVIANDO` ainda está em curso, e
 *     `PREPARADO`/`EXPIRADO`/`FALHA_SEGURA` nunca foram despachados);
 *   · exige o `comando_id` já persistido e **nunca gera outro**;
 *   · remonta o payload idêntico pelo snapshot e barra divergência de hash antes do POST;
 *   · o estado só pode andar para `CRIADO`. Nenhum desfecho aqui transforma um `INCERTO` em
 *     `FALHA_SEGURA` — um 409 não prova que o orçamento não existe.
 *
 * Ação **sempre explícita**: botão do usuário ou operação de suporte. Nunca automática, nunca
 * em laço, nunca num `useEffect` (§12 proíbe repetir sozinho).
 */
async function verificar({ company_id, usuario_id = null, operacao_id, requestId } = {}) {
  const rid = requestId || novoRequestId()
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) {
    return erroLocal({ codigo: CODIGOS.PREPARACAO_NAO_ENCONTRADA, httpStatus: 404, requestId: rid })
  }
  if (typeof operacao_id !== 'string' || !PADRAO_UUID.test(operacao_id)) {
    return erroLocal({ codigo: CODIGOS.PREPARACAO_NAO_ENCONTRADA, httpStatus: 404, requestId: rid })
  }

  const lido = await lerOperacao({ company_id: cid, operacao_id, comPayload: true })
  if (lido.erro) return erroLocal({ codigo: CODIGOS.PERSISTENCIA_INDISPONIVEL, httpStatus: 503, requestId: rid })
  if (!lido.row) return erroLocal({ codigo: CODIGOS.PREPARACAO_NAO_ENCONTRADA, httpStatus: 404, requestId: rid })

  const row = lido.row
  if (row.estado === stateMachine.ESTADOS.CRIADO) {
    return { ok: true, requestId: rid, resultado: { ...projetarOperacao(row), despachado: false, ja_criado: true } }
  }
  if (row.estado !== stateMachine.ESTADOS.INCERTO) {
    // Só INCERTO é verificável. ENVIANDO ainda está em curso; PREPARADO/EXPIRADO/FALHA_SEGURA
    // nunca foram despachados, então não há o que reconciliar.
    return erroLocal({ codigo: CODIGOS.ESTADO_INVALIDO, httpStatus: 409, requestId: rid })
  }
  if (typeof row.comando_id !== 'string' || !PADRAO_UUID.test(row.comando_id)) {
    // INCERTO sem comando_id persistido é incoerência de dados. Gerar um agora seria o erro
    // exato que D10 proíbe — então para.
    return erroLocal({ codigo: CODIGOS.SNAPSHOT_AUSENTE, httpStatus: 409, requestId: rid, estado: ESTADO.INCERTO })
  }

  // Reconciliação: o MESMO `comando_id` de sempre, nunca um novo, e o payload remontado do
  // snapshot (divergência de hash é barrada lá dentro, antes de qualquer POST).
  return despacharCriacao({
    cid,
    usuario_id,
    row,
    comando_id: row.comando_id,
    rid,
    reconciliacao: true,
  })
}

/* ================================================================== *
 * 4. obterOperacao — leitura da própria empresa
 * ================================================================== */

async function obterOperacao({ company_id, operacao_id, requestId } = {}) {
  const rid = requestId || novoRequestId()
  const cid = Number(company_id)
  if (!Number.isFinite(cid) || cid <= 0) {
    return erroLocal({ codigo: CODIGOS.PREPARACAO_NAO_ENCONTRADA, httpStatus: 404, requestId: rid })
  }
  if (typeof operacao_id !== 'string' || !PADRAO_UUID.test(operacao_id)) {
    return erroLocal({ codigo: CODIGOS.PREPARACAO_NAO_ENCONTRADA, httpStatus: 404, requestId: rid })
  }
  const lido = await lerOperacao({ company_id: cid, operacao_id })
  if (lido.erro) return erroLocal({ codigo: CODIGOS.PERSISTENCIA_INDISPONIVEL, httpStatus: 503, requestId: rid })
  if (!lido.row) return erroLocal({ codigo: CODIGOS.PREPARACAO_NAO_ENCONTRADA, httpStatus: 404, requestId: rid })
  return { ok: true, requestId: rid, resultado: projetarOperacao(lido.row) }
}

module.exports = {
  TABELA,
  CODIGOS,
  MENSAGENS,
  STATUS_AMBIGUIDADE,
  STATUS_PRONTO,
  TTL_PREPARACAO_PADRAO_MS,
  ttlPreparacaoMs,
  politicaBloquearAposCriar,
  preparar,
  confirmar,
  verificar,
  obterOperacao,
  // Expostos para teste. As duas primeiras são as traduções do contrato: prévia → payload de
  // criação (§8/§9.2) e 200 da criação → resultado sanitizado (§10/§11.1). A terceira é a
  // barreira de hash, e a quarta é a tabela FALHA_SEGURA × INCERTO em forma de função.
  extrairPayloadCriacaoDaPrevia,
  normalizarResultadoCriacao,
  montarPayloadDespacho,
  classificarRespostaCriacao,
  projetarAmbiguidade,
  projetarOperacao,
}
