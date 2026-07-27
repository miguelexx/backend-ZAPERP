/**
 * Health check: básico para LB, detalhado para operações.
 */
const supabase = require('../config/supabase')

function releaseMetadata() {
  const release = String(process.env.RELEASE_VERSION || '').trim()
  const buildSha = String(process.env.BUILD_SHA || '').trim()
  return {
    ...(release ? { release } : {}),
    ...(buildSha ? { build_sha: buildSha.slice(0, 64) } : {}),
  }
}

/** GET /health — básico (load balancer, sempre 200 se app está up) */
exports.basic = (req, res) => {
  res.json({ ok: true, ...releaseMetadata() })
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
      ...releaseMetadata(),
    }
    if (!isProd && error) body.checks.supabase_error = String(error.message).slice(0, 200)
    return res.status(status).json(body)
  } catch (e) {
    checks.supabase = false
    const body = { ok: false, checks: { ...checks }, ...releaseMetadata() }
    if (!isProd) body.checks.supabase_error = String(e?.message || 'unknown').slice(0, 200)
    return res.status(503).json(body)
  }
}
