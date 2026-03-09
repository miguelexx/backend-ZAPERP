/**
 * Health check: básico para LB, detalhado para operações.
 */
const supabase = require('../config/supabase')

/** GET /health — básico (load balancer, sempre 200 se app está up) */
exports.basic = (req, res) => {
  res.json({ ok: true })
}

/** GET /health/detailed — verifica Supabase; útil para monitoramento */
exports.detailed = async (req, res) => {
  const isProd = process.env.NODE_ENV === 'production'
  const checks = { app: true, supabase: null }
  try {
    const { data, error } = await supabase.from('empresas').select('id').limit(1).maybeSingle()
    checks.supabase = !error
    const status = checks.supabase ? 200 : 503
    const body = {
      ok: checks.app && checks.supabase,
      checks: { ...checks },
    }
    if (!isProd && error) body.checks.supabase_error = String(error.message).slice(0, 200)
    return res.status(status).json(body)
  } catch (e) {
    checks.supabase = false
    const body = { ok: false, checks: { ...checks } }
    if (!isProd) body.checks.supabase_error = String(e?.message || 'unknown').slice(0, 200)
    return res.status(503).json(body)
  }
}
