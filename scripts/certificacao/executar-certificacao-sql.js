#!/usr/bin/env node
/**
 * Executa as queries SQL obrigatórias da certificação pré-deploy.
 * Requer .env com SUPABASE_URL e SUPABASE_SERVICE_KEY (ou SUPABASE_ANON_KEY).
 *
 * Uso: node scripts/certificacao/executar-certificacao-sql.js
 *
 * Saída: resultados das queries B1, B5, B6 para evidência.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })
const supabase = require('../../config/supabase')

async function runQuery(name, queryFn) {
  try {
    const { data, error } = await queryFn()
    if (error) {
      console.log(`\n❌ ${name}:`, error.message)
      return { ok: false, error: error.message }
    }
    console.log(`\n📋 ${name}:`)
    if (!data || (Array.isArray(data) && data.length === 0)) {
      console.log('   (vazio — OK)')
      return { ok: true, rows: 0, data: [] }
    }
    const rows = Array.isArray(data) ? data : [data]
    console.log(`   ${rows.length} linha(s)`)
    rows.slice(0, 10).forEach((r, i) => console.log(`   ${i + 1}.`, JSON.stringify(r)))
    if (rows.length > 10) console.log('   ...')
    return { ok: true, rows: rows.length, data: rows }
  } catch (e) {
    console.log(`\n❌ ${name}:`, e?.message || e)
    return { ok: false, error: String(e) }
  }
}

async function main() {
  console.log('=== CERTIFICAÇÃO PRÉ-DEPLOY — SQL OBRIGATÓRIOS ===\n')

  const results = {}

  // B1) Instâncias cadastradas
  results.empresaZapi = await runQuery(
    'B1.1 — Instâncias cadastradas (empresa_zapi)',
    () => supabase.from('empresa_zapi').select('company_id, ativo, instance_id').order('company_id')
  )

  // B5) Anti-duplicação — deve retornar 0
  results.clientesDup = await runQuery(
    'B5.1 — Clientes duplicados (company_id, telefone) — DEVE SER 0',
    async () => {
      const { data, error } = await supabase.from('clientes').select('company_id, telefone')
      if (error) return { data: null, error }
      const counts = {}
      for (const r of data || []) {
        const k = `${r.company_id}:${(r.telefone || '').trim()}`
        counts[k] = (counts[k] || 0) + 1
      }
      const dups = Object.entries(counts).filter(([, n]) => n > 1).map(([k, n]) => ({ key: k, count: n }))
      return { data: dups, error: null }
    }
  )

  results.conversasDup = await runQuery(
    'B5.2 — Conversas duplicadas (company_id, telefone) — DEVE SER 0',
    async () => {
      const { data, error } = await supabase.from('conversas').select('company_id, telefone')
      if (error) return { data: null, error }
      const counts = {}
      for (const r of data || []) {
        const k = `${r.company_id}:${(r.telefone || '').trim()}`
        counts[k] = (counts[k] || 0) + 1
      }
      const dups = Object.entries(counts).filter(([, n]) => n > 1).map(([k, n]) => ({ key: k, count: n }))
      return { data: dups, error: null }
    }
  )

  results.mensagensDup = await runQuery(
    'B5.3 — Mensagens duplicadas (company_id, whatsapp_id) — DEVE SER 0',
    async () => {
      const { data, error } = await supabase
        .from('mensagens')
        .select('company_id, whatsapp_id')
        .not('whatsapp_id', 'is', null)
      if (error) return { data: null, error }
      const counts = {}
      for (const r of data || []) {
        const k = `${r.company_id}:${(r.whatsapp_id || '').trim()}`
        counts[k] = (counts[k] || 0) + 1
      }
      const dups = Object.entries(counts).filter(([, n]) => n > 1).map(([k, n]) => ({ key: k, count: n }))
      return { data: dups, error: null }
    }
  )

  // B6) Amostra clientes
  results.clientesAmostra = await runQuery(
    'B6 — Amostra clientes (nome/foto) — company 1 e 2',
    () => supabase
      .from('clientes')
      .select('company_id, telefone, nome, foto_perfil')
      .in('company_id', [1, 2])
      .order('atualizado_em', { ascending: false })
      .limit(20)
  )

  // Resumo
  const dupClientes = results.clientesDup?.data?.length ?? (results.clientesDup?.rows ?? 0)
  const dupConversas = results.conversasDup?.data?.length ?? (results.conversasDup?.rows ?? 0)
  const dupMensagens = results.mensagensDup?.data?.length ?? (results.mensagensDup?.rows ?? 0)

  console.log('\n=== RESUMO ===')
  console.log('Duplicados clientes:', dupClientes, dupClientes === 0 ? '✅' : '❌')
  console.log('Duplicados conversas:', dupConversas, dupConversas === 0 ? '✅' : '❌')
  console.log('Duplicados mensagens:', dupMensagens, dupMensagens === 0 ? '✅' : '❌')

  if (dupClientes > 0 || dupConversas > 0 || dupMensagens > 0) {
    console.log('\n⚠️ Duplicados encontrados — executar scripts de dedupe antes do deploy.')
    process.exit(1)
  }

  console.log('\n✅ Certificação SQL: PASS')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
