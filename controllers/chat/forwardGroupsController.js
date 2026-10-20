/**
 * GET /chats/grupos — destinos de grupo no encaminhamento.
 * Independente da aba atual da lista (Em atendimento, Minha fila, etc.).
 * company_id vem só do JWT. Visibilidade: admin vê os grupos da empresa;
 * demais perfis veem grupos do próprio setor e grupos sem setor vinculado.
 */

const supabase = require('../../config/supabase')
const {
  getGrupoIdsPorDepartamentos,
  getGrupoIdsSemDepartamento,
} = require('../../helpers/departamentoGruposHelper')
const { instanciasPermitidasDoUsuario } = require('../../services/chat/access/usuarioWhatsappInstanceAccess')
const { aplicarFiltroNumerosPermitidos } = require('../../services/chat/access/usuarioWhatsappInstanceAccessRules')
const {
  parseForwardGroupsLimit,
  resolveForwardGroupAllowlist,
  buildForwardGroupSearchOr,
  mapGrupoEncaminharRow,
  sortGruposEncaminhar,
  chunkIds,
} = require('../../services/chat/read/forwardGroupsList')

const SELECT_GRUPO =
  'id, telefone, tipo, nome_grupo, foto_grupo, whatsapp_instance_id, ultima_atividade'

function grupoQuery({ company_id, instanciasPermitidas, searchOr }) {
  let q = supabase
    .from('conversas')
    .select(SELECT_GRUPO)
    .eq('company_id', company_id)
    .eq('tipo', 'grupo')
  q = aplicarFiltroNumerosPermitidos(q, instanciasPermitidas, null)
  if (searchOr) q = q.or(searchOr)
  return q
}

async function fetchGrupoRows({ company_id, allowlist, searchOr, limit, instanciasPermitidas }) {
  if (Array.isArray(allowlist) && allowlist.length === 0) return []

  if (allowlist == null) {
    const { data, error } = await grupoQuery({ company_id, instanciasPermitidas, searchOr })
      .order('ultima_atividade', { ascending: false, nullsFirst: false })
      .limit(limit)
    if (error) throw error
    return data || []
  }

  const rows = []
  for (const chunk of chunkIds(allowlist)) {
    const { data, error } = await grupoQuery({ company_id, instanciasPermitidas, searchOr })
      .in('id', chunk)
      .order('ultima_atividade', { ascending: false, nullsFirst: false })
      .limit(limit)
    if (error) throw error
    rows.push(...(data || []))
  }
  return sortGruposEncaminhar(rows).slice(0, limit)
}

exports.listarGruposEncaminhar = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user || {}
    if (company_id == null) return res.status(401).json({ error: 'Não autenticado' })

    const isAdmin = String(perfil || '').toLowerCase() === 'admin'
    const limit = parseForwardGroupsLimit(req.query?.limit)
    const searchOr = buildForwardGroupSearchOr(req.query?.palavra)
    const instanciasPermitidas = await instanciasPermitidasDoUsuario(company_id, user_id)

    let allowlist = null
    if (!isAdmin) {
      const [gruposDoSetor, gruposSemDepartamento] = await Promise.all([
        getGrupoIdsPorDepartamentos(company_id, departamento_ids),
        getGrupoIdsSemDepartamento(company_id),
      ])
      allowlist = resolveForwardGroupAllowlist({
        isAdmin: false,
        gruposDoSetor,
        gruposSemDepartamento,
      })
    }

    const rows = await fetchGrupoRows({
      company_id,
      allowlist,
      searchOr,
      limit,
      instanciasPermitidas,
    })

    return res.json(
      rows.map(mapGrupoEncaminharRow).filter(Boolean)
    )
  } catch (error) {
    console.error('[listarGruposEncaminhar]', error?.message || error)
    return res.status(500).json({ error: 'Erro ao listar grupos' })
  }
}
