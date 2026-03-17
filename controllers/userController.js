const supabase = require('../config/supabase')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')

/** GET /usuarios/me — perfil do usuário logado (inclui preferências) */
exports.getMe = async (req, res) => {
  try {
    const { id: user_id, company_id } = req.user
    let { data, error } = await supabase
      .from('usuarios')
      .select('id, nome, email, perfil, departamento_id, mostrar_nome_ao_cliente')
      .eq('id', user_id)
      .eq('company_id', company_id)
      .maybeSingle()
    if (error && (String(error.message || '').includes('mostrar_nome_ao_cliente') || String(error.message || '').includes('does not exist'))) {
      const res2 = await supabase.from('usuarios').select('id, nome, email, perfil, departamento_id').eq('id', user_id).eq('company_id', company_id).maybeSingle()
      data = res2.data
      error = res2.error
      if (error) return res.status(500).json({ error: error.message })
      if (!data) return res.status(404).json({ error: 'Usuário não encontrado' })
      return res.json({ ...data, mostrar_nome_ao_cliente: true })
    }
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Usuário não encontrado' })
    return res.json({
      ...data,
      mostrar_nome_ao_cliente: data.mostrar_nome_ao_cliente !== false
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao buscar perfil' })
  }
}

/** PATCH /usuarios/me — atualiza preferências do usuário logado */
exports.patchMe = async (req, res) => {
  try {
    const { id: user_id, company_id } = req.user
    const { mostrar_nome_ao_cliente } = req.body || {}
    if (typeof mostrar_nome_ao_cliente !== 'boolean') return res.status(400).json({ error: 'mostrar_nome_ao_cliente deve ser true ou false' })
    const { data, error } = await supabase
      .from('usuarios')
      .update({ mostrar_nome_ao_cliente })
      .eq('id', user_id)
      .eq('company_id', company_id)
      .select('id, nome, mostrar_nome_ao_cliente')
      .single()
    if (error) {
      if (String(error.message || '').includes('mostrar_nome_ao_cliente') || String(error.message || '').includes('does not exist')) {
        return res.status(400).json({ error: 'Preferência indisponível. Execute a migration: ALTER TABLE usuarios ADD COLUMN mostrar_nome_ao_cliente boolean DEFAULT true;' })
      }
      return res.status(500).json({ error: error.message })
    }
    if (!data) return res.status(404).json({ error: 'Usuário não encontrado' })
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar preferências' })
  }
}

/** GET /usuarios — lista atendentes da empresa (admin vê todos inclusive inativos) */
exports.listar = async (req, res) => {
  try {
    const { company_id, perfil } = req.user
    let query = supabase
      .from('usuarios')
      // Não embutir departamentos aqui: em alguns schemas o PostgREST detecta mais de 1 relacionamento
      // e retorna "Could not embed because more than one relationship was found..."
      .select('id, nome, email, perfil, ativo, departamento_id, criado_em')
      .eq('company_id', company_id)
      .order('nome')
    if (perfil !== 'admin') {
      query = query.eq('ativo', true)
    }
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })

    const list = Array.isArray(data) ? data : []

    const depIds = [...new Set(list.map((u) => u?.departamento_id).filter((id) => id != null))]
    let depMap = {}
    if (depIds.length > 0) {
      const { data: deps, error: errDeps } = await supabase
        .from('departamentos')
        .select('id, nome')
        .eq('company_id', company_id)
        .in('id', depIds)
      if (!errDeps && Array.isArray(deps)) {
        deps.forEach((d) => {
          if (d?.id != null) depMap[String(d.id)] = d
        })
      }
    }

    const out = list.map((u) => ({
      ...u,
      departamentos:
        u?.departamento_id != null
          ? (depMap[String(u.departamento_id)] ? { nome: depMap[String(u.departamento_id)].nome } : null)
          : null
    }))

    return res.json(out)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar usuários' })
  }
}

const PERFIS_VALIDOS = ['admin', 'supervisor', 'atendente']

/** POST /usuarios — criar usuário (admin) */
exports.criar = async (req, res) => {
  try {
    const { company_id } = req.user
    const { nome, email, senha, perfil, departamento_id, ativo } = req.body
    if (!nome?.trim() || !email?.trim() || !senha?.trim()) {
      return res.status(400).json({ error: 'nome, email e senha são obrigatórios' })
    }
    const perfilNorm = (perfil || 'atendente').toLowerCase()
    if (!PERFIS_VALIDOS.includes(perfilNorm)) {
      return res.status(400).json({ error: `perfil deve ser: ${PERFIS_VALIDOS.join(', ')}` })
    }
    const hash = await bcrypt.hash(senha, 10)
    const { data, error } = await supabase
      .from('usuarios')
      .insert({
        nome: nome.trim(),
        email: email.trim().toLowerCase(),
        senha_hash: hash,
        perfil: perfilNorm,
        company_id,
        departamento_id: departamento_id || null,
        ativo: ativo !== false
      })
      .select('id, nome, email, perfil, ativo, departamento_id')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar usuário' })
  }
}

