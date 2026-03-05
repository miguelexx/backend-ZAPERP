#!/usr/bin/env node
/**
 * Verifica configuração Z-API por empresa (empresa_zapi).
 * Uso: node scripts/verificar-empresa-zapi.js [company_id]
 * Se company_id omitido, lista todas as empresas configuradas.
 *
 * Saída esperada para envio funcionar:
 *   company_id=2: instance_id presente, ativo=true
 */

require('dotenv').config()
const supabase = require('../config/supabase')

async function main() {
  const companyId = process.argv[2] ? Number(process.argv[2]) : null
  const { data, error } = await supabase
    .from('empresa_zapi')
    .select('company_id, instance_id, ativo, criado_em')
    .order('company_id', { ascending: true })

  if (error) {
    console.error('Erro ao buscar empresa_zapi:', error.message)
    process.exit(1)
  }

  const rows = companyId != null
    ? (data || []).filter((r) => Number(r.company_id) === companyId)
    : (data || [])

  if (rows.length === 0) {
    if (companyId != null) {
      console.warn(`❌ Empresa ${companyId} NÃO configurada em empresa_zapi.`)
      console.warn('   Adicione um registro: company_id, instance_id, instance_token, client_token, ativo=true')
    } else {
      console.warn('❌ Nenhuma empresa configurada em empresa_zapi.')
    }
    process.exit(1)
  }

  for (const r of rows) {
    const ok = r.instance_id && r.ativo === true
    const status = ok ? '✅' : '❌'
    console.log(`${status} company_id=${r.company_id} instance_id=${(r.instance_id || '').slice(0, 24)}... ativo=${r.ativo}`)
    if (!ok) {
      if (!r.instance_id) console.warn('   → instance_id vazio')
      if (r.ativo !== true) console.warn('   → ativo deve ser true para envio funcionar')
    }
  }
  console.log('\nPara envio funcionar: empresa_zapi com instance_id, instance_token, client_token e ativo=true.')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
