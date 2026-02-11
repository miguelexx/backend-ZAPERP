const supabase = require('../config/supabase')

const DEFAULT_CONFIG = {
  bot_global: {
    ativo: false,
    mensagem_boas_vindas: '',
    mensagem_inicial_automatica: '',
    mensagem_fora_horario: '',
    mensagem_ausencia: '',
    mensagem_encerramento: '',
    tempo_limite_sem_resposta_min: 30,
  },
  roteamento: {
    ativar_menu_setores: true,
    texto_menu: 'Escolha o setor pelo número:',
    departamentos_ids: [],
    tipo_distribuicao: 'manual', // round_robin | menor_carga | manual
  },
  ia: {
    usar_ia: false,
    sugerir_respostas: true,
    corrigir_texto: false,
    auto_completar: false,
    resumo_conversa: true,
    classificar_intencao: true,
    sugerir_tags: true,
  },
  automacoes: {
    encerrar_automatico_min: 0,
    transferir_para_humano_apos_bot: true,
    limite_mensagens_bot: 5,
    auto_assumir: false,
    reabrir_automaticamente: false,
  },
}

// GET /ia/config — retorna config mesclada; se tabela não existir, retorna defaults
exports.getConfig = async (req, res) => {
  try {
    const company_id = req.user?.company_id
    if (!company_id) {
      return res.json({
        bot_global: DEFAULT_CONFIG.bot_global,
        roteamento: DEFAULT_CONFIG.roteamento,
        ia: DEFAULT_CONFIG.ia,
        automacoes: DEFAULT_CONFIG.automacoes,
      })
    }
    const { data, error } = await supabase
      .from('ia_config')
      .select('config')
      .eq('company_id', company_id)
      .maybeSingle()

    if (error) {
      console.warn('ia_config select error:', error.message)
      return res.json({
        bot_global: DEFAULT_CONFIG.bot_global,
        roteamento: DEFAULT_CONFIG.roteamento,
        ia: DEFAULT_CONFIG.ia,
        automacoes: DEFAULT_CONFIG.automacoes,
      })
    }
    const config = data?.config ?? {}
    const merged = {
      bot_global: { ...DEFAULT_CONFIG.bot_global, ...(config.bot_global || {}) },
      roteamento: { ...DEFAULT_CONFIG.roteamento, ...(config.roteamento || {}) },
      ia: { ...DEFAULT_CONFIG.ia, ...(config.ia || {}) },
      automacoes: { ...DEFAULT_CONFIG.automacoes, ...(config.automacoes || {}) },
    }
    return res.json(merged)
  } catch (err) {
    console.error('getConfig:', err)
    return res.json({
      bot_global: DEFAULT_CONFIG.bot_global,
      roteamento: DEFAULT_CONFIG.roteamento,
      ia: DEFAULT_CONFIG.ia,
      automacoes: DEFAULT_CONFIG.automacoes,
    })
  }
}

// PUT /ia/config
exports.putConfig = async (req, res) => {
  try {
    const { company_id } = req.user
    const { bot_global, roteamento, ia, automacoes } = req.body

    const { data: existing } = await supabase
      .from('ia_config')
      .select('config')
      .eq('company_id', company_id)
      .maybeSingle()

    const current = existing?.config ?? {}
    const merged = {
      bot_global: { ...DEFAULT_CONFIG.bot_global, ...current.bot_global, ...(bot_global || {}) },
      roteamento: { ...DEFAULT_CONFIG.roteamento, ...current.roteamento, ...(roteamento || {}) },
      ia: { ...DEFAULT_CONFIG.ia, ...current.ia, ...(ia || {}) },
      automacoes: { ...DEFAULT_CONFIG.automacoes, ...current.automacoes, ...(automacoes || {}) },
    }

    const { data, error } = await supabase
      .from('ia_config')
      .upsert(
        {
          company_id,
          config: merged,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'company_id' }
      )
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.json(data?.config ?? merged)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao salvar config IA' })
  }
}

// GET /ia/regras
exports.getRegras = async (req, res) => {
  try {
    const { company_id } = req.user
    const { data, error } = await supabase
      .from('regras_automaticas')
      .select('id, palavra_chave, resposta, departamento_id, tag_id, aplicar_tag, horario_comercial_only, ativo, criado_em, departamentos(nome), tags(nome)')
      .eq('company_id', company_id)
      .order('palavra_chave')

    if (error) {
      console.warn('regras_automaticas select error:', error.message)
      return res.json([])
    }
    return res.json(data ?? [])
  } catch (err) {
    console.error(err)
    return res.json([])
  }
}

// POST /ia/regras
exports.postRegra = async (req, res) => {
  try {
    const { company_id } = req.user
    const { palavra_chave, resposta, departamento_id, tag_id, aplicar_tag, horario_comercial_only, ativo } = req.body

    if (!palavra_chave?.trim() || !resposta?.trim()) {
      return res.status(400).json({ error: 'palavra_chave e resposta são obrigatórios' })
    }

    const { data, error } = await supabase
      .from('regras_automaticas')
      .insert({
        company_id,
        palavra_chave: String(palavra_chave).trim(),
        resposta: String(resposta).trim(),
        departamento_id: departamento_id || null,
        tag_id: tag_id || null,
        aplicar_tag: !!aplicar_tag,
        horario_comercial_only: !!horario_comercial_only,
        ativo: ativo !== false,
      })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar regra' })
  }
}

// PUT /ia/regras/:id
exports.putRegra = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id } = req.params
    const { palavra_chave, resposta, departamento_id, tag_id, aplicar_tag, horario_comercial_only, ativo } = req.body

    const update = {}
    if (palavra_chave !== undefined) update.palavra_chave = String(palavra_chave).trim()
    if (resposta !== undefined) update.resposta = String(resposta).trim()
    if (departamento_id !== undefined) update.departamento_id = departamento_id || null
    if (tag_id !== undefined) update.tag_id = tag_id || null
    if (aplicar_tag !== undefined) update.aplicar_tag = !!aplicar_tag
    if (horario_comercial_only !== undefined) update.horario_comercial_only = !!horario_comercial_only
    if (ativo !== undefined) update.ativo = !!ativo

    const { data, error } = await supabase
      .from('regras_automaticas')
      .update(update)
      .eq('id', id)
      .eq('company_id', company_id)
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Regra não encontrada' })
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao atualizar regra' })
  }
}

// DELETE /ia/regras/:id
exports.deleteRegra = async (req, res) => {
  try {
    const { company_id } = req.user
    const { id } = req.params

    const { error } = await supabase
      .from('regras_automaticas')
      .delete()
      .eq('id', id)
      .eq('company_id', company_id)

    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao excluir regra' })
  }
}

// GET /ia/logs
exports.getLogs = async (req, res) => {
  try {
    const { company_id } = req.user
    const limit = Math.min(Number(req.query.limit || 50), 200)

    const { data, error } = await supabase
      .from('bot_logs')
      .select('id, conversa_id, tipo, detalhes, criado_em')
      .eq('company_id', company_id)
      .order('criado_em', { ascending: false })
      .limit(limit)

    if (error) {
      console.warn('bot_logs select error:', error.message)
      return res.json([])
    }
    return res.json(data ?? [])
  } catch (err) {
    console.error(err)
    return res.json([])
  }
}
