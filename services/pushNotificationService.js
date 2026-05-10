/**
 * Envio de notificações via Firebase Cloud Messaging (Admin SDK).
 * Credenciais apenas no servidor (FIREBASE_SERVICE_ACCOUNT_JSON ou FIREBASE_SERVICE_ACCOUNT_PATH).
 */
const fs = require('fs')
const path = require('path')
const supabase = require('../config/supabase')
const { classifyIncomingPushToken } = require('../helpers/pushTokenFormat')

let adminRef = null
let initAttempted = false
let initOk = false

function safeLog(prefix, obj) {
  try {
    console.log(prefix, typeof obj === 'string' ? obj : JSON.stringify(obj))
  } catch (_) {
    console.log(prefix)
  }
}

function parseServiceAccount() {
  const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim()
  const rawPath = String(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim()
  if (rawJson) {
    try {
      return JSON.parse(rawJson)
    } catch (_) {
      try {
        const decoded = Buffer.from(rawJson, 'base64').toString('utf8')
        return JSON.parse(decoded)
      } catch (e2) {
        console.warn('[fcm] FIREBASE_SERVICE_ACCOUNT_JSON inválido (não é JSON nem base64 JSON):', e2?.message || e2)
        return null
      }
    }
  }
  if (rawPath) {
    const abs = path.isAbsolute(rawPath) ? rawPath : path.join(__dirname, '..', rawPath)
    if (!fs.existsSync(abs)) {
      console.warn('[fcm] FIREBASE_SERVICE_ACCOUNT_PATH não encontrado:', abs)
      return null
    }
    try {
      return JSON.parse(fs.readFileSync(abs, 'utf8'))
    } catch (e) {
      console.warn('[fcm] Falha ao ler service account:', e?.message || e)
      return null
    }
  }
  return null
}

function ensureFirebase() {
  if (initAttempted) return initOk
  initAttempted = true
  const sa = parseServiceAccount()
  if (!sa) {
    return false
  }
  try {
    const admin = require('firebase-admin')
    if (admin.apps.length > 0) {
      adminRef = admin
      initOk = true
      return true
    }
    admin.initializeApp({
      credential: admin.credential.cert(sa),
    })
    adminRef = admin
    initOk = true
    safeLog('[fcm]', { ok: true, msg: 'Firebase Admin inicializado' })
    return true
  } catch (e) {
    console.warn('[fcm] Falha ao inicializar Firebase Admin:', e?.message || e)
    initOk = false
    return false
  }
}

function isInvalidTokenError(err) {
  const code = String(err?.code || err?.errorInfo?.code || '')
  return (
    code.includes('registration-token-not-registered') ||
    code.includes('invalid-registration-token')
  )
}

async function deactivateTokens(tokens) {
  const list = [...new Set((tokens || []).map((t) => String(t || '').trim()).filter(Boolean))]
  if (list.length === 0) return
  const { error } = await supabase.from('push_tokens').update({ ativo: false, atualizado_em: new Date().toISOString() }).in('token', list)
  if (error) console.warn('[fcm] desativar tokens:', error.message || error)
  else safeLog('[fcm]', { tokens_desativados: list.length })
}

async function markTokensUsed(okTokens, empresa_id) {
  const list = [...new Set((okTokens || []).map((t) => String(t || '').trim()).filter(Boolean))]
  if (list.length === 0) return
  const now = new Date().toISOString()
  await supabase
    .from('push_tokens')
    .update({ ultimo_uso_em: now, atualizado_em: now })
    .eq('empresa_id', Number(empresa_id))
    .in('token', list)
}

async function fetchActiveTokens(empresa_id, usuario_id) {
  const { data, error } = await supabase
    .from('push_tokens')
    .select('token')
    .eq('empresa_id', Number(empresa_id))
    .eq('usuario_id', Number(usuario_id))
    .eq('ativo', true)

  if (error) {
    console.warn('[fcm] fetch tokens:', error.message || error)
    return []
  }
  return (data || [])
    .map((r) => r.token)
    .filter(Boolean)
    .filter((t) => classifyIncomingPushToken(t).kind !== 'web_push')
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Envia notificação FCM para um atendente (todos os tokens ativos).
 * Não lança exceção para o chamador — falhas só em log.
 */
async function sendNovaMensagemToUser({
  empresa_id,
  usuario_id,
  conversa_id,
  mensagem_id,
  nomeCliente,
}) {
  if (!ensureFirebase()) return
  const cid = Number(empresa_id)
  const uid = Number(usuario_id)
  const convId = Number(conversa_id)
  const mid = mensagem_id != null ? String(mensagem_id) : ''
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(uid) || uid <= 0) return
  if (!Number.isFinite(convId) || convId <= 0 || !mid) return

  const tokens = await fetchActiveTokens(cid, uid)
  if (tokens.length === 0) return

  const nome = String(nomeCliente || 'Cliente').trim() || 'Cliente'
  const admin = adminRef
  const messaging = admin.messaging()

  const title = 'ZapERP'
  const body = `Nova mensagem de ${nome}`
  const urlPath = `/atendimento?conversa=${encodeURIComponent(String(convId))}`
  const dataPayload = {
    tipo: 'nova_mensagem',
    conversa_id: String(convId),
    mensagem_id: mid,
    empresa_id: String(cid),
    url: urlPath,
  }

  safeLog('[fcm]', {
    evento: 'envio_nova_mensagem',
    empresa_id: cid,
    usuario_id: uid,
    conversa_id: convId,
    mensagem_id: mid,
    tokens: tokens.length,
  })

  const invalid = []
  const successTokens = []

  for (const batch of chunk(tokens, 500)) {
    try {
      const res = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        data: dataPayload,
        android: { priority: 'high', notification: { channelId: 'zaperp-messages', sound: 'default' } },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', category: 'NEW_MESSAGE' } },
        },
        webpush: {
          headers: { Urgency: 'high' },
          notification: { title, body },
        },
      })

      res.responses.forEach((r, i) => {
        const tok = batch[i]
        if (r.success) {
          successTokens.push(tok)
          return
        }
        const err = r.error
        console.warn('[fcm] falha token:', err?.code || err?.message || err)
        if (err && isInvalidTokenError(err)) invalid.push(tok)
      })
    } catch (e) {
      console.warn('[fcm] sendEachForMulticast:', e?.message || e)
    }
  }

  if (successTokens.length) {
    safeLog('[fcm]', { ok: true, enviados: successTokens.length, empresa_id: cid, usuario_id: uid })
    await markTokensUsed(successTokens, cid)
  }
  if (invalid.length) await deactivateTokens(invalid)
}

