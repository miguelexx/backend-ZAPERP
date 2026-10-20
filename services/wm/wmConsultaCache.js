'use strict'

const crypto = require('crypto')

/**
 * Cache LRU em memória + coalescência de requisições em voo, para as LEITURAS de candidatos
 * da API WM (doc 36, Sessão 3 e seção 11 — "cache LRU em memória (sem Redis) para candidatos ·
 * coalescência de requisições iguais em voo").
 *
 * Existe por uma razão só: custo. Cada requisição à WM pode ser cobrada (pendência 7 da seção
 * 10 está ABERTA — não há rate limit nem preço publicado) e um picker incremental dispara
 * muita busca repetida. Dez atendentes pesquisando "notebook" ao mesmo tempo viram UMA chamada.
 *
 * O QUE PODE ENTRAR AQUI: só candidatos de produto (`/produtos/consultar`).
 * O QUE NUNCA PODE: `orcamentos/preparar` e `orcamentos/criar`. `preparar` calcula preço e
 * estoque realtime e tem prazo de validade de negócio; `criar` escreve no ERP. Cachear
 * qualquer um dos dois mostraria preço velho como oficial ou esconderia uma gravação.
 *
 * ISOLAMENTO — a chave é a defesa
 * ------------------------------
 * A WM não prova vínculo de tenant: o telefone autorizado é o único seletor de empresa e ela
 * confia no ZapERP (pendência 13). Logo o cache é tão perigoso quanto a chamada: uma chave sem
 * `company_id` serviria o catálogo da empresa A para a empresa B.
 *
 *   chave = company_id | versao da config da empresa | endpoint | modo | hash do termo | página
 *
 * `versao` é o `atualizado_em` da linha de `wm_orcamento_integracoes`. É ele que INVALIDA o
 * cache quando o vínculo da empresa muda (telefone novo = outra instalação da WM = outro
 * catálogo). Sem versão não há chave: `montarChave` devolve `null` e o chamador não cacheia
 * nem coalesce — fail-safe, nunca "cacheia com a chave que der".
 *
 * TERMO: hash, e SEM dobrar caixa ou acento
 * -----------------------------------------
 * O termo entra na chave como SHA-256 (nada de texto de busca de usuário em estrutura de
 * processo longo) e **exatamente como o usuário digitou**. Não há `toLowerCase`, `trim` nem
 * remoção de acento, apesar de a tentação ser grande para aumentar a taxa de acerto: pelo
 * `docs/wm/04-contratos-api.md`, a busca de produto casa descrição/marca **por ocorrência**
 * (espaço nas pontas muda o resultado) e identificadores ERP/código de barras por **igualdade
 * exata, sem normalização textual**. Dobrar caixa/acento/espaço fundiria duas buscas que a WM
 * responde de formas diferentes — e devolver o resultado de outra busca é pior que gastar uma
 * chamada a mais. O custo de não dobrar é uma entrada extra quando alguém digita "Chapa" e
 * outra pessoa "chapa"; o debounce de 700–900 ms da Sessão 5 já absorve isso.
 *
 * TTL de 3 min (ajustável em 2–5 min por `WM_CACHE_TTL_MS`): o catálogo da WM vem do cache
 * cloud dela, que já pode estar defasado por desenho, e nada aqui é rotulado como "atual".
 * Minutos a mais não mudam a natureza do dado; minutos a menos só gastam chamada.
 *
 * Só SUCESSO é guardado. Erro nunca entra — um 503 cacheado por 3 minutos transformaria uma
 * indisponibilidade de 1 segundo em 3 minutos de módulo quebrado.
 */

/** Teto de entradas. Cada entrada é uma página de até 30 produtos com 4 campos curtos. */
const MAX_ENTRADAS_PADRAO = 500
const MAX_ENTRADAS_MIN = 10
const MAX_ENTRADAS_MAX = 5000

/** TTL padrão e a faixa aceita (2 a 5 min — doc 36, Sessão 3). */
const TTL_PADRAO_MS = 180_000
const TTL_MIN_MS = 120_000
const TTL_MAX_MS = 300_000

/**
 * Map preserva ordem de inserção, e é isso que dá o LRU sem dependência:
 * acerto = delete + set (vai para o fim); estouro = remove a primeira chave (a mais antiga).
 */
const cache = new Map()

/** Requisições em voo, por chave. Promessa compartilhada; nunca guarda resultado. */
const emVoo = new Map()

function envInt(nome, padrao, min, max) {
  const n = Number(process.env[nome])
  if (!Number.isFinite(n) || n <= 0) return padrao
  return Math.min(Math.max(Math.trunc(n), min), max)
}

function ttlMs() {
  return envInt('WM_CACHE_TTL_MS', TTL_PADRAO_MS, TTL_MIN_MS, TTL_MAX_MS)
}

function maxEntradas() {
  return envInt('WM_CACHE_MAX_ENTRADAS', MAX_ENTRADAS_PADRAO, MAX_ENTRADAS_MIN, MAX_ENTRADAS_MAX)
}

/** Hash do termo. Trunca em 32 hex (128 bits) — folgado para colisão acidental. */
function hashTermo(termo) {
  return crypto.createHash('sha256').update(String(termo), 'utf8').digest('hex').slice(0, 32)
}

