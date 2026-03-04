#!/usr/bin/env node
/**
 * Script de teste: multi-tenant Z-API + login + webhook
 * Uso: node scripts/test-multi-tenant-zapi.js
 *
 * Env:
 *   BASE_URL          - ex: http://localhost:3000
 *   COMPANY1_EMAIL   - usuário company_id=1
 *   COMPANY1_SENHA   - senha
 *   COMPANY2_EMAIL   - usuário company_id=2
 *   ADMIN_EMAIL      - admin da company 2 (para reset senha)
 *   ADMIN_SENHA      - senha do admin
 *   INSTANCE_ID_C1   - instance_id da empresa 1 (empresa_zapi) para simular webhook
 *   ZAPI_WEBHOOK_TOKEN - token do webhook (obrigatório para POST /webhooks/zapi)
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const API_BASE = `${BASE_URL}/api`
const WEBHOOK_TOKEN = process.env.ZAPI_WEBHOOK_TOKEN || ''

function log(msg, type = 'info') {
  const colors = { info: '\x1b[36m', ok: '\x1b[32m', err: '\x1b[31m', warn: '\x1b[33m' }
  console.log(`${colors[type] || ''}${msg}\x1b[0m`)
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8')
    return JSON.parse(payload)
  } catch {
    return null
  }
}

async function run() {
  log('\n=== TESTE MULTI-TENANT Z-API ===\n', 'info')

  // 1) Login company 1
  log('1) Login company 1', 'info')
  const c1Email = process.env.COMPANY1_EMAIL
  const c1Senha = process.env.COMPANY1_SENHA
  let token1 = null
  if (c1Email && c1Senha) {
    try {
      const res = await fetch(`${API_BASE}/usuarios/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: c1Email, senha: c1Senha })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        log(`   HTTP ${res.status} - ${data.error || res.statusText} (verifique senha bcrypt)`, 'err')
      } else {
        token1 = data.token
        const payload = decodeJwtPayload(token1)
        const cid = payload?.company_id
        log(`   OK - company_id=${cid}`, 'ok')
      }
    } catch (e) {
      log(`   Erro: ${e.message}`, 'err')
    }
  } else {
    log('   Defina COMPANY1_EMAIL e COMPANY1_SENHA', 'warn')
  }

  // 2) debug-config company 1
  if (token1) {
    log('\n2) GET /api/integrations/zapi/debug-config (company 1)', 'info')
    try {
      const res = await fetch(`${API_BASE}/integrations/zapi/debug-config`, {
        headers: { 'Authorization': `Bearer ${token1}` }
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        log(`   hasInstance=${data.hasInstance}, instance_id=${data.instance_id ?? 'null'}, tokensMasked=${data.tokensMasked}`, 'ok')
        if (data.instance_id && (data.instance_token || data.client_token)) {
          log('   VAZAMENTO: tokens expostos!', 'err')
        }
      } else {
        log(`   HTTP ${res.status} - ${data.error || ''}`, 'err')
      }
    } catch (e) {
      log(`   Erro: ${e.message}`, 'err')
    }
  }

  // 3) debug-status company 1
  if (token1) {
    log('\n3) GET /api/integrations/zapi/debug-status (company 1)', 'info')
    try {
      const res = await fetch(`${API_BASE}/integrations/zapi/debug-status`, {
        headers: { 'Authorization': `Bearer ${token1}` }
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        log(`   connected=${data.connected}, smartphoneConnected=${data.smartphoneConnected}, needsRestore=${data.needsRestore}, error=${data.error ?? 'null'}`, 'ok')
      } else {
        log(`   HTTP ${res.status}`, 'err')
      }
    } catch (e) {
      log(`   Erro: ${e.message}`, 'err')
    }
  }

  // 4) Login company 2
  log('\n4) Login company 2', 'info')
  const c2Email = process.env.COMPANY2_EMAIL
  const c2Senha = process.env.COMPANY2_SENHA
  const adminEmail = process.env.ADMIN_EMAIL
  const adminSenha = process.env.ADMIN_SENHA
  let token2 = null
  let adminToken = null
  if (c2Email && c2Senha) {
    try {
      const res = await fetch(`${API_BASE}/usuarios/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: c2Email, senha: c2Senha })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        log(`   HTTP ${res.status} - ${data.error || res.statusText}`, 'err')
        log('   Se 401: use POST /usuarios/resetar-senha-email com admin', 'warn')
        if (adminEmail && adminSenha) {
          const ar = await fetch(`${API_BASE}/usuarios/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: adminEmail, senha: adminSenha })
          })
          const ad = await ar.json().catch(() => ({}))
          if (ar.ok && ad.token) {
            adminToken = ad.token
            const p = decodeJwtPayload(adminToken)
            if (p?.company_id === 2) {
              log('   Admin company 2 logado. Chamando resetar-senha-email...', 'info')
              const rr = await fetch(`${API_BASE}/usuarios/resetar-senha-email`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: c2Email, nova_senha: c2Senha })
              })
              const rrd = await rr.json().catch(() => ({}))
              if (rr.ok && rrd.ok) {
                log('   Senha resetada. Tentando login novamente...', 'ok')
                const lr = await fetch(`${API_BASE}/usuarios/login`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ email: c2Email, senha: c2Senha })
                })
                const lrd = await lr.json().catch(() => ({}))
                if (lr.ok && lrd.token) {
                  token2 = lrd.token
                  log(`   Login OK após reset - company_id=${decodeJwtPayload(token2)?.company_id}`, 'ok')
                }
              }
            }
          }
        }
      } else {
        token2 = data.token
        log(`   OK - company_id=${decodeJwtPayload(token2)?.company_id}`, 'ok')
      }
    } catch (e) {
      log(`   Erro: ${e.message}`, 'err')
    }
  } else {
    log('   Defina COMPANY2_EMAIL e COMPANY2_SENHA', 'warn')
  }

  // 5) Simular webhook
  const instanceId = process.env.INSTANCE_ID_C1
  log('\n5) POST /webhooks/zapi (simular webhook)', 'info')
  if (!instanceId) {
    log('   Defina INSTANCE_ID_C1 (instance_id da empresa 1)', 'warn')
  } else if (!WEBHOOK_TOKEN) {
    log('   Defina ZAPI_WEBHOOK_TOKEN', 'warn')
  } else {
    try {
      const url = `${BASE_URL}/webhooks/zapi?token=${encodeURIComponent(WEBHOOK_TOKEN)}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId,
          type: 'ReceivedCallback',
          phone: '5511999999999',
          text: { message: '(teste script)' }
        })
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 200) {
        log(`   HTTP 200 - ok=${data.ok}, ignored=${data.ignored ?? 'N/A'}`, 'ok')
      } else if (res.status === 401) {
        log(`   HTTP 401 - token inválido`, 'err')
      } else {
        log(`   HTTP ${res.status} - ${JSON.stringify(data)}`, 'warn')
      }
    } catch (e) {
      log(`   Erro: ${e.message}`, 'err')
    }
  }

  log('\n6) GET /webhooks/zapi/health (público)', 'info')
  try {
    const res = await fetch(`${BASE_URL}/webhooks/zapi/health`)
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.ok) {
      log('   HTTP 200 { ok: true }', 'ok')
    } else {
      log(`   HTTP ${res.status}`, 'warn')
    }
  } catch (e) {
    log(`   Erro: ${e.message}`, 'err')
  }

  log('\n=== FIM ===', 'ok')
  log('Checklist: Company 2 login (reset bcrypt) | Company 1 status/qr via empresa_zapi | Webhook por instanceId', 'info')
}

run()
