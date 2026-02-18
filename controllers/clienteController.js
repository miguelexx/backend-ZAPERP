const supabase = require('../config/supabase');
const { normalizePhoneBR } = require('../helpers/phoneHelper');

/**
 * GET /clientes
 */
exports.listarClientes = async (req, res) => {
  try {
    const { company_id } = req.user
    const cid = Number(company_id)
    let query = supabase
      .from('clientes')
      .select('id, telefone, wa_id, nome, observacoes, foto_perfil, email, empresa, ultimo_contato, criado_em')
      .eq('company_id', cid)
    query = query.order('id', { ascending: false })

    const { palavra, limit } = req.query || {}
    if (palavra && String(palavra).trim()) {
      const term = `%${String(palavra).trim()}%`
      query = query.or(`nome.ilike.${term},telefone.ilike.${term},observacoes.ilike.${term}`)
    }
    const limitNum = Math.min(Math.max(Number(limit) || 500, 1), 2000)
    query = query.limit(limitNum)

    const { data, error } = await query

    if (error) throw error;

    const clientes = (data || []).map(c => ({
      id: c.id,
      telefone: c.telefone,
      wa_id: c.wa_id,
      nome: c.nome,
      observacoes: c.observacoes,
      foto_perfil: c.foto_perfil || null,
      email: c.email || null,
      empresa: c.empresa || null,
      ultimo_contato: c.ultimo_contato || null,
      criado_em: c.criado_em
    }));

    return res.status(200).json(clientes);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: 'Erro ao listar clientes' });
  }
};

/**
 * GET /clientes/:id
 */
exports.buscarClientePorId = async (req, res) => {
  const { id } = req.params;

  try {
    const { company_id } = req.user || {}
    const cid = Number(company_id)
    let q = supabase
      .from('clientes')
      .select('id, telefone, wa_id, nome, observacoes, foto_perfil, email, empresa, ultimo_contato, criado_em')
      .eq('id', Number(id))
      .eq('company_id', cid)
    const { data, error } = await q.maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    const cliente = {
      id: data.id,
      telefone: data.telefone,
      wa_id: data.wa_id,
      nome: data.nome,
      observacoes: data.observacoes,
      foto_perfil: data.foto_perfil || null,
      email: data.email || null,
      empresa: data.empresa || null,
      ultimo_contato: data.ultimo_contato || null,
      criado_em: data.criado_em
    };

    return res.status(200).json(cliente);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: 'Erro ao buscar cliente' });
  }
};

/**
 * POST /clientes
 */
exports.criarCliente = async (req, res) => {
  const { company_id } = req.user || {}
  const { telefone, wa_id, nome, observacoes, email, empresa } = req.body;
  const cid = Number(company_id)

  if (!telefone && !wa_id) {
    return res.status(400).json({ erro: 'Informe telefone ou wa_id' });
  }

  const telefoneNorm = (telefone || wa_id) ? normalizePhoneBR(telefone || wa_id) : '';

  try {
    if (wa_id) {
      const { data: existente } = await supabase
        .from('clientes')
        .select('id')
        .eq('company_id', cid)
        .eq('wa_id', wa_id)
        .maybeSingle();

      if (existente) {
        return res.status(409).json({
          erro: 'Cliente já existe',
          id: existente.id
        });
      }
    }

    if (telefoneNorm) {
      const { data: existenteTel } = await supabase
        .from('clientes')
        .select('id')
        .eq('company_id', cid)
        .eq('telefone', telefoneNorm)
        .maybeSingle();

      if (existenteTel) {
        return res.status(409).json({
          erro: 'Já existe cliente com este número',
          id: existenteTel.id
        });
      }
    }

    const { data, error } = await supabase
      .from('clientes')
      .insert({
        telefone: telefoneNorm || telefone || wa_id,
        wa_id: wa_id || null,
        nome: nome || null,
        observacoes: observacoes || null,
        email: email ? String(email).trim() : null,
        empresa: empresa ? String(empresa).trim() : null,
        company_id: cid
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: 'Erro ao criar cliente' });
  }
};

/**
 * PUT /clientes/:id
 */
exports.atualizarCliente = async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.user || {}
  const cid = Number(company_id)
  const { nome, observacoes, email, empresa, foto_perfil } = req.body;

  if (nome === undefined && observacoes === undefined && email === undefined && empresa === undefined && foto_perfil === undefined) {
    return res.status(400).json({
      erro: 'Informe ao menos um campo'
    });
  }

  try {
    let q = supabase
      .from('clientes')
      .update({
        ...(nome !== undefined && { nome }),
        ...(observacoes !== undefined && { observacoes }),
        ...(email !== undefined && { email: email ? String(email).trim() : null }),
        ...(empresa !== undefined && { empresa: empresa ? String(empresa).trim() : null }),
        ...(foto_perfil !== undefined && { foto_perfil: foto_perfil ? String(foto_perfil).trim() : null }),
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', Number(id))
      .eq('company_id', cid)
      .select()
    const { data, error } = await q.maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: 'Erro ao atualizar cliente' });
  }
};

/**
 * DELETE /clientes/:id
 */
