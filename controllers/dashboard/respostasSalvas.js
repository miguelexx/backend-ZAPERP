const supabase = require('../../config/supabase')

async function validarDepartamentoEmpresa(company_id, departamento_id) {
  if (departamento_id == null || departamento_id === '') return null
  const depId = Number(departamento_id)
  if (!Number.isFinite(depId) || depId <= 0) return { error: 'Setor inválido' }
  const { data: dep, error } = await supabase
    .from('departamentos')
    .select('id')
    .eq('id', depId)
    .eq('company_id', company_id)
    .maybeSingle()
  if (error) return { error: error.message }
  if (!dep) return { error: 'Setor não encontrado nesta empresa' }
  return { departamento_id: depId }
}

function isAdminOrSupervisor(user) {
  const perfil = String(user?.perfil || '').toLowerCase()
  return perfil === 'admin' || perfil === 'administrador' || perfil === 'supervisor'
}

async function buscarRespostaSalvaGerenciavel(company_id, id) {
  const { data, error } = await supabase
    .from('respostas_salvas')
    .select('id, usuario_id, departamento_id')
    .eq('id', id)
    .eq('company_id', company_id)
    .maybeSingle()
  if (error) return { error: error.message }
  if (!data) return { notFound: true }
  return { resposta: data }
}

function podeGerenciarRespostaSalva(resposta, userId, user) {
  if (resposta?.departamento_id == null) {
    return Number(resposta.usuario_id) === userId || isAdminOrSupervisor(user)
  }
  return Number(resposta.usuario_id) === userId
}

async function listarRespostasSalvas(req, res) {
  try {
    const { company_id, id: usuario_id } = req.user
    const userId = Number(usuario_id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Usuário inválido' })
    }
    const { departamento_id, contexto } = req.query
    const contextoAtendimento = String(contexto || '').toLowerCase() === 'atendimento'
    let q = supabase
      .from('respostas_salvas')
      // NÃO embutir departamentos aqui: em alguns schemas o PostgREST detecta mais de 1 relacionamento
      // entre respostas_salvas e departamentos e retorna:
      // "Could not embed because more than one relationship was found..."
      .select('id, titulo, texto, departamento_id, usuario_id, criado_em')
      .eq('company_id', company_id)
      .or(`departamento_id.is.null,usuario_id.eq.${userId}`)
      .order('titulo')
    if (departamento_id != null && departamento_id !== '') {
      const depId = Number(departamento_id)
      if (Number.isFinite(depId) && depId > 0) {
        q = q.or(`departamento_id.eq.${depId},departamento_id.is.null`)
      }
    } else if (contextoAtendimento) {
      // Conversa sem setor: apenas respostas globais (não expor vinculadas a setor)
      q = q.is('departamento_id', null)
    }
    const { data, error } = await q
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const list = Array.isArray(data) ? data : []

    // Resolve nomes de departamento manualmente (evita embed ambíguo)
    const depIds = [...new Set(list.map((r) => r?.departamento_id).filter((id) => id != null))]
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

    const out = list.map((r) => ({
      ...r,
      departamentos: r?.departamento_id != null ? (depMap[String(r.departamento_id)] ? { nome: depMap[String(r.departamento_id)].nome } : null) : null,
    }))

    return res.json(out)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar respostas salvas' })
  }
}

const LIMITE_RESPOSTAS_ATENDENTE = 5

