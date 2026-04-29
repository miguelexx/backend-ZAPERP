/**
 * Envio Web Push (VAPID). Credenciais apenas no servidor.
 */
const webpush = require('web-push')
const supabase = require('../config/supabase')

let configured = false

const DEFAULT_PUSH_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 dias
const MAX_PUSH_TTL_SECONDS = 60 * 60 * 24 * 28 // limite prático comum: 28 dias
const PUSH_SEND_MAX_ATTEMPTS = 3
const PUSH_SEND_BASE_DELAY_MS = 300

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolvePushTtlSeconds() {
  const raw = Number(process.env.WEB_PUSH_TTL_SECONDS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PUSH_TTL_SECONDS
  return Math.min(Math.floor(raw), MAX_PUSH_TTL_SECONDS)
}

function ensureVapidConfigured() {
  if (configured) return true
  const pub = String(process.env.VAPID_PUBLIC_KEY || '').trim()
  const priv = String(process.env.VAPID_PRIVATE_KEY || '').trim()
  const subject = String(process.env.VAPID_SUBJECT || 'mailto:support@zaperp.local').trim()
  if (!pub || !priv) return false
  try {
    webpush.setVapidDetails(subject, pub, priv)
    configured = true
    return true
  } catch (e) {
    console.warn('[web-push] Falha ao configurar VAPID:', e?.message || e)
    return false
  }
}

function subscriptionFromRow(row) {
  if (!row?.endpoint || !row?.p256dh || !row?.auth) return null
  return {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth,
    },
  }
}

async function deleteSubscriptionByEndpoint(endpoint) {
  const ep = String(endpoint || '').trim()
  if (!ep) return
  await supabase.from('push_subscriptions').delete().eq('endpoint', ep)
}

/**
 * @param {import('web-push').PushSubscription} subscription
 * @param {string} payloadUtf8
 */
async function sendToSubscription(subscription, payloadUtf8) {
  if (!ensureVapidConfigured()) return { ok: false, reason: 'vapid_not_configured' }
  const ttl = resolvePushTtlSeconds()
  try {
    for (let attempt = 1; attempt <= PUSH_SEND_MAX_ATTEMPTS; attempt++) {
      try {
        await webpush.sendNotification(subscription, payloadUtf8, {
          TTL: ttl,
          urgency: 'high',
        })
        return { ok: true, attempts: attempt }
      } catch (err) {
        const status = err?.statusCode
        const isGone = status === 404 || status === 410
        if (isGone) {
          await deleteSubscriptionByEndpoint(subscription.endpoint)
          return { ok: false, reason: 'subscription_gone', status, attempts: attempt }
        }

        const isTransient = !status || status === 408 || status === 429 || status >= 500
        const canRetry = isTransient && attempt < PUSH_SEND_MAX_ATTEMPTS
        if (canRetry) {
          const delay = PUSH_SEND_BASE_DELAY_MS * Math.pow(2, attempt - 1)
          await sleep(delay)
          continue
        }

        console.warn('[web-push] sendNotification:', status || err?.message || err)
        return { ok: false, reason: 'send_failed', status, attempts: attempt }
      }
    }
    return { ok: false, reason: 'send_failed', attempts: PUSH_SEND_MAX_ATTEMPTS }
  } catch (err) {
    const status = err?.statusCode
    if (status === 404 || status === 410) {
      await deleteSubscriptionByEndpoint(subscription.endpoint)
      return { ok: false, reason: 'subscription_gone', status }
    }
    console.warn('[web-push] sendNotification:', status || err?.message || err)
    return { ok: false, reason: 'send_failed', status }
  }
}

module.exports = {
  ensureVapidConfigured,
  sendToSubscription,
  deleteSubscriptionByEndpoint,
  subscriptionFromRow,
}
