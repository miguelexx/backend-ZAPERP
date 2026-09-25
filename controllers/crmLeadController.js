'use strict'

const supabase = require('../config/supabase')
const crmSync = require('../services/crmSyncService')
const { isGroupConversation } = require('../helpers/conversaHelper')
const { empresaModuloCrmHabilitado } = require('../helpers/moduloCrmEmpresa')

/**
 * CRM disponível para a empresa = interruptor de ambiente E flag por empresa.
 * Espelha exatamente a condição que o frontend usa para exibir o botão.
 */
async function crmDisponivelParaEmpresa(companyId) {
  if (!crmSync.isEnabled()) return false
  return empresaModuloCrmHabilitado(companyId)
}

/**
 * Normaliza uma etapa (coluna do funil) vinda do CRM Avançado para o formato que
 * o front consome nos botões de "Enviar ao CRM". Aceita variações de nomenclatura
 * (nome/name/label, cor/color, ordem/order, id/etapaId/stage_id...).
 * Retorna null quando a etapa não tem nome (linha inútil).
 */
function normalizeEtapa(e, i) {
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
}

/** Normaliza e ordena uma lista de etapas por `ordem`. */
function normalizeEtapasList(list) {
  return (Array.isArray(list) ? list : [])
    .map((e, i) => normalizeEtapa(e, i))
    .filter(Boolean)
    .sort((a, b) => a.ordem - b.ordem)
}

/**
 * Traduz uma falha do CRM (objeto `_crmError` do crmSyncService, ou `null`) para
 * uma resposta HTTP clara e diagnosticável — o motivo real NUNCA fica engolido.
 *
 *   - CRM 4xx  → 422 (CRM_REJECTED): a requisição foi recusada por CONTEÚDO
 *     (contrato/validação — ex.: funil/etapa inexistente, acaoManual ausente).
 *     Não é "bad gateway"; devolver 502 aqui esconderia a causa real.
 *   - CRM 5xx / timeout / rede (status 0) → 502 (CRM_UNREACHABLE): o CRM está
 *     indisponível ou não respondeu.
 *
 * O `detalhe` (corpo/erro devolvido pelo CRM, truncado) vai no JSON para aparecer
 * no log do front e na aba Network — é exatamente o texto que antes só existia no
 * console do backend.
 */
