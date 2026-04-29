const supabase = require('../config/supabase')

function getPublicKey(req, res) {
  const pub = String(process.env.VAPID_PUBLIC_KEY || '').trim()
  if (!pub) {
    // Push não configurado — retorna 200 com enabled:false para não poluir o console do browser
    return res.status(200).json({ publicKey: null, enabled: false })
  }
  return res.json({ publicKey: pub, enabled: true })
}

/**
 * POST body: { endpoint, keys: { p256dh, auth } }
 */
async function subscribe(req, res) {
  try {
    const company_id = Number(req.user?.company_id)
    const usuario_id = Number(req.user?.id)
    const endpoint = String(req.body?.endpoint || '').trim()
    const p256dh = String(req.body?.keys?.p256dh || '').trim()
    const auth = String(req.body?.keys?.auth || '').trim()

    if (!Number.isFinite(company_id) || company_id <= 0 || !Number.isFinite(usuario_id) || usuario_id <= 0) {
      return res.status(400).json({ error: 'Sessão inválida' })
    }
    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({ error: 'Subscription incompleta' })
    }

    const ua = String(req.headers['user-agent'] || '').slice(0, 512)

    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        company_id,
        usuario_id,
        endpoint,
        p256dh,
        auth,
        user_agent: ua || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' }
    )

    if (error) {
      console.warn('[push] subscribe upsert:', error.message || error)
      return res.status(500).json({ error: 'Não foi possível salvar a subscription' })
    }

    return res.json({ ok: true })
  } catch (e) {
    console.warn('[push] subscribe:', e?.message || e)
    return res.status(500).json({ error: 'Erro interno' })
  }
}

/**
 * DELETE body: { endpoint }
 */
async function unsubscribe(req, res) {
  try {
    const company_id = Number(req.user?.company_id)
    const usuario_id = Number(req.user?.id)
    const endpoint = String(req.body?.endpoint || '').trim()

    if (
      !Number.isFinite(company_id) ||
      company_id <= 0 ||
      !Number.isFinite(usuario_id) ||
      usuario_id <= 0
    ) {
      return res.status(400).json({ error: 'Sessão inválida' })
    }
    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint obrigatório' })
    }

    await supabase
      .from('push_subscriptions')
      .delete()
      .eq('company_id', company_id)
      .eq('usuario_id', usuario_id)
      .eq('endpoint', endpoint)

    return res.json({ ok: true })
  } catch (e) {
    console.warn('[push] unsubscribe:', e?.message || e)
    return res.status(500).json({ error: 'Erro interno' })
  }
}

async function sendTestPush(req, res) {
  try {
    const company_id = Number(req.user?.company_id)
    const usuario_id = Number(req.user?.id)
    if (!Number.isFinite(company_id) || company_id <= 0 || !Number.isFinite(usuario_id) || usuario_id <= 0) {
      return res.status(400).json({ error: 'Sessão inválida' })
    }

    const webPushService = require('../services/webPushService')
    if (!webPushService.ensureVapidConfigured()) {
      return res.status(503).json({ error: 'Web push não configurado no servidor' })
    }

    const { data: rows, error } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('company_id', company_id)
      .eq('usuario_id', usuario_id)

    if (error) {
      console.warn('[push] test subscriptions:', error.message || error)
      return res.status(500).json({ error: 'Falha ao carregar subscriptions' })
    }

    const subs = (rows || []).map(webPushService.subscriptionFromRow).filter(Boolean)
    if (subs.length === 0) {
      return res.status(404).json({ error: 'Nenhuma subscription ativa para este usuário' })
    }

    const nowIso = new Date().toISOString()
    const payload = JSON.stringify({
      title: 'Teste de notificação',
      body: 'Se você recebeu, o push em background está ativo.',
      tag: `push-test-${usuario_id}`,
      renotify: true,
      requireInteraction: true,
      priority: 'high',
      data: {
        type: 'push_test',
        sentAt: nowIso,
        openUrl: '/atendimento',
        url: '/atendimento',
      },
    })

    let sent = 0
    let failed = 0
    for (const sub of subs) {
      const result = await webPushService.sendToSubscription(sub, payload)
      if (result?.ok) sent += 1
      else failed += 1
    }

    return res.json({
      ok: sent > 0,
      sent,
      failed,
      subscriptions: subs.length,
      sentAt: nowIso,
    })
  } catch (e) {
    console.warn('[push] sendTestPush:', e?.message || e)
    return res.status(500).json({ error: 'Erro interno' })
  }
}

module.exports = {
  getPublicKey,
  subscribe,
  unsubscribe,
  sendTestPush,
}
