/**
 * clienteController.js — CRUD de clientes/contatos e vínculos de tag. Rotas: `/clientes/*`.
 *
 * Handlers: `listarClientes` (busca por nome/telefone + nomes vinculados), `buscarClientePorId`,
 * `criarCliente` (cria contato e, se preciso, abre conversa via `conversaAbrirClienteService`),
 * `atualizarCliente`, `excluirCliente`, `apagarTodosClientes` (destrutivo — DELETE /clientes/todos),
 * e `vincular/desvincular/listarTagsCliente`.
 *
 * Busca usa `chatSearchHelper` (telefone canônico + termos) e `clienteNomesVinculados`. Telefone
 * canônico via `conversationSync` (mesmo matching do inbound). `company_id` SEMPRE de `req.user.company_id`.
 */
const supabase = require('../config/supabase');
const { getDisplayName } = require('../helpers/contactEnrichment');
const { getCanonicalPhone, getCanonicalPhoneAnyIntl, getOrCreateCliente } = require('../helpers/conversationSync');
const { ensureConversaForCliente } = require('../services/conversaAbrirClienteService');
const { executarAssumirConversa } = require('../services/conversaAssumirInternoService');
const { buildClienteListagemSearchOr, buildPhoneSearchTerms } = require('../helpers/chatSearchHelper');
const {
  anexarVinculosEmBusca,
  buscarClienteIdsPorNomeVinculado,
  listarVinculosDoCliente,
} = require('../helpers/clienteNomesVinculados');
const crmSync = require('../services/crmSyncService');
const { syncUltraMsgContact } = require('../services/ultramsgSyncContact');
const { marcarSchemaNomeProtecaoIndisponivel, sanitizarPatchNomeSchema } = require('../helpers/clienteNomeColunas');

// Espera máxima (ms) para o enriquecimento via UltraMSG (nome real + foto) no cadastro
// manual de contato. O WhatsApp não envia foto por webhook; buscamos aqui. Se a instância
// estiver desconectada ou o número não estiver na lista, o cadastro segue sem foto.
const CONTACT_ENRICH_TIMEOUT_MS = Math.max(0, Number(process.env.CONTACT_ENRICH_TIMEOUT_MS) || 7000);

const CLIENTE_SELECT_COLS =
  'id, telefone, wa_id, nome, pushname, observacoes, foto_perfil, email, empresa, ultimo_contato, criado_em, atualizado_em, company_id';

