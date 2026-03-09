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
  const checks = { app: true, supabase: null }
  try {
    const { data, error } = await supabase.from('empresas').select('id').limit(1).maybeSingle()
    checks.supabase = !error
    const status = checks.supabase ? 200 : 503
    return res.status(status).json({
      ok: checks.app && checks.supabase,
      checks: {
        ...checks,
        supabase_error: error ? String(error.message).slice(0, 100) : null,
      },
    })
  } catch (e) {
    checks.supabase = false
    return res.status(503).json({
      ok: false,
      checks: { ...checks, supabase_error: e?.message || 'unknown' },
    })
  }
}
