/**
 * Script para testar a API UltraMsg GET /contacts e GET /contacts/contact
 * Uso: node scripts/test-ultramsg-contacts.js
 */
const instanceId = '51534'
const token = 'r6ztawoqwcfhzrdc'

async function fetchApi(endpoint, extraParams = {}) {
  const params = new URLSearchParams({ token, ...extraParams })
  const segment = String(instanceId).toLowerCase().startsWith('instance') ? instanceId : `instance${instanceId}`
  const url = `https://api.ultramsg.com/${segment}${endpoint}?${params}`
  const res = await fetch(url)
  const text = await res.text()
  return { status: res.status, statusText: res.statusText, body: text }
}

async function test() {
  console.log('=== 1) GET /contacts ===')
  const r1 = await fetchApi('/contacts')
  console.log('Status:', r1.status, r1.statusText)
  console.log('Body:', r1.body)
  console.log('')

  console.log('=== 2) GET /contacts/contact?chatId=5511986459364@c.us ===')
  const r2 = await fetchApi('/contacts/contact', { chatId: '5511986459364@c.us' })
  console.log('Status:', r2.status, r2.statusText)
  console.log('Body:', r2.body)
}

test().catch(console.error)