function bodyFlagTrue(v) {
  return v === true || v === 1 || String(v || '').toLowerCase() === 'true';
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function erroTelefoneCliente(codigo, extra = {}) {
  return {
    erro: codigo === 'TELEFONE_OBRIGATORIO' ? 'Informe telefone ou wa_id' : 'Telefone inválido',
    codigo,
    detalhe:
      codigo === 'TELEFONE_OBRIGATORIO'
        ? 'Informe o número do contato para continuar.'
        : 'Informe um número brasileiro válido: DDD + número (10 ou 11 dígitos), com ou sem o código 55. Espaços, parênteses e hífens são aceitos.',
    formato_esperado:
      'Somente números do Brasil. Celular com 9 após o DDD: ex. (11) 98765-4321 → armazenado como 5511987654321.',
    exemplos: ['34999999999', '(34) 99999-9999', '+55 34 99999-9999', '5534999999999'],
    ...extra,
  };
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
    const hasPageParam = Object.prototype.hasOwnProperty.call(req.query || {}, 'page')

    const termoBusca = palavra && String(palavra).trim() ? String(palavra).trim() : null

    // Busca por nome/telefone: usa a RPC unaccent (acento-insensível, um só round-trip
    // com o total via count-over-window). Se a RPC/migration ainda não estiver aplicada,
    // cai no caminho ILIKE legado abaixo — nunca quebra a listagem. Só para busca; a
    // listagem "todos" (sem termo) segue o caminho rápido por índice.
    if (termoBusca) {
      try {
        const phoneVariacoes = buildPhoneSearchTerms(termoBusca)
        const rpcLimit = Math.max(limitNum, 5000)
        const { data: rpcRows, error: rpcErr } = await supabase.rpc('buscar_clientes_listagem', {
          p_company_id: cid,
          p_termo: termoBusca,
          p_phone_variacoes: phoneVariacoes.length ? phoneVariacoes : null,
          p_limit: rpcLimit,
          p_offset: 0,
        })
        if (rpcErr) throw rpcErr
        const rows = Array.isArray(rpcRows) ? rpcRows : []
        const totalReal = rows.length > 0 ? (Number(rows[0].total) || rows.length) : 0
        const clientes = rows.map((c) => ({
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
          criado_em: c.criado_em,
        }))
        await anexarVinculosEmBusca(supabase, cid, clientes, termoBusca, 'contains')
        res.setHeader('X-Total-Count', String(totalReal))
        res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count')
        return res.status(200).json(clientes)
      } catch (rpcFail) {
        console.warn('[listarClientes] RPC buscar_clientes_listagem indisponível, usando ILIKE legado:', rpcFail?.message || rpcFail)
        // segue para o caminho legado abaixo
      }
    }

    // Query de contagem real (sem limite de linhas) — roda em paralelo com a listagem
    let countQuery = supabase
      .from('clientes')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', cid)

    const clienteSearchOr = termoBusca ? buildClienteListagemSearchOr(termoBusca) : null
    if (clienteSearchOr) {
      countQuery = countQuery.or(clienteSearchOr)
    }

    const { count, error: countErr } = await countQuery

    if (countErr) console.warn('[listarClientes] count:', countErr?.message)
    const totalReal = typeof count === 'number' ? count : 0

    let data = []
    if (hasPageParam) {
      // Modo paginado explícito (compatível com front que já pagina)
      let listQuery = supabase
        .from('clientes')
        .select('id, telefone, wa_id, nome, pushname, observacoes, foto_perfil, email, empresa, ultimo_contato, criado_em')
        .eq('company_id', cid)
        .order('id', { ascending: false })
        .range(offset, offset + limitNum - 1)
      if (clienteSearchOr) {
        listQuery = listQuery.or(clienteSearchOr)
      }
      const { data: pageRows, error } = await listQuery
      if (error) throw error
      data = pageRows || []
    } else {
      // Modo "todos": evita teto de 1000 do PostgREST fazendo fetch em lotes internos.
      const CHUNK = 1000
      const MAX_RETURN = 50000
      const target = Math.min(totalReal || MAX_RETURN, MAX_RETURN)
      const allRows = []

      for (let start = 0; start < target; start += CHUNK) {
        let chunkQuery = supabase
          .from('clientes')
          .select('id, telefone, wa_id, nome, pushname, observacoes, foto_perfil, email, empresa, ultimo_contato, criado_em')
          .eq('company_id', cid)
          .order('id', { ascending: false })
          .range(start, start + CHUNK - 1)
        if (clienteSearchOr) {
          chunkQuery = chunkQuery.or(clienteSearchOr)
        }

        const { data: chunkRows, error } = await chunkQuery
        if (error) throw error
        const rows = chunkRows || []
        allRows.push(...rows)
        if (rows.length < CHUNK) break
      }

      data = allRows
    }

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

    if (termoBusca) {
      await anexarVinculosEmBusca(supabase, cid, clientes, termoBusca, 'contains')
      const extraIds = await buscarClienteIdsPorNomeVinculado(supabase, cid, termoBusca, {
        mode: 'contains',
        limit: 1000,
      })
      const jaTem = new Set(clientes.map((c) => Number(c.id)))
      const faltando = extraIds.filter((id) => !jaTem.has(id))
      if (faltando.length > 0) {
        const { data: extraRows } = await supabase
          .from('clientes')
          .select('id, telefone, wa_id, nome, pushname, observacoes, foto_perfil, email, empresa, ultimo_contato, criado_em')
          .eq('company_id', cid)
          .in('id', faltando)
        const extras = (extraRows || []).map((c) => ({
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
          criado_em: c.criado_em,
        }))
        await anexarVinculosEmBusca(supabase, cid, extras, termoBusca, 'contains')
        clientes.push(...extras)
      }
    }

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
      criado_em: data.criado_em,
      nomes_vinculados: await listarVinculosDoCliente(supabase, cid, data.id, data.nome),
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
  const { telefone, wa_id, nome, observacoes, email, empresa, abrir_conversa, assumir, whatsapp_instance_id } = req.body;
  const cid = Number(company_id)

  const telefoneRaw = telefone != null ? String(telefone).trim() : ''
  const waIdRaw = wa_id != null ? String(wa_id).trim() : ''

  if (!telefoneRaw && !waIdRaw) {
    return res.status(400).json(erroTelefoneCliente('TELEFONE_OBRIGATORIO'));
  }

  try {
    if (telefoneRaw) {
      // Aceita telefone BR canônico OU número internacional válido (10–15 dígitos).
      // Antes, só passava o padrão BR estrito (normalizePhoneBR), então números
      // válidos fora desse molde — internacionais, ou colados em formatos que não
      // normalizavam — caíam em "Telefone inválido" mesmo sendo reais. Só bloqueamos
      // de fato grupos, identificadores internos (LID) e o que não tem dígitos de
      // telefone algum. getOrCreateCliente (com allowNonBR) revalida o formato no INSERT.
      const telefoneCanonico = getCanonicalPhone(telefoneRaw)
      const telefoneIntl = getCanonicalPhoneAnyIntl(telefoneRaw)
      const ehGrupoOuLid =
        telefoneCanonico.startsWith('lid:') || telefoneCanonico.endsWith('@g.us')
      const bloqueado = ehGrupoOuLid || (!telefoneCanonico && !telefoneIntl)
      if (bloqueado) {
        return res.status(400).json(
          erroTelefoneCliente('TELEFONE_INVALIDO', {
            detalhe: ehGrupoOuLid
              ? 'Grupos e identificadores internos (LID) não podem ser cadastrados por este formulário.'
              : 'Informe um número com DDD (Brasil) ou o número completo com código do país. Espaços, parênteses, hífens e "+" são aceitos.',
          })
        )
      }
    }

    const nomeTrim = trimOrNull(nome)
    const observacoesTrim = trimOrNull(observacoes)
    const emailTrim = trimOrNull(email)
    const empresaTrim = trimOrNull(empresa)

    const fields = {
      // allowNonBR: aceita também números internacionais válidos no cadastro manual.
      // Não afeta números BR (o caminho BR canônico continua sendo o preferido); só
      // adiciona um fallback quando o número não cai no padrão 55+DDD+8/9.
      allowNonBR: true,
      ...(nomeTrim ? { nome: nomeTrim, nomeSource: 'manual' } : {}),
      ...(emailTrim ? { email: emailTrim } : {}),
      ...(empresaTrim ? { empresa: empresaTrim } : {}),
      ...(waIdRaw ? { wa_id: waIdRaw } : {}),
    }

    const phoneForLookup = telefoneRaw || waIdRaw
    const { cliente_id: clienteId, created: clienteCriado } = await getOrCreateCliente(
      supabase,
      cid,
      phoneForLookup,
      fields
    )

    if (!clienteId) {
      return res.status(400).json(
        erroTelefoneCliente('TELEFONE_INVALIDO', {
          detalhe: 'Não foi possível cadastrar ou localizar o cliente para este número.',
        })
      )
    }

    const { data: row, error: fetchErr } = await supabase
      .from('clientes')
      .select(CLIENTE_SELECT_COLS)
      .eq('company_id', cid)
      .eq('id', clienteId)
      .maybeSingle()

    if (fetchErr) throw fetchErr
    if (!row) {
      return res.status(500).json({ erro: 'Erro ao carregar cliente cadastrado' })
    }

    let data = row
    if (observacoesTrim != null && observacoesTrim !== trimOrNull(data.observacoes)) {
      const { data: updated, error: updErr } = await supabase
        .from('clientes')
        .update({
          observacoes: observacoesTrim,
          atualizado_em: new Date().toISOString(),
        })
        .eq('id', clienteId)
        .eq('company_id', cid)
        .select(CLIENTE_SELECT_COLS)
        .maybeSingle()
      if (updErr) throw updErr
      if (updated) data = updated
    }

    // Enriquecimento via UltraMSG: nome real + foto de perfil. O webhook do WhatsApp NÃO
    // traz a foto, e o cadastro manual antes nunca a buscava — o contato nascia sem foto.
    // syncUltraMsgContact consulta a API e persiste foto_perfil/nome/pushname em clientes de
    // forma sticky (NÃO sobrescreve o nome digitado manualmente). Espera limitada para o
    // formulário já devolver a foto quando o WhatsApp responde rápido; no timeout o sync segue
    // em background e persiste para o próximo carregamento. Nunca quebra o cadastro.
    const enrichPhone = String(data.telefone || '').trim()
    const enriquecivel = enrichPhone && !enrichPhone.startsWith('lid:') && !enrichPhone.endsWith('@g.us')
    if (enriquecivel) {
      try {
        const enriched = await Promise.race([
          syncUltraMsgContact(enrichPhone, cid).catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), CONTACT_ENRICH_TIMEOUT_MS)),
        ])
        if (enriched) {
          const { data: fresh } = await supabase
            .from('clientes')
            .select(CLIENTE_SELECT_COLS)
            .eq('company_id', cid)
            .eq('id', clienteId)
            .maybeSingle()
          if (fresh) data = fresh
        }
      } catch (_) {
        // best-effort: falha no enriquecimento não impede o cadastro
      }
    }

    // Espelha o contato no CRM Avançado (fire-and-forget; o serviço trata erro e
    // não rejeita, então nunca quebra o cadastro). empresaId = company_id do JWT.
    crmSync.syncContato({
      empresaId: cid,
      contatoId: data.id,
      nome: data.nome,
      email: data.email,
      telefone: data.telefone,
      empresaNome: data.empresa,
    })

    const statusCode = clienteCriado === true ? 201 : 200
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
        cliente,
        whatsapp_instance_id,
      })
      if (!r.ok) {
        return res.status(statusCode).json({
          ...data,
          conversa: null,
          conversa_criada: false,
          conversa_aviso: r.error,
          cliente_reutilizado: clienteCriado !== true,
          ...(r.codigo === 'SELECIONE_WHATSAPP_INSTANCE'
            ? { codigo: r.codigo, whatsapp_instances: r.whatsapp_instances || [] }
            : {}),
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
        conversa_criada: r.criada,
        cliente_reutilizado: clienteCriado !== true,
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
            const { emitirRealtimeAposAssumir, emitirMovimentacaoInternaAtendimento } = require('./chatController')
            emitirRealtimeAposAssumir(io, cid, r.conversa.id, usuario_id, ar.conversa)
            if (ar.atendimento) {
              await emitirMovimentacaoInternaAtendimento(io, {
                company_id: cid,
                conversa: ar.conversa,
                atendimento: ar.atendimento,
              })
            }
          }
        } else {
          payload.assumir_erro = ar.error
          payload.assumir_status = ar.status
        }
      }
      return res.status(statusCode).json(payload)
    }

    return res.status(statusCode).json({
      ...data,
      cliente_reutilizado: clienteCriado !== true,
    });
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
    let payloadUpdate = {
        ...(nome !== undefined && {
          nome,
          nome_origem: 'manual',
          nome_protegido: true,
          nome_override: true,
        }),
        ...(observacoes !== undefined && { observacoes }),
        ...(email !== undefined && { email: email ? String(email).trim() : null }),
        ...(empresa !== undefined && { empresa: empresa ? String(empresa).trim() : null }),
        ...(foto_perfil !== undefined && { foto_perfil: foto_perfil ? String(foto_perfil).trim() : null }),
        ...(telefone !== undefined && { telefone: String(telefone).trim() }),
        atualizado_em: new Date().toISOString(),
      }
    let q = supabase
      .from('clientes')
      .update(payloadUpdate)
      .eq('id', Number(id))
      .eq('company_id', cid)
      .select()
    let { data, error } = await q.maybeSingle();
    if (error && marcarSchemaNomeProtecaoIndisponivel(error)) {
      payloadUpdate = sanitizarPatchNomeSchema(payloadUpdate)
      const retry = await supabase
        .from('clientes')
        .update(payloadUpdate)
        .eq('id', Number(id))
        .eq('company_id', cid)
        .select()
        .maybeSingle()
      data = retry.data
      error = retry.error
    }

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ erro: 'Já existe um cliente com este número de telefone.' });
      }
      throw error;
    }
    if (!data) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    // Espelha a atualização no CRM Avançado (fire-and-forget). empresaId = company_id do JWT.
    crmSync.syncContato({
      empresaId: cid,
      contatoId: data.id,
      nome: data.nome,
      email: data.email,
      telefone: data.telefone,
      empresaNome: data.empresa,
    })

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
    const tabelasFilhas = ['cliente_nomes_vinculados', 'cliente_tags', 'contato_opt_in', 'contato_opt_out'];
    for (const tabela of tabelasFilhas) {
      const { error: errFilha } = await supabase.from(tabela).delete().eq('company_id', cid);
      if (errFilha && !String(errFilha.message || '').includes('does not exist')) {
        console.warn(`[apagarTodosClientes] ${tabela}:`, errFilha?.message);
      }
    }

    // 3) Deleta os clientes
    const { data: delData, error: errDel } = await supabase.from('clientes').delete().eq('company_id', cid).select('id');
    if (errDel) throw errDel;
    const qtd = Array.isArray(delData) ? delData.length : 0;
    return res.status(200).json({ ok: true, apagados: qtd, mensagem: `${qtd} cliente(s) apagado(s).` });
  } catch (err) {
    console.error('[apagarTodosClientes]', err);
    return res.status(500).json({ erro: 'Erro interno' });
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
    const tabelasFilhasComEmpresa = ['cliente_nomes_vinculados', 'cliente_tags', 'contato_opt_in', 'contato_opt_out'];
    for (const tabela of tabelasFilhasComEmpresa) {
      const { error: errFilha } = await supabase.from(tabela).delete().eq('company_id', cid).eq('cliente_id', clienteId);
      if (errFilha && !String(errFilha.message || '').includes('does not exist')) {
        console.warn(`[excluirCliente] ${tabela}:`, errFilha?.message);
      }
    }

    // 3) Deleta o cliente
    const { error: errDelete } = await supabase.from('clientes').delete().eq('id', clienteId).eq('company_id', cid);
    if (errDelete) throw errDelete;

    return res.status(200).json({ ok: true, mensagem: 'Cliente excluído' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: 'Erro interno' });
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
      .select('cliente_id')
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
      console.error('[clienteController] desvincularTag', error?.message)
      return res.status(500).json({ erro: 'Erro interno' })
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
      console.error('[clienteController] getTagsCliente', error?.message)
      return res.status(500).json({ erro: 'Erro interno' })
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