exports.excluirCliente = async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.user || {};
  const cid = Number(company_id);

  try {
    let query = supabase.from('clientes').select('id').eq('id', Number(id)).eq('company_id', cid);
    const { data: cliente, error: errBusca } = await query.maybeSingle();

    if (errBusca) throw errBusca;
    if (!cliente) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    await supabase.from('conversas').update({ cliente_id: null }).eq('company_id', cid).eq('cliente_id', Number(id));
    let delQ = supabase.from('clientes').delete().eq('id', Number(id)).eq('company_id', cid);
    const { error: errDelete } = await delQ;

    if (errDelete) throw errDelete;
    return res.status(200).json({ ok: true, mensagem: 'Cliente excluído' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: 'Erro ao excluir cliente' });
  }
};

/**
 * POST /clientes/:id/tags
 */
exports.vincularTag = async (req, res) => {
  try {
    const clienteId = parseInt(req.params.id);
    const { tagId } = req.body;
    const { company_id } = req.user || {}
    const cid = Number(company_id)

    if (!clienteId || !tagId) {
      return res.status(400).json({ erro: 'clienteId e tagId são obrigatórios' });
    }

    // garante que cliente e tag pertencem à empresa
    const { data: cl } = await supabase
      .from('clientes')
      .select('id')
      .eq('id', clienteId)
      .eq('company_id', cid)
      .maybeSingle();
    if (!cl) return res.status(404).json({ erro: 'Cliente não encontrado' });

    const { data: tg } = await supabase
      .from('tags')
      .select('id')
      .eq('id', Number(tagId))
      .eq('company_id', cid)
      .maybeSingle();
    if (!tg) return res.status(404).json({ erro: 'Tag não encontrada' });

    // 🔒 evita duplicidade
    const { data: existente, error: errExiste } = await supabase
      .from('cliente_tags')
      .select('*')
      .eq('company_id', cid)
      .eq('cliente_id', clienteId)
      .eq('tag_id', Number(tagId))
      .maybeSingle();

    if (errExiste) {
      const msg = String(errExiste.message || '')
      if (msg.includes('cliente_tags') || msg.includes('does not exist')) {
        return res.status(400).json({ erro: 'Banco desatualizado: rode o supabase/RUN_IN_SUPABASE.sql (tabela cliente_tags).' })
      }
      throw errExiste
    }

    if (existente) {
      return res.status(409).json({ erro: 'Tag já vinculada a este cliente' });
    }

    const { error } = await supabase
      .from('cliente_tags')
      .insert({
        company_id: cid,
        cliente_id: clienteId,
        tag_id: Number(tagId)
      });

    if (error) {
      console.error('ERRO SUPABASE:', error);
      return res.status(500).json({ erro: 'Erro ao vincular tag' });
    }

    return res.status(200).json({ sucesso: true });

  } catch (err) {
    console.error('ERRO GERAL:', err);
    return res.status(500).json({ erro: 'Erro ao vincular tag' });
  }
};

/**
 * DELETE /clientes/:id/tags/:tagId
 */
exports.desvincularTag = async (req, res) => {
  try {
    const { company_id } = req.user || {}
    const cid = Number(company_id)
    const clienteId = Number(req.params.id)
    const tagId = Number(req.params.tagId)
    if (!clienteId || !tagId) {
      return res.status(400).json({ erro: 'Parâmetros inválidos' })
    }

    const { error } = await supabase
      .from('cliente_tags')
      .delete()
      .eq('company_id', cid)
      .eq('cliente_id', clienteId)
      .eq('tag_id', tagId)

    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('cliente_tags') || msg.includes('does not exist')) {
        return res.status(400).json({ erro: 'Banco desatualizado: rode o supabase/RUN_IN_SUPABASE.sql (tabela cliente_tags).' })
      }
      return res.status(500).json({ erro: error.message })
    }
    return res.status(200).json({ sucesso: true })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ erro: 'Erro ao desvincular tag' })
  }
}

/**
 * GET /clientes/:id/tags
 */
exports.listarTagsCliente = async (req, res) => {
  try {
    const { company_id } = req.user || {}
    const cid = Number(company_id)
    const clienteId = Number(req.params.id)
    if (!clienteId) return res.status(400).json({ erro: 'Parâmetro inválido' })

    const { data: cl } = await supabase
      .from('clientes')
      .select('id')
      .eq('id', clienteId)
      .eq('company_id', cid)
      .maybeSingle()
    if (!cl) return res.status(404).json({ erro: 'Cliente não encontrado' })

    const { data: rows, error } = await supabase
      .from('cliente_tags')
      .select('tag_id')
      .eq('company_id', cid)
      .eq('cliente_id', clienteId)

    if (error) {
      const msg = String(error.message || '')
      if (msg.includes('cliente_tags') || msg.includes('does not exist')) {
        return res.status(400).json({ erro: 'Banco desatualizado: rode o supabase/RUN_IN_SUPABASE.sql (tabela cliente_tags).' })
      }
      return res.status(500).json({ erro: error.message })
    }

    const tagIds = (rows || []).map((r) => r.tag_id).filter((x) => x != null)
    if (tagIds.length === 0) return res.status(200).json([])

    const { data: tags, error: errTags } = await supabase
      .from('tags')
      .select('id, nome, cor')
      .eq('company_id', cid)
      .in('id', tagIds)
      .order('nome', { ascending: true })
    if (errTags) return res.status(500).json({ erro: errTags.message })

    return res.status(200).json(tags || [])
  } catch (e) {
    console.error(e)
    return res.status(500).json({ erro: 'Erro ao listar tags do cliente' })
  }
}
