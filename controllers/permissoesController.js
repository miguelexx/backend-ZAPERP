/**
 * Controller de permissões granulares.
 * Catálogo, listagem e atualização de permissões por usuário.
 */
const {
  PERMISSOES_CATALOGO,
  getCatalogoAgrupado
} = require('../helpers/permissoesCatalogo')
const {
  getPermissoesEfetivasUsuario,
  salvarPermissoesUsuario
} = require('../helpers/permissoesService')
const supabase = require('../config/supabase')
const { registrar: registrarAuditoria } = require('../helpers/auditoriaLog')

/** GET /config/permissoes/catalogo — lista todas as permissões agrupadas por categoria */
exports.getCatalogo = async (req, res) => {
  try {
    const agrupado = getCatalogoAgrupado()
    const categorias = Object.keys(agrupado).sort()
    const catalogo = categorias.map((cat) => ({
      categoria: cat,
      permissoes: agrupado[cat]
    }))
    return res.json({ catalogo, flat: PERMISSOES_CATALOGO })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar catálogo de permissões' })
  }
}

/** GET /usuarios/:id/permissoes — permissões efetivas do usuário (admin ou próprio usuário) */
exports.getPermissoesUsuario = async (req, res) => {
  try {
    const { company_id, id: current_user_id, perfil } = req.user
    const { id: target_user_id } = req.params
    const tid = Number(target_user_id)

    // Só admin pode ver permissões de outros; usuário pode ver as próprias
    if (Number(current_user_id) !== tid && perfil !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão para visualizar permissões deste usuário' })
    }

    const { data: usuario, error: errUser } = await supabase
      .from('usuarios')
      .select('id, nome, email, perfil, departamento_id')
      .eq('id', tid)
      .eq('company_id', company_id)
      .maybeSingle()

    if (errUser) return res.status(500).json({ error: errUser.message })
    if (!usuario) return res.status(404).json({ error: 'Usuário não encontrado' })

    const permissoes = await getPermissoesEfetivasUsuario(tid, company_id, usuario.perfil || 'atendente')

    return res.json({
      usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil, departamento_id: usuario.departamento_id },
      permissoes
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar permissões do usuário' })
  }
}

/** PUT /usuarios/:id/permissoes — atualiza overrides de permissões (somente admin) */
exports.putPermissoesUsuario = async (req, res) => {
  try {
    const { company_id, perfil } = req.user
    const { id: target_user_id } = req.params
    const { permissoes } = req.body

    if (perfil !== 'admin') {
      return res.status(403).json({ error: 'Somente admin pode alterar permissões de usuários' })
    }

    const tid = Number(target_user_id)
    const { data: usuario } = await supabase
      .from('usuarios')
      .select('id, perfil')
      .eq('id', tid)
      .eq('company_id', company_id)
      .maybeSingle()

    if (!usuario) return res.status(404).json({ error: 'Usuário não encontrado' })

    if (!permissoes || typeof permissoes !== 'object') {
      return res.status(400).json({ error: 'Corpo deve conter { permissoes: { codigo: boolean|null } }' })
    }

    const result = await salvarPermissoesUsuario(tid, company_id, permissoes)
    if (result.error) return res.status(500).json({ error: result.error })

    await registrarAuditoria({
      company_id,
      usuario_id: req.user?.id,
      acao: 'permissoes_alterar',
      entidade: 'usuario',
      entidade_id: tid,
      detalhes_json: { permissoes_alteradas: Object.keys(permissoes || {}) },
    })

    const efetivas = await getPermissoesEfetivasUsuario(tid, company_id, usuario.perfil || 'atendente')
    return res.json({ ok: true, permissoes: efetivas })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao salvar permissões' })
  }
}

/** GET /config/permissoes/me — minhas permissões efetivas (para o frontend esconder/mostrar menus) */
exports.getMinhasPermissoes = async (req, res) => {
  try {
    const { company_id, id: user_id, perfil } = req.user
    const permissoes = await getPermissoesEfetivasUsuario(user_id, company_id, perfil)
    const mapa = {}
    for (const p of permissoes) {
      mapa[p.codigo] = p.concedido
    }
    return res.json({ permissoes: mapa, detalhado: permissoes })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar suas permissões' })
  }
}
