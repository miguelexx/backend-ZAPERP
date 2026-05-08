/**
 * Reprocessa webhooks UltraMSG falhos a partir da tabela webhook_logs.
 *
 * Objetivo:
 * - Recuperar mensagens que chegaram no webhook, mas falharam no processamento (ex.: erro 42703).
 * - Reenviar o payload original para o endpoint oficial /webhooks/ultramsg, preservando o fluxo atual.
 * - Evitar duplicatas: o backend já possui idempotência por whatsapp_id/conversa.
 *
 * Uso:
 *   node scripts/reprocessar-webhooks-ultramsg-falhos.js --start=2026-05-08T14:00:00Z --end=2026-05-08T16:00:00Z --company=9
 *   node scripts/reprocessar-webhooks-ultramsg-falhos.js --start=... --end=... --company=9 --apply
 *
 * Flags:
 *   --start=ISO_DATE      (obrigatório)
 *   --end=ISO_DATE        (obrigatório)
 *   --company=ID          (opcional; recomendado)
 *   --limit=NUM           (opcional; padrão 1000)
 *   --apply               (opcional; sem isso roda em dry-run)
 *   --baseUrl=URL         (opcional; padrão APP_URL ou http://localhost:3000)
 *   --token=TOKEN         (opcional; padrão WHATSAPP_WEBHOOK_TOKEN)
 *   --includeProcessed    (opcional; inclui logs com response_status=200)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const supabase = require('../config/supabase')

function getArg(name) {
  const prefix = `--${name}=`
  const arg = process.argv.find((a) => a.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : null
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function ensureIso(value, label) {
  const d = new Date(value)
  if (!value || Number.isNaN(d.getTime())) {
    throw new Error(`Parâmetro inválido: ${label}. Use ISO, ex: 2026-05-08T14:00:00Z`)
  }
  return d.toISOString()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cleanPayload(payload, row) {
  const p = payload && typeof payload === 'object' ? { ...payload } : {}
  if (p._log) delete p._log
  if (!p.instanceId && row.instance_id) p.instanceId = row.instance_id
  if (!p.instance_id && row.instance_id) p.instance_id = row.instance_id
  return p
}

function isMessageEvent(ev) {
  const v = String(ev || '').toLowerCase()
  return [
    'message_received',
    'message_create',
    'webhook_message_received',
    'webhook_message_create',
    'webhook_message_download_media',
    'message_reaction',
    'webhook_message_reaction',
  ].includes(v)
}

async function fetchLogs({ startIso, endIso, companyId, limit, includeProcessed }) {
  const pageSize = Math.min(Math.max(Number(limit) || 1000, 1), 5000)
  let from = 0
  const out = []

  while (true) {
    let query = supabase
      .from('webhook_logs')
      .select('id, provider, company_id, instance_id, event_type, status, response_status, error_message, payload, criado_em')
      .eq('provider', 'ultramsg')
      .gte('criado_em', startIso)
      .lte('criado_em', endIso)
      .order('criado_em', { ascending: true })
      .range(from, from + pageSize - 1)

    if (companyId != null) query = query.eq('company_id', companyId)

    if (!includeProcessed) {
      query = query.or('response_status.gte.400,error_message.ilike.%status_mensagem%')
    }

    const { data, error } = await query
    if (error) throw error
    if (!Array.isArray(data) || data.length === 0) break

    out.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  return out.filter((r) => isMessageEvent(r.event_type))
}

async function repostWebhook({ baseUrl, token, row }) {
  const url = `${baseUrl.replace(/\/$/, '')}/webhooks/ultramsg${token ? `?token=${encodeURIComponent(token)}` : ''}`
  const payload = cleanPayload(row.payload, row)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  return { ok: res.ok, status: res.status, text }
}

async function main() {
  const startIso = ensureIso(getArg('start'), 'start')
  const endIso = ensureIso(getArg('end'), 'end')
  const companyRaw = getArg('company')
  const companyId = companyRaw != null ? Number(companyRaw) : null
  const limit = Number(getArg('limit') || 1000)
  const apply = hasFlag('apply')
  const includeProcessed = hasFlag('includeProcessed')
  const baseUrl = getArg('baseUrl') || process.env.APP_URL || 'http://localhost:3000'
  const token = getArg('token') || process.env.WHATSAPP_WEBHOOK_TOKEN || ''

  if (companyRaw != null && !Number.isFinite(companyId)) {
    throw new Error('Parâmetro inválido: company')
  }

  console.log('=== Reprocessamento UltraMSG (webhook_logs) ===')
  console.log('Janela:', startIso, '->', endIso)
  console.log('Company:', companyId ?? '(todas)')
  console.log('Modo:', apply ? 'APPLY (reenviando)' : 'DRY-RUN (sem reenviar)')
  console.log('Base URL:', baseUrl)
  console.log('Include processed:', includeProcessed ? 'sim' : 'nao')

  const rows = await fetchLogs({ startIso, endIso, companyId, limit, includeProcessed })
  console.log(`Total de logs candidatos: ${rows.length}`)

  if (rows.length === 0) {
    console.log('Nada para reprocessar.')
    return
  }

  const preview = rows.slice(0, 10).map((r) => ({
    id: r.id,
    criado_em: r.criado_em,
    event_type: r.event_type,
    company_id: r.company_id,
    response_status: r.response_status,
    error_message: r.error_message,
  }))
  console.log('Preview (10 primeiros):')
  console.table(preview)

  if (!apply) {
    console.log('Dry-run finalizado. Use --apply para reenviar os payloads.')
    return
  }

  if (!token) {
    throw new Error('WHATSAPP_WEBHOOK_TOKEN ausente. Informe --token=... ou configure no .env')
  }

  let okCount = 0
  let failCount = 0
  const failures = []

  for (const row of rows) {
    try {
      const result = await repostWebhook({ baseUrl, token, row })
      if (result.ok) {
        okCount += 1
      } else {
        failCount += 1
        failures.push({ id: row.id, status: result.status, body: String(result.text || '').slice(0, 300) })
      }
    } catch (e) {
      failCount += 1
      failures.push({ id: row.id, status: 0, body: String(e?.message || e).slice(0, 300) })
    }
    // ritmo conservador para não sobrecarregar servidor/banco
    await sleep(120)
  }

  console.log('=== Resultado ===')
  console.log('Sucesso:', okCount)
  console.log('Falhas:', failCount)
  if (failures.length > 0) {
    console.log('Falhas (até 20):')
    console.table(failures.slice(0, 20))
  }
}

main().catch((e) => {
  console.error('Erro no reprocessamento:', e?.message || e)
  process.exit(1)
})

