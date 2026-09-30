'use strict'

/**
 * crmSyncService — sincronização de dados do ZapERP para o CRM Avançado.
 *
 * Complementa o hand-off SSO (controllers/crmSsoController.js): o SSO leva o
 * usuário para o CRM; este serviço mantém empresa/contato/lead espelhados lá.
 *
 * REGRA DE IDs (decisão do Miguel, 2026-08-24): os IDs do ZapERP são inteiros
 * (serial do Postgres — empresas.id, clientes.id, conversas.id), NÃO UUIDs. O
 * CRM usa o company_id do ZapERP diretamente como seu próprio ID, sem tradução,
 * exatamente como o SSO já faz (crmSsoController envia idEmpresaZap = String(id)).
 * Por isso todos os IDs vão como String(inteiro) — enviar UUID quebraria a
 * correspondência com a empresa que o SSO já registrou no CRM.
 *
 * CONTRATO:
 *   - Base:    process.env.CRM_AVANCADO_URL   (mesma var do SSO; sem barra final)
 *   - Segredo: process.env.ZAP_SSO_SECRET     (mesmo segredo do SSO)
 *   - Header:  x-zaperp-secret: <ZAP_SSO_SECRET> em todas as chamadas
 *   - Sem CRM_AVANCADO_URL/ZAP_SSO_SECRET → integração desativada: no-op silencioso.
 *
 * FIRE-AND-FORGET: nenhuma função rejeita. Erro do CRM é logado e engolido —
 * a sincronização é secundária e NUNCA pode quebrar um fluxo do ZapERP
 * (cadastro de cliente, webhook de inbound, etc.). Os callers podem `await`
 * sem risco, mas o ideal é não bloquear a resposta HTTP.
 *
 * HTTP: usa o `fetch` global (Node 18+; aqui Node 24) com AbortController para
 * timeout — mesmo padrão de services/whatsappConfigService.js. Não usa axios
 * (não é dependência do projeto).
 */

// O CRM Avançado pede pelo menos 10s (upsert de lead + oportunidade pode ter
// cold start / consulta de funil). Mantemos folga em 12s. Só o botão "Enviar ao
// CRM" e o resumo do dashboard fazem await disto; os hooks de background rodam
// fire-and-forget (setImmediate / sem await), então este teto não afeta latência
// do inbound nem do cadastro de cliente.
const TIMEOUT_MS = 12000

// CRM_API_URL aponta para o backend da API (ex.: https://crm-zap-api.wmsistemas.inf.br).
// Se não configurado, usa CRM_AVANCADO_URL como fallback (configuração legada de 1 domínio só).
// CRM_AVANCADO_URL é reservado para o redirect SSO no browser (frontend SPA).
function baseUrl() {
  return (process.env.CRM_API_URL || process.env.CRM_AVANCADO_URL || '').replace(/\/+$/, '')
}

function secret() {
  return process.env.ZAP_SSO_SECRET || ''
}

/** Integração habilitada só quando URL da API e segredo existem. */
function isEnabled() {
  return !!(baseUrl() && secret())
}

function headers() {
  return {
    'x-zaperp-secret': secret(),
    'Content-Type': 'application/json',
  }
}

/**
 * Normaliza um ID do ZapERP (inteiro) para string, como o CRM espera.
 * Retorna null para valores vazios/ausentes (deixa o CRM validar campos obrigatórios).
 */
function idToString(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s || null
}

/** Remove chaves com valor null/undefined/'' — mantém o corpo enxuto (campos opcionais). */
function pruneEmpty(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined) continue
    if (typeof v === 'string' && !v.trim()) continue
    out[k] = v
  }
  return out
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } finally {
    clearTimeout(to)
  }
}

// Motivo legível de uma exceção do fetch (timeout vs. rede/DNS) para o log.
// NÃO inclui o segredo (ele só vai no header x-zaperp-secret, nunca na URL).
function reasonFromErr(err) {
  if (err?.name === 'AbortError') return `timeout após ${TIMEOUT_MS}ms`
  return err?.message || String(err)
}

/**
 * Constrói o objeto de erro do CRM a partir de uma resposta HTTP não-OK,
 * extraindo a MENSAGEM REAL que o CRM Avançado mandou no corpo (ele já devolve
 * mensagens específicas por status — ex.: "Segredo ZapERP inválido ou ausente",
 * "Usuário ZapERP inválido ou inativo", "A etapa selecionada não foi encontrada
 * neste funil"). Sem isso, o caller só via o status numérico e mascarava a causa.
 *
 * `detail` = corpo cru (para log/Network); `message` = campo legível parseado do
 * JSON (message | error | mensagem), quando o corpo for JSON.
 */
