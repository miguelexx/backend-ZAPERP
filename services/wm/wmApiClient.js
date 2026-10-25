'use strict'

const { fetchWithRetry, isConnectionLevelError } = require('../../helpers/retryWithBackoff')

/**
 * Cliente HTTP da API WM (ERP Icthus) — doc 36, decisão D5.
 *
 * Espelha `services/providers/whapi/http.js` (JSON + Bearer em header, token mascarado em log,
 * `AbortSignal.timeout` por tentativa via getter) e reusa `helpers/retryWithBackoff.fetchWithRetry`.
 * As TRÊS políticas de retry abaixo são o núcleo de segurança deste módulo:
 *
 *   | chamada             | retryOpts                       | efeito                                       |
 *   |---------------------|---------------------------------|----------------------------------------------|
 *   | produtos/consultar  | { idempotent: true }            | leitura: 5xx/429/408 e rede podem repetir    |
 *   | orcamentos/preparar | { retryConnectionErrors: true } | POST sem escrita: só falha de conexão repete |
 *   | orcamentos/criar    | OMITIDO (null)                  | maxAttempts = 1 — NUNCA repete               |
 *
 * `criar` grava no ERP: timeout, 5xx ou resposta ambígua **não podem** ser repetidos — repetir
 * duplicaria orçamento. O retry de conexão também não vale ali, porque a reconciliação correta é
 * reenviar o MESMO `comando_id` por ação explícita do usuário (D10), nunca automaticamente.
 *
 * Este módulo não conhece banco, não conhece `company_id` e não resolve o telefone autorizado: ele
 * recebe o payload já montado e validado por quem tem esse contexto (Sessões 3 e 4).
 *
 * SEGREDOS — regras absolutas:
 *   · o Bearer (`ZAPERP_API_TOKEN`) só aparece em header, nunca em URL/query, nunca em log cru,
 *     nunca em mensagem de erro;
 *   · `telefone` (o contato autorizado que resolve a instalação WM, seção 4 do doc 36) NUNCA é
 *     registrado em log, nem parcialmente, nem mascarado;
 *   · corpo de requisição e corpo de resposta NUNCA vão para log — a resposta carrega CPF/CNPJ/IE
 *     de candidatos (seção 6 do doc 36). Só status, endpoint e o código da chave `erro`.
 *
 * TLS: verificado, sempre. Os vizinhos `config/produtosDb.js` (`rejectUnauthorized: false`) e
 * `config/wmSqlServer.js` (`trustServerCertificate` default true) fazem o oposto — não copiar.
 * Aqui não existe nenhuma opção de desligar verificação; é fetch nativo com os padrões do Node.
 */

/**
 * Prefixo que TODOS os caminhos do Assistente carregam no `openapi.yaml`, e que a base de
 * produção publicada pela WM **também** já inclui
 * (`https://apiwmassistente.wmsistemas.inf.br/api/v1/assistente`). Somar os dois daria
 * `/api/v1/assistente/api/v1/assistente/produtos/consultar` e um 404 silencioso, então
 * `resolveBaseUrl` corta este sufixo da base quando ele está lá.
 */
const PREFIXO_OPENAPI = '/api/v1/assistente'

/** Caminhos exatos do `openapi.yaml` da WM (docs/wm/openapi.yaml). Não deduzir, não descobrir. */
const WM_PATHS = Object.freeze({
  ACESSO_VALIDAR: '/api/v1/assistente/acesso/validar',
  CLIENTES_CONSULTAR: '/api/v1/assistente/clientes/consultar',
  PRODUTOS_CONSULTAR: '/api/v1/assistente/produtos/consultar',
  ORCAMENTOS_PREPARAR: '/api/v1/assistente/orcamentos/preparar',
  ORCAMENTOS_CRIAR: '/api/v1/assistente/orcamentos/criar',
})

/** Tipo de operação — define timeout e política de retry. */
const OPERACAO = Object.freeze({
  LEITURA: 'leitura',
  PREPARACAO: 'preparacao',
  CRIACAO: 'criacao',
})

/**
 * Teto de corpo de resposta. Uma página da WM tem no máximo 30 candidatos com poucos campos
 * curtos, então 1 MiB é folgado em ~2 ordens de grandeza. O teto existe para que um upstream
 * comprometido ou mal configurado não consiga esgotar a memória do processo.
 */
const MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * Timeouts padrão. ATENÇÃO: o SLA da WM é a pendência 6 da seção 10 do doc 36 — está ABERTA.
 * O `504 REALTIME_TIMEOUT` existe no contrato mas sem número publicado, então estes valores
 * (e os do `.env.example`) são ESTIMATIVA e devem ser revistos quando a WM publicar o SLA.
 * Escrita tem folga maior porque `preparar`/`criar` atravessam API -> Worker -> SQL Server.
 */
const TIMEOUT_READ_PADRAO_MS = 15000
const TIMEOUT_WRITE_PADRAO_MS = 30000
const TIMEOUT_MIN_MS = 1000
const TIMEOUT_MAX_MS = 120000

/** Mascara token em log — espelha `maskToken` do whapi/http.js. */
function maskToken(t) {
  if (!t || typeof t !== 'string') return '***'
  if (t.length <= 4) return '****'
  return t.slice(0, 2) + '***' + t.slice(-2)
}

/**
 * Host privado/loopback/link-local = recusado (anti-SSRF). A base URL é configuração de
 * ambiente, não entrada de usuário, mas um `.env` errado não pode transformar o backend em
 * proxy para a rede interna. IP literal público é aceito; literal privado, não.
 *
 * Limite conhecido: isto valida o NOME configurado, não o endereço resolvido — rebind de DNS
 * continua teoricamente possível (o fetch nativo não permite pinar o IP resolvido). Risco baixo
 * porque a URL vem do `.env` e não do navegador.
 */
function hostPermitido(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'localhost.localdomain') return false
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return false
  // IPv6
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return false
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return false // fc00::/7 — unique local
    if (/^fe[89ab][0-9a-f]:/.test(h)) return false // fe80::/10 — link local
    if (/^::ffff:/.test(h)) return false // IPv4 mapeado — não dá para confiar
    return true
  }
  // IPv4 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 0 || a === 127 || a === 10) return false
    if (a === 169 && b === 254) return false // link local + metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
    if (a >= 224) return false // multicast/reservado
    return true
  }
  return true
}

/**
 * Base URL **só** de `WM_API_BASE_URL`. O `openapi.yaml` da WM não tem seção `servers`
 * (fragilidade registrada na seção 10 do doc 36), então não há descoberta e não há hardcode.
 * Exige HTTPS, host público, sem credencial embutida, sem query/fragmento.
 *
 * Prefixo de caminho é aceito (deploy atrás de path), com dois tratamentos de duplicação:
 *
 *   · base terminando em `/api/v1/assistente` — que é exatamente a base de produção publicada
 *     pela WM — tem esse sufixo CORTADO, porque `WM_PATHS` usa o caminho completo do OpenAPI.
 *     Cortar em vez de recusar é o certo aqui: é a base oficial, e exigir que o `.env` guarde
 *     uma versão aparada dela seria uma armadilha de configuração;
 *   · base terminando em `/api` ou `/api/v1` continua RECUSADA. Ali não há o que cortar com
 *     segurança (a WM nunca publicou uma base assim) e somar daria `/api/v1/api/v1/...`.
 *
 * Falhar alto, ou normalizar de forma documentada, é melhor que depurar 404 em produção.
 */
function resolveBaseUrl() {
  const raw = String(process.env.WM_API_BASE_URL || '').trim()
  if (!raw) return { ok: false, motivo: 'base_url_ausente' }
  let u = null
  try { u = new URL(raw) } catch { return { ok: false, motivo: 'base_url_invalida' } }
  if (u.protocol !== 'https:') return { ok: false, motivo: 'base_url_sem_tls' }
  if (u.username || u.password) return { ok: false, motivo: 'base_url_com_credencial' }
  if (u.search || u.hash) return { ok: false, motivo: 'base_url_com_query' }
  if (!hostPermitido(u.hostname)) return { ok: false, motivo: 'base_url_host_nao_publico' }
  let prefixo = String(u.pathname || '').replace(/\/+$/, '')
  if (prefixo.toLowerCase().endsWith(PREFIXO_OPENAPI)) {
    prefixo = prefixo.slice(0, prefixo.length - PREFIXO_OPENAPI.length)
  }
  if (/\/api(\/v\d+)?$/i.test(prefixo)) return { ok: false, motivo: 'base_url_com_prefixo_api' }
  return { ok: true, base: u.origin + prefixo }
}

function resolveToken() {
  const t = String(process.env.ZAPERP_API_TOKEN || '').trim()
  return t || null
}

