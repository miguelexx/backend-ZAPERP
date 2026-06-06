#!/usr/bin/env node
'use strict'

/**
 * Smoke test de carga leve para o backend ZapERP.
 *
 * Uso basico:
 *   BASE_URL=http://localhost:3000 JWT_SECRET=... node scripts/load-smoke.js
 *
 * Variaveis uteis:
 *   COMPANY_COUNT=70
 *   USERS_PER_COMPANY=3
 *   DURATION_SECONDS=30
 *   CONCURRENCY=25
 *   CHAT_ID=123                      abre conversa existente
 *   WEBHOOK_TOKEN=... INSTANCE_ID=... simula recebimento via UltraMSG
 *   SEND_MESSAGE_CHAT_ID=123          envia mensagem real pelo endpoint do chat (cuidado)
 *   SEND_MESSAGE_TEXT="teste carga"
 */

const jwt = require('jsonwebtoken')

const BASE_URL = String(process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const JWT_SECRET = String(process.env.JWT_SECRET || '').trim()
const COMPANY_COUNT = positiveInt(process.env.COMPANY_COUNT, 70)
const USERS_PER_COMPANY = positiveInt(process.env.USERS_PER_COMPANY, 3)
const DURATION_SECONDS = positiveInt(process.env.DURATION_SECONDS, 30)
const CONCURRENCY = positiveInt(process.env.CONCURRENCY, 25)
const CHAT_ID = process.env.CHAT_ID ? Number(process.env.CHAT_ID) : null
const WEBHOOK_TOKEN = String(process.env.WEBHOOK_TOKEN || process.env.WHATSAPP_WEBHOOK_TOKEN || '').trim()
const INSTANCE_ID = String(process.env.INSTANCE_ID || process.env.ULTRAMSG_INSTANCE_ID || '').trim()
const SEND_MESSAGE_CHAT_ID = process.env.SEND_MESSAGE_CHAT_ID ? Number(process.env.SEND_MESSAGE_CHAT_ID) : null
const SEND_MESSAGE_TEXT = String(process.env.SEND_MESSAGE_TEXT || 'teste carga ZapERP').trim()

if (!JWT_SECRET) {
  console.error('Defina JWT_SECRET para gerar tokens de teste.')
  process.exit(1)
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function makeToken(companyId, userId) {
  return jwt.sign(
    {
      id: userId,
      company_id: companyId,
      perfil: 'admin',
      departamento_ids: [1],
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  )
}

const identities = []
for (let companyId = 1; companyId <= COMPANY_COUNT; companyId++) {
  for (let u = 1; u <= USERS_PER_COMPANY; u++) {
    const userId = companyId * 1000 + u
    identities.push({ companyId, userId, token: makeToken(companyId, userId) })
  }
}

const stats = []
const errors = new Map()
let opCounter = 0
const endAt = Date.now() + DURATION_SECONDS * 1000

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function record(name, status, ms, error) {
  stats.push({ name, status, ms })
  if (error || status >= 400) {
    const key = `${name}:${status}:${error || ''}`.slice(0, 180)
    errors.set(key, (errors.get(key) || 0) + 1)
  }
}

async function request(name, identity, method, path, body) {
  const started = Date.now()
  try {
    const headers = { Authorization: `Bearer ${identity.token}` }
    let payload
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload })
    await res.arrayBuffer()
    record(name, res.status, Date.now() - started)
  } catch (e) {
    record(name, 0, Date.now() - started, e?.message || String(e))
  }
}

async function webhook(companyId) {
  if (!WEBHOOK_TOKEN || !INSTANCE_ID) return
  const started = Date.now()
  const id = `load_${companyId}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const body = {
    event_type: 'message_received',
    instanceId: INSTANCE_ID,
    data: {
      id,
      from: `55119999${String(companyId).padStart(4, '0')}@c.us`,
      to: '551100000000@c.us',
      fromMe: false,
      type: 'chat',
      body: `load smoke ${id}`,
      time: Math.floor(Date.now() / 1000),
    },
  }
  try {
    const res = await fetch(`${BASE_URL}/webhooks/ultramsg?token=${encodeURIComponent(WEBHOOK_TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    await res.arrayBuffer()
    record('POST /webhooks/ultramsg', res.status, Date.now() - started)
  } catch (e) {
    record('POST /webhooks/ultramsg', 0, Date.now() - started, e?.message || String(e))
  }
}

async function oneOperation() {
  const identity = pick(identities)
  const n = opCounter++ % 100
  if (n < 45) {
    return request('GET /api/chats', identity, 'GET', '/api/chats?status_atendimento=aberta')
  }
  if (n < 70) {
    return request('GET /api/clientes', identity, 'GET', '/api/clientes?limit=50&page=1')
  }
  if (n < 85 && CHAT_ID) {
    return request('GET /api/chats/:id', identity, 'GET', `/api/chats/${CHAT_ID}?limit=50`)
  }
  if (n < 95 && WEBHOOK_TOKEN && INSTANCE_ID) {
    return webhook(identity.companyId)
  }
  if (SEND_MESSAGE_CHAT_ID) {
    return request('POST /api/chats/:id/mensagens', identity, 'POST', `/api/chats/${SEND_MESSAGE_CHAT_ID}/mensagens`, {
      texto: SEND_MESSAGE_TEXT,
    })
  }
  return request('GET /health', identity, 'GET', '/health')
}

async function worker() {
  while (Date.now() < endAt) {
    await oneOperation()
  }
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

async function main() {
  console.log(JSON.stringify({
    baseUrl: BASE_URL,
    companyCount: COMPANY_COUNT,
    usersPerCompany: USERS_PER_COMPANY,
    durationSeconds: DURATION_SECONDS,
    concurrency: CONCURRENCY,
    chatId: CHAT_ID,
    webhookEnabled: Boolean(WEBHOOK_TOKEN && INSTANCE_ID),
    sendMessageEnabled: Boolean(SEND_MESSAGE_CHAT_ID),
  }))

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  const byName = new Map()
  for (const row of stats) {
    if (!byName.has(row.name)) byName.set(row.name, [])
    byName.get(row.name).push(row)
  }

  const totalMs = DURATION_SECONDS * 1000
  const summary = {
    totalRequests: stats.length,
    rps: Number((stats.length / (totalMs / 1000)).toFixed(2)),
    errors: [...errors.entries()].map(([key, count]) => ({ key, count })),
    endpoints: [...byName.entries()].map(([name, rows]) => {
      const lat = rows.map((r) => r.ms)
      const ok = rows.filter((r) => r.status > 0 && r.status < 400).length
      return {
        name,
        count: rows.length,
        ok,
        errorCount: rows.length - ok,
        p50: percentile(lat, 50),
        p95: percentile(lat, 95),
        max: Math.max(...lat),
      }
    }),
  }

  console.log(JSON.stringify(summary, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
