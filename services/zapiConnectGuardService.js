/**
 * Guard para o fluxo Conectar WhatsApp (Z-API QR Code).
 * Reduz risco de bloqueio: throttle 15s entre QRs; bloqueio 90s após 3 tentativas.
 * Reconexões muito rápidas podem acionar detecção do WhatsApp.
 */

const supabase = require('../config/supabase')

const THROTTLE_SECONDS = 15
const MAX_ATTEMPTS = 3
const BLOCK_SECONDS = 90

/**
 * Verifica se pode servir novo QR.
 * @returns {Promise<{ ok: true } | { ok: false, retryAfterSeconds: number }>}
 */
async function checkGuard(company_id) {
  if (!company_id) return { ok: false, retryAfterSeconds: BLOCK_SECONDS }
  const { data, error } = await supabase
    .from('zapi_connect_guard')
    .select('last_qr_at, qr_attempts, blocked_until')
    .eq('company_id', company_id)
    .maybeSingle()

  if (error) {
    console.error('[ZAPI-GUARD] Erro ao buscar guard:', error.message)
    return { ok: false, retryAfterSeconds: BLOCK_SECONDS }
  }

  const now = new Date()
  const lastQr = data?.last_qr_at ? new Date(data.last_qr_at) : null
  const blockedUntil = data?.blocked_until ? new Date(data.blocked_until) : null
  const attempts = Number(data?.qr_attempts) || 0

  // Bloqueado por bloqueio ativo
  if (blockedUntil && blockedUntil > now) {
    const sec = Math.ceil((blockedUntil - now) / 1000)
    return { ok: false, retryAfterSeconds: Math.min(sec, BLOCK_SECONDS) }
  }

  // Já atingiu 3 tentativas → ativar bloqueio de 60s
  if (attempts >= MAX_ATTEMPTS) {
    const blockEnd = new Date(now.getTime() + BLOCK_SECONDS * 1000)
    await supabase
      .from('zapi_connect_guard')
      .upsert({
        company_id,
        blocked_until: blockEnd.toISOString(),
        last_qr_at: now.toISOString(),
      }, { onConflict: 'company_id' })
    return { ok: false, retryAfterSeconds: BLOCK_SECONDS }
  }

  // Throttle: última chamada há menos de 10s
  if (lastQr) {
    const elapsed = (now - lastQr) / 1000
    if (elapsed < THROTTLE_SECONDS) {
      return { ok: false, retryAfterSeconds: Math.ceil(THROTTLE_SECONDS - elapsed) }
    }
  }

  return { ok: true }
}

/**
 * Registra que um QR foi servido (incrementa tentativas, atualiza last_qr_at).
 */
async function recordQrServed(company_id) {
  if (!company_id) return
  const now = new Date()
  const { data } = await supabase
    .from('zapi_connect_guard')
    .select('qr_attempts')
    .eq('company_id', company_id)
    .maybeSingle()

  const attempts = (Number(data?.qr_attempts) || 0) + 1
  await supabase
    .from('zapi_connect_guard')
    .upsert({
      company_id,
      last_qr_at: now.toISOString(),
      qr_attempts: attempts,
    }, { onConflict: 'company_id' })
}

/**
 * Zera tentativas e limpa bloqueio quando a instância conectou.
 */
async function resetOnConnected(company_id) {
  if (!company_id) return
  await supabase
    .from('zapi_connect_guard')
    .upsert({
      company_id,
      qr_attempts: 0,
      blocked_until: null,
      last_qr_at: null,
    }, { onConflict: 'company_id' })
}

/**
 * Retorna número de tentativas restantes (3 - attempts).
 */
async function getAttempts(company_id) {
  if (!company_id) return { attempts: 0, attemptsLeft: MAX_ATTEMPTS }
  const { data } = await supabase
    .from('zapi_connect_guard')
    .select('qr_attempts')
    .eq('company_id', company_id)
    .maybeSingle()

  const attempts = Number(data?.qr_attempts) || 0
  return { attempts, attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts) }
}

module.exports = {
  checkGuard,
  recordQrServed,
  resetOnConnected,
  getAttempts,
  THROTTLE_SECONDS,
  MAX_ATTEMPTS,
  BLOCK_SECONDS,
}
