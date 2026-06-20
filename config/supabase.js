const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados no .env')
}

const SUPABASE_TIMEOUT_MS = parseInt(process.env.SUPABASE_TIMEOUT_MS, 10) || 30_000

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
  },
  global: {
    fetch: (url, options = {}) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS)
      return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
    },
  },
})

module.exports = supabase
