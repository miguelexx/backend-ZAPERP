const supabase = require('../config/supabase')
const { getProvider } = require('../services/providers')

/** GET /config/empresa — dados da empresa */
exports.getEmpresa = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('empresas')
      .select('*')
      .eq('id', company_id)
      .single()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Empresa não encontrada' })
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao obter empresa' })
  }
}

/** PUT /config/empresa */
exports.putEmpresa = async (req, res) => {
  try {
    const { company_id } = req.user
    const {
      nome,
      ativo,
      logo_url,
      tema,
      cor_primaria,
      horario_inicio,
      horario_fim,
      sla_minutos_sem_resposta,
      plano_id,
      limite_chats_por_atendente,
      timeout_inatividade_min,
      zapi_auto_sync_contatos
    } = req.body
    const update = {}
    if (nome !== undefined) update.nome = nome
    if (ativo !== undefined) update.ativo = !!ativo
    if (logo_url !== undefined) update.logo_url = logo_url || null
    if (tema !== undefined) update.tema = tema || 'light'
    if (cor_primaria !== undefined) update.cor_primaria = cor_primaria || '#2563eb'
    if (horario_inicio !== undefined) update.horario_inicio = horario_inicio || '09:00'
    if (horario_fim !== undefined) update.horario_fim = horario_fim || '18:00'
    if (sla_minutos_sem_resposta !== undefined) update.sla_minutos_sem_resposta = Math.max(1, Math.min(1440, Number(sla_minutos_sem_resposta) || 30))
    if (plano_id !== undefined) update.plano_id = plano_id || null
    if (limite_chats_por_atendente !== undefined) update.limite_chats_por_atendente = Math.max(0, Number(limite_chats_por_atendente) || 0)
    if (timeout_inatividade_min !== undefined) update.timeout_inatividade_min = Math.max(0, Number(timeout_inatividade_min) || 0)
    if (zapi_auto_sync_contatos !== undefined) update.zapi_auto_sync_contatos = !!zapi_auto_sync_contatos

    const { data, error } = await supabase.from('empresas').update(update).eq('id', company_id).select().single()
    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('zapi_auto_sync_contatos') || msg.includes('does not exist')) {
        return res.status(400).json({ error: 'Banco desatualizado: rode o supabase/RUN_IN_SUPABASE.sql (coluna zapi_auto_sync_contatos).' })
      }
      return res.status(500).json({ error: error.message })
    }
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar empresa' })
  }
}

/** GET /config/planos */
exports.getPlanos = async (req, res) => {
  try {
    const { data, error } = await supabase.from('planos').select('*').order('id')
    if (error) return res.status(500).json({ error: error.message })
    return res.json(data || [])
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar planos' })
  }
}

/** GET /config/empresas-whatsapp — lista mapeamentos phone_number_id → company (multi-tenant) */
exports.getEmpresasWhatsapp = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('empresas_whatsapp')
      .select('*')
      .eq('company_id', company_id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json(data || [])
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar' })
  }
}

/** POST /config/empresas-whatsapp — registra phone_number_id para multi-tenant */
exports.postEmpresasWhatsapp = async (req, res) => {
  try {
    const { company_id } = req.user
    const { phone_number_id, phone_number } = req.body
    if (!phone_number_id?.trim()) return res.status(400).json({ error: 'phone_number_id é obrigatório' })
    const { data, error } = await supabase
      .from('empresas_whatsapp')
      .upsert({
        company_id,
        phone_number_id: String(phone_number_id).trim(),
        phone_number: phone_number ? String(phone_number).trim() : null
      }, { onConflict: 'phone_number_id' })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao salvar' })
  }
}

/** DELETE /config/empresas-whatsapp/:id */
exports.deleteEmpresasWhatsapp = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const { error } = await supabase
      .from('empresas_whatsapp')
      .delete()
      .eq('id', id)
      .eq('company_id', company_id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao excluir' })
  }
}

