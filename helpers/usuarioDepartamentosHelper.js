/**
 * Helper para usuários com múltiplos departamentos.
 * Retorna departamento_ids (array) do usuário a partir da tabela usuario_departamentos.
 * Compatível com legado: se tabela não existir ou usuário não tiver registros, usa departamento_id de usuarios.
 */

const supabase = require('../config/supabase')

/**
 * Retorna array de departamento_ids do usuário.
 * @param {number} usuario_id
 * @param {number} company_id
 * @param {object} usuarioLegado - usuário com departamento_id (fallback)
 * @returns {Promise<number[]>}
 */
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
        return fallbackDepartamentoId(usuarioLegado)
      }
      throw error
    }

    const ids = (data || []).map((r) => Number(r.departamento_id)).filter((id) => Number.isFinite(id) && id > 0)
    if (ids.length > 0) return ids
    return fallbackDepartamentoId(usuarioLegado)
  } catch (e) {
    return fallbackDepartamentoId(usuarioLegado)
  }
}

function fallbackDepartamentoId(usuarioLegado) {
  const depId = usuarioLegado?.departamento_id
  if (depId != null && Number.isFinite(Number(depId))) return [Number(depId)]
  return []
}

/**
 * Verifica se o usuário pertence ao departamento (por ID ou array de IDs).
 * @param {number|number[]} userDepIds - departamento_id (legado) ou array de departamento_ids
 * @param {number|null} convDepId - departamento_id da conversa
 * @returns {boolean}
 */
function usuarioPertenceAoDepartamento(userDepIds, convDepId) {
  if (convDepId == null) return true
  const ids = Array.isArray(userDepIds) ? userDepIds : (userDepIds != null ? [Number(userDepIds)] : [])
  return ids.some((id) => Number(id) === Number(convDepId))
}

/**
 * Retorna condição para usuário sem departamentos (sem setor).
 * @param {number|number[]} userDepIds
 * @returns {boolean}
 */
function usuarioSemDepartamentos(userDepIds) {
  const ids = Array.isArray(userDepIds) ? userDepIds : (userDepIds != null ? [Number(userDepIds)] : [])
  return ids.length === 0
}

module.exports = {
  obterDepartamentoIdsDoUsuario,
  usuarioPertenceAoDepartamento,
  usuarioSemDepartamentos
}
