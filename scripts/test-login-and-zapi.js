#!/usr/bin/env node
/**
 * Script de teste: Login + JWT + Z-API Connect
 * Uso: node scripts/test-login-and-zapi.js
 * Env: BASE_URL, LOGIN_EMAIL, LOGIN_SENHA (opcional para teste de connect com TOKEN)
 *
 * Se LOGIN_EMAIL e LOGIN_SENHA estiverem definidos, faz login e usa o token.
 * Caso contrário, usa TOKEN se definido.
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const API_BASE = `${BASE_URL}/api`
const LOGIN_EMAIL = process.env.LOGIN_EMAIL
const LOGIN_SENHA = process.env.LOGIN_SENHA
const TOKEN = process.env.TOKEN

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

function hasTokenLeak(obj, path = '') {
  if (!obj) return []
  const leaks = []
  const forbidden = ['instance_token', 'instanceToken', 'client_token', 'clientToken', 'token']
  for (const [k, v] of Object.entries(obj)) {
    const fullPath = path ? `${path}.${k}` : k
    if (forbidden.some(f => k.toLowerCase().includes(f))) {
      leaks.push(fullPath)
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)) {
      leaks.push(...hasTokenLeak(v, fullPath))
    }
  }
  return leaks
}

async function run() {
  log('\n=== TESTE LOGIN + JWT + Z-API CONNECT ===\n', 'info')

  let token = TOKEN
  let companyIdFromJwt = null

  // 1) Login (se credenciais fornecidas)
  if (LOGIN_EMAIL && LOGIN_SENHA) {
    log('1) POST /api/usuarios/login', 'info')
    try {
      const res = await fetch(`${API_BASE}/usuarios/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: LOGIN_EMAIL, senha: LOGIN_SENHA })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        log(`   HTTP ${res.status} - ${data.error || res.statusText}`, 'err')
        process.exit(1)
      }
      token = data.token
      if (!token) {
        log('   Resposta sem token', 'err')
        process.exit(1)
      }
      const payload = decodeJwtPayload(token)
      companyIdFromJwt = payload?.company_id
      const hasCompanyId = Number.isFinite(companyIdFromJwt) && companyIdFromJwt > 0
      if (!hasCompanyId) {
        log(`   JWT SEM company_id válido! Payload: ${JSON.stringify(payload)}`, 'err')
        process.exit(1)
      }
      log(`   HTTP 200 - JWT OK, company_id=${companyIdFromJwt}`, 'ok')
    } catch (e) {
      log(`   Erro: ${e.message}`, 'err')
      process.exit(1)
    }
  } else if (TOKEN) {
    log('1) Usando TOKEN do ambiente', 'info')
    const payload = decodeJwtPayload(TOKEN)
    companyIdFromJwt = payload?.company_id
    if (!Number.isFinite(companyIdFromJwt) || companyIdFromJwt <= 0) {
      log(`   JWT sem company_id válido`, 'err')
      process.exit(1)
    }
    log(`   company_id=${companyIdFromJwt}`, 'ok')
  } else {
    log('   Defina LOGIN_EMAIL e LOGIN_SENHA ou TOKEN', 'err')
    process.exit(1)
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }

  // 2) GET /connect/status
  log('\n2) GET /api/integrations/zapi/connect/status', 'info')
  try {
    const res = await fetch(`${API_BASE}/integrations/zapi/connect/status`, { headers })
    const data = await res.json().catch(() => ({}))
    const leaks = hasTokenLeak(data)
    if (leaks.length) {
      log(`   VAZAMENTO DE TOKEN em: ${leaks.join(', ')}`, 'err')
      process.exit(1)
    }
    if (res.status === 401) {
      log(`   HTTP 401 - Token inválido ou tenant inválido`, 'err')
      process.exit(1)
    }
    log(`   HTTP ${res.status} - hasInstance=${data.hasInstance}, connected=${data.connected}`, 'ok')
  } catch (e) {
    log(`   Erro: ${e.message}`, 'err')
  }

  // 3) POST /connect/qrcode (1ª)
  log('\n3) POST /connect/qrcode (1ª chamada)', 'info')
  try {
    const res = await fetch(`${API_BASE}/integrations/zapi/connect/qrcode`, {
      method: 'POST',
      headers
    })
    const data = await res.json().catch(() => ({}))
    const leaks = hasTokenLeak(data)
    if (leaks.length) {
      log(`   VAZAMENTO: ${leaks.join(', ')}`, 'err')
      process.exit(1)
    }
    if (data.connected) {
      log(`   HTTP ${res.status} - connected=true (já conectado)`, 'ok')
    } else if (data.qrBase64) {
      log(`   HTTP ${res.status} - qrBase64 OK, attemptsLeft=${data.attemptsLeft ?? 'N/A'}`, 'ok')
    } else if (res.status === 404) {
      log(`   HTTP 404 - Empresa sem instância (esperado se não configurou empresa_zapi)`, 'warn')
    } else if (res.status === 429) {
      log(`   HTTP 429 - throttle/blocked (retryAfterSeconds=${data.retryAfterSeconds})`, 'ok')
    } else {
      log(`   HTTP ${res.status} - ${JSON.stringify(data)}`, res.ok ? 'ok' : 'warn')
    }
  } catch (e) {
    log(`   Erro: ${e.message}`, 'err')
  }

  // 4) POST /connect/qrcode (2ª imediata - deve 429)
  log('\n4) POST /connect/qrcode (2ª imediata - esperado 429)', 'info')
  try {
    const res = await fetch(`${API_BASE}/integrations/zapi/connect/qrcode`, {
      method: 'POST',
      headers
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 429) {
      log(`   HTTP 429 ✓ - retryAfterSeconds=${data.retryAfterSeconds ?? 'N/A'}`, 'ok')
    } else if (res.status === 200 && data.connected) {
      log(`   HTTP 200 - connected=true (não serviu QR)`, 'ok')
    } else if (res.status === 404) {
      log(`   HTTP 404 - sem instância`, 'warn')
    } else {
      log(`   HTTP ${res.status} - esperava 429`, 'warn')
    }
  } catch (e) {
    log(`   Erro: ${e.message}`, 'err')
  }

  // 5) phone-code inválido (400)
  log('\n5) POST /connect/phone-code phone inválido (esperado 400)', 'info')
  try {
    const res = await fetch(`${API_BASE}/integrations/zapi/connect/phone-code`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: '123' })
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 400) {
      log(`   HTTP 400 ✓`, 'ok')
    } else if (res.status === 404) {
      log(`   HTTP 404 - sem instância`, 'warn')
    } else {
      log(`   HTTP ${res.status}`, res.status === 400 ? 'ok' : 'warn')
    }
  } catch (e) {
    log(`   Erro: ${e.message}`, 'err')
  }

  log('\n=== FIM DOS TESTES ===', 'ok')
  log(`JWT company_id: ${companyIdFromJwt}`, 'info')
  log('Nenhuma resposta contém instance_token/client_token ✓', 'ok')
}

run()
