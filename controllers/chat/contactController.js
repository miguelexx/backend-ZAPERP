/**
 * Contatos e grupos: criar grupo/comunidade, vincular cliente, renomear contato, observação,
 * abrir conversa por cliente e criar contato (cliente + conversa).
 * Extraído de controllers/chatController.js (Fase 5 da modularização) sem alteração de comportamento.
 * Reexportado pela fachada controllers/chatController.js.
 */

const supabase = require('../../config/supabase')
const { isGroupConversation } = require('../../helpers/conversaHelper')
const { normalizeName, isBadName } = require('../../helpers/contactEnrichment')
const { updateClienteResiliente } = require('../../helpers/clienteNomeColunas')
const { ensureConversaForCliente } = require('../../services/conversaAbrirClienteService')
const { resolveWhatsappInstanceForManualAction } = require('../../services/whatsappInstanceService')
const { getCanonicalPhone, getCanonicalPhoneAnyIntl, getOrCreateCliente, findOrCreateConversation } = require('../../helpers/conversationSync')
const { emitirEventoEmpresaConversa, emitirConversaAtualizada } = require('../../services/chat/realtime/chatRealtimeGateway')
const { assertPermissaoConversa, assertPodeEnviarMensagem } = require('../../services/chat/access/conversationPolicy')
const { loadWhatsappInstanceMetaMap } = require('../../services/chat/read/conversationLookups')
const { safeWhatsappInstanceMeta } = require('../../services/chat/presentation/chatDto')

exports.criarGrupo = async (req, res) => {
  try {
    const io = req.app.get('io')
    const { company_id, id: usuario_id } = req.user
    const { nome } = req.body

    const { data, error } = await supabase
      .from('conversas')
      .insert({
        company_id,
        tipo: 'grupo',
        nome_grupo: nome,
        telefone: `grupo_${Date.now()}`,
        status_atendimento: 'aberta',
        usuario_id
      })
      .select()
      .single()

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    emitirEventoEmpresaConversa(io, company_id, data.id, 'nova_conversa', data)

    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar grupo' })
  }
}
// =====================================================
// 5) CRIAR COMUNIDADE
// =====================================================
exports.criarComunidade = async (req, res) => {
  try {
    const io = req.app.get('io')
    const { company_id, id: usuario_id } = req.user
    const { nome } = req.body

    const { data, error } = await supabase
      .from('conversas')
      .insert({
        company_id,
        tipo: 'comunidade',
        nome_grupo: nome,
        telefone: `comunidade_${Date.now()}`,
        status_atendimento: 'aberta',
        usuario_id
      })
      .select()
      .single()

    if (error) { console.error('[chatController]', error?.message); return res.status(500).json({ error: 'Erro interno' }) }

    emitirEventoEmpresaConversa(io, company_id, data.id, 'nova_conversa', data)

    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar comunidade' })
  }
}

// =====================================================
// Vincular cliente existente a uma conversa — PUT /chats/:id/cliente
// =====================================================
exports.vincularClienteConversa = async (req, res) => {
  try {
    const conversa_id = Number(req.params.id)
    const cliente_id = Number(req.body?.cliente_id)
    const { company_id, id: user_id, perfil, departamento_ids = [] } = req.user

    if (!Number.isFinite(conversa_id) || conversa_id <= 0) {
      return res.status(400).json({ error: 'ID da conversa inválido' })
    }
    if (!Number.isFinite(cliente_id) || cliente_id <= 0) {
      return res.status(400).json({ error: 'cliente_id inválido' })
    }

    const perm = await assertPermissaoConversa({
      company_id,
      conversa_id,
      user_id,
      role: perfil,
      user_dep_ids: departamento_ids,
    })
    if (!perm.ok) return res.status(perm.status).json({ error: perm.error })
    if (isGroupConversation(perm.conv)) {
      return res.status(400).json({ error: 'Não é possível vincular cliente em conversa de grupo.' })
    }

    const { data: cliente, error: errCli } = await supabase
      .from('clientes')
      .select('id, nome, telefone, email, empresa, observacoes, foto_perfil')
      .eq('id', cliente_id)
      .eq('company_id', Number(company_id))
      .maybeSingle()

    if (errCli) return res.status(500).json({ error: errCli.message })
    if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' })

    const nomeContato = normalizeName(cliente.nome || '') || null
    const patch = {
      cliente_id,
      ...(nomeContato ? { nome_contato_cache: nomeContato } : {}),
      ...(cliente.foto_perfil ? { foto_perfil_contato_cache: cliente.foto_perfil } : {}),
    }

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .update(patch)
      .eq('id', conversa_id)
      .eq('company_id', Number(company_id))
      .select('id, cliente_id, telefone, tipo, nome_contato_cache, foto_perfil_contato_cache, status_atendimento, atendente_id, departamento_id')
      .maybeSingle()

    if (errConv) return res.status(500).json({ error: errConv.message })
    if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada' })

    const payload = {
      id: conversa_id,
      cliente_id,
      contato_nome: nomeContato || undefined,
      nome_contato_cache: nomeContato || undefined,
      foto_perfil: cliente.foto_perfil || undefined,
      foto_perfil_contato_cache: cliente.foto_perfil || undefined,
      status_atendimento: conversa.status_atendimento,
      atendente_id: conversa.atendente_id,
      departamento_id: conversa.departamento_id,
    }

    const io = req.app?.get?.('io') || null
    if (io) {
      emitirConversaAtualizada(io, company_id, conversa_id, payload, { skipAtualizarConversa: true })
    }

    return res.json({ ok: true, conversa: { ...conversa, ...payload }, cliente })
  } catch (err) {
    console.error('[vincularClienteConversa]', err)
    return res.status(500).json({ error: 'Erro ao vincular cliente à conversa' })
  }
}

