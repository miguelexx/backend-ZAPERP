/**
 * Helper para usuarios com multiplos departamentos.
 * Retorna departamento_ids a partir da tabela usuario_departamentos.
 * Compat com legado: se a tabela nao existir ou nao houver registros, usa usuarios.departamento_id.
 */

const supabase = require('../config/supabase')

function normalizeDepartamentoIds(ids) {
  const source = Array.isArray(ids) ? ids : (ids != null ? [ids] : [])
  return [...new Set(
    source
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id))
  )]
}

async function filtrarDepartamentosDaEmpresa(company_id, ids) {
  const cid = Number(company_id)
  const normalized = normalizeDepartamentoIds(ids)
  if (!Number.isFinite(cid) || cid <= 0 || normalized.length === 0) {
    return { validIds: [], invalidIds: normalized }
  }

  const { data, error } = await supabase
    .from('departamentos')
    .select('id')
    .eq('company_id', cid)
    .in('id', normalized)

  if (error) throw error

  const validSet = new Set((data || []).map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0))
  return {
    validIds: normalized.filter((id) => validSet.has(id)),
    invalidIds: normalized.filter((id) => !validSet.has(id)),
  }
}

async function validarDepartamentoIdsDaEmpresa(company_id, ids) {
  const { validIds, invalidIds } = await filtrarDepartamentosDaEmpresa(company_id, ids)
  if (invalidIds.length > 0) {
    return {
      ok: false,
      validIds,
      invalidIds,
      error: 'Departamento invalido para esta empresa',
    }
  }
  return { ok: true, validIds, invalidIds: [] }
}

async function fallbackDepartamentoId(usuarioLegado, company_id = null) {
  const ids = normalizeDepartamentoIds(usuarioLegado?.departamento_id)
  if (ids.length === 0) return []
  if (company_id == null) return ids
  try {
    const { validIds } = await filtrarDepartamentosDaEmpresa(company_id, ids)
    return validIds
  } catch (_) {
    return []
  }
}

async function obterDepartamentoIdsDoUsuario(usuario_id, company_id, usuarioLegado = null) {
  try {
    const { data, error } = await supabase
      .from('usuario_departamentos')
      .select('departamento_id')
      .eq('usuario_id', Number(usuario_id))
      .eq('company_id', Number(company_id))

    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('usuario_departamentos') || msg.includes('does not exist') || msg.includes('relation')) {
        return await fallbackDepartamentoId(usuarioLegado, company_id)
      }
      throw error
    }

    const ids = normalizeDepartamentoIds((data || []).map((r) => r.departamento_id))
    if (ids.length > 0) {
      const { validIds } = await filtrarDepartamentosDaEmpresa(company_id, ids)
      if (validIds.length > 0) return validIds
    }
    return await fallbackDepartamentoId(usuarioLegado, company_id)
  } catch (_) {
    return await fallbackDepartamentoId(usuarioLegado, company_id)
  }
}

function usuarioPertenceAoDepartamento(userDepIds, convDepId) {
  if (convDepId == null) return true
  const ids = normalizeDepartamentoIds(userDepIds)
  return ids.some((id) => Number(id) === Number(convDepId))
}

function usuarioSemDepartamentos(userDepIds) {
  return normalizeDepartamentoIds(userDepIds).length === 0
}

module.exports = {
  obterDepartamentoIdsDoUsuario,
  validarDepartamentoIdsDaEmpresa,
  filtrarDepartamentosDaEmpresa,
  normalizeDepartamentoIds,
  usuarioPertenceAoDepartamento,
  usuarioSemDepartamentos,
}
