#!/usr/bin/env node
'use strict'

/**
 * Aplica migrations SQL pendentes via conexao PostgreSQL direta.
 *
 * Requer DATABASE_URL no .env (Supabase: Settings > Database > Connection string).
 *
 * Uso:
 *   node scripts/apply-pending-migrations.js
 *   node scripts/apply-pending-migrations.js --dry-run
 */

const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true })

const FILES = [
  '20260423130000_web_push_subscriptions.sql',
  '20260524120000_financeiro_pagamento_status.sql',
  '20260524130000_financeiro_pagamento_concluido.sql',
  '20260525120000_mensagens_apagada_para_todos.sql',
  '20260527000000_whatsapp_send_guard_logs.sql',
  '20260608000000_alerta_atendimento_sem_resposta.sql',
  '20260608120000_production_blockers_consolidated.sql',
]

function getDatabaseUrl() {
  const direct = String(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').trim()
  if (direct) return direct
  const host = process.env.PG_HOST || process.env.DB_HOST
  const user = process.env.PG_USER || process.env.DB_USER || 'postgres'
  const password = process.env.PG_PASSWORD || process.env.DB_PASSWORD || process.env.SUPABASE_DB_PASSWORD
  const database = process.env.PG_DATABASE || process.env.DB_NAME || 'postgres'
  const port = process.env.PG_PORT || process.env.DB_PORT || '5432'
  if (host && password) {
    const ssl = String(process.env.PG_SSL || process.env.DB_SSL || 'true').toLowerCase() !== 'false'
    const q = ssl ? '?sslmode=require' : ''
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}${q}`
  }
  return ''
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const dbUrl = getDatabaseUrl()
  if (!dbUrl) {
    console.error('❌ DATABASE_URL (ou PG_HOST + PG_PASSWORD) nao configurado no .env')
    console.error('   Supabase: Project Settings > Database > Connection string > URI')
    process.exit(1)
  }

  const { Client } = require('pg')
  const client = new Client({ connectionString: dbUrl })
  await client.connect()
  console.log('✅ Conectado ao PostgreSQL')

  try {
    for (const file of FILES) {
      const full = path.join(__dirname, '..', 'supabase', 'migrations', file)
      if (!fs.existsSync(full)) {
        console.warn('⚠️ Arquivo ausente, pulando:', file)
        continue
      }
      const sql = fs.readFileSync(full, 'utf8')
      console.log(`\n📦 ${file} (${sql.length} bytes)`)
      if (dryRun) {
        console.log('   (dry-run — nao executado)')
        continue
      }
      await client.query(sql)
      console.log('   ✅ aplicado')
    }
    console.log('\n✅ Migrations aplicadas com sucesso')
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('❌ Falha ao aplicar migrations:', e.message)
  process.exit(1)
})
