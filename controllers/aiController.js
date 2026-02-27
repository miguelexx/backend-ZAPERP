'use strict'

const { answerDashboardQuestion } = require('../services/aiDashboardService')
const supabase = require('../config/supabase')

/**
 * POST /api/ai/ask
 * Body: { question: string, period_days?: number }
 */
async function ask(req, res) {
  try {
    const company_id = req.user?.company_id
    if (!company_id) {
      return res.status(401).json({ ok: false, error: 'Empresa não identificada.' })
    }

    const { question, period_days } = req.body || {}

    if (!question || typeof question !== 'string' || question.trim().length < 3) {
      return res.status(400).json({ ok: false, error: 'Pergunta inválida ou muito curta.' })
    }

    const days = period_days != null ? Number(period_days) : undefined

    const result = await answerDashboardQuestion({
      company_id,
      question: question.trim(),
      period_days: days,
    })

    // Log opcional em bot_logs — não quebra se a tabela não existir
    try {
      await supabase.from('bot_logs').insert({
        company_id,
        tipo: 'ai_analytics',
        detalhes: {
          question: question.trim(),
          intent: result.intent,
          ok: result.ok,
        },
      })
    } catch (_) {}

    return res.json(result)
  } catch (err) {
    console.error('[aiController] ask error:', err?.message || err)
    return res.status(500).json({ ok: false, error: 'Erro interno ao processar pergunta.' })
  }
}

module.exports = { ask }
