#!/usr/bin/env node
/**
 * Script de teste: POST /api/integrations/zapi/contacts/sync
 * Uso: node scripts/certificacao/test-sync-contatos.js BASE_URL JWT_TOKEN
 * Ex:  node scripts/certificacao/test-sync-contatos.js http://localhost:3000 eyJhbGc...
 */

const BASE_URL = process.argv[2] || 'http://localhost:3000'
const TOKEN = process.argv[3] || process.env.JWT_TOKEN

if (!TOKEN) {
  console.error('Uso: node test-sync-contatos.js BASE_URL JWT_TOKEN')
  console.error('Ou: JWT_TOKEN=xxx node test-sync-contatos.js BASE_URL')
  process.exit(1)
}

async function main() {
  const url = `${BASE_URL.replace(/\/$/, '')}/api/integrations/zapi/contacts/sync`
  console.log('POST', url)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`
    }
  })
  const data = await res.json().catch(() => ({}))
  console.log('Status:', res.status)
  console.log(JSON.stringify(data, null, 2))
  if (!data.ok) {
    process.exit(1)
  }
  console.log('\n--- Resumo ---')
  console.log('Modo:', data.mode)
  console.log('Total obtido:', data.totalFetched)
  console.log('Inseridos:', data.inserted)
  console.log('Atualizados:', data.updated)
  console.log('Ignorados:', data.skipped)
  if (data.errors?.length) {
    console.log('Erros:', data.errors.slice(0, 5).join('; '))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
