'use strict'

const supabase = require('../config/supabase')
const crmSync = require('../services/crmSyncService')
const { isGroupConversation } = require('../helpers/conversaHelper')

/**
 * POST /api/crm/leads/from-conversa/:conversaId
 *
 * "Enviar ao CRM": transforma o contato de uma conversa em lead no CRM Avançado
 * (aparece na página de Leads). Puxa todos os dados disponíveis do cliente
 * (nome, telefone, e-mail, empresa, observações) e sincroniza tanto o contato
 * quanto o lead no CRM externo (services/crmSyncService).
 *
 * SEGURANÇA:
 *   - company_id vem SEMPRE de req.user (JWT) — nunca de body/query/params.
 *   - A conversa e o cliente são lidos com filtro explícito por company_id
 *     (SERVICE_ROLE bypassa RLS; o isolamento é 100% app-layer).
 *
 * IDEMPOTÊNCIA:
 *   - leadId = conversaId, o MESMO id que a captura automática de lead usa
 *     (webhookZapiController). Reenviar atualiza o mesmo lead em vez de duplicar
 *     — desde que o CRM Avançado faça upsert por leadId (contrato do sync).
 *
 * Contrato de resposta (compatível com o front SendToCrmChatButton):
 *   - 201 { ok:true, lead:{id}|null, from_conversa:{...} }  → enviado
 *   - 403 { code:'CRM_DISABLED' }                            → integração off
 *   - 400 / 404                                              → entrada inválida
 *   - 502                                                    → CRM não respondeu
 */
