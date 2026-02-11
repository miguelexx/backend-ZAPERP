const supabase = require('../config/supabase');
const { normalizePhoneBR } = require('../helpers/phoneHelper');

/**
 * GET /clientes
 */
exports.listarClientes = async (req, res) => {
  try {
    const { company_id } = req.user
    const cid = Number(company_id) || 1
    let query = supabase
      .from('clientes')
      .select('id, telefone, wa_id, nome, observacoes, foto_perfil, criado_em')
    if (cid === 1) {
      query = query.or('company_id.eq.1,company_id.is.null')
    } else {
      query = query.eq('company_id', cid)
    }
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
    const { data, error } = await supabase
      .from('clientes')
      .select('id, telefone, wa_id, nome, observacoes, foto_perfil')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    const cliente = { id: data.id, telefone: data.telefone, wa_id: data.wa_id, nome: data.nome, observacoes: data.observacoes, foto_perfil: data.foto_perfil || null };

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
  const { telefone, wa_id, nome, observacoes } = req.body;

  if (!telefone && !wa_id) {
    return res.status(400).json({ erro: 'Informe telefone ou wa_id' });
  }

  const telefoneNorm = (telefone || wa_id) ? normalizePhoneBR(telefone || wa_id) : '';

  try {
    if (wa_id) {
      const { data: existente } = await supabase
        .from('clientes')
        .select('id')
        .eq('company_id', company_id)
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
        .eq('company_id', company_id)
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
        company_id: company_id || 1
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
  const { nome, observacoes } = req.body;

  if (nome === undefined && observacoes === undefined) {
    return res.status(400).json({
      erro: 'Informe ao menos um campo'
    });
  }

  try {
    const { data, error } = await supabase
      .from('clientes')
      .update({
        ...(nome !== undefined && { nome }),
        ...(observacoes !== undefined && { observacoes })
      })
      .eq('id', id)
      .select()
      .maybeSingle();

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
  const cid = Number(company_id) || 1;

  try {
    let query = supabase.from('clientes').select('id').eq('id', id);
    if (cid === 1) query = query.or('company_id.eq.1,company_id.is.null');
    else query = query.eq('company_id', cid);
    const { data: cliente, error: errBusca } = await query.maybeSingle();

    if (errBusca) throw errBusca;
    if (!cliente) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    await supabase.from('conversas').update({ cliente_id: null }).eq('cliente_id', id);
    const { error: errDelete } = await supabase.from('clientes').delete().eq('id', id);

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

    if (!clienteId || !tagId) {
      return res.status(400).json({ erro: 'clienteId e tagId são obrigatórios' });
    }

    // 🔒 evita duplicidade
    const { data: existente } = await supabase
      .from('cliente_tags')
      .select('*')
      .eq('cliente_id', clienteId)
      .eq('tag_id', tagId)
      .maybeSingle();

    if (existente) {
      return res.status(409).json({ erro: 'Tag já vinculada a este cliente' });
    }

    const { error } = await supabase
      .from('cliente_tags')
      .insert({
        cliente_id: clienteId,
        tag_id: tagId
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