function envInt(nome, padrao) {
  const n = Number(process.env[nome])
  if (!Number.isFinite(n) || n <= 0) return padrao
  return Math.min(Math.max(Math.trunc(n), TIMEOUT_MIN_MS), TIMEOUT_MAX_MS)
}

/** Timeout por tipo de operação (`WM_API_TIMEOUT_READ_MS` / `WM_API_TIMEOUT_WRITE_MS`). */
function resolveTimeoutMs(operacao) {
  if (operacao === OPERACAO.LEITURA) return envInt('WM_API_TIMEOUT_READ_MS', TIMEOUT_READ_PADRAO_MS)
  return envInt('WM_API_TIMEOUT_WRITE_MS', TIMEOUT_WRITE_PADRAO_MS)
}

/**
 * Opções de fetch. O `signal` é GETTER: cada leitura (= cada tentativa do fetchWithRetry) ganha
 * um timeout novo. Um `AbortSignal.timeout` fixo dispararia na 1ª tentativa e deixaria as
 * retentativas abortando na hora — a lição já registrada no whapi/http.js.
 */
function criarFetchOptions(body, timeoutMs) {
  const opts = {
    method: 'POST',
    headers: { accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body == null ? {} : body),
    // Redirect externo é bloqueado: um 30x da WM nunca é seguido, porque seguir levaria o
    // Bearer para um host que não é o configurado.
    redirect: 'error',
  }
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      Object.defineProperty(opts, 'signal', {
        enumerable: true,
        configurable: true,
        get() {
          try { return AbortSignal.timeout(timeoutMs) } catch { return undefined }
        },
      })
    }
  } catch { /* runtime sem AbortSignal.timeout: segue sem timeout de aborto */ }
  return opts
}

function headerValue(res, nome) {
  try {
    const v = res?.headers?.get?.(nome)
    return v == null ? '' : String(v)
  } catch { return '' }
}

function contentTypeJson(ct) {
  const base = String(ct || '').split(';')[0].trim().toLowerCase()
  if (base === 'application/json') return true
  return /^application\/[\w.+-]*\+json$/.test(base)
}

/**
 * Lê o corpo com teto de bytes. Usa o reader do stream quando existe (Node 24) para parar ANTES
 * de materializar um corpo gigante; cai para `res.text()` quando o objeto não é um Response real
 * (mocks de teste), e aí o teto é conferido depois da leitura.
 */
async function lerCorpoLimitado(res, maxBytes = MAX_RESPONSE_BYTES) {
  const declarado = Number(headerValue(res, 'content-length'))
  if (Number.isFinite(declarado) && declarado > maxBytes) {
    return { excedeu: true, texto: '' }
  }
  const reader = typeof res?.body?.getReader === 'function' ? res.body.getReader() : null
  if (!reader) {
    let texto = ''
    try { texto = await res.text() } catch { texto = '' }
    if (Buffer.byteLength(String(texto || ''), 'utf8') > maxBytes) return { excedeu: true, texto: '' }
    return { excedeu: false, texto: String(texto || '') }
  }
  const partes = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength ?? value.length ?? 0
        if (total > maxBytes) {
          try { await reader.cancel() } catch { /* ignora */ }
          return { excedeu: true, texto: '' }
        }
        partes.push(Buffer.from(value))
      }
    }
  } catch {
    return { excedeu: false, texto: Buffer.concat(partes).toString('utf8') }
  }
  return { excedeu: false, texto: Buffer.concat(partes).toString('utf8') }
}

/**
 * Sanitiza o código da chave `erro` da WM antes de qualquer uso. A WM declara os códigos como
 * identificadores (`SINCRONIZADOR_OFFLINE`, `payload_invalido`), mas o `shared/http/errors.ts`
 * completo não foi recebido — então o valor é tratado como entrada hostil: só `[A-Za-z0-9_]`,
 * no máximo 64 caracteres. Nada de erro cru atravessando este módulo.
 */
function sanitizarCodigoErro(valor) {
  if (typeof valor !== 'string') return null
  const limpo = valor.trim().slice(0, 64).replace(/[^A-Za-z0-9_]/g, '')
  return limpo || null
}

function extrairIndiceItem(data) {
  const v = data?.indice_item
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  return null
}

/**
 * Log de erro/diagnóstico. NUNCA imprime corpo de requisição (tem `telefone`), corpo de resposta
 * (tem CPF/CNPJ/IE) nem o token. Em sucesso só loga com `WM_API_DEBUG=true`.
 */