async function sendTransferenciaToUser({
  empresa_id,
  usuario_id,
  conversa_id,
  nomeCliente,
  transferido_por_nome,
}) {
  if (!ensureFirebase()) return
  const cid = Number(empresa_id)
  const uid = Number(usuario_id)
  const convId = Number(conversa_id)
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(uid) || uid <= 0) return
  if (!Number.isFinite(convId) || convId <= 0) return

  const tokens = await fetchActiveTokens(cid, uid)
  if (tokens.length === 0) return

  const cliente = String(nomeCliente || '').trim()
  const from = String(transferido_por_nome || 'Um colega').trim()
  const title = 'ZapERP'
  const body = cliente
    ? `${from} transferiu «${cliente}» para você`
    : `${from} transferiu um atendimento para você`

  const admin = adminRef
  const messaging = admin.messaging()
  const urlPath = `/atendimento?conversa=${encodeURIComponent(String(convId))}`
  const dataPayload = {
    tipo: 'conversa_transferida',
    conversa_id: String(convId),
    empresa_id: String(cid),
    url: urlPath,
  }

  safeLog('[fcm]', { evento: 'envio_transferencia', empresa_id: cid, usuario_id: uid, conversa_id: convId, tokens: tokens.length })

  const invalid = []
  const successTokens = []

  for (const batch of chunk(tokens, 500)) {
    try {
      const res = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        data: dataPayload,
        android: { priority: 'high' },
        apns: { headers: { 'apns-priority': '10' } },
        webpush: { headers: { Urgency: 'high' }, notification: { title, body } },
      })
      res.responses.forEach((r, i) => {
        const tok = batch[i]
        if (r.success) {
          successTokens.push(tok)
          return
        }
        const err = r.error
        console.warn('[fcm] falha token (transfer):', err?.code || err?.message || err)
        if (err && isInvalidTokenError(err)) invalid.push(tok)
      })
    } catch (e) {
      console.warn('[fcm] transfer sendEachForMulticast:', e?.message || e)
    }
  }

  if (successTokens.length) {
    safeLog('[fcm]', { ok: true, transfer_ok: successTokens.length, empresa_id: cid, usuario_id: uid })
    await markTokensUsed(successTokens, cid)
  }
  if (invalid.length) await deactivateTokens(invalid)
}

function scheduleHandoffFcmPush(opts) {
  setImmediate(() => {
    sendTransferenciaToUser(opts).catch((e) => console.warn('[fcm] scheduleHandoff:', e?.message || e))
  })
}

module.exports = {
  ensureFirebase,
  sendNovaMensagemToUser,
  scheduleHandoffFcmPush,
}
