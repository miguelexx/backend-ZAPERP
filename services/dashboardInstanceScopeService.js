const { listWhatsappInstances, getWhatsappInstanceById } = require('./whatsappInstanceService')

function toPositiveId(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null
}

async function resolveDashboardInstanceScope(companyId, requestedInstanceId = null) {
  const company_id = toPositiveId(companyId)
  if (!company_id) throw new Error('company_id inválido')

  const requested = toPositiveId(requestedInstanceId)
  if (requestedInstanceId != null && String(requestedInstanceId).trim() !== '' && !requested) {
    const err = new Error('whatsapp_instance_id inválido')
    err.status = 400
    throw err
  }

  if (requested) {
    const result = await getWhatsappInstanceById(company_id, requested, { requireActive: true })
    if (result.error || !result.instance) {
      const err = new Error('Instância WhatsApp inválida ou inativa para esta empresa')
      err.status = 400
      throw err
    }
    return {
      company_id,
      whatsapp_instance_id: requested,
      include_legacy_null: false,
      source: 'explicit',
      nome: result.instance.nome || 'WhatsApp',
    }
  }

  const { instances, error } = await listWhatsappInstances(company_id)
  if (error) throw new Error(error)
  const active = (instances || []).filter((item) => item?.ativo !== false)
  const withId = active.filter((item) => toPositiveId(item?.id))

  if (withId.length === 1) {
    return {
      company_id,
      whatsapp_instance_id: Number(withId[0].id),
      // Compatibilidade controlada: em uma empresa com uma única instância, linhas
      // anteriores à migração não podem pertencer a outra instância da empresa.
      include_legacy_null: true,
      source: 'single_active',
      nome: withId[0].nome || 'WhatsApp principal',
    }
  }

  const defaultInstance = withId.find((item) => item.is_default === true)
  if (defaultInstance) {
    return {
      company_id,
      whatsapp_instance_id: Number(defaultInstance.id),
      include_legacy_null: false,
      source: 'default_active',
      nome: defaultInstance.nome || 'WhatsApp principal',
    }
  }

  if (withId.length > 1) {
    const err = new Error('Selecione uma instância WhatsApp para consultar o Dashboard')
    err.status = 400
    throw err
  }

  return {
    company_id,
    whatsapp_instance_id: null,
    include_legacy_null: true,
    source: 'legacy_only',
    nome: active[0]?.nome || 'WhatsApp principal',
  }
}

function applyDashboardInstanceScope(query, scope) {
  const instanceId = toPositiveId(scope?.whatsapp_instance_id)
  if (!instanceId) return query.is('whatsapp_instance_id', null)
  if (scope?.include_legacy_null === true) {
    return query.or(`whatsapp_instance_id.eq.${instanceId},whatsapp_instance_id.is.null`)
  }
  return query.eq('whatsapp_instance_id', instanceId)
}

module.exports = {
  resolveDashboardInstanceScope,
  applyDashboardInstanceScope,
}
