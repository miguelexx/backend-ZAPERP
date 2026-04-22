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
const { finalizeConversationsByAbsence } = require('../services/absenceFinalizationService')

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
        .select('id, telefone, tipo, status_atendimento')
        .eq('company_id', company_id)
        .neq('status_atendimento', 'fechada')
        .neq('status_atendimento', 'aguardando_cliente')

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
            conversaId: conv.id
          })

          const statusMsg = resultSend?.ok ? 'sent' : 'erro'
          await supabase.from('mensagens').insert({
            conversa_id: conv.id,
            texto: mensagemEncerramento,
            direcao: 'out',
            company_id,
            status: statusMsg
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
    return res.status(500).json({ error: err.message })
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
    return res.status(500).json({ error: err.message })
  }
}

/** POST /jobs/finalizacao-ausencia-cliente */
exports.finalizacaoAusenciaCliente = async (req, res) => {
  try {
    const result = await finalizeConversationsByAbsence()
    if (!result.ok) return res.status(503).json({ error: result.error || 'Falha ao processar finalização por ausência' })
    return res.json(result)
  } catch (err) {
    console.error('finalizacaoAusenciaCliente:', err)
    return res.status(500).json({ error: err.message })
  }
}

exports.checkCronSecret = checkCronSecret
