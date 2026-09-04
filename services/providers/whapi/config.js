/**
 * Resolve instância Whapi da empresa.
 * companyId obrigatório. Instância explícita recusada se for de outro tenant.
 * GUARDA CRÍTICA: só resolve se a instância for provider='whapi' — nunca manda
 * credenciais de uma instância UltraMSG pelo adapter Whapi (e vice-versa).
 *
 * Whapi: channel id = whatsapp_instances.instance_id (ex. NEBULA-AER3B) — SEM prefixo "instance".
 *        token = whatsapp_instances.instance_token (Bearer).
 */

const {
  getDefaultWhatsappInstance,
  getWhatsappInstanceById,
} = require('../../whatsappInstanceService')

const PROVIDER = 'whapi'

async function resolveConfig(opts = {}) {
  const companyId = opts?.companyId ?? opts?.company_id
  if (companyId == null || companyId === '') return null
  const cid = Number(companyId)
  const whatsappInstanceId = opts?.whatsappInstanceId ?? opts?.whatsapp_instance_id
  const resolved = whatsappInstanceId
    ? await getWhatsappInstanceById(cid, whatsappInstanceId, { includeCredentials: true, requireActive: true })
    : await getDefaultWhatsappInstance(cid, { includeCredentials: true, provider: PROVIDER })
  const instance = resolved?.instance
  if (resolved?.error || !instance) {
    console.warn(`[WHAPI] Empresa ${companyId} sem instancia Whapi configurada.`, resolved?.error || 'config vazio')
    return null
  }
  // Guarda de provider: adapter Whapi só fala com instância Whapi.
  const provider = String(instance.provider || '').trim().toLowerCase()
  if (provider !== PROVIDER) {
    console.warn(`[WHAPI] Instancia ${instance.id} da empresa ${cid} nao e provider=whapi (e '${provider}'). Recusado.`)
    return null
  }
  const channelId = String(instance.instance_id || '').trim()
  const token = String(instance.instance_token || '').trim()
  if (!channelId || !token) return null
  return {
    token,
    channelId,
    companyId: cid,
    whatsappInstanceId: instance.id ?? null,
    provider: PROVIDER,
  }
}

module.exports = { resolveConfig }