async function criarRespostaSalva(req, res) {
  try {
    const { company_id, id: usuario_id } = req.user
    const userId = Number(usuario_id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Usuário inválido' })
    }
    const { titulo, texto, departamento_id } = req.body
    const tituloTrim = String(titulo || '').trim()
    const textoTrim = String(texto || '').trim()
    if (!tituloTrim || !textoTrim) return res.status(400).json({ error: 'titulo e texto obrigatórios' })
    if (tituloTrim.length > 255) return res.status(400).json({ error: 'titulo deve ter no máximo 255 caracteres' })

    // Atendentes têm limite de respostas salvas próprias
    if (!isAdminOrSupervisor(req.user)) {
      const { count, error: countErr } = await supabase
        .from('respostas_salvas')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company_id)
        .eq('usuario_id', userId)
      if (countErr) {
        console.error('[respostas_salvas] count error:', countErr.message)
      } else if ((count ?? 0) >= LIMITE_RESPOSTAS_ATENDENTE) {
        return res.status(400).json({
          error: `Limite de ${LIMITE_RESPOSTAS_ATENDENTE} respostas salvas atingido. Exclua uma existente antes de criar outra.`,
          code: 'LIMITE_RESPOSTAS_ATINGIDO',
          limite: LIMITE_RESPOSTAS_ATENDENTE,
          total: count,
        })
      }
    }

    const depCheck = await validarDepartamentoEmpresa(company_id, departamento_id)
    if (depCheck?.error) return res.status(400).json({ error: depCheck.error })
    const depId = depCheck?.departamento_id ?? null
    const { data, error } = await supabase
      .from('respostas_salvas')
      .insert({
        company_id,
        usuario_id: userId,
        titulo: tituloTrim,
        texto: textoTrim,
        departamento_id: depId,
      })
      .select()
      .single()
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    return res.status(201).json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar resposta salva' })
  }
}

async function atualizarRespostaSalva(req, res) {
  try {
    const { company_id, id: usuario_id } = req.user
    const userId = Number(usuario_id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Usuário inválido' })
    }
    const { id } = req.params
    const { titulo, texto, departamento_id } = req.body
    const update = {}
    if (titulo !== undefined) {
      const tituloTrim = String(titulo || '').trim()
      if (!tituloTrim) return res.status(400).json({ error: 'titulo obrigatório' })
      if (tituloTrim.length > 255) return res.status(400).json({ error: 'titulo deve ter no máximo 255 caracteres' })
      update.titulo = tituloTrim
    }
    if (texto !== undefined) {
      const textoTrim = String(texto || '').trim()
      if (!textoTrim) return res.status(400).json({ error: 'texto obrigatório' })
      update.texto = textoTrim
    }
    if (departamento_id !== undefined) {
      const depCheck = await validarDepartamentoEmpresa(company_id, departamento_id)
      if (depCheck?.error) return res.status(400).json({ error: depCheck.error })
      const depId = depCheck?.departamento_id ?? null
      update.departamento_id = depId
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' })
    }
    const found = await buscarRespostaSalvaGerenciavel(company_id, id)
    if (found?.error) return res.status(500).json({ error: found.error })
    if (found?.notFound) return res.status(404).json({ error: 'Resposta não encontrada' })
    if (!podeGerenciarRespostaSalva(found.resposta, userId, req.user)) {
      return res.status(403).json({ error: 'Sem permissão para editar esta resposta' })
    }
    const { data, error } = await supabase
      .from('respostas_salvas')
      .update(update)
      .eq('id', id)
      .eq('company_id', company_id)
      .select()
      .single()
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    if (!data) return res.status(404).json({ error: 'Resposta não encontrada' })
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar resposta salva' })
  }
}

async function excluirRespostaSalva(req, res) {
  try {
    const { company_id, id: usuario_id } = req.user
    const userId = Number(usuario_id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: 'Usuário inválido' })
    }
    const { id } = req.params
    const found = await buscarRespostaSalvaGerenciavel(company_id, id)
    if (found?.error) return res.status(500).json({ error: found.error })
    if (found?.notFound) return res.status(404).json({ error: 'Resposta não encontrada' })
    if (!podeGerenciarRespostaSalva(found.resposta, userId, req.user)) {
      return res.status(403).json({ error: 'Sem permissão para excluir esta resposta' })
    }
    const { error } = await supabase
      .from('respostas_salvas')
      .delete()
      .eq('id', id)
      .eq('company_id', company_id)
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    return res.json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao excluir resposta salva' })
  }
}

module.exports = {
  listarRespostasSalvas,
  criarRespostaSalva,
  atualizarRespostaSalva,
  excluirRespostaSalva,
}