async function crmErrorFromResponse(res) {
  let detalhe = ''
  try { detalhe = await res.text() } catch (_) {}
  let mensagem = null
  try {
    const parsed = JSON.parse(detalhe)
    const m = parsed && (parsed.message ?? parsed.error ?? parsed.mensagem)
    if (m != null && String(m).trim()) mensagem = String(m).trim().slice(0, 300)
  } catch (_) {
    // corpo não é JSON — deixa `message` null e mantém só o `detail` cru.
  }
  return { _crmError: true, status: res.status, detail: detalhe.slice(0, 500), message: mensagem }
}

async function post(path, body) {
  if (!isEnabled()) return null // CRM não configurado — ignora silenciosamente
  const url = `${baseUrl()}/api/webhooks/zaperp${path}`
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body || {}),
    })
    if (!res.ok) {
      const errObj = await crmErrorFromResponse(res)
      console.error(`[CRM Sync] POST ${url} respondeu ${res.status}:`, errObj.message || errObj.detail)
      return errObj
    }
    try { return await res.json() } catch (_) { return { ok: true } }
  } catch (err) {
    console.error(`[CRM Sync] Falha ao chamar POST ${url}:`, reasonFromErr(err))
    return { _crmError: true, status: 0, detail: reasonFromErr(err) }
  }
}

async function get(path) {
  if (!isEnabled()) return null
  const url = `${baseUrl()}/api/webhooks/zaperp${path}`
  try {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: headers(),
    })
    if (!res.ok) {
      const errObj = await crmErrorFromResponse(res)
      console.error(`[CRM Sync] GET ${url} respondeu ${res.status}:`, errObj.message || errObj.detail)
      return errObj
    }
    return await res.json()
  } catch (err) {
    console.error(`[CRM Sync] Falha ao chamar GET ${url}:`, reasonFromErr(err))
    return { _crmError: true, status: 0, detail: reasonFromErr(err) }
  }
}

/**
 * Sync empresa → POST /empresa
 * @param {{ empresaId:number|string, nome:string, cnpj?:string, email?:string, telefone?:string }} p
 */
function syncEmpresa(p = {}) {
  const empresaId = idToString(p.empresaId)
  if (!empresaId || !p.nome) return Promise.resolve(null)
  return post('/empresa', pruneEmpty({
    empresaId,
    nome: p.nome,
    cnpj: p.cnpj,
    email: p.email,
    telefone: p.telefone,
  }))
}

/**
 * Sync contato/cliente → POST /contato
 * @param {{ empresaId:number|string, contatoId:number|string, nome:string, email?:string, telefone?:string, empresaNome?:string }} p
 */
function syncContato(p = {}) {
  const empresaId = idToString(p.empresaId)
  const contatoId = idToString(p.contatoId)
  if (!empresaId || !contatoId || !p.nome) return Promise.resolve(null)
  return post('/contato', pruneEmpty({
    empresaId,
    contatoId,
    nome: p.nome,
    email: p.email,
    telefone: p.telefone,
    empresaNome: p.empresaNome,
  }))
}

/**
 * Sync lead (captura via WhatsApp) → POST /lead
 *
 * ETAPA (funil): quando o usuário escolhe para qual etapa mandar o lead, o
 * ZapERP envia `etapaId` e/ou `etapaNome`. O CRM Avançado deve criar/mover o
 * lead direto para essa etapa (upsert por leadId). Ambos são opcionais — sem
 * eles, o CRM usa a etapa padrão do funil (comportamento atual).
 *
 * FUNIL: no "Enviar ao CRM" o usuário escolhe o funil + a etapa; o ZapERP envia
 * `funilId`/`funilNome` além de `etapaId`/`etapaNome`, com `acaoManual:true`. O
 * CRM cria/move o lead para o funil + etapa escolhidos. A captura automática de
 * inbound não manda nenhum desses (CRM usa o funil e a etapa padrão).
 *
 * @param {{ empresaId:number|string, leadId:number|string, nome:string,
 *           email?:string, telefone?:string, origemNome?:string,
 *           responsavelEmail?:string, observacoes?:string,
 *           funilId?:number|string, funilNome?:string,
 *           etapaId?:number|string, etapaNome?:string,
 *           acaoManual?:boolean, usuarioId?:number|string }} p
 */
function syncLead(p = {}) {
  const empresaId = idToString(p.empresaId)
  const leadId = idToString(p.leadId)
  if (!empresaId || !leadId || !p.nome) return Promise.resolve(null)
  const body = pruneEmpty({
    empresaId,
    leadId,
    contatoId: idToString(p.contatoId),
    nome: p.nome,
    email: p.email,
    telefone: p.telefone,
    origemNome: p.origemNome,
    responsavelEmail: p.responsavelEmail,
    observacoes: p.observacoes,
    funilId: idToString(p.funilId),
    funilNome: p.funilNome,
    etapaId: idToString(p.etapaId),
    etapaNome: p.etapaNome,
    usuarioId: idToString(p.usuarioId),
  })
  // acaoManual é booleano — pruneEmpty removeria `false`, então só o setamos
  // explicitamente quando true (envio manual pelo botão "Enviar ao CRM").
  if (p.acaoManual === true) body.acaoManual = true
  return post('/lead', body)
}