function mapCrmError(leadRes) {
  const crmStatus = Number(leadRes?.status) || 0
  const detalhe = (leadRes?.detail ? String(leadRes.detail) : '').slice(0, 500) || null
  const isContractError = crmStatus >= 400 && crmStatus < 500
  const httpStatus = isContractError ? 422 : 502
  let msgUsuario
  if (crmStatus === 0) {
    msgUsuario = 'Não foi possível conectar ao CRM Avançado. Verifique a conexão e tente novamente.'
  } else if (isContractError) {
    msgUsuario = `O CRM Avançado recusou os dados do lead (${crmStatus}). Verifique o funil/etapa selecionados.`
  } else {
    msgUsuario = `O CRM Avançado retornou erro (${crmStatus}). Tente novamente em instantes.`
  }
  return {
    httpStatus,
    code: isContractError ? 'CRM_REJECTED' : 'CRM_UNREACHABLE',
    crm_status: crmStatus,
    detalhe,
    error: msgUsuario,
  }
}

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

  // TODO o corpo do handler roda dentro deste try/catch — inclusive o gate de
  // disponibilidade (que lê o banco). Assim NENHUMA exceção sobe sem tratamento
  // e derruba o worker (gateway 502); tudo vira JSON de erro com motivo.
  try {
    // Interruptor mestre (ambiente) + módulo CRM ligado para esta empresa.
    if (!(await crmDisponivelParaEmpresa(companyId))) {
      return res.status(403).json({
        error: 'O CRM não está disponível para esta empresa.',
        code: 'CRM_DISABLED',
      })
    }

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

    // Funil escolhido pelo usuário (opcional). O front manda o id e/ou o nome do
    // funil; o CRM Avançado cria/move o lead direto para o funil + etapa dados.
    const funilIdRaw = req.body?.funil_id
    const funilId =
      funilIdRaw === null || funilIdRaw === undefined || String(funilIdRaw).trim() === ''
        ? null
        : String(funilIdRaw).trim()
    const funilNome =
      typeof req.body?.funil_nome === 'string' && req.body.funil_nome.trim()
        ? req.body.funil_nome.trim()
        : null

    // Ação manual: quando o usuário clica "Enviar ao CRM" (vs. captura automática
    // via webhook de inbound). O CRM usa isso para permitir entrar em qualquer
    // etapa em andamento do funil escolhido.
    const usuarioId = req.user?.id != null ? String(req.user.id) : null

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
      funilId,
      funilNome,
      etapaId,
      etapaNome,
      acaoManual: true,
      usuarioId,
    }

    let leadRes = await crmSync.syncLead(leadPayload)

    // Retry único APENAS em erro 5xx do CRM (cold start / falha transitória do
    // servidor, que responde rápido). NÃO retentamos:
    //   - status 0 (timeout/rede): retentar só empilha mais TIMEOUT_MS e pode
    //     estourar o timeout do proxy reverso → 502 de GATEWAY (crash aparente).
    //   - 4xx (recusa definitiva por contrato): a 2ª tentativa daria o mesmo erro
    //     e ainda arriscaria criar lead duplicado.
    if (crmSync.isCrmError(leadRes) && Number(leadRes.status) >= 500) {
      console.warn(`[crmLead] CRM ${leadRes.status} na 1ª tentativa, retentando syncLead…`)
      leadRes = await crmSync.syncLead(leadPayload)
    }

    if (crmSync.isCrmError(leadRes)) {
      const m = mapCrmError(leadRes)
      console.error(
        `[crmLead] CRM rejeitou lead (respondendo HTTP ${m.httpStatus}): ` +
        `crm_status=${m.crm_status} detalhe=${m.detalhe || '-'}`
      )
      return res.status(m.httpStatus).json({
        error: m.error,
        code: m.code,
        crm_status: m.crm_status,
        detalhe: m.detalhe,
      })
    }

    if (leadRes === null) {
      // syncLead devolve null quando o CRM não está configurado (URL/segredo
      // ausentes) ou o payload não tem os campos mínimos. Tratamos como CRM
      // indisponível — com motivo explícito no log.
      console.error('[crmLead] syncLead devolveu null (CRM não configurado ou payload mínimo ausente)')
      return res.status(502).json({
        error: 'O CRM Avançado não respondeu. Tente novamente.',
        code: 'CRM_UNREACHABLE',
        crm_status: 0,
        detalhe: null,
      })
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
    // Exceção inesperada (banco, bug, etc.) — logamos message + stack e
    // devolvemos 500 JSON. NUNCA deixamos a exceção subir (evita o 502 de
    // gateway por promise rejeitada num handler async do Express).
    console.error('[crmLead] Falha ao enviar lead da conversa:', err?.message || err)
    if (err?.stack) console.error(err.stack)
    return res.status(500).json({ error: 'Erro ao enviar ao CRM.', code: 'INTERNAL' })
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

  if (!(await crmDisponivelParaEmpresa(companyId))) {
    return res.status(403).json({
      error: 'O CRM não está disponível para esta empresa.',
      code: 'CRM_DISABLED',
    })
  }

  try {
    const raw = await crmSync.listEtapas(companyId)

    if (crmSync.isCrmError(raw)) {
      return res.status(200).json({ etapas: [], funis: [], disponivel: false, pipeline_nome: null })
    }

    // Formato novo do CRM: `funis[]`, cada um com suas próprias `etapas`. Cada
    // funil pode ser marcado como `padrao:true`. Aceitamos também o formato
    // antigo (funil único: `{ funil, etapas }` ou um array direto de etapas).
    const funisRaw = Array.isArray(raw?.funis) ? raw.funis : []
    const funis = funisRaw
      .map((f, i) => {
        if (!f || typeof f !== 'object') return null
        const id = f.id ?? f.funilId ?? f.pipeline_id ?? f.pipelineId ?? null
        const nome = (f.nome ?? f.name ?? f.label ?? '').toString().trim() || `Funil ${i + 1}`
        return {
          id: id != null ? String(id) : null,
          nome,
          padrao: f.padrao === true || f.default === true || f.isDefault === true,
          etapas: normalizeEtapasList(f.etapas ?? f.stages),
        }
      })
      .filter((f) => f && f.etapas.length > 0)

    // Etapas do funil padrão/legado — mantém o campo `etapas` para
    // compatibilidade com builds antigos do front (funil único).
    const funilPadrao = funis.find((f) => f.padrao) || funis[0] || null
    const etapasLegado = Array.isArray(raw)
      ? normalizeEtapasList(raw)
      : Array.isArray(raw?.etapas)
        ? normalizeEtapasList(raw.etapas)
        : (funilPadrao ? funilPadrao.etapas : [])

    return res.status(200).json({
      etapas: etapasLegado,
      funis,
      disponivel: raw != null,
      // O CRM Avançado devolve o funil em `funil.nome`; aceitamos também
      // pipelineNome/pipeline_nome caso o contrato evolua.
      pipeline_nome:
        (raw?.funil?.nome ?? raw?.pipelineNome ?? raw?.pipeline_nome ?? funilPadrao?.nome ?? null) || null,
    })
  } catch (err) {
    console.error('[crmLead] Falha ao listar etapas do CRM', err?.message || err)
    // Não quebra a UI: devolve vazio para o front cair no envio simples.
    return res.status(200).json({ etapas: [], funis: [], disponivel: false })
  }
}

module.exports = { enviarLeadDaConversa, listarEtapasCrm }
