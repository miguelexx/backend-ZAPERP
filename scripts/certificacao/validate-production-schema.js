#!/usr/bin/env node
'use strict'

/**
 * Valida schema real do Supabase vs requisitos de producao.
 * Exit 0 = OK, 1 = bloqueadores pendentes.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), override: true })
const supabase = require('../../config/supabase')

const REQUIRED = {
  conversas: [
    'ultima_mensagem_cliente_em',
    'ultima_resposta_atendente_em',
    'sla_status',
    'primeiro_alerta_enviado_em',
    'alerta_critico_enviado_em',
    'gestor_notificado_em',
    'conversa_reaberta_por_sla_em',
    'atendente_original_id',
    'motivo_reabertura',
    'tag_aplicada_por_sla',
    'pagamento_prazo_ate',
    'pagamento_concluido_em',
    'aguardando_cliente_desde',
  ],
  mensagens: [
    'apagada_para_todos',
    'apagada_em',
    'reply_meta',
    'whatsapp_id',
    'status_mensagem',
  ],
  tables: [
    'alerta_sem_resposta_eventos',
    'push_subscriptions',
    'push_inbound_delivery_log',
    'whatsapp_envio_guard_logs',
    'auditoria_eventos',
    'push_tokens',
    'empresa_pix_config',
  ],
}

async function checkColumn(table, col) {
  const { error } = await supabase.from(table).select(col).limit(1)
  return error ? String(error.message) : null
}

async function checkTable(table) {
  const { error } = await supabase.from(table).select('*').limit(1)
  return error ? String(error.message) : null
}

async function main() {
  console.log('=== VALIDACAO SCHEMA PRODUCAO ===\n')
  let failed = 0

  for (const col of REQUIRED.conversas) {
    const err = await checkColumn('conversas', col)
    const ok = !err
    console.log(`${ok ? '✅' : '❌'} conversas.${col}${err ? ' — ' + err.split('\n')[0] : ''}`)
    if (!ok) failed++
  }

  for (const col of REQUIRED.mensagens) {
    const err = await checkColumn('mensagens', col)
    const ok = !err
    console.log(`${ok ? '✅' : '❌'} mensagens.${col}${err ? ' — ' + err.split('\n')[0] : ''}`)
    if (!ok) failed++
  }

  for (const table of REQUIRED.tables) {
    const err = await checkTable(table)
    const ok = !err
    console.log(`${ok ? '✅' : '❌'} table ${table}${err ? ' — ' + err.split('\n')[0] : ''}`)
    if (!ok) failed++
  }

  console.log('\n=== RESUMO ===')
  if (failed === 0) {
    console.log('✅ Schema compativel com o codigo atual')
    process.exit(0)
  }
  console.log(`❌ ${failed} bloqueador(es) de schema pendente(s)`)
  console.log('   Execute: node scripts/apply-pending-migrations.js')
  process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
