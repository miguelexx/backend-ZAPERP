const supabase = require('../config/supabase')

function normalizePositiveIds(ids) {
  const arr = Array.isArray(ids) ? ids : ids != null ? [ids] : []
  return [
    ...new Set(
      arr
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ]
}

function isAdminRole(role) {
  return String(role || '').toLowerCase() === 'admin'
}

function isGroupRow(row) {
  if (!row) return false
  const tipo = String(row.tipo || '').toLowerCase()
  const telefone = String(row.telefone || '').toLowerCase()
  return tipo === 'grupo' || tipo === 'group' || telefone.endsWith('@g.us')
}

async function getGrupoDepartamentoIds(company_id, conversa_id) {
  const { data, error } = await supabase
    .from('departamento_grupos')
    .select('departamento_id')
    .eq('company_id', Number(company_id))
    .eq('conversa_id', Number(conversa_id))

  if (error) throw error
  return normalizePositiveIds((data || []).map((row) => row.departamento_id))
}

async function getGrupoIdsPorDepartamentos(company_id, departamentoIds) {
  const depIds = normalizePositiveIds(departamentoIds)
  if (depIds.length === 0) return []

  const { data, error } = await supabase
    .from('departamento_grupos')
    .select('conversa_id')
    .eq('company_id', Number(company_id))
    .in('departamento_id', depIds)

  if (error) throw error
  return normalizePositiveIds((data || []).map((row) => row.conversa_id))
}

async function usuarioPodeVerGrupo({ company_id, conversa_id, role, departamento_ids }) {
  if (isAdminRole(role)) return true
  const userDepIds = normalizePositiveIds(departamento_ids)
  if (userDepIds.length === 0) return false

  const grupoDepIds = await getGrupoDepartamentoIds(company_id, conversa_id)
  if (grupoDepIds.length === 0) return false

  const userDepSet = new Set(userDepIds)
  return grupoDepIds.some((depId) => userDepSet.has(Number(depId)))
}

function pushNonGroupVisibilityParts(parts, field, values) {
  const ids = normalizePositiveIds(values)
  ids.forEach((id) => {
    parts.push(`and(${field}.eq.${id},tipo.is.null)`)
    parts.push(`and(${field}.eq.${id},tipo.neq.grupo)`)
  })
}

function pushAllowedGroupIdsPart(parts, grupoIds) {
  const ids = normalizePositiveIds(grupoIds)
  if (ids.length > 0) {
    parts.push(`id.in.(${ids.join(',')})`)
  }
}

module.exports = {
  normalizePositiveIds,
  isGroupRow,
  getGrupoDepartamentoIds,
  getGrupoIdsPorDepartamentos,
  usuarioPodeVerGrupo,
  pushNonGroupVisibilityParts,
  pushAllowedGroupIdsPart,
}
