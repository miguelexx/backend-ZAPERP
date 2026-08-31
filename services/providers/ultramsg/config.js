/**
 * Resolve instância UltraMSG da empresa.
 * companyId obrigatório. Instância explícita recusada se for de outro tenant.
 */

const {
  getDefaultWhatsappInstance,
  getWhatsappInstanceById,
} = require('../../whatsappInstanceService')
const { ULTRAMSG_BASE_URL } = require('./constants')

/**
 * Resolve config (basePath, token) para chamadas à UltraMsg.
 * @param {{ companyId?: number }} [opts]
 */
async function resolveConfig(opts = {}) {
  const companyId = opts?.companyId ?? opts?.company_id
  if (companyId == null || companyId === '') return null
  const cid = Number(companyId)
  const whatsappInstanceId = opts?.whatsappInstanceId ?? opts?.whatsapp_instance_id
  const resolved = whatsappInstanceId
    ? await getWhatsappInstanceById(cid, whatsappInstanceId, { includeCredentials: true, requireActive: true })
    : await getDefaultWhatsappInstance(cid, { includeCredentials: true })
  const instance = resolved.instance
  const config = instance
  const error = resolved.error
  if (resolved.error || !instance) {
    console.warn(`[ULTRAMSG] Empresa ${companyId} sem instancia WhatsApp configurada.`, error || 'config vazio')
    return null
  }
  const instanceId = String(config.instance_id || '').trim()
  const token = String(config.instance_token || '').trim()
  if (!instanceId || !token) return null
  const segment = instanceId.toLowerCase().startsWith('instance') ? instanceId : `instance${instanceId}`
  const basePath = `${ULTRAMSG_BASE_URL}/${encodeURIComponent(segment)}`
  return {
    basePath,
    token,
    instanceId: segment,
    companyId: cid,
    whatsappInstanceId: instance.id ?? null,
    provider: instance.provider || 'ultramsg',
  }
}

module.exports = { resolveConfig }
