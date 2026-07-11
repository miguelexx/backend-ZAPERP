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

const _debounceMap = new Map() // key: `${company_id}:${conversa_id}` -> ts do último disparo
let _running = 0

setInterval(() => {
  const cutoff = Date.now() - debounceMs()
  for (const [key, ts] of _debounceMap.entries()) {
    if (ts < cutoff) _debounceMap.delete(key)
  }
}, 5 * 60 * 1000).unref()

/**
 * Agenda (não bloqueia o webhook) um backfill de mídia para a conversa, se necessário.
 * @param {{ supabase:any, io:any, company_id:number, conversa_id:number, mensagemSalva:object }} ctx
 */
function scheduleInboundMediaBackfill(ctx) {
  const { company_id, conversa_id, mensagemSalva } = ctx || {}
  if (isBackfillDisabled()) return
  if (company_id == null || conversa_id == null) return
  if (!precisaBackfillMidia(mensagemSalva)) return

  const key = `${company_id}:${conversa_id}`
  const now = Date.now()
  const last = _debounceMap.get(key)
  if (last && now - last < debounceMs()) return // já agendado recentemente
  _debounceMap.set(key, now)

  if (_running >= maxConcurrent()) return // proteção de carga; próxima mensagem re-agenda

  setImmediate(async () => {
    _running += 1
    try {
      const { syncOldMessagesForConversation } = require('./oldMessagesSyncService')
      const res = await syncOldMessagesForConversation(company_id, Number(conversa_id), {
        io: ctx.io || null,
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
  })
}

module.exports = {
  scheduleInboundMediaBackfill,
  precisaBackfillMidia,
  hasUsableMediaUrl,
}
