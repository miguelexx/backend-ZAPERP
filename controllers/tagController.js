const supabase = require('../config/supabase');

/**
 * GET /tags
 */
exports.listarTags = async (req, res) => {
  try {
    const { company_id } = req.user;

    const { data, error } = await supabase
      .from('tags')
      .select('id, nome, cor')
      .eq('company_id', company_id)
      .order('nome', { ascending: true });

    if (error) throw error;

    return res.status(200).json(data || []);
  } catch (error) {
    console.error('Erro ao listar tags:', error);
    return res.status(500).json({ erro: 'Erro ao listar tags' });
  }
};

/**
 * POST /tags
 * body: { nome, cor }
 */
exports.criarTag = async (req, res) => {
  const { nome, cor } = req.body;
  const { company_id } = req.user;

  if (!nome || String(nome).trim() === '') {
    return res.status(400).json({ erro: 'nome é obrigatório' });
  }

  try {
    const { data: existente } = await supabase
      .from('tags')
      .select('id')
      .eq('nome', nome.trim())
      .eq('company_id', company_id)
      .maybeSingle();

    if (existente) {
      return res.status(200).json({ sucesso: true, tag: existente, mensagem: 'Tag já existia' });
    }

    const { data, error } = await supabase
      .from('tags')
      .insert({
        nome: nome.trim(),
        cor: cor || null,
        company_id
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ sucesso: true, tag: data });
  } catch (error) {
    console.error('Erro ao criar tag:', error);
    return res.status(500).json({ erro: 'Erro ao criar tag' });
  }
};

/**
 * PUT /tags/:id
 */
exports.atualizarTag = async (req, res) => {
  const { id } = req.params;
  const { nome, cor } = req.body;
  const { company_id } = req.user;

  if (!nome || String(nome).trim() === '') {
    return res.status(400).json({ erro: 'nome é obrigatório' });
  }

  try {
    const { data, error } = await supabase
      .from('tags')
      .update({ nome: nome.trim(), cor: cor || null })
      .eq('id', id)
      .eq('company_id', company_id)
      .select()
      .single();

    if (error) throw error;
    return res.status(200).json({ sucesso: true, tag: data });
  } catch (error) {
    console.error('Erro ao atualizar tag:', error);
    return res.status(500).json({ erro: 'Erro ao atualizar tag' });
  }
};

/**
 * DELETE /tags/:id
 */
exports.excluirTag = async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.user;

  try {
    const { error } = await supabase
      .from('tags')
      .delete()
      .eq('id', id)
      .eq('company_id', company_id);

    if (error) throw error;
    return res.status(200).json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao excluir tag:', error);
    return res.status(500).json({ erro: 'Erro ao excluir tag' });
  }
};
