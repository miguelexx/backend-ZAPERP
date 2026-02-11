/**
 * Instruções para rodar a migration IA.
 * Execute: node scripts/run-ia-migration.js
 */
const fs = require('fs')
const path = require('path')

const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20250207000000_ia_config.sql')

if (fs.existsSync(migrationPath)) {
  const sql = fs.readFileSync(migrationPath, 'utf8')
  console.log('Execute o seguinte SQL no Supabase (Dashboard > SQL Editor):\n')
  console.log(sql)
  console.log('\nOu rode: supabase db push (se tiver Supabase CLI)')
} else {
  console.log('Arquivo de migration não encontrado.')
}