// =====================================================
// Nome exibido do contato (conversa + cliente vinculado) — PUT /chats/:id/nome-contato
// =====================================================
exports.atualizarNomeContato = async (req, res) => {
  const conversa_id = Number(req.params.id)
  const company_id = Number(req.user?.company_id)
  const user_id = req.user?.id
  const role = req.user?.perfil
  let gravouConversa = false
  let payload = null
  let clienteAtualizado = null

  const responderOk = () => {
    if (res.headersSent) return
    return res.json({
      ok: true,
      conversa: payload,
      cliente: clienteAtualizado,
    })
  }

  try {
    if (!Number.isFinite(conversa_id) || conversa_id <= 0) {
      return res.status(400).json({ error: 'ID da conversa inválido' })
    }
    if (!Number.isFinite(company_id) || company_id <= 0) {
      return res.status(401).json({ error: 'Tenant inválido' })
    }

    const nomeRaw = req.body?.nome != null ? String(req.body.nome) : ''
    const nome = normalizeName(nomeRaw)
    if (!nome) {
      return res.status(400).json({ error: 'Informe um nome válido para o contato.' })
    }
    let nomeInvalido = false
    try {
      nomeInvalido = isBadName(nome)
    } catch (badNameErr) {
      console.error('[atualizarNomeContato] isBadName', badNameErr)
      nomeInvalido = false
    }
    if (nomeInvalido) {
      return res.status(400).json({ error: 'Nome inválido. Use o nome do contato, não apenas números.' })
    }

    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('id, company_id, cliente_id, tipo, telefone, nome_contato_cache, atendente_id, status_atendimento')
      .eq('id', conversa_id)
      .eq('company_id', company_id)
      .maybeSingle()

    if (errConv) return res.status(500).json({ error: errConv.message })
    if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada' })
    if (isGroupConversation(conversa)) {
      return res.status(400).json({ error: 'Não é possível renomear contato em conversa de grupo.' })
    }

    const isAdmin = role === 'admin' || role === 'supervisor'
    const isAtendente = conversa.atendente_id != null && Number(conversa.atendente_id) === Number(user_id)
    if (!isAdmin && !isAtendente) {
      return res.status(403).json({ error: 'Assuma a conversa para editar o nome do contato.' })
    }

    const { error: errCache } = await supabase
      .from('conversas')
      .update({ nome_contato_cache: nome })
      .eq('id', conversa_id)
      .eq('company_id', company_id)

    if (errCache) return res.status(500).json({ error: errCache.message })
    gravouConversa = true

    const clienteId = conversa.cliente_id != null ? Number(conversa.cliente_id) : null
    payload = {
      id: conversa_id,
      contato_nome: nome,
      nome_contato_cache: nome,
      cliente_nome: nome,
      ...(clienteId ? { cliente_id: clienteId } : {}),
    }

    if (clienteId) {
      try {
        const first = await updateClienteResiliente(supabase, {
          id: clienteId,
          companyId: company_id,
          updates: {
            nome,
            nome_origem: 'manual',
            nome_protegido: true,
            nome_override: true,
            atualizado_em: new Date().toISOString(),
          },
        })
        let cli = null
        let errCli = first.error
        if (!errCli) {
          let after = await supabase
            .from('clientes')
            .select('id, nome, telefone, email, empresa, observacoes, foto_perfil, nome_protegido, nome_origem')
            .eq('id', clienteId)
            .eq('company_id', company_id)
            .maybeSingle()
          if (after.error) {
            after = await supabase
              .from('clientes')
              .select('id, nome, telefone, email, empresa, observacoes, foto_perfil')
              .eq('id', clienteId)
              .eq('company_id', company_id)
              .maybeSingle()
          }
          cli = after.data
          errCli = after.error
        }

        if (errCli) {
          console.error('[atualizarNomeContato] cliente', errCli)
        } else {
          clienteAtualizado = cli
        }
      } catch (cliErr) {
        console.error('[atualizarNomeContato] cliente', cliErr)
      }
    }

    try {
      const io = req.app?.get?.('io') || null
      if (io) {
        emitirConversaAtualizada(io, company_id, conversa_id, payload, { skipAtualizarConversa: true })
      }
    } catch (emitErr) {
      console.error('[atualizarNomeContato] emit', emitErr)
    }

    return responderOk()
  } catch (err) {
    console.error('[atualizarNomeContato]', err)
    if (gravouConversa && payload) return responderOk()
    if (res.headersSent) return
    return res.status(500).json({ error: 'Erro ao atualizar nome do contato' })
  }
}

