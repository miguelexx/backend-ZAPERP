'use strict'

const jwt = require('jsonwebtoken')

/**
 * Hand-off (SSO) do ZapERP para o CRM Avançado.
 *
 * O usuário já está autenticado no ZapERP (passou pelo middleware `auth`,
 * então `req.user` traz id, company_id e email). Aqui assinamos um token
 * curto (HS256) com o segredo compartilhado ZAP_SSO_SECRET e devolvemos a
 * URL do CRM Avançado (`/sso?token=...`). O front faz o window.location.
 *
 * É chamado via fetch/axios (com o Bearer do ZapERP no header) — por isso
 * respondemos JSON com a URL, em vez de um 302 (um redirect no navegador
 * não carregaria o header Authorization).
 *
 * Configuração (env do backend do ZapERP):
 *   - ZAP_SSO_SECRET   : mesmo valor configurado no CRM Avançado
 *   - CRM_AVANCADO_URL : origem pública do CRM (ex.: https://crm.suaempresa.com)
 * Sem essas variáveis, o endpoint responde 503 (integração desativada).
 */
async function abrirCrmAvancado(req, res) {
  const segredo = process.env.ZAP_SSO_SECRET
  const baseUrl = (process.env.CRM_AVANCADO_URL || '').replace(/\/+$/, '')

  if (!segredo || !baseUrl) {
    return res.status(503).json({
      error: 'Integração com o CRM Avançado não está configurada neste ambiente.',
    })
  }

  const idUsuarioZap = req.user?.id ?? req.user?.user_id
  const idEmpresaZap = req.user?.company_id
  const email = req.user?.email

  if (!idUsuarioZap || !idEmpresaZap || !email) {
    return res.status(400).json({ error: 'Sessão do ZapERP incompleta para o SSO.' })
  }

  const nome = req.user?.nome || req.user?.name || email

  const token = jwt.sign(
    {
      idEmpresaZap: String(idEmpresaZap),
      idUsuarioZap: String(idUsuarioZap),
      email: String(email),
      nome: String(nome),
    },
    segredo,
    { algorithm: 'HS256', expiresIn: '2m' },
  )

  const url = `${baseUrl}/sso?token=${encodeURIComponent(token)}`
  return res.json({ url })
}

module.exports = { abrirCrmAvancado }
