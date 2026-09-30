'use strict'

// GET /crm/instancia-status?companyId=<id>
//
// Endpoint server-to-server para o CRM Avançado confirmar qual número de WhatsApp
// está conectado na empresa. Autenticado por x-zaperp-secret === ZAP_SSO_SECRET
// (comparação segura). Reutiliza o provider Whapi já existente (getConnectionStatus
// = GET /health; getUserProfile = GET /users/profile), com o token resolvido pela
// instância padrão whapi da empresa (services/providers/whapi/config.resolveConfig).
//
// CONTRATO:
//   200 { ok:true, conectado:<bool>, numero:<string|null>, nome:<string|null> }
//   - Empresa sem instância whapi → { ok:true, conectado:false, numero:null, nome:null }
//   - Qualquer erro/timeout na Whapi → conectado:false com 200 (o CRM mostra
//     "ainda não conectado" em vez de quebrar). NUNCA 500 por falha da Whapi.
//   - O token da Whapi NUNCA aparece na resposta.
//   401 segredo ausente/divergente · 400 companyId inválido · 503 ZAP_SSO_SECRET ausente.

const { segredoConfere } = require('../helpers/zaperpSecret')
const { getProvider } = require('../services/providers')

// Timeout curto por chamada à Whapi (o timeout interno do adapter é ~30s; aqui
// impomos ~5s para o CRM não travar esperando um canal lento/adormecido).
const WHAPI_STATUS_TIMEOUT_MS = 5000

// Corre `promise` contra um timer; se estourar, resolve com `fallback` (não rejeita).
// getConnectionStatus/getUserProfile já não lançam, mas o teto de tempo é nosso.
function comTimeout(promise, ms, fallback) {
  let timer
  const limite = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([
    Promise.resolve(promise)
      .catch(() => fallback)
      .finally(() => clearTimeout(timer)),
    limite,
  ])
}

const SEM_INSTANCIA = { ok: true, conectado: false, numero: null, nome: null }

async function instanciaStatus(req, res) {
  const segredo = process.env.ZAP_SSO_SECRET
  if (!segredo) {
    return res.status(503).json({ ok: false, error: 'Integração não configurada (ZAP_SSO_SECRET).' })
  }
  if (!segredoConfere(req.headers['x-zaperp-secret'], segredo)) {
    return res.status(401).json({ ok: false, error: 'Segredo inválido.' })
  }

  const companyId = Number(req.query?.companyId)
  if (!Number.isFinite(companyId) || companyId <= 0) {
    return res.status(400).json({ ok: false, error: 'companyId inválido.' })
  }

  try {
    const whapi = getProvider({ provider: 'whapi' })

    // GET /health → { ok, connected, status, phone, ... }. resolveConfig devolve null
    // (status 'not_configured') quando a empresa não tem instância whapi ativa.
    const health = await comTimeout(
      whapi.getConnectionStatus({ companyId }),
      WHAPI_STATUS_TIMEOUT_MS,
      { ok: false, connected: false, status: 'timeout' },
    )

    if (health?.status === 'not_configured') {
      return res.status(200).json(SEM_INSTANCIA)
    }

    const conectado = health?.connected === true
    const numero = health?.phone ? String(health.phone).replace(/\D/g, '') || null : null

    // Nome do perfil: best-effort, só quando conectado. Falha/timeout → nome null.
    let nome = null
    if (conectado) {
      const perfil = await comTimeout(
        whapi.getUserProfile({ companyId }),
        WHAPI_STATUS_TIMEOUT_MS,
        { ok: false },
      )
      if (perfil?.ok && perfil.profile) {
        nome =
          (perfil.profile.name && String(perfil.profile.name).trim()) ||
          (perfil.profile.verified_name && String(perfil.profile.verified_name).trim()) ||
          (perfil.profile.push_name && String(perfil.profile.push_name).trim()) ||
          null
      }
    }

    return res.status(200).json({ ok: true, conectado, numero, nome })
  } catch (err) {
    // Falha inesperada NÃO deve virar 500 — o CRM só quer saber se está conectado.
    console.error('[crm:instancia-status] company=', companyId, err?.message)
    return res.status(200).json({ ok: true, conectado: false, numero: null, nome: null })
  }
}

module.exports = { instanciaStatus }