exports.atualizarObservacao = async (req, res) => {
  try {
    const { id } = req.params;
    const { observacao } = req.body;
    const { company_id, id: user_id, perfil } = req.user;

    const permEnvio = await assertPodeEnviarMensagem({ company_id, conversa_id: Number(id), user_id, role: req.user?.perfil, user_dep_ids: req.user?.departamento_ids })
    if (!permEnvio.ok) return res.status(permEnvio.status).json({ error: permEnvio.error });

    // busca cliente ligado à conversa
    const { data: conversa, error: errConv } = await supabase
      .from('conversas')
      .select('cliente_id')
      .eq('id', Number(id))
      .eq('company_id', company_id)
      .single();

    if (errConv) return res.status(500).json({ error: errConv.message });
    if (!conversa?.cliente_id) {
      return res.status(404).json({ error: 'Cliente não encontrado para esta conversa' });
    }

    const { error: errCli } = await supabase
      .from('clientes')
      .update({ observacoes: observacao ?? null })
      .eq('id', Number(conversa.cliente_id))
      .eq('company_id', company_id);

    if (errCli) return res.status(500).json({ error: errCli.message });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao atualizar observação:', err);
    return res.status(500).json({ error: 'Erro ao atualizar observação' });
  }
};

exports.abrirConversaCliente = async (req, res) => {
  try {
    const io = req.app.get('io')
    const { company_id, id: usuario_id } = req.user
    const { cliente_id, whatsapp_instance_id } = req.body

    if (!cliente_id) {
      return res.status(400).json({ error: 'cliente_id é obrigatório' })
    }

    const cid = Number(company_id)
    let clienteQuery = supabase
      .from('clientes')
      .select('id, nome, pushname, telefone, foto_perfil')
      .eq('id', Number(cliente_id))
      .eq('company_id', cid)
    const { data: cliente, error: errCli } = await clienteQuery.maybeSingle()

    if (errCli || !cliente) {
      return res.status(404).json({ error: 'Cliente não encontrado' })
    }

    const r = await ensureConversaForCliente({ company_id, usuario_id, cliente, whatsapp_instance_id })
    if (!r.ok) {
      if (r.codigo === 'SELECIONE_WHATSAPP_INSTANCE') {
        return res.status(400).json({
          error: r.error,
          codigo: r.codigo,
          whatsapp_instances: r.whatsapp_instances || [],
        })
      }
      const st = r.error === 'Cliente sem telefone cadastrado' ? 400 : 500
      return res.status(st).json({ error: r.error })
    }

    if (r.criada && io) {
      emitirEventoEmpresaConversa(io, company_id, r.conversa.id, 'nova_conversa', r.conversa)
    }

    return res.json({ conversa: r.conversa, criada: r.criada })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao abrir conversa' })
  }
}

// Resposta 400 padronizada — frontend pode exibir formato ao usuário (novo contato manual)
function erroTelefoneNovoContato (codigo, extra = {}) {
  const base = {
    error: codigo === 'TELEFONE_OBRIGATORIO' ? 'Telefone obrigatório' : 'Telefone inválido',
    codigo,
    detalhe:
      codigo === 'TELEFONE_OBRIGATORIO'
        ? 'Informe o número do contato para continuar.'
        : 'Informe um número brasileiro válido: DDD + número (10 ou 11 dígitos), com ou sem o código do país 55 (12 ou 13 dígitos no total). Espaços, parênteses e hífens podem ser usados e serão ignorados.',
    formato_esperado:
      'Somente números do Brasil. Celular com 9 após o DDD: ex. (11) 98765-4321 → armazenado como 5511987654321. Fixo sem o 9: ex. (11) 3456-7890.',
    exemplos: ['34999999999', '(34) 99999-9999', '+55 34 99999-9999', '5534999999999'],
    ...extra
  }
  return base
}

