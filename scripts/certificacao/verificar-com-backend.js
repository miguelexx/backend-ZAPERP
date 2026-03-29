#!/usr/bin/env node
/**
 * Inicia o backend, aguarda ficar pronto, executa a verificação e encerra.
 * Uso: node scripts/certificacao/verificar-com-backend.js
 *
 * Útil quando não há outro terminal com o backend rodando.
 */

const path = require('path')
const { spawn } = require('child_process')
const http = require('http')

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true })
const PORT = process.env.PORT || 3000
const BASE_URL = `http://localhost:${PORT}`

function waitForBackend(maxWaitMs = 25000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    function tryOnce() {
      if (Date.now() - start > maxWaitMs) {
        return reject(new Error('Timeout: backend não iniciou'))
      }
      const req = http.request(
        { hostname: 'localhost', port: PORT, path: '/health', method: 'GET' },
        (res) => {
          let data = ''
          res.on('data', (c) => { data += c })
          res.on('end', () => {
            if (res.statusCode === 200) return resolve()
            setTimeout(tryOnce, 500)
          })
        }
      )
      req.on('error', () => setTimeout(tryOnce, 500))
      req.setTimeout(5000, () => { req.destroy(); setTimeout(tryOnce, 500) })
      req.end()
    }
    tryOnce()
  })
}

async function main() {
  console.log('🔄 Iniciando backend na porta', PORT, '...\n')
  const backend = spawn('node', ['index.js'], {
    cwd: path.join(__dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' }
  })
  let backendReady = false
  backend.stdout.on('data', (d) => {
    if (!backendReady && String(d).includes('rodando')) backendReady = true
  })
  backend.stderr.on('data', () => {})
  backend.on('error', (err) => {
    console.error('Erro ao iniciar backend:', err.message)
    process.exit(1)
  })
  try {
    await waitForBackend()
  } catch (e) {
    backend.kill('SIGTERM')
    console.error('❌ Backend não iniciou a tempo. Verifique erros no .env (JWT_SECRET, APP_URL, WHATSAPP_WEBHOOK_TOKEN).')
    process.exit(1)
  }
  console.log('✅ Backend pronto. Executando verificação...\n')
  const { spawn: spawnVerify } = require('child_process')
  const verify = spawnVerify('node', ['scripts/certificacao/verificar-sistema.js', BASE_URL], {
    cwd: path.join(__dirname, '..', '..'),
    stdio: 'inherit'
  })
  verify.on('close', (code) => {
    backend.kill('SIGTERM')
    setTimeout(() => { backend.kill('SIGKILL') }, 2000)
    process.exit(code || 0)
  })
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
