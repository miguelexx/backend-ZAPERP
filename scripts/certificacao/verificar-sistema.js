#!/usr/bin/env node
/**
 * Script de certificação: verifica se o sistema está funcionando conforme a revisão completa.
 * Uso: node scripts/certificacao/verificar-sistema.js [BASE_URL]
 * Ex:  node scripts/certificacao/verificar-sistema.js http://localhost:5000
 * Ex:  node scripts/certificacao/verificar-sistema.js https://zaperpapi.wmsistemas.inf.br
 *
 * Carrega .env do backend automaticamente. APP_URL é usado se nenhum argumento for passado.
 *
 * Verifica:
 * - Health básico e detalhado
 * - Webhook Z-API health
 * - Rotas críticas (chats, clientes, webhooks)
 * - Variáveis de ambiente obrigatórias
 */

const path = require('path')
const https = require('https')
const http = require('http')

// Carrega .env do backend (scripts/certificacao → backend/.env)
const envPath = path.join(__dirname, '..', '..', '.env')
require('dotenv').config({ path: envPath, override: true })

const BASE_URL = process.argv[2] || process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`
const TIMEOUT_MS = 10000

const results = { ok: true, checks: [], errors: [] }

function addCheck(name, pass, detail) {
  results.checks.push({ name, pass, detail: detail || null })
  if (!pass) results.ok = false
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const lib = urlObj.protocol === 'https:' ? https : http
    const opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      rejectUnauthorized: true
    }
    const req = lib.request(opts, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let json = null
        try {
          json = data ? JSON.parse(data) : null
        } catch (_) {}
        resolve({ status: res.statusCode, json, ok: res.statusCode >= 200 && res.statusCode < 400 })
      })
    })
    req.on('error', (err) => reject(err))
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error('Timeout'))
    })
    req.end()
  })
}

async function main() {
  console.log('=== Verificação do sistema WhatsApp Plataforma ===\n')
  console.log(`Base URL: ${BASE_URL}\n`)

  // 1. Health básico
  try {
    const r = await fetchJSON(`${BASE_URL}/health`)
    addCheck('GET /health', r.ok && r.json?.ok === true, r.json ? 'ok' : `status ${r.status}`)
  } catch (e) {
    const msg = e.code === 'ECONNREFUSED' ? 'conexão recusada (backend off?)' : (e.code === 'ENOTFOUND' ? 'host não encontrado' : (e.message || 'erro'))
    addCheck('GET /health', false, msg)
  }

  // 2. Health detalhado (Supabase)
  try {
    const r = await fetchJSON(`${BASE_URL}/health/detailed`)
    const dbOk = r.json?.checks?.supabase === true
    addCheck('GET /health/detailed (Supabase)', r.ok && dbOk, dbOk ? 'conectado' : (r.json?.checks?.supabase_error || 'erro'))
  } catch (e) {
    const msg = e.code === 'ECONNREFUSED' ? 'conexão recusada' : (e.message || 'erro')
    addCheck('GET /health/detailed', false, msg)
  }

  // 3. Webhook UltraMsg health
  try {
    const r = await fetchJSON(`${BASE_URL}/webhooks/ultramsg/health`)
    const webhookOk = r.ok && r.json?.ok === true
    addCheck('GET /webhooks/ultramsg/health', webhookOk, r.json ? 'ok' : `status ${r.status}`)
  } catch (e) {
    const msg = e.code === 'ECONNREFUSED' ? 'conexão recusada' : (e.message || 'erro')
    addCheck('GET /webhooks/ultramsg/health', false, msg)
  }

  // 4. Variáveis de ambiente (via debug/env se não produção)
  const isProd = process.env.NODE_ENV === 'production'
  if (!isProd) {
    try {
      const r = await fetchJSON(`${BASE_URL}/debug/env`)
      const tokenSet = r.json?.WEBHOOK_TOKEN_SET === true
      addCheck('WHATSAPP_WEBHOOK_TOKEN configurado', tokenSet, tokenSet ? 'sim' : 'não (debug env)')
    } catch (_) {
      addCheck('WHATSAPP_WEBHOOK_TOKEN', null, 'não verificado (endpoint /debug/env só em dev)')
    }
  }

  // 5. Rotas existem (404 = rota não encontrada; 401 = precisa auth = rota existe)
  for (const [pathName, expectedStatus] of [
    ['/chats', [200, 401]],
    ['/clientes', [200, 401]],
    ['/dashboard/departamentos', [200, 401]],
    ['/webhooks/ultramsg', [200]],
  ]) {
    try {
      const r = await fetchJSON(`${BASE_URL}${pathName}`)
      const ok = expectedStatus.includes(r.status)
      addCheck(`Rota ${pathName}`, ok, `status ${r.status}`)
    } catch (e) {
      const msg = e.code === 'ECONNREFUSED' ? 'conexão recusada' : (e.message || 'erro')
      addCheck(`Rota ${pathName}`, false, msg)
    }
  }

  // Saída
  console.log('--- Resultados ---\n')
  for (const c of results.checks) {
    const icon = c.pass === true ? '✅' : (c.pass === false ? '❌' : '⚠️')
    console.log(`${icon} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  console.log('')
  if (results.ok) {
    console.log('✅ Todos os checks críticos passaram.')
  } else {
    const allConnectionFailed = results.checks.filter(c => c.pass === false).every(c =>
      c.detail?.includes('conexão recusada') || c.detail?.includes('Timeout') || c.detail?.includes('host não encontrado')
    )
    if (allConnectionFailed) {
      console.log('❌ Não foi possível conectar ao backend.')
      console.log('')
      console.log('💡 Dicas:')
      try {
        const u = new URL(BASE_URL)
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
          const port = u.port || (u.protocol === 'https:' ? 443 : 80)
          console.log(`   • Backend local: npm run dev (em outro terminal) — porta ${port}`)
          console.log('   • OU use: npm run cert:verificar:local (inicia backend, verifica e encerra)')
        } else {
          console.log('   • Verifique se o servidor remoto está online e acessível')
        }
      } catch (_) {}
      console.log('   • Teste remoto: node scripts/certificacao/verificar-sistema.js https://zaperpapi.wmsistemas.inf.br')
      console.log('   • Verifique firewall/proxy se o host for remoto')
    } else {
      console.log('❌ Alguns checks falharam. Revise a configuração.')
    }
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('Erro:', e.message || e)
  process.exit(1)
})
