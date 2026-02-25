/**
 * Simulador de mensagem enviada pelo celular (fromMe: true)
 *
 * Simula exatamente o que a Z-API envia ao backend quando você manda
 * uma mensagem pelo WhatsApp do celular (recurso notifySentByMe).
 *
 * Uso:
 *   node scripts/simular-msg-celular.js
 *   node scripts/simular-msg-celular.js --phone 5511999999999 --texto "Olá teste" --meu 5511888888888
 *   node scripts/simular-msg-celular.js --tipo delivery   (simula DeliveryCallback sem texto)
 *   node scripts/simular-msg-celular.js --url http://localhost:5000
 *
 * Argumentos opcionais:
 *   --phone   Número do CONTATO (para quem foi enviada a mensagem). Default: pede interativo.
 *   --meu     Seu número (connectedPhone). Default: lê ZAPI_CONNECTED_PHONE no .env ou pede.
 *   --texto   Texto da mensagem. Default: "Mensagem de teste do celular 🔄"
 *   --tipo    "received" (padrão) ou "delivery" (DeliveryCallback sem conteúdo)
 *   --url     URL do backend. Default: APP_URL do .env ou http://localhost:5000
 */

'use strict'

const path = require('path')
const readline = require('readline')

// Carrega .env do projeto
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
} catch (_) {}

// ── Parse de argumentos simples (sem dependência externa) ──────────────────
const args = process.argv.slice(2)
function getArg(name) {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}

const INSTANCE_ID  = process.env.ZAPI_INSTANCE_ID || ''
const APP_URL_ENV  = (process.env.APP_URL || 'http://localhost:5000').replace(/\/$/, '')

const argUrl  = getArg('url')
const argPhone = getArg('phone')
const argMeu  = getArg('meu')
const argTexto = getArg('texto')
const argTipo  = (getArg('tipo') || 'received').toLowerCase()

const BASE_URL = argUrl || APP_URL_ENV
const WEBHOOK_URL = `${BASE_URL}/webhooks/zapi`

// ── Helpers ────────────────────────────────────────────────────────────────
function gerarMsgId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
  })
}

// ── Monta payload ReceivedCallback (fromMe=true) ───────────────────────────
function montarPayloadRecebido(phone, connectedPhone, texto, messageId) {
  return {
    instanceId: INSTANCE_ID,
    type: 'ReceivedCallback',
    phone,
    fromMe: true,
    momment: Date.now(),
    status: 'SENT',
    chatName: 'Contato Teste',
    senderName: 'Eu',
    senderPhoto: null,
    connectedPhone,
    waitingMessage: false,
    isGroup: false,
    isNewsLetter: false,
    messageId,
    text: { message: texto },
  }
}

// ── Monta payload DeliveryCallback (fromMe=true, sem conteúdo) ────────────
function montarPayloadDelivery(phone, connectedPhone, messageId) {
  return {
    instanceId: INSTANCE_ID,
    type: 'DeliveryCallback',
    phone,
    fromMe: true,
    momment: Date.now(),
    status: 'SENT',
    connectedPhone,
    waitingMessage: false,
    isGroup: false,
    messageId,
  }
}

// ── Envia o webhook ────────────────────────────────────────────────────────
async function enviarWebhook(payload, rotulo) {
  const body = JSON.stringify(payload)
  console.log(`\n📤 Enviando ${rotulo} para: ${WEBHOOK_URL}`)
  console.log('   Payload:', JSON.stringify(payload, null, 2))

  let resp
  try {
    resp = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
  } catch (e) {
    console.error('\n❌ Erro de conexão:', e.message)
    console.error('   Verifique se o backend está rodando em:', BASE_URL)
    return false
  }

  const text = await resp.text()
  let json
  try { json = JSON.parse(text) } catch (_) { json = text }

  if (resp.ok) {
    console.log(`\n✅ HTTP ${resp.status} — Resposta:`, JSON.stringify(json, null, 2))
  } else {
    console.error(`\n❌ HTTP ${resp.status} — Resposta:`, JSON.stringify(json, null, 2))
  }
  return resp.ok
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════')
  console.log(' Simulador de mensagem enviada pelo CELULAR (fromMe)')
  console.log('═══════════════════════════════════════════════════════')
  console.log(` Backend: ${WEBHOOK_URL}`)
  console.log(` Tipo:    ${argTipo === 'delivery' ? 'DeliveryCallback (sem texto)' : 'ReceivedCallback (com texto)'}`)
  console.log('')

  // Número do contato
  let phoneContato = argPhone
  if (!phoneContato) {
    phoneContato = await ask('📱 Número do CONTATO (para quem você enviou, ex: 5511999999999): ')
  }
  if (!phoneContato) {
    console.error('❌ Número do contato é obrigatório.')
    process.exit(1)
  }
  phoneContato = phoneContato.replace(/\D/g, '')

  // Meu número (connectedPhone)
  let meuNumero = argMeu || process.env.ZAPI_CONNECTED_PHONE || ''
  if (!meuNumero) {
    meuNumero = await ask('📱 SEU número (connectedPhone, ex: 5511888888888): ')
  }
  if (!meuNumero) {
    console.error('❌ Seu número é obrigatório (connectedPhone).')
    process.exit(1)
  }
  meuNumero = meuNumero.replace(/\D/g, '')

  const texto    = argTexto || 'Mensagem de teste do celular 🔄'
  const msgId    = gerarMsgId()

  if (argTipo === 'delivery') {
    // Simula apenas DeliveryCallback (sem texto — testa o caminho de status)
    const payload = montarPayloadDelivery(phoneContato, meuNumero, msgId)
    await enviarWebhook(payload, 'DeliveryCallback (fromMe, sem texto)')
  } else {
    // Simula ReceivedCallback (o principal — traz o conteúdo da mensagem)
    const payload = montarPayloadRecebido(phoneContato, meuNumero, texto, msgId)
    const ok = await enviarWebhook(payload, 'ReceivedCallback (fromMe=true)')

    if (ok) {
      console.log('\n─────────────────────────────────────────────────────')
      console.log('✅ Webhook enviado com sucesso!')
      console.log(`   messageId gerado: ${msgId}`)
      console.log(`   Verifique no sistema: a conversa com ${phoneContato} deve`)
      console.log(`   mostrar a mensagem "${texto}" como enviada (bolha direita).`)
      console.log('')
      console.log('   Se não aparecer, ative WHATSAPP_DEBUG=true no .env e')
      console.log('   reinicie o backend para ver logs detalhados.')

      // Opcionalmente simula também o DeliveryCallback logo após (como a Z-API faz)
      const simDelivery = argTipo !== 'received-only'
      if (simDelivery) {
        console.log('\n📦 Simulando também o DeliveryCallback (confirmação de envio)...')
        const payloadDel = montarPayloadDelivery(phoneContato, meuNumero, msgId)
        await enviarWebhook(payloadDel, 'DeliveryCallback (fromMe, sem texto)')
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════\n')
  process.exit(0)
}

main().catch(e => {
  console.error('Erro inesperado:', e)
  process.exit(1)
})
