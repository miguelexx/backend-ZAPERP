'use strict'

/**
 * aiController.js — POST /api/ai/ask
 *
 * Pipeline de segurança + performance:
 *   1) Validação do body
 *   2) Verificação de limite mensal por empresa
 *   3) Cache de respostas (24h, chave = SHA-256(company_id + question + period_days))
 *   4) Chamada ao serviço de IA (OpenAI + Supabase)
 *   5) Escrita no cache (se resposta ok)
 *   6) Log de auditoria em ai_logs
 *   7) Fallback automático em caso de erro
 */

const crypto = require('crypto')
const { answerDashboardQuestion } = require('../services/aiDashboardService')
const supabase = require('../config/supabase')

// ── Constantes ────────────────────────────────────────────────────────────────
const CACHE_TTL_HOURS = 24
const MONTHLY_DEFAULT_LIMIT = 1000  // perguntas/mês se empresa não tiver limite definido
const MAX_QUESTION_LENGTH = 500

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Log estruturado de erro — nunca lança exceção. */
function logError(context) {
  try {
    console.error(JSON.stringify({
      service: 'AI',
      timestamp: new Date().toISOString(),
      ...context,
    }))
  } catch (_) {}
}

/** SHA-256 da pergunta normalizada, escopado por empresa. */
function buildQuestionHash(company_id, question, period_days) {
  const normalized = question.toLowerCase().trim().replace(/\s+/g, ' ')
  const raw = `${company_id}:${normalized}:${period_days ?? 7}`
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/** ISO da meia-noite do 1° dia do mês atual. */
function startOfMonth() {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

// ── Verificação de limite mensal ──────────────────────────────────────────────

/**
 * Retorna { allowed, used, limit }.
 * Se a tabela/coluna não existir, permite a requisição (fail-open).
 */
async function checkMonthlyLimit(company_id) {
  try {
    const { data: emp } = await supabase
      .from('empresas')
      .select('ai_limit_per_month')
      .eq('id', company_id)
      .maybeSingle()

    const limit = emp?.ai_limit_per_month ?? MONTHLY_DEFAULT_LIMIT
    if (!limit || limit <= 0) return { allowed: true, used: 0, limit: null }  // null = ilimitado

    const { count } = await supabase
      .from('ai_logs')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', company_id)
      .eq('success', true)
      .gte('created_at', startOfMonth())

    const used = count ?? 0
    return { allowed: used < limit, used, limit }
  } catch (err) {
    logError({ error: err?.message, company_id, phase: 'monthly_limit_check' })
    return { allowed: true, used: 0, limit: null }  // fail-open
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/** Busca resposta em cache válido. Retorna null se não encontrar. */
async function getCached(company_id, question_hash) {
  try {
    const { data } = await supabase
      .from('ai_cache')
      .select('response, intent')
      .eq('company_id', company_id)
      .eq('question_hash', question_hash)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    return data || null
  } catch (err) {
    logError({ error: err?.message, company_id, phase: 'cache_read' })
    return null
  }
}

/** Salva resposta no cache (upsert por company_id + question_hash). */
async function saveCache({ company_id, question_hash, question, response, intent }) {
  try {
    const expires_at = new Date(Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString()
    await supabase.from('ai_cache').upsert(
      {
        company_id,
        question_hash,
        question: question.slice(0, MAX_QUESTION_LENGTH),
        response,           // objeto JSON completo { ok, intent, answer, data }
        intent,
        created_at: new Date().toISOString(),
        expires_at,
      },
      { onConflict: 'company_id,question_hash' }
    )
  } catch (err) {
    logError({ error: err?.message, company_id, phase: 'cache_write' })
  }
}

// ── Log de auditoria ──────────────────────────────────────────────────────────

async function writeAuditLog({ company_id, usuario_id, question, intent, answer, success, ip }) {
  try {
    await supabase.from('ai_logs').insert({
      company_id,
      usuario_id: usuario_id || null,
      question: question.slice(0, MAX_QUESTION_LENGTH),
      intent: intent || 'UNKNOWN',
      response: typeof answer === 'string' ? answer.slice(0, 2000) : null,
      tokens_used: null,  // expandir futuramente expondo usage da OpenAI SDK
      success: !!success,
      ip: ip || null,
      created_at: new Date().toISOString(),
    })
  } catch (err) {
    logError({ error: err?.message, company_id, phase: 'audit_log' })
  }
}

// ── Handler principal ─────────────────────────────────────────────────────────

async function ask(req, res) {
  const company_id = req.user?.company_id
  const usuario_id = req.user?.id
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 50)

  try {
    if (!company_id) {
      return res.status(401).json({ ok: false, intent: null, answer: null, data: null, error: 'Empresa não identificada.' })
    }

    const { question, period_days } = req.body || {}

    if (!question || typeof question !== 'string' || question.trim().length < 3) {
      return res.status(400).json({ ok: false, intent: null, answer: null, data: null, error: 'Pergunta inválida ou muito curta.' })
    }

    if (question.trim().length > MAX_QUESTION_LENGTH) {
      return res.status(400).json({ ok: false, intent: null, answer: null, data: null, error: `Pergunta muito longa (máximo ${MAX_QUESTION_LENGTH} caracteres).` })
    }

    const trimmedQuestion = question.trim()
    const days = period_days != null ? Number(period_days) : undefined

    // ── 1) Verificar limite mensal ────────────────────────────────────────────
    const { allowed, used, limit } = await checkMonthlyLimit(company_id)
    if (!allowed) {
      return res.status(429).json({
        ok: false,
        intent: null,
        answer: null,
        data: null,
        error: `Limite mensal de perguntas atingido (${used}/${limit}). Aguarde o próximo mês ou contate o suporte.`,
      })
    }

    // ── 2) Verificar cache ────────────────────────────────────────────────────
    const questionHash = buildQuestionHash(company_id, trimmedQuestion, days)
    const cached = await getCached(company_id, questionHash)

    if (cached) {
      // Resposta em cache: retorna sem chamar OpenAI
      const cachedResponse = typeof cached.response === 'object'
        ? cached.response
        : { ok: true, intent: cached.intent, answer: cached.response, data: null }

      return res.json({ ...cachedResponse, cached: true })
    }

    // ── 3) Chamar serviço de IA ───────────────────────────────────────────────
    const result = await answerDashboardQuestion({
      company_id,
      question: trimmedQuestion,
      period_days: days,
    })

    // ── 4) Salvar no cache (apenas respostas bem-sucedidas) ───────────────────
    if (result.ok) {
      await saveCache({
        company_id,
        question_hash: questionHash,
        question: trimmedQuestion,
        response: result,   // armazena o objeto completo como JSONB
        intent: result.intent,
      })
    }

    // ── 5) Log de auditoria ───────────────────────────────────────────────────
    await writeAuditLog({
      company_id,
      usuario_id,
      question: trimmedQuestion,
      intent: result.intent,
      answer: result.answer,
      success: result.ok,
      ip,
    })

    return res.json(result)

  } catch (err) {
    // ── Fallback automático — não crasha o servidor ───────────────────────────
    logError({
      error: err?.message,
      stack: err?.stack,
      company_id,
      phase: 'ask_handler',
    })

    // Tenta logar o erro na auditoria
    await writeAuditLog({
      company_id,
      usuario_id,
      question: (req.body?.question || '').trim().slice(0, MAX_QUESTION_LENGTH),
      intent: 'ERROR',
      answer: null,
      success: false,
      ip,
    })

    return res.status(500).json({
      ok: false,
      intent: null,
      answer: 'O assistente está temporariamente indisponível. Tente novamente em alguns segundos.',
      data: null,
    })
  }
}

module.exports = { ask }
