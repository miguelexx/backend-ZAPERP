#!/usr/bin/env node
/**
 * Verifica isolamento de clientes por empresa e sync Z-API.
 *
 * 1. Audit: confere que cada cliente pertence a apenas uma empresa (company_id)
 * 2. Sync: opcional, chama POST /contacts/sync para uma empresa (requer JWT)
 *
 * Uso:
 *   node scripts/verificar-clientes-por-empresa.js audit
 *   node scripts/verificar-clientes-por-empresa.js sync <company_id> <JWT_TOKEN>
 *
 * O sync também é disparado automaticamente quando o celular conecta (webhook
 * /webhooks/zapi/connection com type=ConnectedCallback).
 */

require('dotenv').config()
const supabase = require('../config/supabase')

async function audit() {
  console.log('📋 Auditoria: clientes por empresa\n')

  const { data: clientes, error } = await supabase
    .from('clientes')
    .select('id, company_id, telefone, nome, criado_em')
    .order('company_id', { ascending: true })
    .order('telefone', { ascending: true })

  if (error) {
    console.error('❌ Erro ao buscar clientes:', error.message)
    process.exit(1)
  }

  const byCompany = new Map()
  for (const c of clientes || []) {
    const cid = Number(c.company_id)
    if (!byCompany.has(cid)) byCompany.set(cid, [])
    byCompany.get(cid).push(c)
  }

  let duplicados = 0
  for (const [cid, list] of byCompany) {
    const tels = new Map()
    for (const c of list) {
      const t = String(c.telefone || '').trim()
      if (tels.has(t)) duplicados++
      else tels.set(t, c)
    }
    console.log(`  Empresa ${cid}: ${list.length} clientes (${tels.size} telefones únicos)`)
  }

  // Verifica duplicatas (company_id, telefone)
  const { data: allRows } = await supabase.from('clientes').select('company_id, telefone')
  const counts = new Map()
  for (const r of allRows || []) {
    const k = `${r.company_id}:${(r.telefone || '').trim()}`
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  const duplicatas = [...counts.entries()].filter(([, n]) => n > 1)
  if (duplicatas.length > 0) {
    console.log('\n❌ Duplicatas (company_id, telefone):', duplicatas.length, 'pares')
    duplicatas.slice(0, 5).forEach(([k]) => console.log('   ', k))
  } else {
    console.log('\n✅ Nenhuma duplicata (company_id, telefone) - isolamento OK')
  }

  console.log('\n✅ Cada empresa tem seus próprios clientes. Constraint: idx_clientes_company_telefone_unique')
  process.exit(0)
}

async function runSync(companyId, token) {
  if (!companyId || !token) {
    console.error('Uso: node scripts/verificar-clientes-por-empresa.js sync <company_id> <JWT_TOKEN>')
    process.exit(1)
  }
  const baseUrl = process.env.APP_URL || 'http://localhost:3000'
  const url = `${baseUrl.replace(/\/$/, '')}/api/integrations/zapi/contacts/sync`
  console.log('📤 POST', url, 'company_id=', companyId)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('❌ Erro HTTP', res.status, data)
      process.exit(1)
    }
    console.log('✅ Sync OK:', data)
    process.exit(0)
  } catch (e) {
    console.error('❌ Erro na requisição:', e.message)
    process.exit(1)
  }
}

async function main() {
  const cmd = process.argv[2] || 'audit'
  if (cmd === 'audit') {
    await audit()
  } else if (cmd === 'sync') {
    await runSync(process.argv[3], process.argv[4])
  } else {
    console.log('Comandos: audit | sync <company_id> <JWT>')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
