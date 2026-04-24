/**
 * Envio Web Push (VAPID). Credenciais apenas no servidor.
 */
const webpush = require('web-push')
const supabase = require('../config/supabase')

let configured = false

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
  try {
    await webpush.sendNotification(subscription, payloadUtf8, {
      TTL: 120,
      urgency: 'high',
    })
    return { ok: true }
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
