/**
 * Lista de grupos para o modal de encaminhar.
 * Regras puras (sem query): visibilidade por setor, limite e formato do item.
 */

const { normalizePositiveIds } = require('../../../helpers/departamentoGruposHelper')
const { escapeIlikePattern, quoteOrValue } = require('../../../helpers/chatSearchHelper')

const FORWARD_GROUPS_DEFAULT_LIMIT = 200
const FORWARD_GROUPS_MAX_LIMIT = 400
const FORWARD_GROUPS_IN_CHUNK = 150

function parseForwardGroupsLimit(raw) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return FORWARD_GROUPS_DEFAULT_LIMIT
  return Math.min(n, FORWARD_GROUPS_MAX_LIMIT)
}

/**
 * null = admin, sem restrição por id (ainda filtra company_id e número).
 * Array = ids de grupos do setor do usuário + grupos sem setor vinculado.
 */
function resolveForwardGroupAllowlist({ isAdmin, gruposDoSetor, gruposSemDepartamento }) {
  if (isAdmin) return null
  return normalizePositiveIds([...(gruposDoSetor || []), ...(gruposSemDepartamento || [])])
}

function buildForwardGroupSearchOr(raw) {
  const term = String(raw || '').trim()
  if (term.length < 2) return null
  const pattern = quoteOrValue(`%${escapeIlikePattern(term)}%`)
  return `nome_grupo.ilike.${pattern},telefone.ilike.${pattern}`
}

function mapGrupoEncaminharRow(row) {
  if (!row || row.id == null) return null
  const nome =
    row.nome_grupo != null && String(row.nome_grupo).trim()
      ? String(row.nome_grupo).trim()
      : null
  return {
    id: row.id,
    telefone: row.telefone ?? null,
    tipo: 'grupo',
    nome_grupo: nome,
    foto_grupo: row.foto_grupo ?? null,
    is_group: true,
    contato_nome: nome || row.telefone || 'Grupo',
    whatsapp_instance_id: row.whatsapp_instance_id ?? null,
    ultima_atividade: row.ultima_atividade ?? null,
  }
}

function sortGruposEncaminhar(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const ta = a?.ultima_atividade ? Date.parse(a.ultima_atividade) : 0
    const tb = b?.ultima_atividade ? Date.parse(b.ultima_atividade) : 0
    const na = Number.isFinite(ta) ? ta : 0
    const nb = Number.isFinite(tb) ? tb : 0
    if (nb !== na) return nb - na
    return Number(b?.id) - Number(a?.id)
  })
}

function chunkIds(ids, size = FORWARD_GROUPS_IN_CHUNK) {
  const list = Array.isArray(ids) ? ids : []
  const step = Math.max(1, Number(size) || FORWARD_GROUPS_IN_CHUNK)
  const chunks = []
  for (let i = 0; i < list.length; i += step) chunks.push(list.slice(i, i + step))
  return chunks
}

module.exports = {
  FORWARD_GROUPS_DEFAULT_LIMIT,
  FORWARD_GROUPS_MAX_LIMIT,
  FORWARD_GROUPS_IN_CHUNK,
  parseForwardGroupsLimit,
  resolveForwardGroupAllowlist,
  buildForwardGroupSearchOr,
  mapGrupoEncaminharRow,
  sortGruposEncaminhar,
  chunkIds,
}
