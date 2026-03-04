const supabase = require('../config/supabase')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')

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

/** POST /usuarios — criar usuário (admin) */
exports.criar = async (req, res) => {
  try {
    const { company_id } = req.user
    const { nome, email, senha, perfil, departamento_id, ativo } = req.body
    if (!nome?.trim() || !email?.trim() || !senha?.trim()) {
      return res.status(400).json({ error: 'nome, email e senha são obrigatórios' })
    }
    const hash = await bcrypt.hash(senha, 10)
    const { data, error } = await supabase
      .from('usuarios')
      .insert({
        nome: nome.trim(),
        email: email.trim().toLowerCase(),
        senha_hash: hash,
        perfil: perfil || 'atendente',
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
    const { nome, email, perfil, departamento_id, ativo } = req.body
    const update = {}
    if (nome !== undefined) update.nome = nome.trim()
    if (email !== undefined) update.email = email.trim().toLowerCase()
    if (perfil !== undefined) update.perfil = perfil || 'atendente'
    if (departamento_id !== undefined) update.departamento_id = departamento_id || null
    if (ativo !== undefined) update.ativo = !!ativo

    const { data, error } = await supabase
      .from('usuarios')
      .update(update)
      .eq('id', id)
      .eq('company_id', company_id)
      .select('id, nome, email, perfil, ativo, departamento_id')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Usuário não encontrado' })
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar usuário' })
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

    // Busca usuário pelo email
    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('*')
      .eq('email', emailNorm)
      .maybeSingle()

    // Não vazar se o usuário existe (padrão SaaS)
    if (error || !usuario) {
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }

    // Conta desativada: não revelar existência (padrão SaaS)
    if (usuario.ativo === false) {
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }

    // 🔎 Localiza corretamente a coluna de senha (compatível com vários padrões)
    const senhaBanco =
      usuario.senha_hash ||
      usuario.senha ||
      usuario.password ||
      usuario.pass

    if (!senhaBanco || typeof senhaBanco !== 'string') {
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }

    // Valida que o hash é bcrypt válido (evita bugs tipo "$2b$10$$2b$10$..." corrompido)
    if (!senhaBanco.startsWith('$2')) {
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }

    // Compara senha enviada com hash do banco
    const senhaOk = await bcrypt.compare(senha, senhaBanco)

    if (!senhaOk) {
      return res.status(401).json({ error: 'Credenciais inválidas' })
    }

    // Verifica se o usuário pertence a uma empresa
    if (!usuario.company_id) {
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

    // Retorna token e dados do usuário
    return res.json({
      token,
      usuario: {
        id: usuario.id,
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
