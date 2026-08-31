const crmSync = require('../../services/crmSyncService')

/**
 * GET /dashboard/crm-resumo — métricas do CRM Avançado da empresa.
 *
 * Endpoint dedicado e isolado de propósito: buscar o resumo dentro de /overview
 * bloquearia a home num GET externo de até 8s. Aqui o painel carrega este bloco
 * à parte (lazy). empresaId vem SEMPRE do JWT. Se a integração estiver desativada
 * ou o CRM não responder, devolve enabled:false / crm:null — nunca erro — para o
 * painel simplesmente não exibir as métricas do CRM.
 */
async function crmResumo(req, res) {
  const { company_id } = req.user
  try {
    if (!crmSync.isEnabled()) {
      return res.json({ enabled: false, empresaId: String(company_id), crm: null })
    }
    const resumo = await crmSync.resumoEmpresa(company_id)
    return res.json({
      enabled: true,
      empresaId: String(company_id),
      crm: resumo?.crm ?? null,
    })
  } catch (err) {
    console.error('[dashboardController] crmResumo', err?.message || err)
    return res.json({ enabled: false, empresaId: String(company_id ?? ''), crm: null })
  }
}

module.exports = { crmResumo }
