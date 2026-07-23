/**
 * Backfill automático de mídia recebida SEM URL no webhook.
 *
 * Cenário comprovado (payload real): instâncias UltraMsg com webhook_message_download_media
 * ineficaz entregam `message_received` de áudio/imagem com `media:""` — a URL nunca chega por
 * webhook. Porém o `GET /chats/messages` (mesmo endpoint do botão "Carregar mensagens antigas")
 * RETORNA a mídia. Este serviço dispara esse fetch em background quando uma mensagem de mídia é
 * gravada sem URL, reparando a linha (via a lógica de reparo do oldMessagesSyncService) em segundos,
 * sem ação do atendente.
 *
 * Proteções para tráfego intenso:
 *  - debounce por conversa (default 60s) — vários áudios seguidos disparam 1 fetch só;
 *  - teto global de execuções concorrentes;
 *  - desligável por env INBOUND_MEDIA_BACKFILL_DISABLED=1.
 */

const MEDIA_FAMILY_TIPOS = new Set(['voice', 'audio', 'imagem', 'video', 'sticker', 'arquivo'])
const MEDIA_PLACEHOLDER_TEXTS = new Set([
  '(mensagem)', '(mídia)', '(midia)', '(imagem)', '(áudio)', '(audio)', '(áudio de voz)',
  '(vídeo)', '(video)', '(vídeo visualização única)', '(figurinha)', '(sticker)', '(arquivo)', '(documento)',
])

