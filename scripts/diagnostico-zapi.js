/**
 * Diagnóstico Z-API — verifica configuração de webhooks e ativa notifySentByMe
 *
 * Uso:
 *   node scripts/diagnostico-zapi.js           (só diagnóstico)
 *   node scripts/diagnostico-zapi.js --fix     (diagnóstico + corrige webhooks)
 *   node scripts/diagnostico-zapi.js --fix --simular  (corrige + envia msg de teste)
 */

'use strict'

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const INSTANCE_ID    = process.env.ZAPI_INSTANCE_ID || ''
const TOKEN          = process.env.ZAPI_TOKEN || ''
const CLIENT_TOKEN   = process.env.ZAPI_CLIENT_TOKEN || ''
const BASE_URL       = (process.env.ZAPI_BASE_URL || 'https://api.z-api.io').replace(/\/$/, '')
const APP_URL        = (process.env.APP_URL || 'http://localhost:5000').replace(/\/$/, '')
const WEBHOOK_TOKEN  = process.env.ZAPI_WEBHOOK_TOKEN || ''
const LOCAL_URL      = 'http://localhost:' + (process.env.PORT || 5000)

const args           = process.argv.slice(2)
const FIX            = args.includes('--fix')
const SIMULAR        = args.includes('--simular')
const USAR_LOCAL     = args.includes('--local')

const BASE_PATH = `${BASE_URL}/instances/${INSTANCE_ID}/token/${TOKEN}`
const WEBHOOK_URL = USAR_LOCAL
  ? `${LOCAL_URL}/webhooks/zapi`
  : `${APP_URL}/webhooks/zapi${WEBHOOK_TOKEN ? `?token=${encodeURIComponent(WEBHOOK_TOKEN)}` : ''}`

function headers() {
  const h = { 'Content-Type': 'application/json' }
  if (CLIENT_TOKEN) h['Client-Token'] = CLIENT_TOKEN
  return h
}

async function zapiGet(endpoint) {
  try {
    const res = await fetch(`${BASE_PATH}${endpoint}`, { headers: headers() })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch (_) { json = text }
    return { ok: res.ok, status: res.status, data: json }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.message }
  }
}

