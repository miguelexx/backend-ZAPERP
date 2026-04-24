const supabase = require('../config/supabase');
const { normalizePhoneBR } = require('../helpers/phoneHelper');
const { getDisplayName } = require('../helpers/contactEnrichment');
const { ensureConversaForCliente } = require('../services/conversaAbrirClienteService');
const { executarAssumirConversa } = require('../services/conversaAssumirInternoService');

function bodyFlagTrue(v) {
  return v === true || v === 1 || String(v || '').toLowerCase() === 'true';
}

/**
 * GET /clientes
 * Query params: palavra (busca), limit (máx 5000, default 500), page (default 1)
 * Headers de resposta: X-Total-Count (total real no banco, sem limite de paginação)
 */
exports.listarClientes = async (req, res) => {
  try {
    const { company_id } = req.user
    const cid = Number(company_id)

    const { palavra, limit, page } = req.query || {}
    const limitNum = Math.min(Math.max(Number(limit) || 500, 1), 5000)
    const pageNum = Math.max(Number(page) || 1, 1)
    const offset = (pageNum - 1) * limitNum

    const termoBusca = palavra && String(palavra).trim() ? String(palavra).trim() : null

    // Query de contagem real (sem limite de linhas) — roda em paralelo com a listagem
    let countQuery = supabase
      .from('clientes')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', cid)

    if (termoBusca) {
      const term = `%${termoBusca}%`
      countQuery = countQuery.or(`nome.ilike.${term},telefone.ilike.${term},observacoes.ilike.${term}`)
    }

    let listQuery = supabase
      .from('clientes')
      .select('id, telefone, wa_id, nome, pushname, observacoes, foto_perfil, email, empresa, ultimo_contato, criado_em')
      .eq('company_id', cid)
      .order('id', { ascending: false })
      .range(offset, offset + limitNum - 1)

    if (termoBusca) {
      const term = `%${termoBusca}%`
      listQuery = listQuery.or(`nome.ilike.${term},telefone.ilike.${term},observacoes.ilike.${term}`)
    }

    const [{ count, error: countErr }, { data, error }] = await Promise.all([countQuery, listQuery])

    if (countErr) console.warn('[listarClientes] count:', countErr?.message)
    if (error) throw error

    const totalReal = typeof count === 'number' ? count : (data?.length ?? 0)

    const clientes = (data || []).map(c => ({
      id: c.id,
      telefone: c.telefone,
      wa_id: c.wa_id,
      nome: getDisplayName(c) || null,
      pushname: c.pushname || null,
      observacoes: c.observacoes,
      foto_perfil: c.foto_perfil || null,
      email: c.email || null,
      empresa: c.empresa || null,
      ultimo_contato: c.ultimo_contato || null,
      criado_em: c.criado_em
    }))

    // X-Total-Count permite o frontend exibir o total real sem depender do tamanho da página
    res.setHeader('X-Total-Count', String(totalReal))
    res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count')
    return res.status(200).json(clientes)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao listar clientes' })
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
  const { company_id, id: usuario_id, perfil, departamento_ids = [] } = req.user || {}
  const { telefone, wa_id, nome, observacoes, email, empresa, abrir_conversa, assumir } = req.body;
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

    const abrirFlag = bodyFlagTrue(abrir_conversa)
    const assumirFlag = bodyFlagTrue(assumir)
    if (abrirFlag || assumirFlag) {
      const cliente = {
        id: data.id,
        nome: data.nome,
        pushname: data.pushname || null,
        telefone: data.telefone,
        foto_perfil: data.foto_perfil || null
      }
      const r = await ensureConversaForCliente({
        company_id: cid,
        usuario_id,
        cliente
      })
      if (!r.ok) {
        return res.status(201).json({
          ...data,
          conversa: null,
          conversa_criada: false,
          conversa_aviso: r.error
        })
      }
      const io = req.app && req.app.get('io')
      if (r.criada && io) {
        const { emitirEventoEmpresaConversa } = require('./chatController')
        emitirEventoEmpresaConversa(io, cid, r.conversa.id, 'nova_conversa', r.conversa)
      }
      let payload = {
        ...data,
        conversa: r.conversa,
        conversa_criada: r.criada
      }
      if (assumirFlag && r.conversa?.id) {
        const ar = await executarAssumirConversa({
          company_id: cid,
          conversa_id: r.conversa.id,
          user_id: usuario_id,
          perfil,
          departamento_ids
        })
        if (ar.ok && ar.conversa) {
          payload.conversa = { ...r.conversa, ...ar.conversa }
          if (io) {
            const { emitirRealtimeAposAssumir } = require('./chatController')
            emitirRealtimeAposAssumir(io, cid, r.conversa.id, usuario_id, ar.conversa)
          }
        } else {
          payload.assumir_erro = ar.error
          payload.assumir_status = ar.status
        }
      }
      return res.status(201).json(payload)
    }

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
  const { nome, observacoes, email, empresa, foto_perfil, telefone } = req.body;

  if (nome === undefined && observacoes === undefined && email === undefined && empresa === undefined && foto_perfil === undefined && telefone === undefined) {
    return res.status(400).json({
      erro: 'Informe ao menos um campo'
    });
  }

  if (telefone !== undefined && !String(telefone || '').trim()) {
    return res.status(400).json({ erro: 'Telefone não pode ser vazio' });
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
        ...(telefone !== undefined && { telefone: String(telefone).trim() }),
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', Number(id))
      .eq('company_id', cid)
      .select()
    const { data, error } = await q.maybeSingle();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ erro: 'Já existe um cliente com este número de telefone.' });
      }
      throw error;
    }
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
 * DELETE /clientes/todos — apaga todos os clientes da empresa.
 * Remove todos os registros filhos com FK para clientes antes de deletar.
 */