async function enviarLeadDaConversa(req, res) {
  const companyId = Number(req.user?.company_id)
  const conversaId = Number(req.params?.conversaId)

  if (!companyId) return res.status(401).json({ error: 'Sessão inválida.' })
  if (!Number.isInteger(conversaId) || conversaId <= 0) {
    return res.status(400).json({ error: 'Conversa inválida.' })
  }

  // Interruptor mestre: sem CRM_AVANCADO_URL/ZAP_SSO_SECRET não há para onde enviar.
  if (!crmSync.isEnabled()) {
    return res.status(403).json({
      error: 'O CRM Avançado não está configurado neste ambiente.',
      code: 'CRM_DISABLED',
    })
  }

  try {
    // 1. Conversa — escopada por empresa.
    const { data: conversa, error: convErr } = await supabase
      .from('conversas')
      .select('id, telefone, cliente_id, tipo, nome_contato_cache')
      .eq('id', conversaId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (convErr) throw convErr
    if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada.' })
    if (isGroupConversation(conversa)) {
      return res.status(400).json({ error: 'Grupos não podem ser enviados como lead.' })
    }

    // 2. Cliente vinculado — escopado por empresa; puxa todos os dados possíveis.
    let cliente = null
    if (conversa.cliente_id) {
      const { data: cli, error: cliErr } = await supabase
        .from('clientes')
        .select('id, nome, pushname, telefone, email, empresa, observacoes')
        .eq('id', conversa.cliente_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (cliErr) throw cliErr
      cliente = cli || null
    }

    // 3. Melhor dado disponível para cada campo do lead.
    const telefone =
      (cliente?.telefone && String(cliente.telefone).trim()) ||
      (conversa.telefone && String(conversa.telefone).trim()) ||
      null

    const nome =
      (cliente?.nome && String(cliente.nome).trim()) ||
      (cliente?.pushname && String(cliente.pushname).trim()) ||
      (conversa.nome_contato_cache && String(conversa.nome_contato_cache).trim()) ||
      telefone ||
      `Lead ${conversaId}`

    const email = (cliente?.email && String(cliente.email).trim()) || null
    const empresaNome = (cliente?.empresa && String(cliente.empresa).trim()) || null

    const notaManual =
      typeof req.body?.observacoes === 'string' ? req.body.observacoes.trim() : ''
    const observacoes =
      notaManual ||
      (cliente?.observacoes ? String(cliente.observacoes).trim() : '') ||
      null

    // Etapa do funil escolhida pelo usuário (opcional). O front manda o id e/ou
    // o nome da etapa; o CRM Avançado cria/move o lead direto para ela.
    const etapaIdRaw = req.body?.etapa_id
    const etapaId =
      etapaIdRaw === null || etapaIdRaw === undefined || String(etapaIdRaw).trim() === ''
        ? null
        : String(etapaIdRaw).trim()
    const etapaNome =
      typeof req.body?.etapa_nome === 'string' && req.body.etapa_nome.trim()
        ? req.body.etapa_nome.trim()
        : null

    // 4. Sincroniza contato + lead no CRM Avançado.
    //    contatoId = cliente.id (quando há cliente cadastrado).
    if (cliente?.id) {
      await crmSync.syncContato({
        empresaId: companyId,
        contatoId: cliente.id,
        nome,
        email,
        telefone,
        empresaNome,
      })
    }

    const leadPayload = {
      empresaId: companyId,
      leadId: conversaId,
      nome,
      email,
      telefone,
      origemNome: 'WhatsApp',
      responsavelEmail: (req.user?.email && String(req.user.email).trim()) || null,
      observacoes,
      etapaId,
      etapaNome,
    }

    let leadRes = await crmSync.syncLead(leadPayload)

    // Retry automático: se a primeira tentativa falhou, tenta mais uma vez.
    if (crmSync.isCrmError(leadRes)) {
      console.warn('[crmLead] Primeira tentativa falhou, retentando syncLead…')
      leadRes = await crmSync.syncLead(leadPayload)
    }

    if (crmSync.isCrmError(leadRes)) {
      const detail = leadRes.detail || ''
      const status = leadRes.status || 0
      console.error(`[crmLead] CRM rejeitou lead: status=${status} detail=${detail}`)
      const msgUsuario = status === 0
        ? 'Não foi possível conectar ao CRM Avançado. Verifique sua conexão e tente novamente.'
        : `O CRM Avançado retornou erro (${status}). Tente novamente.`
      return res.status(502).json({ error: msgUsuario })
    }

    if (leadRes === null) {
      return res.status(502).json({ error: 'O CRM Avançado não respondeu. Tente novamente.' })
    }

    const leadId =
      leadRes?.lead?.id ?? leadRes?.leadId ?? leadRes?.id ?? null

    return res.status(201).json({
      ok: true,
      lead: leadId != null ? { id: leadId } : null,
      from_conversa: {
        conversa_id: conversaId,
        cliente_id: cliente?.id ?? null,
      },
    })
  } catch (err) {
    console.error('[crmLead] Falha ao enviar lead da conversa', err?.message || err)
    return res.status(500).json({ error: 'Erro ao enviar ao CRM.' })
  }
}

/**
 * GET /api/crm/etapas
 *
 * Lista as etapas (colunas do funil) do CRM Avançado da empresa, para o usuário
 * escolher em qual etapa o lead deve entrar ao "Enviar ao CRM".
 *
 * SEGURANÇA: company_id vem SEMPRE de req.user (JWT).
 *
 * DEGRADAÇÃO GRACIOSA: se o CRM Avançado ainda não expõe o endpoint de etapas
 * (ou não respondeu), devolve 200 { etapas: [], disponivel:false } — o front
 * então cai no envio simples, sem erro. Só a ausência de configuração do CRM
 * (interruptor mestre) devolve 403.
 */
async function listarEtapasCrm(req, res) {
  const companyId = Number(req.user?.company_id)
  if (!companyId) return res.status(401).json({ error: 'Sessão inválida.' })

  if (!crmSync.isEnabled()) {
    return res.status(403).json({
      error: 'O CRM Avançado não está configurado neste ambiente.',
      code: 'CRM_DISABLED',
    })
  }

  try {
    const raw = await crmSync.listEtapas(companyId)

    if (crmSync.isCrmError(raw)) {
      return res.status(200).json({ etapas: [], disponivel: false, pipeline_nome: null })
    }

    // Aceita { etapas: [...] } ou um array direto; normaliza cada etapa.
    const lista = Array.isArray(raw) ? raw : Array.isArray(raw?.etapas) ? raw.etapas : []
    const etapas = lista
      .map((e, i) => {
        if (!e || typeof e !== 'object') return null
        const id = e.id ?? e.etapaId ?? e.stage_id ?? e.stageId ?? null
        const nome = (e.nome ?? e.name ?? e.label ?? '').toString().trim()
        if (!nome) return null
        return {
          id: id != null ? String(id) : null,
          nome,
          ordem: Number.isFinite(Number(e.ordem ?? e.order)) ? Number(e.ordem ?? e.order) : i,
          tipo: (e.tipo ?? e.type ?? '').toString().trim() || null,
          cor: (e.cor ?? e.color ?? '').toString().trim() || null,
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.ordem - b.ordem)

    return res.status(200).json({
      etapas,
      disponivel: raw != null,
      // O CRM Avançado devolve o funil em `funil.nome`; aceitamos também
      // pipelineNome/pipeline_nome caso o contrato evolua.
      pipeline_nome:
        (raw?.funil?.nome ?? raw?.pipelineNome ?? raw?.pipeline_nome ?? null) || null,
    })
  } catch (err) {
    console.error('[crmLead] Falha ao listar etapas do CRM', err?.message || err)
    // Não quebra a UI: devolve vazio para o front cair no envio simples.
    return res.status(200).json({ etapas: [], disponivel: false })
  }
}

module.exports = { enviarLeadDaConversa, listarEtapasCrm }