function parsePositiveIntEnv(name, fallback, { min, max }) {
  const n = Number(process.env[name])
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function isBackfillDisabled() {
  return String(process.env.INBOUND_MEDIA_BACKFILL_DISABLED || '').trim() === '1'
}

function debounceMs() {
  return parsePositiveIntEnv('INBOUND_MEDIA_BACKFILL_DEBOUNCE_MS', 60_000, { min: 5_000, max: 600_000 })
}

function maxConcurrent() {
  return parsePositiveIntEnv('INBOUND_MEDIA_BACKFILL_MAX_CONCURRENT', 3, { min: 1, max: 20 })
}

/** URL renderável já presente? (https remota ou /uploads local) */
function hasUsableMediaUrl(url) {
  const u = String(url || '').trim()
  return u.startsWith('https://') || u.startsWith('http://') || u.startsWith('/uploads/')
}

/**
 * Decide se uma mensagem gravada precisa de backfill de mídia.
 * true quando: sem URL renderável E (tipo de mídia OU texto é placeholder de mídia/genérico).
 * @param {{ tipo?: string, texto?: string, url?: string }} msg
 */
function precisaBackfillMidia(msg) {
  if (!msg) return false
  if (hasUsableMediaUrl(msg.url)) return false
  const tipo = String(msg.tipo || '').toLowerCase().trim()
  if (MEDIA_FAMILY_TIPOS.has(tipo)) return true
  const texto = String(msg.texto || '').trim().toLowerCase()
  return MEDIA_PLACEHOLDER_TEXTS.has(texto)
}

const _debounceMap = new Map() // key: `${company_id}:${conversa_id}` -> ts do último disparo efetivo
const _trailingTimers = new Map() // key -> Timeout de passada de arrasto (rajada/teto) já agendada
let _running = 0

/** Retardo curto para re-tentar quando o teto de concorrência estava cheio (mídia não pode ficar presa). */
function capacityRetryMs() {
  return parsePositiveIntEnv('INBOUND_MEDIA_BACKFILL_CAPACITY_RETRY_MS', 2_000, { min: 500, max: 30_000 })
}

setInterval(() => {
  const cutoff = Date.now() - debounceMs()
  for (const [key, ts] of _debounceMap.entries()) {
    if (ts < cutoff) _debounceMap.delete(key)
  }
}, 5 * 60 * 1000).unref()

/**
 * Executa (fora do caminho do webhook) o GET /chats/messages que repara TODAS as mensagens
 * de mídia sem URL da conversa. Respeita o teto de concorrência: se cheio, re-agenda em vez
 * de descartar — o áudio recebido não pode ficar preso esperando o atendente responder.
 * @param {{ supabase:any, io:any, company_id:number, conversa_id:number, source?:string }} ctx
 */
function _runBackfillNow(ctx) {
  const { company_id, conversa_id } = ctx
  const key = `${company_id}:${conversa_id}`

  if (_running >= maxConcurrent()) {
    // Teto atingido: NÃO marca debounce (senão a conversa ficava travada por debounceMs).
    // Re-agenda uma única passada curta para não perder o pedido.
    _armTrailingBackfill(ctx, capacityRetryMs())
    return
  }

  _debounceMap.set(key, Date.now())
  _running += 1
  setImmediate(async () => {
    try {
      const { syncOldMessagesForConversation } = require('./oldMessagesSyncService')
      const res = await syncOldMessagesForConversation(company_id, Number(conversa_id), {
        io: ctx.io || null,
        source: ctx.source || 'inbound_media_backfill',
      }).catch((e) => ({ ok: false, error: e?.message || String(e) }))
      const changed = (res?.messagesUpdated || 0) + (res?.messagesInserted || 0)
      if (changed > 0) {
        console.log('[inboundMediaBackfill] mídia recuperada via GET /chats/messages', {
          company_id, conversa_id, atualizadas: res.messagesUpdated || 0, inseridas: res.messagesInserted || 0,
          source: ctx.source || 'inbound_media_backfill',
        })
      }
    } catch (e) {
      console.warn('[inboundMediaBackfill] falha', { conversa_id, err: e?.message || String(e) })
    } finally {
      _running -= 1
    }
  })
}

/**
 * Agenda UMA passada de arrasto (trailing) para a conversa. Coalesce: se já há uma agendada,
 * mantém a existente. Cobre dois cenários que antes só se resolviam com nova mensagem do
 * contato ou resposta do atendente:
 *  - rajada: 2º/3º áudio chegam DEPOIS do GET anterior (dentro do debounce);
 *  - mídia ainda não pronta na UltraMsg no 1º fetch (GET volta sem URL).
 */
function _armTrailingBackfill(ctx, delayMs) {
  const { company_id, conversa_id } = ctx
  const key = `${company_id}:${conversa_id}`
  if (_trailingTimers.has(key)) return
  const t = setTimeout(() => {
    _trailingTimers.delete(key)
    _runBackfillNow(ctx)
  }, Math.max(0, Number(delayMs) || 0))
  if (typeof t.unref === 'function') t.unref()
  _trailingTimers.set(key, t)
}

/**
 * Agenda (não bloqueia o webhook) um backfill de mídia para a conversa, se necessário.
 * @param {{ supabase:any, io:any, company_id:number, conversa_id:number, mensagemSalva:object }} ctx
 */
function scheduleInboundMediaBackfill(ctx) {
  const { supabase, io, company_id, conversa_id, mensagemSalva } = ctx || {}
  if (isBackfillDisabled()) return
  if (company_id == null || conversa_id == null) return
  if (!precisaBackfillMidia(mensagemSalva)) return

  const key = `${company_id}:${conversa_id}`
  const now = Date.now()
  const last = _debounceMap.get(key)
  const runCtx = { supabase, io, company_id, conversa_id, source: 'inbound_media_backfill' }

  if (last && now - last < debounceMs()) {
    // Já rodou há pouco: agenda a passada de arrasto ao FIM da janela de debounce, capturando
    // os áudios que chegaram depois do GET anterior sem re-disparar um GET por mensagem.
    _armTrailingBackfill(runCtx, (last + debounceMs()) - now)
    return
  }

  _runBackfillNow(runCtx)
}

// ─── Rede de segurança durável: sweep periódico de mídia recebida SEM URL ───────────────
// Cobre o áudio único cuja mídia não estava pronta na UltraMsg no 1º fetch (sem rajada para
// disparar arrasto) e qualquer linha que escapou dos webhooks. Auto-cura em minutos, sem o
// atendente precisar responder. Mídia sem URL é gravada como tipo='texto' + placeholder
// ('(áudio)'…); linhas tipadas sem URL (voice/audio/imagem…) também entram por garantia.
const SWEEP_PLACEHOLDER_TEXTS = Array.from(MEDIA_PLACEHOLDER_TEXTS)
const SWEEP_MEDIA_TIPOS = ['voice', 'audio', 'imagem', 'video', 'sticker', 'arquivo']

function isSweepDisabled() {
  return isBackfillDisabled() ||
    String(process.env.INBOUND_MEDIA_BACKFILL_SWEEP_DISABLED || '').trim() === '1'
}

/**
 * Uma passada do sweep: encontra conversas com mídia recebida sem URL nas últimas horas e
 * dispara o reparo (mesmo GET /chats/messages do botão "Carregar mensagens antigas").
 * @returns {Promise<{ scanned:number, conversationsTriggered:number }>}
 */
async function runInboundMediaBackfillSweep(supabase, io = null) {
  const out = { scanned: 0, conversationsTriggered: 0 }
  if (!supabase || isSweepDisabled()) return out

  const maxAgeH = parsePositiveIntEnv('INBOUND_MEDIA_BACKFILL_SWEEP_MAX_AGE_HOURS', 12, { min: 1, max: 168 })
  const batch = parsePositiveIntEnv('INBOUND_MEDIA_BACKFILL_SWEEP_BATCH', 300, { min: 20, max: 3000 })
  const maxConversas = parsePositiveIntEnv('INBOUND_MEDIA_BACKFILL_SWEEP_MAX_CONVERSAS', 40, { min: 1, max: 500 })
  const delayMs = parsePositiveIntEnv('INBOUND_MEDIA_BACKFILL_SWEEP_DELAY_MS', 250, { min: 0, max: 5000 })
  const sinceIso = new Date(Date.now() - maxAgeH * 3600000).toISOString()

  const seenConversas = new Set()
  const alvos = []

  const coletar = (rows) => {
    for (const r of rows || []) {
      out.scanned += 1
      if (hasUsableMediaUrl(r.url)) continue
      const cid = Number(r.company_id)
      const conv = Number(r.conversa_id)
      if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(conv) || conv <= 0) continue
      const k = `${cid}:${conv}`
      if (seenConversas.has(k)) continue
      seenConversas.add(k)
      alvos.push({ company_id: cid, conversa_id: conv })
    }
  }

  // Duas queries simples (evita .or() do PostgREST, que já mordeu este projeto): mídia sem URL
  // chega como placeholder de texto E, por garantia, como tipo de mídia sem URL.
  try {
    const { data: porTexto, error: e1 } = await supabase
      .from('mensagens')
      .select('id, company_id, conversa_id, tipo, texto, url, criado_em')
      .in('texto', SWEEP_PLACEHOLDER_TEXTS)
      .gte('criado_em', sinceIso)
      .order('criado_em', { ascending: false })
      .limit(batch)
    if (e1) console.warn('[inboundMediaBackfill/sweep] query texto:', e1.message)
    else coletar(porTexto)
  } catch (e) {
    console.warn('[inboundMediaBackfill/sweep] query texto (throw):', e?.message || e)
  }

  try {
    const { data: porTipo, error: e2 } = await supabase
      .from('mensagens')
      .select('id, company_id, conversa_id, tipo, texto, url, criado_em')
      .in('tipo', SWEEP_MEDIA_TIPOS)
      .is('url', null)
      .gte('criado_em', sinceIso)
      .order('criado_em', { ascending: false })
      .limit(batch)
    if (e2) console.warn('[inboundMediaBackfill/sweep] query tipo:', e2.message)
    else coletar(porTipo)
  } catch (e) {
    console.warn('[inboundMediaBackfill/sweep] query tipo (throw):', e?.message || e)
  }

  const { syncOldMessagesForConversation } = require('./oldMessagesSyncService')
  let processadas = 0
  for (const alvo of alvos) {
    if (processadas >= maxConversas) break
    processadas += 1
    try {
      const res = await syncOldMessagesForConversation(alvo.company_id, alvo.conversa_id, {
        io: io || null,
        source: 'inbound_media_backfill_sweep',
      })
      const changed = (res?.messagesUpdated || 0) + (res?.messagesInserted || 0)
      if (changed > 0) out.conversationsTriggered += 1
    } catch (e) {
      console.warn('[inboundMediaBackfill/sweep] reparo conversa:', alvo.conversa_id, e?.message || e)
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
  }

  if (out.conversationsTriggered > 0) {
    console.log('[inboundMediaBackfill/sweep] mídia sem URL reparada', {
      scanned: out.scanned,
      conversasReparadas: out.conversationsTriggered,
    })
  }
  return out
}

/**
 * Agenda o sweep periódico (default: 5 min). Desligar: INBOUND_MEDIA_BACKFILL_SWEEP_DISABLED=1.
 * Usa scheduler lock para não duplicar em múltiplas instâncias.
 * @returns {() => void} cancela os timers
 */
function startInboundMediaBackfillSweepScheduler(supabase, io) {
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return () => {}
  if (isSweepDisabled()) return () => {}

  const intervalMs = Math.max(
    60 * 1000,
    Number(process.env.INBOUND_MEDIA_BACKFILL_SWEEP_INTERVAL_MS) || 5 * 60 * 1000
  )

  const tick = async () => {
    try {
      const { withSchedulerRunLock } = require('./schedulerLock')
      await withSchedulerRunLock('inbound_media_backfill_sweep', intervalMs, () =>
        runInboundMediaBackfillSweep(supabase, io)
      )
    } catch (e) {
      console.warn('[inboundMediaBackfill/sweep] tick', e?.message || e)
    }
  }

  const first = setTimeout(tick, 30 * 1000)
  if (typeof first.unref === 'function') first.unref()
  const id = setInterval(tick, intervalMs)
  if (typeof id.unref === 'function') id.unref()
  return () => {
    clearTimeout(first)
    clearInterval(id)
  }
}

module.exports = {
  scheduleInboundMediaBackfill,
  runInboundMediaBackfillSweep,
  startInboundMediaBackfillSweepScheduler,
  precisaBackfillMidia,
  hasUsableMediaUrl,
}