/**
 * Lista as etapas (colunas do funil) do CRM Avançado da empresa.
 *   → GET /api/webhooks/zaperp/empresa/:empresaId/etapas
 *
 * CONTRATO ESPERADO (a implementar no CRM Avançado):
 *   Resposta 200 (qualquer um dos formatos é aceito pelo caller):
 *     { etapas: [ { id, nome, ordem?, cor?, tipo? }, ... ], pipelineNome? }
 *     ou diretamente um array [ { id, nome, ... }, ... ]
 *   - `id`   : identificador da etapa no CRM (usado como etapaId no /lead)
 *   - `nome` : rótulo exibido no botão (ex.: "Perdido", "Negociação")
 *   - `ordem`: opcional — para ordenar os botões na mesma ordem do Kanban
 *   - `tipo` : opcional — ex.: "ganho" | "perdido" | "aberto" (para cor do botão)
 *
 * @param {number|string} empresaId
 * @returns {Promise<object|null>} payload do CRM, ou null se desativado/falha.
 */
function listEtapas(empresaId) {
  const id = idToString(empresaId)
  if (!id) return Promise.resolve(null)
  return get(`/empresa/${encodeURIComponent(id)}/etapas`)
}

/**
 * Resumo do CRM da empresa → GET /empresa/:empresaId/resumo
 * @param {number|string} empresaId
 * @returns {Promise<object|null>} { empresaId, crm: { totalLeads, ... } } ou null
 */
function resumoEmpresa(empresaId) {
  const id = idToString(empresaId)
  if (!id) return Promise.resolve(null)
  return get(`/empresa/${encodeURIComponent(id)}/resumo`)
}

function isCrmError(v) {
  return v != null && typeof v === 'object' && v._crmError === true
}

// ─── Inbound → CRM (inbox) ───────────────────────────────────────────────────
// Encaminha ao CRM Avançado TODA mensagem RECEBIDA (fromMe=false) para alimentar o
// inbox dele. Diferente do resto do sync (que usa CRM_API_URL + path fixo), o destino
// é uma URL COMPLETA e independente: CRM_INBOUND_URL (ex.: https://.../api/webhooks/
// zaperp/mensagem). Assim o inbox pode viver em outro host/rota que o sync de lead.
//
// GATE PRÓPRIO: exige CRM_INBOUND_URL + ZAP_SSO_SECRET. Sem a URL, no-op silencioso
// (não quebra o fluxo do webhook). O segredo é o MESMO do SSO (header x-zaperp-secret).
//
// Timeout 15s + 1 retry APENAS em falha de rede/timeout (uma resposta HTTP, mesmo 5xx,
// não é retentada — repetir arriscaria duplicar no inbox). Fire-and-forget: nunca lança.

const INBOUND_TIMEOUT_MS = 15000

function inboundUrl() {
  return String(process.env.CRM_INBOUND_URL || '').trim().replace(/\s+$/, '')
}

/**
 * Encaminha uma mensagem recebida ao inbox do CRM Avançado.
 * @param {{ companyId:number|string, telefone:string, nome?:string, mensagem?:string,
 *          tipo?:string, midiaUrl?:string|null, messageId?:string|null, fromMe?:boolean }} payload
 * @returns {Promise<object|null>} resultado (ou null quando CRM_INBOUND_URL não configurada).
 */
async function forwardInboundMessage(payload = {}) {
  const url = inboundUrl()
  const seg = secret()
  // Sem URL de inbound configurada → pula o encaminhamento sem erro (spec).
  if (!url || !seg) return null

  const body = JSON.stringify({ ...payload, fromMe: false })
  const opts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-zaperp-secret': seg,
    },
    body,
  }

  // 2 tentativas: a 2ª só acontece em exceção de rede/timeout (não em resposta HTTP).
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const res = await fetchWithTimeout(url, opts, INBOUND_TIMEOUT_MS)
      if (res.ok) return { ok: true }
      // Resposta HTTP não-OK: loga o motivo real e NÃO retenta (resposta chegou).
      const errObj = await crmErrorFromResponse(res)
      console.error(`[CRM Inbound] POST ${url} respondeu ${res.status}:`, errObj.message || errObj.detail)
      return errObj
    } catch (err) {
      const ultima = tentativa === 2
      console.error(
        `[CRM Inbound] Falha de rede ao encaminhar inbound (tentativa ${tentativa}/2):`,
        reasonFromErr(err),
      )
      if (ultima) return { _crmError: true, status: 0, detail: reasonFromErr(err) }
      // senão: cai no laço e tenta mais uma vez
    }
  }
  return null
}

module.exports = {
  isEnabled,
  isCrmError,
  syncEmpresa,
  syncContato,
  syncLead,
  resumoEmpresa,
  listEtapas,
  forwardInboundMessage,
}
