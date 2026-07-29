/**
 * Jobs para cron (timeout inatividade, etc.)
 * Protegido por header X-Cron-Secret === process.env.CRON_SECRET
 * Usa comparação timing-safe para evitar timing-attacks.
 */
const crypto = require('crypto')
const supabase = require('../config/supabase')
const {
  DEFAULT_CHATBOT_CONFIG,
  validateChatbotConfig,
  normalizeChatbotTriageStrings,
} = require('../services/chatbotTriageService')
const {
  finalizeConversationsByAbsence,
  finalizeAbsenceForConversaIds,
  CONFIRM_FINALIZE_ABSENCE,
} = require('../services/absenceFinalizationService')
const { runAdminAtendimentoAlertaForAllCompanies } = require('../services/adminAtendimentoAlertaService')
const { runAtendimentoSemRespostaForAllCompanies } = require('../services/atendimentoSemRespostaService')
const { processarVencimentosPagamentoFinanceiro } = require('../services/conversaPagamentoFinanceiroService')

function timingSafeEqualStr(a, b) {
  const sa = String(a ?? '')
  const sb = String(b ?? '')
  const maxLen = Math.max(Buffer.byteLength(sa, 'utf8'), Buffer.byteLength(sb, 'utf8'), 1)
  const ba = Buffer.alloc(maxLen)
  const bb = Buffer.alloc(maxLen)
  ba.write(sa, 'utf8')
  bb.write(sb, 'utf8')
  return crypto.timingSafeEqual(ba, bb) && sa.length === sb.length
}

function checkCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET
  const provided = req.headers['x-cron-secret']
  if (!secret || !String(secret).trim()) {
    return res.status(503).json({ error: 'CRON_SECRET não configurado. Configure no .env para usar jobs de cron.' })
  }
  if (!provided || !timingSafeEqualStr(secret, provided)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

/**
 * POST /jobs/timeout-inatividade-chatbot
 * Encerra conversas por inatividade do cliente ao chatbot.
 * - Última mensagem do BOT (cliente não respondeu)
 * - Mais antiga que encerrar_automatico_min
 * - Exceção: NÃO encerra se a última mensagem do bot foi a de "fora do horário"
 * - Envia mensagem configurada antes de fechar
 */
exports.timeoutInatividadeChatbot = async (req, res) => {
  try {
    const { data: configs } = await supabase
      .from('ia_config')
      .select('company_id, config')

    if (!configs?.length) {
      return res.json({ ok: true, processadas: 0, mensagem: 'Nenhuma empresa com ia_config' })
    }

    const { getProvider } = require('../services/providers')
    const provider = getProvider()
    if (!provider?.sendText) {
      return res.status(503).json({ error: 'Provider de envio não disponível' })
    }

    let totalProcessadas = 0

    for (const row of configs) {
      const company_id = row.company_id
      const config = row.config || {}
      const automacoes = config.automacoes || {}
      const chatbotTriage = config.chatbot_triage || {}
      const triageMerged = { ...DEFAULT_CHATBOT_CONFIG, ...chatbotTriage }
      const triageNorm =
        validateChatbotConfig(triageMerged) || normalizeChatbotTriageStrings(triageMerged)

      const encerrarMin = Number(automacoes.encerrar_automatico_min) || 0
      if (encerrarMin <= 0) continue

      const mensagemEncerramento = String(automacoes.mensagem_encerramento_inatividade || '-conversa encerrada por conta de inatividade-').trim()
      const mensagemForaHorario = String(triageNorm.mensagemForaHorario || '').trim()

      // Conversas não fechadas, excluindo grupos
      const { data: conversas } = await supabase
        .from('conversas')
        .select('id, telefone, tipo, status_atendimento, whatsapp_instance_id')
        .eq('company_id', company_id)
        .neq('status_atendimento', 'fechada')
        .neq('status_atendimento', 'aguardando_cliente')
        .neq('status_atendimento', 'mensagem_disparada')

      if (!conversas?.length) continue

      const conversaIds = conversas
        .filter((c) => {
          const tipo = String(c.tipo || '').toLowerCase()
          const tel = String(c.telefone || '')
          return tipo !== 'grupo' && !tel.includes('@g.us')
        })
        .map((c) => c.id)

      if (conversaIds.length === 0) continue

      const { data: mensagens } = await supabase
        .from('mensagens')
        .select('conversa_id, criado_em, direcao, texto')
        .eq('company_id', company_id)
        .in('conversa_id', conversaIds)
        .order('criado_em', { ascending: false })

      const ultimaPorConversa = {}
      ;(mensagens || []).forEach((m) => {
        if (!ultimaPorConversa[m.conversa_id]) ultimaPorConversa[m.conversa_id] = m
      })

      const limite = new Date(Date.now() - encerrarMin * 60 * 1000)

      for (const conv of conversas) {
        if (!conversaIds.includes(conv.id)) continue

        const ultima = ultimaPorConversa[conv.id]
        if (!ultima) continue

        // Só encerra se a ÚLTIMA mensagem foi do BOT (out) = cliente não respondeu
        if (ultima.direcao !== 'out') continue
        if (new Date(ultima.criado_em) > limite) continue

        // Exceção: se a última msg do bot foi "fora do horário", não encerra
        if (mensagemForaHorario && String(ultima.texto || '').trim() === mensagemForaHorario) continue

        const telefone = conv.telefone || ''
        if (!telefone || String(telefone).includes('@g.us') || String(telefone).toLowerCase().startsWith('lid:')) continue

        try {
          const resultSend = await provider.sendText(telefone, mensagemEncerramento, {
            companyId: company_id,
            conversaId: conv.id,
            whatsappInstanceId: conv.whatsapp_instance_id || undefined,
            sendOrigin: 'timeout_inatividade_chatbot',
          })

          const ok = resultSend?.ok === true
          const messageId = resultSend?.messageId ? String(resultSend.messageId).trim() : null
          const hasTraceableId = !!messageId && (messageId.includes('@') || /^[A-F0-9]{12,}$/i.test(messageId) || messageId.length > 20)
          const statusMsg = ok ? (hasTraceableId ? 'sent' : 'pending') : 'erro'
          if (!ok || !hasTraceableId) {
            console.warn('[timeoutInatividadeChatbot] envio sem confirmacao rastreavel', {
              company_id,
              conversa_id: conv.id,
              whatsapp_instance_id: conv.whatsapp_instance_id || null,
              status: statusMsg,
              provider_message_id: messageId || null,
              erro: ok ? null : String(resultSend?.error || 'desconhecido').slice(0, 200),
            })
          }
          await supabase.from('mensagens').insert({
            conversa_id: conv.id,
            texto: mensagemEncerramento,
            direcao: 'out',
            origem: 'automacao',
            company_id,
            status: statusMsg,
            status_mensagem: ok ? (hasTraceableId ? 'sent' : 'sending') : 'failed',
            ...(hasTraceableId ? { whatsapp_id: messageId } : {}),
            ...(conv.whatsapp_instance_id ? { whatsapp_instance_id: conv.whatsapp_instance_id } : {}),
          })

          const { error: updErr } = await supabase
            .from('conversas')
            .update({ status_atendimento: 'fechada' })
            .eq('id', conv.id)
            .eq('company_id', company_id)

          if (!updErr) {
            totalProcessadas++
            const { resetOpcaoInvalidaLimitForConversa } = require('../services/chatbotTriageService')
            await resetOpcaoInvalidaLimitForConversa(supabase, company_id, conv.id)
            await supabase.from('historico_atendimentos').insert({
              conversa_id: conv.id,
              usuario_id: null,
              acao: 'encerramento_inatividade_chatbot',
              observacao: `Conversa encerrada automaticamente após ${encerrarMin} min sem resposta do cliente ao chatbot`
            })
          }
        } catch (e) {
          console.warn('[timeoutInatividadeChatbot] Erro ao processar conversa', conv.id, e?.message || e)
        }
      }
    }

    return res.json({ ok: true, processadas: totalProcessadas })
  } catch (err) {
    console.error('timeoutInatividadeChatbot:', err)
    return res.status(500).json({ error: 'Erro interno' })
  }
}

/** POST /jobs/timeout-inatividade — fecha/reabre conversas inativas */
exports.timeoutInatividade = async (req, res) => {
  try {
    const { data: empresas } = await supabase
      .from('empresas')
      .select('id, timeout_inatividade_min')
      .gt('timeout_inatividade_min', 0)

    if (!empresas || empresas.length === 0) {
      return res.json({ ok: true, processadas: 0, mensagem: 'Nenhuma empresa com timeout configurado' })
    }

    let totalProcessadas = 0

    for (const emp of empresas) {
      const min = Number(emp.timeout_inatividade_min) || 0
      if (min <= 0) continue

      // Conversas em_atendimento onde última msg do cliente foi há mais de X min
      const { data: conversas } = await supabase
        .from('conversas')
        .select('id, atendente_id')
        .eq('company_id', emp.id)
        .eq('status_atendimento', 'em_atendimento')
        .not('atendente_id', 'is', null)

      if (!conversas?.length) continue

      const conversaIds = conversas.map((c) => c.id)

      const { data: ultimasMsg } = await supabase
        .from('mensagens')
        .select('conversa_id, criado_em, direcao')
        .eq('company_id', emp.id)
        .in('conversa_id', conversaIds)
        .order('criado_em', { ascending: false })

      const ultimaPorConversa = {}
      ;(ultimasMsg || []).forEach((m) => {
        if (!ultimaPorConversa[m.conversa_id]) ultimaPorConversa[m.conversa_id] = m
      })

      const limite = new Date(Date.now() - min * 60 * 1000)

      for (const conv of conversas) {
        const ultima = ultimaPorConversa[conv.id]
        if (!ultima) continue
        // Só consideramos inativo se a ÚLTIMA mensagem foi do cliente (in)
        if (ultima.direcao !== 'in') continue
        if (new Date(ultima.criado_em) > limite) continue

        const { error } = await supabase
          .from('conversas')
          .update({
            status_atendimento: 'aberta',
            atendente_id: null,
            atendente_atribuido_em: null
          })
          .eq('id', conv.id)
          .eq('company_id', emp.id)

        if (!error) {
          totalProcessadas++
          await supabase.from('historico_atendimentos').insert({
            conversa_id: conv.id,
            usuario_id: null,
            acao: 'timeout_inatividade',
            observacao: `Conversa reaberta automaticamente após ${min} min sem resposta do atendente`
          })
        }
      }
    }

    return res.json({ ok: true, processadas: totalProcessadas })
  } catch (err) {
    console.error('timeoutInatividade:', err)
    return res.status(500).json({ error: 'Erro interno' })
  }
}

/** POST /jobs/finalizacao-ausencia-cliente */
exports.finalizacaoAusenciaCliente = async (req, res) => {
  try {
    const dryRun =
      req.query.dry_run === '1' ||
      req.query.dry_run === 'true' ||
      req.body?.dry_run === true
    if (dryRun) {
      const result = await finalizeConversationsByAbsence({ dryRun: true, execute: false, source: 'http' })
      if (!result.ok) {
        return res.status(503).json({ error: result.error || 'Falha na simulação (dry-run) de finalização por ausência' })
      }
      return res.json({
        ok: true,
        dryRun: true,
        quantidade_candidatos: result.candidatos?.length ?? 0,
        candidatos: result.candidatos,
        analisadas: result.analisadas,
        maxPerCycle: result.maxPerCycle,
        truncatedByMaxPerCycle: result.truncatedByMaxPerCycle,
        aviso: result.aviso,
      })
    }

    const confirm = String(req.body?.confirm || '').trim()
    const executeConfirmado = req.body?.execute === true && confirm === CONFIRM_FINALIZE_ABSENCE
    if (req.body?.execute === true && !executeConfirmado) {
      return res.status(400).json({
        error: `Para executar com confirmação explícita, envie confirm exatamente: "${CONFIRM_FINALIZE_ABSENCE}".`,
      })
    }

    const result = await finalizeConversationsByAbsence({
      dryRun: false,
      source: executeConfirmado ? 'http_confirm' : 'cron',
    })
    if (!result.ok) return res.status(503).json({ error: result.error || 'Falha ao processar finalização por ausência' })
    return res.json({
      ...result,
      ...(executeConfirmado ? { executado_com_confirmacao_http: true } : {}),
    })
  } catch (err) {
    console.error('finalizacaoAusenciaCliente:', err)
    return res.status(500).json({ error: 'Erro interno' })
  }
}

/**
 * POST /jobs/finalizacao-ausencia-lote — finalização por IDs (cron). Nunca executa sem confirm no body.
 * dry_run: true → só valida e devolve preview por conversa.
 */
exports.finalizacaoAusenciaLote = async (req, res) => {
  try {
    const body = req.body || {}
    const company_id = Number(body.company_id)
    if (!Number.isInteger(company_id) || company_id <= 0) {
      return res.status(400).json({ error: 'company_id inválido' })
    }
    const result = await finalizeAbsenceForConversaIds({
      company_id,
      conversa_ids: body.conversa_ids,
      dryRun: !!body.dry_run,
      execute: body.execute === true,
      confirm: body.confirm,
    })
    if (!result.ok) return res.status(400).json({ error: result.error || 'Falha no lote' })
    return res.json(result)
  } catch (err) {
    console.error('finalizacaoAusenciaLote:', err)
    return res.status(500).json({ error: 'Erro interno' })
  }
}

/**
 * POST /jobs/admin-atendimento-alerta
 * Envia resumo diário ao número configurado (UltraMSG), por empresa, no horário + fuso do chatbot.
 * Idempotente via tabela admin_atendimento_alerta_envios. Recomenda-se cron a cada 1–3 minutos.
 */
/** POST /jobs/vencimento-pagamento-financeiro — pagamento_pendente vencido → em_atraso */
exports.vencimentoPagamentoFinanceiro = async (req, res) => {
  try {
    const dryRun =
      req.query.dry_run === '1' ||
      req.query.dry_run === 'true' ||
      req.body?.dry_run === true
    const result = await processarVencimentosPagamentoFinanceiro({ dryRun })
    if (!result.ok) {
      return res.status(500).json({ error: result.error || 'Falha ao processar vencimentos de pagamento' })
    }
    return res.json(result)
  } catch (err) {
    console.error('vencimentoPagamentoFinanceiro:', err)
    return res.status(500).json({ error: 'Erro interno' })
  }
}

/** POST /jobs/atendimento-sem-resposta — alertas de conversa sem resposta do atendente */
exports.atendimentoSemResposta = async (req, res) => {
  try {
    const dryRun =
      req.query.dry_run === '1' ||
      req.query.dry_run === 'true' ||
      req.body?.dry_run === true
    const io = req.app?.get?.('io') || null
    const out = await runAtendimentoSemRespostaForAllCompanies({ dryRun, io })
    if (!out.ok) {
      return res.status(500).json({ error: out.error || 'Falha ao processar alertas sem resposta' })
    }
    return res.json({
      ok: true,
      dryRun,
      processadas: out.processadas,
      detalhes: out.detalhes,
    })
  } catch (err) {
    console.error('atendimentoSemResposta:', err)
    return res.status(500).json({ error: 'Erro interno' })
  }
}

exports.adminAtendimentoAlerta = async (req, res) => {
  try {
    const dryRun =
      req.query.dry_run === '1' ||
      req.query.dry_run === 'true' ||
      req.body?.dry_run === true
    const out = await runAdminAtendimentoAlertaForAllCompanies({ dryRun })
    if (!out.ok) {
      return res.status(500).json({ error: out.error || 'Falha ao processar alertas' })
    }
    return res.json({
      ok: true,
      dryRun,
      empresas_com_alerta_ativo: out.processadas,
      enviadas: out.enviadas,
      detalhes: out.detalhes,
      mensagem: out.mensagem,
    })
  } catch (err) {
    console.error('adminAtendimentoAlerta:', err)
    return res.status(500).json({ error: 'Erro interno' })
  }
}

exports.checkCronSecret = checkCronSecret