/**
 * Monta a chave do cache. Devolve `null` quando falta qualquer componente obrigatório —
 * e `null` significa "não cacheia e não coalesce", nunca "cacheia sem isso".
 *
 * @param {object} args
 * @param {number} args.companyId     sempre de `req.user.company_id`
 * @param {string} args.configVersao  `atualizado_em` da config da empresa (invalidador)
 * @param {string} args.endpoint      identificador curto do endpoint ('produtos/consultar')
 * @param {string} args.modo          'busca' | 'codigo' — discrimina a semântica do termo
 * @param {string} args.termo         termo EXATO como validado (não normalizado)
 * @param {number} [args.pagina]      página; ausente conta como 1 (default da WM)
 * @returns {string|null}
 */
function montarChave({ companyId, configVersao, endpoint, modo, termo, pagina } = {}) {
  const cid = Number(companyId)
  if (!Number.isFinite(cid) || cid <= 0) return null
  const versao = String(configVersao ?? '').trim()
  if (!versao) return null
  const ep = String(endpoint ?? '').trim()
  const md = String(modo ?? '').trim()
  if (!ep || !md) return null
  if (typeof termo !== 'string' || termo.length === 0) return null
  const pg = pagina === undefined || pagina === null ? 1 : Number(pagina)
  if (!Number.isInteger(pg) || pg < 1) return null
  return `c=${cid}|v=${versao}|e=${ep}|m=${md}|t=${hashTermo(termo)}|p=${pg}`
}

/**
 * Lê do cache. Entrada vencida é removida na leitura (não espera o LRU chegar nela).
 * @returns {{ hit: boolean, valor?: any }}
 */
function obter(chave) {
  if (!chave) return { hit: false }
  const entrada = cache.get(chave)
  if (!entrada) return { hit: false }
  if (entrada.expiraEm <= Date.now()) {
    cache.delete(chave)
    return { hit: false }
  }
  // Renova a posição: acesso recente vai para o fim da fila de descarte.
  cache.delete(chave)
  cache.set(chave, entrada)
  return { hit: true, valor: entrada.valor }
}

/** Guarda sucesso. `undefined`/`null` não é guardado — não existe "sucesso vazio" aqui. */
function guardar(chave, valor) {
  if (!chave || valor === undefined || valor === null) return
  if (cache.has(chave)) cache.delete(chave)
  cache.set(chave, { valor, expiraEm: Date.now() + ttlMs() })
  const teto = maxEntradas()
  while (cache.size > teto) {
    const maisAntiga = cache.keys().next()
    if (maisAntiga.done) break
    cache.delete(maisAntiga.value)
  }
}

/**
 * Resolve com cache + coalescência.
 *
 * `produtor` é chamado no máximo uma vez por chave em voo. Quem chega durante o voo espera a
 * MESMA promessa — é isso que faz N atendentes pesquisando o mesmo termo custarem 1 chamada.
 *
 * `cacheavel(valor)` decide se o resultado entra no cache. O chamador usa isso para guardar só
 * sucesso: erro mapeado nunca é cacheado.
 *
 * Sem chave (`null`), executa direto: sem cache, sem coalescência. Fail-safe por desenho.
 *
 * @param {string|null} chave
 * @param {() => Promise<any>} produtor
 * @param {(valor:any) => boolean} [cacheavel]
 * @returns {Promise<{ valor: any, origem: 'fresco'|'cache'|'coalescido' }>}
 */
async function resolverComCoalescencia(chave, produtor, cacheavel) {
  if (!chave) return { valor: await produtor(), origem: 'fresco' }

  const doCache = obter(chave)
  if (doCache.hit) return { valor: doCache.valor, origem: 'cache' }

  const voando = emVoo.get(chave)
  if (voando) return { valor: await voando, origem: 'coalescido' }

  const promessa = (async () => produtor())()
  emVoo.set(chave, promessa)
  let valor = null
  try {
    valor = await promessa
  } finally {
    emVoo.delete(chave)
  }
  const podeCachear = typeof cacheavel === 'function' ? Boolean(cacheavel(valor)) : true
  if (podeCachear) guardar(chave, valor)
  return { valor, origem: 'fresco' }
}

/**
 * Invalida tudo de uma empresa (prefixo `c=<id>|`). Serve ao provisionamento: trocar o telefone
 * já muda a chave pelo `atualizado_em`, mas limpar explicitamente evita entradas órfãs
 * ocupando o teto. Sem argumento, limpa tudo.
 */
function invalidar(companyId) {
  if (companyId === undefined || companyId === null) {
    cache.clear()
    return
  }
  const prefixo = `c=${Number(companyId)}|`
  for (const chave of Array.from(cache.keys())) {
    if (chave.startsWith(prefixo)) cache.delete(chave)
  }
}

module.exports = {
  MAX_ENTRADAS_PADRAO,
  TTL_PADRAO_MS,
  TTL_MIN_MS,
  TTL_MAX_MS,
  montarChave,
  obter,
  guardar,
  resolverComCoalescencia,
  invalidar,
  // só para teste/diagnóstico — nunca usado em caminho de requisição
  _estado: () => ({ entradas: cache.size, emVoo: emVoo.size, ttlMs: ttlMs(), maxEntradas: maxEntradas() }),
}
