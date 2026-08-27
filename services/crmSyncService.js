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
      let detalhe = ''
      try { detalhe = await res.text() } catch (_) {}
      console.error(`[CRM Sync] POST ${url} respondeu ${res.status}:`, detalhe.slice(0, 500))
      return { _crmError: true, status: res.status, detail: detalhe.slice(0, 500) }
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
      let detalhe = ''
      try { detalhe = await res.text() } catch (_) {}
      console.error(`[CRM Sync] GET ${url} respondeu ${res.status}:`, detalhe.slice(0, 500))
      return { _crmError: true, status: res.status, detail: detalhe.slice(0, 500) }
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
 * @param {{ empresaId:number|string, leadId:number|string, nome:string,
 *           email?:string, telefone?:string, origemNome?:string,
 *           responsavelEmail?:string, observacoes?:string,
 *           etapaId?:number|string, etapaNome?:string }} p
 */
function syncLead(p = {}) {
  const empresaId = idToString(p.empresaId)
  const leadId = idToString(p.leadId)
  if (!empresaId || !leadId || !p.nome) return Promise.resolve(null)
  return post('/lead', pruneEmpty({
    empresaId,
    leadId,
    nome: p.nome,
    email: p.email,
    telefone: p.telefone,
    origemNome: p.origemNome,
    responsavelEmail: p.responsavelEmail,
    observacoes: p.observacoes,
    etapaId: idToString(p.etapaId),
    etapaNome: p.etapaNome,
  }))
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

module.exports = {
  isEnabled,
  isCrmError,
  syncEmpresa,
  syncContato,
  syncLead,
  resumoEmpresa,
  listEtapas,
}
