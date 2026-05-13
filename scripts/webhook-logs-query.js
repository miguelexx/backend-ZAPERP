#!/usr/bin/env node
/**
 * Lista registos recentes de public.webhook_logs (UltraMsg) via Supabase.
 *
 * Pré-requisitos no backend/.env:
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...   (service role — só em ambiente confiável)
 *
 * Uso:
 *   node scripts/webhook-logs-query.js
 *   node scripts/webhook-logs-query.js --company=6 --instance=instance89002 --limit=50
 *
 * Não coloque tokens de webhook ou API UltraMsg neste ficheiro.
 */

'use strict'

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const { createClient } = require('@supabase/supabase-js')

function arg(name, def) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (!p) return def
  return p.slice(name.length + 3)
}

async function main() {
  const url = String(process.env.SUPABASE_URL || '').trim()
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!url || !key) {
    console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do backend.')
    process.exit(1)
  }

  const companyId = arg('company', '6')
  const instanceId = arg('instance', 'instance89002')
  const limit = Math.min(200, Math.max(1, parseInt(arg('limit', '40'), 10) || 40))

  const supabase = createClient(url, key)

  console.log('\n--- Últimos logs company_id =', companyId, '---\n')
  const { data: byCompany, error: e1 } = await supabase
    .from('webhook_logs')
    .select(
      'id, criado_em, status, event_type, instance_id, company_id, response_status, error_message, processing_ms, ip'
    )
    .eq('provider', 'ultramsg')
    .eq('company_id', Number(companyId))
    .order('criado_em', { ascending: false })
    .limit(limit)

  if (e1) {
    console.error(e1.message || e1)
    process.exit(1)
  }
  console.table(byCompany || [])

  console.log('\n--- Últimos logs com instance_id ~', instanceId, '(qualquer company_id) ---\n')
  const { data: byInst, error: e2 } = await supabase
    .from('webhook_logs')
    .select(
      'id, criado_em, status, event_type, instance_id, company_id, response_status, error_message, processing_ms'
    )
    .eq('provider', 'ultramsg')
    .in('instance_id', [instanceId, '89002'])
    .order('criado_em', { ascending: false })
    .limit(limit)

  if (e2) {
    console.error(e2.message || e2)
    process.exit(1)
  }
  console.table(byInst || [])
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