exports.apagarTodosClientes = async (req, res) => {
  const { company_id } = req.user || {};
  const cid = Number(company_id);
  if (!cid) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }

  try {
    // 1) Desvincula conversas (cliente_id nullable — não pode deletar, só anular)
    await supabase.from('conversas').update({ cliente_id: null }).eq('company_id', cid).neq('cliente_id', null);

    // 2) Remove tabelas filhas com FK para clientes (empresa isolada por company_id)
    const tabelasFilhas = ['cliente_tags', 'contato_opt_in', 'contato_opt_out'];
    for (const tabela of tabelasFilhas) {
      const { error: errFilha } = await supabase.from(tabela).delete().eq('company_id', cid);
      if (errFilha && !String(errFilha.message || '').includes('does not exist')) {
        console.warn(`[apagarTodosClientes] ${tabela}:`, errFilha?.message);
      }
    }

    // 3) campanha_envios não tem company_id — remove via clientes da empresa
    const { data: clienteIds } = await supabase.from('clientes').select('id').eq('company_id', cid);
    const ids = (clienteIds || []).map((c) => c.id).filter(Boolean);
    if (ids.length > 0) {
      const { error: errEnvios } = await supabase.from('campanha_envios').delete().in('cliente_id', ids);
      if (errEnvios && !String(errEnvios.message || '').includes('does not exist')) {
        console.warn('[apagarTodosClientes] campanha_envios:', errEnvios?.message);
      }
    }

    // 4) Deleta os clientes
    const { data: delData, error: errDel } = await supabase.from('clientes').delete().eq('company_id', cid).select('id');
    if (errDel) throw errDel;
    const qtd = Array.isArray(delData) ? delData.length : 0;
    return res.status(200).json({ ok: true, apagados: qtd, mensagem: `${qtd} cliente(s) apagado(s).` });
  } catch (err) {
    console.error('[apagarTodosClientes]', err);
    return res.status(500).json({ erro: err.message || 'Erro ao apagar clientes' });
  }
};

/**
 * DELETE /clientes/:id
 * Remove todos os registros filhos com FK para clientes antes de deletar.
 */
exports.excluirCliente = async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.user || {};
  const cid = Number(company_id);
  const clienteId = Number(id);

  try {
    const { data: cliente, error: errBusca } = await supabase
      .from('clientes')
      .select('id')
      .eq('id', clienteId)
      .eq('company_id', cid)
      .maybeSingle();

    if (errBusca) throw errBusca;
    if (!cliente) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    // 1) Desvincula conversas (cliente_id nullable)
    await supabase.from('conversas').update({ cliente_id: null }).eq('company_id', cid).eq('cliente_id', clienteId);

    // 2) Remove tabelas filhas com FK para clientes
    const tabelasFilhasComEmpresa = ['cliente_tags', 'contato_opt_in', 'contato_opt_out'];
    for (const tabela of tabelasFilhasComEmpresa) {
      const { error: errFilha } = await supabase.from(tabela).delete().eq('company_id', cid).eq('cliente_id', clienteId);
      if (errFilha && !String(errFilha.message || '').includes('does not exist')) {
        console.warn(`[excluirCliente] ${tabela}:`, errFilha?.message);
      }
    }

    // 3) campanha_envios — sem company_id, filtra pelo cliente_id
    const { error: errEnvios } = await supabase.from('campanha_envios').delete().eq('cliente_id', clienteId);
    if (errEnvios && !String(errEnvios.message || '').includes('does not exist')) {
      console.warn('[excluirCliente] campanha_envios:', errEnvios?.message);
    }

    // 4) Deleta o cliente
    const { error: errDelete } = await supabase.from('clientes').delete().eq('id', clienteId).eq('company_id', cid);
    if (errDelete) throw errDelete;

    return res.status(200).json({ ok: true, mensagem: 'Cliente excluído' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: err.message || 'Erro ao excluir cliente' });
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
