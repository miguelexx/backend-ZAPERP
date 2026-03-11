#!/usr/bin/env node
/**
 * Configura UltraMsg na empresa_zapi.
 * Uso: node scripts/configurar-ultramsg.js [company_id]
 *
 * Variáveis: ULTRAMSG_INSTANCE_ID e ULTRAMSG_TOKEN (ou argumentos)
 * Ex: node scripts/configurar-ultramsg.js 1
 * Ou: ULTRAMSG_INSTANCE_ID=instance51534 ULTRAMSG_TOKEN=xxx node scripts/configurar-ultramsg.js 1
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const supabase = require('../config/supabase')

const INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID || 'instance51534'
const TOKEN = process.env.ULTRAMSG_TOKEN || process.env.ULTRAMSG_INSTANCE_TOKEN || 'r6ztawoqwcfhzrd'

async function main() {
  const companyId = process.argv[2] ? Number(process.argv[2]) : (process.env.WEBHOOK_COMPANY_ID ? Number(process.env.WEBHOOK_COMPANY_ID) : 1)

  if (!companyId || !Number.isFinite(companyId)) {
    console.error('Uso: node scripts/configurar-ultramsg.js <company_id>')
    console.error('Ex: node scripts/configurar-ultramsg.js 1')
    process.exit(1)
  }

  const { data, error } = await supabase
    .from('empresa_zapi')
    .upsert(
      {
        company_id: companyId,
        instance_id: INSTANCE_ID,
        instance_token: TOKEN,
        client_token: '',
        ativo: true,
        atualizado_em: new Date().toISOString()
      },
      { onConflict: 'company_id' }
    )
    .select('company_id, instance_id, ativo')
    .single()

  if (error) {
    console.error('❌ Erro ao configurar empresa_zapi:', error.message)
    process.exit(1)
  }

  console.log('✅ UltraMsg configurado para company_id', companyId)
  console.log('   instance_id:', data?.instance_id || INSTANCE_ID)
  console.log('   ativo:', data?.ativo)
  console.log('\nWebhook URL para configurar no painel UltraMsg:')
  const appUrl = (process.env.APP_URL || 'https://zaperpapi.wmsistemas.inf.br').replace(/\/$/, '')
  const webhookToken = process.env.ZAPI_WEBHOOK_TOKEN || ''
  const suffix = webhookToken ? `?token=${encodeURIComponent(webhookToken)}` : ''
  console.log(`   ${appUrl}/webhooks/ultramsg${suffix}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