/** PUT /usuarios/:id — atualizar usuário (admin) */
exports.atualizar = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const { nome, email, perfil, departamento_id, ativo, mostrar_nome_ao_cliente } = req.body
    const update = {}
    if (nome !== undefined) update.nome = nome.trim()
    if (email !== undefined) update.email = email.trim().toLowerCase()
    if (perfil !== undefined) {
      const perfilNorm = (perfil || 'atendente').toLowerCase()
      if (!PERFIS_VALIDOS.includes(perfilNorm)) {
        return res.status(400).json({ error: `perfil deve ser: ${PERFIS_VALIDOS.join(', ')}` })
      }
      update.perfil = perfilNorm
    }
    if (departamento_id !== undefined) update.departamento_id = departamento_id || null
    if (ativo !== undefined) update.ativo = !!ativo
    if (typeof mostrar_nome_ao_cliente === 'boolean') update.mostrar_nome_ao_cliente = mostrar_nome_ao_cliente

    const { data, error } = await supabase
      .from('usuarios')
      .update(update)
      .eq('id', id)
      .eq('company_id', company_id)
      .select('id, nome, email, perfil, ativo, departamento_id, mostrar_nome_ao_cliente')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Usuário não encontrado' })
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar usuário' })
  }
}

/** POST /usuarios/resetar-senha-email — resetar senha por email (admin da empresa) */
exports.resetarSenhaPorEmail = async (req, res) => {
  try {
    const { company_id } = req.user
    const { email, nova_senha } = req.body
    if (!email?.trim() || !nova_senha?.trim()) {
      return res.status(400).json({ error: 'email e nova_senha são obrigatórios' })
    }
    if (nova_senha.length < 6) {
      return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' })
    }
    const emailNorm = String(email).trim().toLowerCase()
    const hash = await bcrypt.hash(nova_senha, 10)
    const { data: usuario, error: errFind } = await supabase
      .from('usuarios')
      .select('id')
      .eq('email', emailNorm)
      .eq('company_id', company_id)
      .maybeSingle()
    if (errFind) return res.status(500).json({ error: errFind.message })
    if (!usuario) return res.status(404).json({ error: 'Usuário não encontrado nesta empresa' })
    const { error } = await supabase
      .from('usuarios')
      .update({ senha_hash: hash })
      .eq('id', usuario.id)
      .eq('company_id', company_id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao redefinir senha' })
  }
}

/** POST /usuarios/:id/redefinir-senha — redefinir senha (admin) */
exports.redefinirSenha = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const { nova_senha } = req.body
    if (!nova_senha?.trim() || nova_senha.length < 6) {
      return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' })
    }
    const hash = await bcrypt.hash(nova_senha, 10)
    const { error } = await supabase
      .from('usuarios')
      .update({ senha_hash: hash })
      .eq('id', id)
      .eq('company_id', company_id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao redefinir senha' })
  }
}

/** DELETE /usuarios/:id — desativar (soft) ou excluir (admin) */
exports.excluir = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const { data: usuario } = await supabase
      .from('usuarios')
      .select('id')
      .eq('id', id)
      .eq('company_id', company_id)
      .single()
    if (!usuario) return res.status(404).json({ error: 'Usuário não encontrado' })
    const { error } = await supabase
      .from('usuarios')
      .update({ ativo: false })
      .eq('id', id)
      .eq('company_id', company_id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao excluir usuário' })
  }
}

exports.login = async (req, res) => {
  try {
    const { email, senha } = req.body

    // Validação e sanitização de entrada
    if (!email || !senha) {
      return res.status(400).json({ error: 'Email e senha obrigatórios' })
    }
    const emailNorm = String(email).trim().toLowerCase().slice(0, 320)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({ error: 'Email inválido' })
    }
    if (String(senha).length > 200) {
      return res.status(400).json({ error: 'Credenciais inválidas' })
    }

    // Busca usuário pelo email (case-insensitive: aceita User@Email.com mesmo se no banco estiver user@email.com)
    const emailParaBusca = emailNorm.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('*')
      .ilike('email', emailParaBusca)
      .maybeSingle()

    const isDev = String(process.env.NODE_ENV || '').toLowerCase() !== 'production'
    function logDevLoginFail(reason) {
      if (isDev) console.log('[LOGIN_DEV]', reason, '| email:', emailNorm?.slice(0, 20) + '***')
    }

    if (error || !usuario) {
      logDevLoginFail('user_not_found')
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }
    if (usuario.ativo === false) {
      logDevLoginFail('inactive')
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }

    const senhaBanco =
      usuario.senha_hash || usuario.senha || usuario.password || usuario.pass
    if (!senhaBanco || typeof senhaBanco !== 'string') {
      logDevLoginFail('hash_invalid')
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }
    if (!senhaBanco.startsWith('$2')) {
      logDevLoginFail('hash_invalid')
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }

    const senhaOk = await bcrypt.compare(senha, senhaBanco)
    if (!senhaOk) {
      logDevLoginFail('bcrypt_mismatch')
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }
    if (!usuario.company_id) {
      logDevLoginFail('no_company_id')
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }

    // Gera JWT com dados essenciais (user_id/company_id obrigatórios p/ multi-tenant)
    const token = jwt.sign(
      {
        user_id: usuario.id,
        id: usuario.id,
        company_id: Number(usuario.company_id),
        email: usuario.email,
        perfil: usuario.perfil || 'atendente',
        departamento_id: usuario.departamento_id ?? null
      },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    )

    // Retorna token e dados do usuário (nome para exibição no cabeçalho)
    return res.json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome || usuario.email?.split('@')[0] || 'Usuário',
        email: usuario.email,
        company_id: usuario.company_id,
        perfil: usuario.perfil || 'atendente',
        departamento_id: usuario.departamento_id ?? null
      }
    })
  } catch (err) {
    console.error('ERRO LOGIN:', err)
    return res.status(500).json({ error: 'Erro no login' })
  }
}
