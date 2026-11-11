const supabase = require('../../config/supabase')
const { normalizePositiveIds, isGroupRow } = require('../../helpers/departamentoGruposHelper')

async function listarDepartamentos(req, res) {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('departamentos')
      .select('id, nome, criado_em')
      .eq('company_id', company_id)
      .order('nome')
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    return res.json(data || [])
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar departamentos' })
  }
}

async function criarDepartamento(req, res) {
  try {
    const { company_id } = req.user
    const { nome } = req.body
    if (!nome?.trim()) return res.status(400).json({ error: 'nome é obrigatório' })
    const { data, error } = await supabase
      .from('departamentos')
      .insert({ company_id, nome: nome.trim() })
      .select()
      .single()
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    return res.status(201).json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar departamento' })
  }
}

async function atualizarDepartamento(req, res) {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const { nome } = req.body
    if (!nome?.trim()) return res.status(400).json({ error: 'nome é obrigatório' })
    const { data, error } = await supabase
      .from('departamentos')
      .update({ nome: nome.trim() })
      .eq('id', id)
      .eq('company_id', company_id)
      .select()
      .single()
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    if (!data) return res.status(404).json({ error: 'Departamento não encontrado' })
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar departamento' })
  }
}

async function excluirDepartamento(req, res) {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const depId = Number(id)

    // Verifica se há usuários vinculados a este departamento
    const { data: usuariosNoSetor } = await supabase
      .from('usuarios')
      .select('id, nome')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)

    if (usuariosNoSetor && usuariosNoSetor.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir: ${usuariosNoSetor.length} usuário(s) ainda vinculado(s) a este setor. Reatribua-os em Configurações > Usuários antes de excluir.`
      })
    }

    // Verifica conversas no setor
    const { data: conversasNoSetor } = await supabase
      .from('conversas')
      .select('id')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)

    if (conversasNoSetor && conversasNoSetor.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir: existem ${conversasNoSetor.length} conversa(s) neste setor. Transfira-as para outro setor antes de excluir.`
      })
    }

    // Verifica respostas salvas e regras automáticas vinculadas
    const { data: respostasVinculadas } = await supabase
      .from('respostas_salvas')
      .select('id')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)
    if (respostasVinculadas?.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir: ${respostasVinculadas.length} resposta(s) salva(s) vinculada(s). Altere ou remova o vínculo em Configurações > Respostas salvas.`
      })
    }

    const { data: regrasVinculadas } = await supabase
      .from('regras_automaticas')
      .select('id')
      .eq('company_id', company_id)
      .eq('departamento_id', depId)
    if (regrasVinculadas?.length > 0) {
      return res.status(400).json({
        error: `Não é possível excluir: ${regrasVinculadas.length} regra(s) automática(s) vinculada(s). Altere em IA > Respostas automáticas.`
      })
    }

    const { error } = await supabase
      .from('departamentos')
      .delete()
      .eq('id', depId)
      .eq('company_id', company_id)
    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }
    return res.json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao excluir departamento' })
  }
}

// =====================================================
// RESPOSTAS SALVAS (pessoais por usuário; setor opcional)
// =====================================================
async function getDepartamentoDaEmpresa(company_id, departamento_id) {
  const depId = Number(departamento_id)
  if (!Number.isFinite(depId) || depId <= 0) return null
  const { data, error } = await supabase
    .from('departamentos')
    .select('id, nome')
    .eq('company_id', Number(company_id))
    .eq('id', depId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function listarGruposDepartamento(req, res) {
  try {
    const { company_id } = req.user
    const departamento = await getDepartamentoDaEmpresa(company_id, req.params.id)
    if (!departamento) return res.status(404).json({ error: 'Departamento nao encontrado' })

    const { data: vinculos, error: errVinculos } = await supabase
      .from('departamento_grupos')
      .select('conversa_id')
      .eq('company_id', Number(company_id))
      .eq('departamento_id', Number(departamento.id))
    if (errVinculos) return res.status(500).json({ error: errVinculos.message })

    const vinculadosSet = new Set((vinculos || []).map((v) => Number(v.conversa_id)))

    const { data: grupos, error } = await supabase
      .from('conversas')
      .select('id, telefone, tipo, nome_grupo, foto_grupo, criado_em, ultima_atividade')
      .eq('company_id', Number(company_id))
      .eq('tipo', 'grupo')
      .order('nome_grupo', { ascending: true, nullsFirst: false })

    if (error) { console.error('[dashboardController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    const rows = (grupos || [])
      .filter(isGroupRow)
      .map((g) => ({
        id: g.id,
        telefone: g.telefone,
        tipo: g.tipo,
        nome_grupo: g.nome_grupo,
        foto_grupo: g.foto_grupo,
        criado_em: g.criado_em,
        ultima_atividade: g.ultima_atividade,
        vinculado: vinculadosSet.has(Number(g.id)),
      }))

    return res.json({ departamento, grupos: rows })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar grupos do departamento' })
  }
}

async function atualizarGruposDepartamento(req, res) {
  try {
    const { company_id, id: usuario_id } = req.user
    const departamento = await getDepartamentoDaEmpresa(company_id, req.params.id)
    if (!departamento) return res.status(404).json({ error: 'Departamento nao encontrado' })

    const conversaIds = normalizePositiveIds(req.body?.conversa_ids)

    if (conversaIds.length > 0) {
      const { data: conversas, error: errConversas } = await supabase
        .from('conversas')
        .select('id, tipo, telefone')
        .eq('company_id', Number(company_id))
        .in('id', conversaIds)
      if (errConversas) return res.status(500).json({ error: errConversas.message })

      const byId = new Map((conversas || []).map((c) => [Number(c.id), c]))
      const invalid = conversaIds.filter((id) => !isGroupRow(byId.get(Number(id))))
      if (invalid.length > 0) {
        return res.status(400).json({ error: 'A lista contem conversa que nao e grupo desta empresa' })
      }
    }

    const { error: delErr } = await supabase
      .from('departamento_grupos')
      .delete()
      .eq('company_id', Number(company_id))
      .eq('departamento_id', Number(departamento.id))
    if (delErr) return res.status(500).json({ error: delErr.message })

    if (conversaIds.length > 0) {
      const rows = conversaIds.map((conversa_id) => ({
        company_id: Number(company_id),
        departamento_id: Number(departamento.id),
        conversa_id,
        criado_por: Number(usuario_id) || null,
      }))
      const { error: insertErr } = await supabase
        .from('departamento_grupos')
        .insert(rows)
      if (insertErr) return res.status(500).json({ error: insertErr.message })
    }

    return res.json({ ok: true, departamento_id: Number(departamento.id), conversa_ids: conversaIds })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar grupos do departamento' })
  }
}

module.exports = {
  listarDepartamentos,
  criarDepartamento,
  atualizarDepartamento,
  excluirDepartamento,
  listarGruposDepartamento,
  atualizarGruposDepartamento,
}
