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
 *  - passada de arrasto (trailing) ao fim do debounce — garante o último áudio da rajada;
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

function trailingMs() {
  return parsePositiveIntEnv('INBOUND_MEDIA_BACKFILL_TRAILING_MS', 8_000, { min: 1_000, max: 60_000 })
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

// chave → { lastTs, trailingTimer }
const _debounceMap = new Map()
let _running = 0

// Limpeza periódica de entradas expiradas no mapa de debounce.
setInterval(() => {
  const cutoff = Date.now() - debounceMs() * 2
  for (const [key, entry] of _debounceMap.entries()) {
    if (entry.lastTs < cutoff && !entry.trailingTimer) _debounceMap.delete(key)
  }
}, 5 * 60 * 1000).unref()

async function executarBackfill({ supabase, io, company_id, conversa_id }) {
  if (_running >= maxConcurrent()) return
  _running += 1
  try {
    const { syncOldMessagesForConversation } = require('./oldMessagesSyncService')
    const res = await syncOldMessagesForConversation(company_id, Number(conversa_id), {
      io: io || null,
      source: 'inbound_media_backfill',
    }).catch((e) => ({ ok: false, error: e?.message || String(e) }))
    const changed = (res?.messagesUpdated || 0) + (res?.messagesInserted || 0)
    if (changed > 0) {
      console.log('[inboundMediaBackfill] mídia recuperada via GET /chats/messages', {
        company_id, conversa_id, atualizadas: res.messagesUpdated || 0, inseridas: res.messagesInserted || 0,
      })
    }
  } catch (e) {
    console.warn('[inboundMediaBackfill] falha', { conversa_id, err: e?.message || String(e) })
  } finally {
    _running -= 1
  }
}

/**
 * Agenda (não bloqueia o webhook) um backfill de mídia para a conversa, se necessário.
 *
 * Estratégia: trailing-debounce por conversa.
 * - 1 áudio: dispara após trailingMs (dá tempo do provedor liberar a URL na API).
 * - Rajada: cada nova mensagem reinicia o timer; dispara 1x ao fim da rajada.
 * - Se já há maxConcurrent em execução, pula silenciosamente (a mídia será reparada
 *   pelo sweep periódico do inboundMediaPersistenceService se necessário).
 *
 * @param {{ supabase:any, io:any, company_id:number, conversa_id:number, mensagemSalva:object }} ctx
 */
function scheduleInboundMediaBackfill(ctx) {
  const { supabase, io, company_id, conversa_id, mensagemSalva } = ctx || {}
  if (isBackfillDisabled()) return
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return
  if (company_id == null || conversa_id == null) return
  if (!precisaBackfillMidia(mensagemSalva)) return

  const key = `${company_id}:${conversa_id}`
  const now = Date.now()
  const entry = _debounceMap.get(key) || { lastTs: 0, trailingTimer: null }

  // Reinicia o timer a cada nova mensagem (trailing).
  if (entry.trailingTimer) clearTimeout(entry.trailingTimer)
  entry.lastTs = now
  _debounceMap.set(key, entry)

  if (_running >= maxConcurrent()) return

  const trailing = trailingMs()
  entry.trailingTimer = setTimeout(() => {
    entry.trailingTimer = null
    setImmediate(() => executarBackfill({ supabase, io, company_id, conversa_id }))
  }, trailing)
  if (typeof entry.trailingTimer.unref === 'function') entry.trailingTimer.unref()
}

module.exports = {
  scheduleInboundMediaBackfill,
  precisaBackfillMidia,
  hasUsableMediaUrl,
}