// =====================================================
// 6) CRIAR CONTATO (cliente + conversa)
// =====================================================
exports.criarContato = async (req, res) => {
  try {
    const io = req.app.get('io')
    const { company_id, id: usuario_id } = req.user
    const { nome, telefone, whatsapp_instance_id } = req.body

    const telefoneRaw = telefone != null ? String(telefone).trim() : ''
    if (!telefoneRaw) {
      return res.status(400).json(erroTelefoneNovoContato('TELEFONE_OBRIGATORIO'))
    }

    const instanceRes = await resolveWhatsappInstanceForManualAction(company_id, whatsapp_instance_id)
    if (instanceRes.code === 'SELECIONE_WHATSAPP_INSTANCE') {
      return res.status(400).json({
        error: instanceRes.error,
        codigo: instanceRes.code,
        whatsapp_instances: instanceRes.instances || [],
      })
    }
    if (instanceRes.error || !instanceRes.instanceId) {
      return res.status(400).json({ error: instanceRes.error || 'Instância WhatsApp indisponível' })
    }

    // Bloquear apenas LID e JID de grupo — números internacionais são permitidos como fallback
    let telefoneCanonico = getCanonicalPhone(telefoneRaw)
    const isLidOrGroup = telefoneCanonico.startsWith('lid:') || telefoneCanonico.endsWith('@g.us')
    if (isLidOrGroup) {
      return res.status(400).json(
        erroTelefoneNovoContato('TELEFONE_INVALIDO', {
          detalhe: 'Grupos e identificadores internos (LID) não podem ser cadastrados por este formulário.'
        })
      )
    }

    let allowNonBR = false
    if (!telefoneCanonico) {
      const intlCanonical = getCanonicalPhoneAnyIntl(telefoneRaw)
      if (!intlCanonical) {
        return res.status(400).json(
          erroTelefoneNovoContato('TELEFONE_INVALIDO', {
            detalhe: 'Não foi possível interpretar um telefone válido. Verifique DDD e quantidade de dígitos.'
          })
        )
      }
      telefoneCanonico = intlCanonical
      allowNonBR = true
    }

    const nomeTrim = nome != null ? String(nome).trim() : ''

    // Cliente: getOrCreateCliente evita 23505 e unifica variantes (55… vs DDD…).
    const { cliente_id: clienteId } = await getOrCreateCliente(supabase, company_id, telefoneRaw, {
      ...(nomeTrim ? { nome: nomeTrim } : {}),
      allowNonBR,
    })
    if (!clienteId) {
      return res.status(400).json(
        erroTelefoneNovoContato('TELEFONE_INVALIDO', {
          detalhe: 'Não foi possível cadastrar ou localizar o cliente para este número.'
        })
      )
    }

    // Conversa: findOrCreateConversation inclui conversas fechadas e trata race (23505).
    let resultado
    try {
      resultado = await findOrCreateConversation(supabase, {
        company_id,
        phone: telefoneCanonico,
        cliente_id: clienteId,
        isGroup: false,
        whatsapp_instance_id: instanceRes.instanceId,
        whatsapp_instance_is_default: instanceRes.isDefault === true,
        logPrefix: '[criarContato]',
        allowNonBR,
      })
    } catch (e) {
      console.error(e)
      return res.status(500).json({ error: 'Erro ao criar contato' })
    }

    if (!resultado?.conversa?.id) {
      return res.status(500).json({ error: 'Erro ao criar contato' })
    }

    const convId = Number(resultado.conversa.id)
    const convNova = resultado.created === true

    if (Number(resultado.conversa.cliente_id) !== Number(clienteId)) {
      await supabase
        .from('conversas')
        .update({ cliente_id: clienteId })
        .eq('company_id', company_id)
        .eq('id', convId)
    }

    if (convNova) {
      const patch = { tipo: 'cliente', usuario_id }
      await supabase.from('conversas').update(patch).eq('company_id', company_id).eq('id', convId)
    }

    const { data: conversa, error: errFull } = await supabase
      .from('conversas')
      .select('*')
      .eq('company_id', company_id)
      .eq('id', convId)
      .single()

    if (errFull || !conversa) {
      return res.status(500).json({ error: errFull?.message || 'Erro ao carregar conversa' })
    }

    if (convNova && io) {
      emitirEventoEmpresaConversa(io, company_id, conversa.id, 'nova_conversa', conversa)
    }

    const whatsappInstanceMetaMap = await loadWhatsappInstanceMetaMap(company_id, [conversa.whatsapp_instance_id, instanceRes.instanceId])
    const whatsappInstanceMeta = safeWhatsappInstanceMeta(
      whatsappInstanceMetaMap.get(Number(conversa.whatsapp_instance_id)) ||
      whatsappInstanceMetaMap.get(Number(instanceRes.instanceId)) ||
      instanceRes.instance
    )

    // reutilizada: número já tinha conversa (ex.: fechada ou duplicata) — frontend pode só navegar, sem toast de erro.
    return res.json({ ...conversa, ...whatsappInstanceMeta, reutilizada: !convNova })

  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro ao criar contato' })
  }
}
