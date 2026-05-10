/**
 * Classifica o campo `token` de /api/push/tokens: PushSubscription.toJSON() (Web Push/VAPID)
 * vs token FCM (string opaca).
 */

function looksLikeWebPushSubscriptionObject(o) {
  return (
    o &&
    typeof o === 'object' &&
    !Array.isArray(o) &&
    typeof o.endpoint === 'string' &&
    String(o.endpoint).trim().length > 0 &&
    o.keys &&
    typeof o.keys === 'object' &&
    typeof o.keys.p256dh === 'string' &&
    String(o.keys.p256dh).trim().length > 0 &&
    typeof o.keys.auth === 'string' &&
    String(o.keys.auth).trim().length > 0
  )
}

/**
 * @returns {{ kind: 'empty' }
 *   | { kind: 'invalid_json_shape' }
 *   | { kind: 'web_push', endpoint: string, p256dh: string, auth: string }
 *   | { kind: 'fcm', token: string }}
 */
function classifyIncomingPushToken(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { kind: 'empty' }
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s)
      if (looksLikeWebPushSubscriptionObject(o)) {
        return {
          kind: 'web_push',
          endpoint: String(o.endpoint).trim(),
          p256dh: String(o.keys.p256dh).trim(),
          auth: String(o.keys.auth).trim(),
        }
      }
      return { kind: 'invalid_json_shape' }
    } catch {
      return { kind: 'fcm', token: s }
    }
  }
  return { kind: 'fcm', token: s }
}

function isWebPushSubscriptionJsonString(raw) {
  return classifyIncomingPushToken(raw).kind === 'web_push'
}

module.exports = {
  classifyIncomingPushToken,
  looksLikeWebPushSubscriptionObject,
  isWebPushSubscriptionJsonString,
}