/** GET /config/auditoria — logs de atendimentos + historico */
exports.getAuditoria = async (req, res) => {
  try {
    const { company_id } = req.user
    const limit = Math.min(Number(req.query.limit || 100), 500)

    const { data: atend } = await supabase
      .from('atendimentos')
      .select('id, conversa_id, acao, observacao, criado_em, de_usuario_id, para_usuario_id')
      .eq('company_id', company_id)
      .order('criado_em', { ascending: false })
      .limit(limit)

    const { data: convIds } = await supabase.from('conversas').select('id').eq('company_id', company_id)
    const ids = (convIds || []).map(c => c.id)
    let hist = []
    if (ids.length > 0) {
      const { data: h } = await supabase
        .from('historico_atendimentos')
        .select('id, conversa_id, acao, observacao, criado_em, usuario_id')
        .in('conversa_id', ids)
        .order('criado_em', { ascending: false })
        .limit(limit)
      hist = h || []
    }

    const userIds = new Set()
    ;(atend || []).forEach(a => { if (a.de_usuario_id) userIds.add(a.de_usuario_id); if (a.para_usuario_id) userIds.add(a.para_usuario_id) })
    ;(hist || []).forEach(h => { if (h.usuario_id) userIds.add(h.usuario_id) })

    let userMap = {}
    if (userIds.size > 0) {
      const { data: users } = await supabase
        .from('usuarios')
        .select('id, nome')
        .eq('company_id', company_id)
        .in('id', [...userIds])
      users?.forEach(u => { userMap[u.id] = u.nome })
    }

    const items = [
      ...(atend || []).map(a => ({ tipo: 'atendimento', ...a, usuario_nome: userMap[a.de_usuario_id], para_nome: userMap[a.para_usuario_id] })),
      ...(hist || []).map(h => ({ tipo: 'historico', ...h, usuario_nome: userMap[h.usuario_id] }))
    ].sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em)).slice(0, limit)

    return res.json(items)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao listar auditoria' })
  }
}

// ─── Perfil do WhatsApp (Z-API) ────────────────────────────────────────────────

/** PUT /config/whatsapp/profile-picture — atualiza foto de perfil da instância conectada */
exports.updateWhatsappProfilePicture = async (req, res) => {
  try {
    const { value } = req.body || {}
    if (!value || typeof value !== 'string' || !value.trim().startsWith('http')) {
      return res.status(400).json({ error: 'Forneça uma URL válida em "value".' })
    }
    const provider = getProvider()
    if (!provider?.updateProfilePicture) {
      return res.status(503).json({ error: 'Provedor não suporta atualização de foto de perfil.' })
    }
    const ok = await provider.updateProfilePicture(value.trim())
    if (!ok) return res.status(502).json({ error: 'Z-API retornou falha ao atualizar foto de perfil.' })
    return res.json({ ok: true, value: true })
  } catch (err) {
    console.error('[configController] updateWhatsappProfilePicture:', err?.message || err)
    return res.status(500).json({ error: 'Erro ao atualizar foto de perfil.' })
  }
}

/** PUT /config/whatsapp/profile-name — atualiza nome de perfil da instância conectada */
exports.updateWhatsappProfileName = async (req, res) => {
  try {
    const { value } = req.body || {}
    if (!value || typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({ error: 'Forneça um nome válido em "value".' })
    }
    if (value.trim().length > 25) {
      return res.status(400).json({ error: 'Nome de perfil deve ter no máximo 25 caracteres.' })
    }
    const provider = getProvider()
    if (!provider?.updateProfileName) {
      return res.status(503).json({ error: 'Provedor não suporta atualização de nome de perfil.' })
    }
    const ok = await provider.updateProfileName(value.trim())
    if (!ok) return res.status(502).json({ error: 'Z-API retornou falha ao atualizar nome de perfil.' })
    return res.json({ ok: true, value: true })
  } catch (err) {
    console.error('[configController] updateWhatsappProfileName:', err?.message || err)
    return res.status(500).json({ error: 'Erro ao atualizar nome de perfil.' })
  }
}

/** PUT /config/whatsapp/profile-description — atualiza descrição/bio da instância conectada */
exports.updateWhatsappProfileDescription = async (req, res) => {
  try {
    const { value } = req.body || {}
    if (value === undefined || value === null) {
      return res.status(400).json({ error: 'Forneça a descrição em "value".' })
    }
    const desc = String(value).trim()
    if (desc.length > 139) {
      return res.status(400).json({ error: 'Descrição deve ter no máximo 139 caracteres.' })
    }
    const provider = getProvider()
    if (!provider?.updateProfileDescription) {
      return res.status(503).json({ error: 'Provedor não suporta atualização de descrição de perfil.' })
    }
    const ok = await provider.updateProfileDescription(desc)
    if (!ok) return res.status(502).json({ error: 'Z-API retornou falha ao atualizar descrição de perfil.' })
    return res.json({ ok: true, value: true })
  } catch (err) {
    console.error('[configController] updateWhatsappProfileDescription:', err?.message || err)
    return res.status(500).json({ error: 'Erro ao atualizar descrição de perfil.' })
  }
}