function logWm({ operacao, endpoint, status, erroWm, transporte, duracaoMs, token, configuracaoInvalida }) {
  const temProblema = Boolean(configuracaoInvalida) || Boolean(transporte) || Number(status) >= 400
  if (!temProblema && String(process.env.WM_API_DEBUG || '').toLowerCase() !== 'true') return
  console.log(JSON.stringify({
    '[WM REQUEST]': { operacao, endpoint, auth: `Bearer ${maskToken(token)}` },
    '[WM RESPONSE]': {
      status: Number(status) || 0,
      erro: erroWm || null,
      transporte: transporte || null,
      configuracao: configuracaoInvalida || null,
      duracaoMs: Number(duracaoMs) || 0,
    },
  }))
}

/** Classifica a exceção do fetch. É isto que decide, adiante, FALHA_SEGURA × INCERTO. */
function classificarFalha(e) {
  const nome = String(e?.name || '')
  if (nome === 'AbortError' || nome === 'TimeoutError') return 'timeout'
  if (isConnectionLevelError(e)) return 'conexao'
  return 'desconhecido'
}

/**
 * Resultado normalizado — sempre este formato, nunca exceção para o chamador.
 *
 *   ok                    2xx com JSON válido
 *   status                HTTP da WM; 0 quando não houve resposta
 *   data                  corpo JSON (opaco para este módulo)
 *   erroWm                código sanitizado da chave `erro` (NÃO `codigo`, NÃO `error`)
 *   indiceItem            `indice_item` zero-based do 502 de preparar
 *   transporte            'timeout' | 'conexao' | 'desconhecido' | null
 *   respostaInvalida      2xx com content-type/JSON/tamanho fora do contrato
 *   configuracaoInvalida  motivo de config (nada foi enviado — prova de FALHA_SEGURA)
 */
async function requisitar({ operacao, path, body, retryOpts }) {
  const baseRes = resolveBaseUrl()
  const token = resolveToken()
  const base = {
    operacao,
    endpoint: path,
    ok: false,
    status: 0,
    data: null,
    erroWm: null,
    indiceItem: null,
    transporte: null,
    respostaInvalida: false,
    configuracaoInvalida: null,
    duracaoMs: 0,
  }

  if (!baseRes.ok) {
    const out = { ...base, configuracaoInvalida: baseRes.motivo }
    logWm({ ...out, token })
    return out
  }
  if (!token) {
    const out = { ...base, configuracaoInvalida: 'token_ausente' }
    logWm({ ...out, token })
    return out
  }

  const url = `${baseRes.base}${path}`
  const opts = criarFetchOptions(body, resolveTimeoutMs(operacao))
  opts.headers = { ...opts.headers, Authorization: `Bearer ${token}` }

  const iniciou = Date.now()
  let res = null
  try {
    // retryOpts null/undefined em `criar` → fetchWithRetry usa maxAttempts = 1 (POST não idempotente).
    res = await fetchWithRetry(url, opts, retryOpts || null)
  } catch (e) {
    const out = { ...base, transporte: classificarFalha(e), duracaoMs: Date.now() - iniciou }
    logWm({ ...out, token })
    return out
  }

  const status = Number(res?.status) || 0
  const ct = headerValue(res, 'content-type')
  const { excedeu, texto } = await lerCorpoLimitado(res)

  let data = null
  let parseFalhou = false
  if (texto) {
    try { data = JSON.parse(texto) } catch { parseFalhou = true }
  }

  const corpoForaDoContrato = excedeu || parseFalhou || (Boolean(texto) && !contentTypeJson(ct))
  const ok2xx = status >= 200 && status < 300
  const out = {
    ...base,
    status,
    data: corpoForaDoContrato ? null : data,
    erroWm: corpoForaDoContrato ? null : sanitizarCodigoErro(data?.erro),
    indiceItem: corpoForaDoContrato ? null : extrairIndiceItem(data),
    ok: ok2xx && !corpoForaDoContrato,
    respostaInvalida: ok2xx && corpoForaDoContrato,
    duracaoMs: Date.now() - iniciou,
  }
  logWm({ ...out, token })
  return out
}

