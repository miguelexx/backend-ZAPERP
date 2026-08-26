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

    const leadRes = await crmSync.syncLead({
      empresaId: companyId,
      leadId: conversaId,
      nome,
      email,
      telefone,
      origemNome: 'WhatsApp',
      responsavelEmail: (req.user?.email && String(req.user.email).trim()) || null,
      observacoes,
    })

    // syncLead é fire-and-forget: retorna null em falha de comunicação. Como já
    // validamos isEnabled() acima, null aqui = o CRM não respondeu de fato.
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

module.exports = { enviarLeadDaConversa }