async function zapiPut(endpoint, body) {
  try {
    const res = await fetch(`${BASE_PATH}${endpoint}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(body)
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch (_) { json = text }
    return { ok: res.ok, status: res.status, data: json }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.message }
  }
}

function ok(v)  { return v ? '✅' : '❌' }
function sec(s) { return String(s || '').slice(0, 6) + '…' }

// ─── Diagnóstico ─────────────────────────────────────────────────────────────
async function diagnosticar() {
  console.log('\n═══════════════════════════════════════════════════')
  console.log(' DIAGNÓSTICO Z-API — Webhooks & notifySentByMe')
  console.log('═══════════════════════════════════════════════════')
  console.log(` Instance:    ${INSTANCE_ID ? sec(INSTANCE_ID) : '❌ NÃO DEFINIDO'}`)
  console.log(` Token:       ${TOKEN ? '✅ definido' : '❌ NÃO DEFINIDO'}`)
  console.log(` ClientToken: ${CLIENT_TOKEN ? '✅ definido' : '⚠️  não definido (pode falhar)'}`)
  console.log(` APP_URL:     ${APP_URL}`)
  console.log(` Webhook URL: ${WEBHOOK_URL}`)
  console.log('')

  if (!INSTANCE_ID || !TOKEN) {
    console.error('❌ ZAPI_INSTANCE_ID e ZAPI_TOKEN são obrigatórios no .env')
    return null
  }

  // 1) Verificar conexão da instância
  console.log('▶ 1) Verificando status da instância...')
  const statusR = await zapiGet('/status')
  const connected = statusR.data?.connected === true || statusR.data?.status === 'connected' || statusR.data?.value === 'connected'
  console.log(`   ${ok(statusR.ok)} HTTP ${statusR.status}`)
  if (statusR.ok && statusR.data) {
    console.log(`   Status: ${JSON.stringify(statusR.data).slice(0, 150)}`)
  }
  if (!connected) {
    console.warn('   ⚠️  Instância pode estar DESCONECTADA. Verifique o painel Z-API.')
  }

  // 2) Verificar webhook "received" atual
  console.log('\n▶ 2) Verificando webhook "received" (mensagens recebidas)...')
  const whrR = await zapiGet('/webhook')
  const whrNotFound = whrR.status === 404 || String(whrR.data?.error || '').includes('NOT_FOUND')
  if (!whrNotFound && whrR.ok && whrR.data) {
    console.log(`   ${ok(true)} Webhook atual: ${JSON.stringify(whrR.data).slice(0, 300)}`)
    const receivedUrl = whrR.data?.received?.url || whrR.data?.url || whrR.data?.value || ''
    const notifyEnabled = whrR.data?.notifySentByMe === true || whrR.data?.received?.notifySentByMe === true
    console.log(`   URL recebida: "${receivedUrl}"`)
    console.log(`   notifySentByMe: ${notifyEnabled ? '✅ ATIVO' : '❌ INATIVO ← CAUSA DO PROBLEMA'}`)
    if (!notifyEnabled) {
      console.warn('\n   ⚠️  notifySentByMe está DESATIVADO!')
      console.warn('   Isso significa que mensagens enviadas pelo CELULAR não chegam ao sistema.')
      console.warn('   Execute com --fix para corrigir automaticamente.\n')
    }
  } else {
    console.log('   ℹ️  GET /webhook → NOT_FOUND (esta versão da Z-API não expõe config via GET)')
    console.log('   Use --fix para aplicar/reaplicar a configuração via PUT.')
  }

  // 3) Verificar notifySentByMe específico
  console.log('\n▶ 3) Verificando notifySentByMe...')
  const nsbmR = await zapiGet('/notify-sent-by-me')
  const nsbmNotFound = nsbmR.status === 404 || String(nsbmR.data?.error || '').includes('NOT_FOUND')
  if (nsbmNotFound) {
    console.log('   ℹ️  GET /notify-sent-by-me → NOT_FOUND (esta versão da Z-API não expõe o estado via GET)')
    console.log('   Use --fix para garantir que está ativado via PUT.')
    return { connected, notifySentByMe: null }
  } else if (nsbmR.ok && nsbmR.data != null) {
    const active = nsbmR.data?.value === true || nsbmR.data?.notifySentByMe === true || nsbmR.data === true
    console.log(`   ${ok(active)} notifySentByMe: ${active ? 'ATIVO' : 'INATIVO'}`)
    console.log(`   Resposta: ${JSON.stringify(nsbmR.data).slice(0, 200)}`)
    return { connected, notifySentByMe: active }
  } else {
    console.log(`   HTTP ${nsbmR.status}: ${JSON.stringify(nsbmR.data || nsbmR.error || '').slice(0, 100)}`)
    console.log('   (Endpoint pode não estar disponível nesta versão da Z-API)')
    return { connected, notifySentByMe: null }
  }
}

// ─── Corrigir webhooks ────────────────────────────────────────────────────────
async function corrigirWebhooks() {
  console.log('\n═══════════════════════════════════════════════════')
  console.log(' CORRIGINDO WEBHOOKS Z-API')
  console.log('═══════════════════════════════════════════════════')
  console.log(` Webhook URL: ${WEBHOOK_URL}`)
  console.log('')

  const STATUS_URL   = USAR_LOCAL
    ? `${LOCAL_URL}/webhooks/zapi/status`
    : `${APP_URL}/webhooks/zapi/status${WEBHOOK_TOKEN ? `?token=${encodeURIComponent(WEBHOOK_TOKEN)}` : ''}`
  const CONN_URL     = USAR_LOCAL
    ? `${LOCAL_URL}/webhooks/zapi/connection`
    : `${APP_URL}/webhooks/zapi/connection${WEBHOOK_TOKEN ? `?token=${encodeURIComponent(WEBHOOK_TOKEN)}` : ''}`
  const PRESENCE_URL = USAR_LOCAL
    ? `${LOCAL_URL}/webhooks/zapi/presence`
    : `${APP_URL}/webhooks/zapi/presence${WEBHOOK_TOKEN ? `?token=${encodeURIComponent(WEBHOOK_TOKEN)}` : ''}`

  // Lista de configurações para tentar
  const configs = [
    {
      label: 'received (+ notifySentByMe)',
      candidates: ['/update-webhook-received', '/update-on-message-received'],
      body: { value: WEBHOOK_URL, notifySentByMe: true }
    },
    {
      label: 'delivery',
      candidates: ['/update-webhook-delivery', '/update-on-message-delivery'],
      body: { value: WEBHOOK_URL }
    },
    {
      label: 'status (leitura/entrega)',
      candidates: ['/update-on-message-status', '/update-webhook-status'],
      body: { value: STATUS_URL }
    },
    {
      label: 'connected',
      candidates: ['/update-webhook-connected', '/update-on-connected'],
      body: { value: CONN_URL }
    },
    {
      label: 'disconnected',
      candidates: ['/update-webhook-disconnected', '/update-on-disconnected'],
      body: { value: CONN_URL }
    },
  ]

  const resultados = []
  for (const cfg of configs) {
    let sucesso = false
    for (const endpoint of cfg.candidates) {
      const r = await zapiPut(endpoint, cfg.body)
      if (r.ok) {
        console.log(`   ✅ ${cfg.label}: configurado via ${endpoint}`)
        sucesso = true
        break
      }
    }
    if (!sucesso) {
      console.warn(`   ⚠️  ${cfg.label}: todos endpoints falharam`)
    }
    resultados.push({ label: cfg.label, ok: sucesso })
  }

  // Ativar notifySentByMe separadamente (múltiplos formatos tentados)
  console.log('\n▶ Ativando notifySentByMe (mensagens enviadas pelo celular)...')
  const nsbmFormatos = [
    { value: true },                             // booleano (Z-API v2 docs)
    { value: WEBHOOK_URL },                      // URL (versões que pedem destino)
    { notifySentByMe: true },                    // sem 'value' (legado)
    { value: WEBHOOK_URL, notifySentByMe: true } // misto
  ]

  let nsbmOk = false
  for (const body of nsbmFormatos) {
    const r = await zapiPut('/update-notify-sent-by-me', body)
    if (r.ok) {
      console.log(`   ✅ notifySentByMe ATIVADO com body: ${JSON.stringify(body)}`)
      nsbmOk = true
      break
    } else {
      console.log(`   ⚠️  Tentativa com ${JSON.stringify(body)} → HTTP ${r.status}: ${JSON.stringify(r.data || '').slice(0,80)}`)
    }
  }

  if (!nsbmOk) {
    console.warn('\n   ❌ Não foi possível ativar notifySentByMe via API.')
    console.warn('   AÇÃO MANUAL NECESSÁRIA:')
    console.warn('   1. Acesse o painel Z-API: https://app.z-api.io')
    console.warn('   2. Vá em "Instâncias" → sua instância → "Webhooks" ou "Configurações"')
    console.warn('   3. Ative a opção "Notificar mensagens enviadas por mim"')
    console.warn(`   4. Configure o webhook "Ao receber" como: ${WEBHOOK_URL}`)
  }

  resultados.push({ label: 'notifySentByMe', ok: nsbmOk })
  return resultados
}

// ─── Simular mensagem do celular ──────────────────────────────────────────────
async function simularMensagem() {
  const url = USAR_LOCAL ? `${LOCAL_URL}/webhooks/zapi` : `${APP_URL}/webhooks/zapi`
  const msgId = Array.from({ length: 20 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('')

  const payload = {
    instanceId: INSTANCE_ID,
    type: 'ReceivedCallback',
    phone: '5511900000099',          // número de teste
    fromMe: true,
    momment: Date.now(),
    status: 'SENT',
    chatName: 'Contato Diagnóstico',
    senderName: 'Eu',
    connectedPhone: '5500000000000', // placeholder — substitua pelo seu número real
    waitingMessage: false,
    isGroup: false,
    messageId: msgId,
    text: { message: `[DIAGNÓSTICO] Teste de espelhamento mobile → ${new Date().toLocaleTimeString()}` }
  }

  console.log('\n▶ Simulando mensagem fromMe (celular)...')
  console.log(`   POST ${url}`)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await res.json().catch(() => null)
    if (res.ok) {
      console.log(`   ✅ HTTP ${res.status}:`, JSON.stringify(data))
      console.log(`   Mensagem registrada! Verifique no sistema a conversa "5511900000099".`)
    } else {
      console.error(`   ❌ HTTP ${res.status}:`, JSON.stringify(data))
    }
  } catch (e) {
    console.error('   ❌ Erro de conexão:', e.message)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const info = await diagnosticar()

  if (FIX) {
    await corrigirWebhooks()

  // Re-verificar após correção
  console.log('\n▶ Verificação pós-correção...')
  const checkR = await zapiGet('/notify-sent-by-me')
  const checkNotFound = checkR.status === 404 || String(checkR.data?.error || '').includes('NOT_FOUND')
  if (checkNotFound) {
    console.log('   ✅ Configuração aplicada via PUT (GET não disponível nesta versão da Z-API).')
    console.log('   Os seguintes PUTs retornaram HTTP 200:')
    console.log('     • /update-webhook-received com { value: webhookUrl, notifySentByMe: true }')
    console.log('     • /update-notify-sent-by-me com { value: true }')
    console.log('   → Mensagens do celular DEVEM chegar agora.')
  } else if (checkR.ok) {
    const active = checkR.data?.value === true || checkR.data?.notifySentByMe === true || checkR.data === true
    console.log(`   ${ok(active)} notifySentByMe: ${active ? '✅ ATIVO' : '❌ AINDA INATIVO'}`)
  }
  }

  if (SIMULAR) {
    await simularMensagem()
  }

  console.log('\n═══════════════════════════════════════════════════')
  if (!FIX) {
    console.log('Rode com --fix para corrigir automaticamente os webhooks.')
    console.log('Rode com --fix --simular para corrigir + testar.')
  }
  console.log('═══════════════════════════════════════════════════\n')

  process.exit(0)
}

main().catch(e => { console.error('Erro:', e); process.exit(1) })