/**
 * `POST /acesso/validar` — confere se um telefone é aceito pela WM. Não escreve nada e não
 * executa consulta operacional: é leitura pura, logo o retry idempotente é seguro.
 *
 * **Só em provisionamento e diagnóstico, nunca por orçamento** (seção 11 do doc 36). O único
 * chamador previsto é `scripts/wm-provisionar-empresa.js`.
 *
 * O que a resposta prova e o que NÃO prova: `200 { autorizado: true }` diz que existe um contato
 * ativo e inequívoco com esse telefone do lado da WM. **Não** diz que esse contato pertence à
 * mesma empresa do `company_id` do ZapERP — a WM declara que não fornece essa prova (pendência
 * 13 da seção 10). Quem chamar isto tem de dizer isso em voz alta a quem estiver provisionando.
 *
 * `403` = contato inexistente/inativo, ou telefone normalizado fora de 8–15 dígitos. Nunca
 * tentar "resolver" um 403 mexendo no nono dígito: a normalização brasileira é da WM
 * (`docs/wm/14-normalizacao-telefones.md`) e aqui o telefone vai como foi provisionado.
 */
async function validarAcesso(payload) {
  return requisitar({
    operacao: OPERACAO.LEITURA,
    path: WM_PATHS.ACESSO_VALIDAR,
    body: payload,
    retryOpts: { idempotent: true },
  })
}

/**
 * `POST /clientes/consultar` — leitura. Mesma política de retry de `consultarProdutos`: nada é
 * escrito, então repetir 5xx/429/408 e falha de rede é seguro.
 *
 * DIFERENÇA QUE IMPORTA em relação a `consultarProdutos`: esta porta é REALTIME. A WM precisa
 * falar com o sincronizador instalado na máquina da loja, e devolve `503 SINCRONIZADOR_OFFLINE`
 * quando ele está fora do ar — enquanto `produtos/consultar`, servido do acervo já sincronizado
 * dentro da WM, continua respondendo 200. Medido em produção em 25/10/2026. Esse 503 NÃO está
 * declarado nas respostas desta rota no `openapi.yaml` (pendência registrada no Anexo A).
 */
async function consultarClientes(payload) {
  return requisitar({
    operacao: OPERACAO.LEITURA,
    path: WM_PATHS.CLIENTES_CONSULTAR,
    body: payload,
    retryOpts: { idempotent: true },
  })
}

/**
 * `POST /produtos/consultar` — leitura. Retry de 5xx/429/408 e rede é seguro: nada é escrito.
 * O payload já vem validado (`validators/wmOrcamentosValidators`) e com o `telefone` injetado
 * pelo chamador server-side.
 */
async function consultarProdutos(payload) {
  return requisitar({
    operacao: OPERACAO.LEITURA,
    path: WM_PATHS.PRODUTOS_CONSULTAR,
    body: payload,
    retryOpts: { idempotent: true },
  })
}

/**
 * `POST /orcamentos/preparar` — valida e calcula a prévia SEM escrever no ERP. Por ser POST,
 * só falha de conexão (requisição provadamente não chegou) é repetida.
 */
async function prepararOrcamento(payload) {
  return requisitar({
    operacao: OPERACAO.PREPARACAO,
    path: WM_PATHS.ORCAMENTOS_PREPARAR,
    body: payload,
    retryOpts: { retryConnectionErrors: true },
  })
}

/**
 * `POST /orcamentos/criar` — ESCREVE no ERP. `retryOpts` omitido de propósito: uma tentativa,
 * e só. Timeout ou resposta ambígua viram INCERTO (D10) e a reconciliação é reenviar o MESMO
 * `comando_id` por ação explícita — nunca aqui, nunca em loop, nunca com UUID novo.
 */
async function criarOrcamento(payload) {
  return requisitar({
    operacao: OPERACAO.CRIACAO,
    path: WM_PATHS.ORCAMENTOS_CRIAR,
    body: payload,
    // NÃO passar retryOpts. Qualquer objeto aqui (mesmo {}) é uma porta para duplicar orçamento.
  })
}

module.exports = {
  PREFIXO_OPENAPI,
  WM_PATHS,
  OPERACAO,
  MAX_RESPONSE_BYTES,
  TIMEOUT_READ_PADRAO_MS,
  TIMEOUT_WRITE_PADRAO_MS,
  maskToken,
  hostPermitido,
  resolveBaseUrl,
  resolveTimeoutMs,
  sanitizarCodigoErro,
  validarAcesso,
  consultarClientes,
  consultarProdutos,
  prepararOrcamento,
  criarOrcamento,
}
