/**
 * Configura credenciais UltraMsg na tabela empresa_zapi.
 * Uso: node scripts/configurar-ultramsg.js [company_id]
 *
 * Variáveis de ambiente:
 *   ULTRAMSG_INSTANCE_ID=instance51534
 *   ULTRAMSG_TOKEN=r6ztawoqwcfhzrd
 *   COMPANY_ID=1 (ou passar como arg)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const supabase = require('../config/supabase')

const instanceId = process.env.ULTRAMSG_INSTANCE_ID || 'instance51534'
const token = process.env.ULTRAMSG_TOKEN || 'r6ztawoqwcfhzrd'
const companyId = Number(process.argv[2] || process.env.COMPANY_ID || 1)

async function main() {
  if (!companyId || !Number.isFinite(companyId)) {
    console.error('Usage: node configurar-ultramsg.js [company_id]')
    process.exit(1)
  }
  const { data, error } = await supabase
    .from('empresa_zapi')
    .upsert(
      { company_id: companyId, instance_id: instanceId, instance_token: token, client_token: '', ativo: true },
      { onConflict: 'company_id' }
    )
    .select('id, company_id, instance_id, ativo')
  if (error) {
    console.error('Erro:', error.message)
    process.exit(1)
  }
  console.log('✅ UltraMsg configurado:', data?.[0] || { company_id: companyId, instance_id: instanceId })
}

main()
