/**
 * Copia mídia inbound (imagem, vídeo, figurinha, áudio/voz) da URL remota da UltraMSG para /uploads,
 * para não depender de links com TTL curto. Fluxo do webhook inalterado: corre em background.
 * Não remove arquivos: permanecem no disco enquanto UPLOADS_DIR for persistente (meta: ≥ 3 dias no histórico;
 * depende de volume em disco + backup; URLs remotas da UltraMsg podem expirar em ~24h se a cópia falhar).
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { ensureUploadsRootExists } = require('../config/uploadsRoot')
const { isAllowedInboundMediaUrl } = require('../helpers/allowedInboundMediaUrl')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../helpers/timestampApiCompat')

const MAX_BYTES = 80 * 1024 * 1024

const MSG_SELECT_PERSIST =
  'id, conversa_id, company_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'

/** Imagem, vídeo, figurinha e áudio/voz — mesma lógica de URL remota com TTL curto. */
function tipoQualificaPersistencia(tipo) {
  const t = String(tipo || '').toLowerCase()
  return t === 'imagem' || t === 'sticker' || t === 'video' || t === 'audio' || t === 'voice'
}

function extFromContentType(ct) {
  const c = String(ct || '').split(';')[0].trim().toLowerCase()
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'audio/ogg': '.ogg',
    'audio/opus': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/wav': '.wav',
    'audio/webm': '.webm',
  }
  return map[c] || null
}

const ALLOW_EXT_FROM_NAME = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.mp4',
  '.mov',
  '.ogg',
  '.opus',
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.webm',
])

function safeExtFromNomeArquivo(nome) {
  const base = path.basename(String(nome || ''))
  const m = base.match(/(\.[a-z0-9]{2,8})$/i)
  if (!m) return null
  const e = m[1].toLowerCase()
  if (e === '.jpeg') return '.jpg'
  return ALLOW_EXT_FROM_NAME.has(e) ? e : null
}

function pickStoredFilename({ company_id, mensagem_id, contentType, nome_arquivo, tipo }) {
  const fromNome = safeExtFromNomeArquivo(nome_arquivo)
  const fromCt = extFromContentType(contentType)
  const t = String(tipo || '').toLowerCase()
  let ext = fromNome || fromCt || (t === 'imagem' ? '.jpg' : t === 'video' ? '.mp4' : t === 'sticker' ? '.webp' : '.ogg')
  if (!ext.startsWith('.')) ext = `.${ext}`
  const rand = crypto.randomBytes(6).toString('hex')
  return `inbound-c${Number(company_id)}-m${Number(mensagem_id)}-${rand}${ext}`
}

/**
 * Agenda persistência assíncrona (não bloqueia resposta do webhook).
 * @param {{ supabase: any, io: any|null, company_id: number, mensagem_id: number, fromMe?: boolean, departamento_id?: any }} ctx
 */
function schedulePersistInboundMediaIfNeeded(ctx) {
  const { supabase, io, company_id, mensagem_id, fromMe } = ctx || {}
  if (!supabase || company_id == null || mensagem_id == null) return
  setImmediate(() => {
    persistInboundMediaToUploads({ supabase, io, company_id, mensagem_id, fromMe: !!fromMe }).catch((e) => {
      console.warn('[inboundMediaPersist] falha assíncrona:', { mensagem_id, err: e?.message || String(e) })
    })
  })
}

async function persistInboundMediaToUploads({ supabase, io, company_id, mensagem_id, fromMe }) {
  const { data: row, error: selErr } = await supabase
    .from('mensagens')
    .select(MSG_SELECT_PERSIST)
    .eq('id', mensagem_id)
    .eq('company_id', company_id)
    .maybeSingle()

  if (selErr || !row) return
  if (!tipoQualificaPersistencia(row.tipo)) return

  const remoteUrl = String(row.url || '').trim()
  if (!remoteUrl.startsWith('https://')) return

  let parsed
  try {
    parsed = new URL(remoteUrl)
  } catch {
    return
  }
  if (!isAllowedInboundMediaUrl(parsed)) {
    console.warn('[inboundMediaPersist] URL fora da allowlist; ignorando:', { mensagem_id, host: parsed.hostname })
    return
  }

  let upstream
  try {
    upstream = await fetch(parsed.href, {
      redirect: 'follow',
      headers: { 'User-Agent': 'ZapERP-InboundMediaPersist/1.0' },
    })
  } catch (e) {
    console.warn('[inboundMediaPersist] fetch:', mensagem_id, e?.message || e)
    return
  }

  if (!upstream.ok) {
    console.warn('[inboundMediaPersist] upstream não OK:', mensagem_id, upstream.status)
    return
  }

  const cl = upstream.headers.get('content-length')
  if (cl && Number(cl) > MAX_BYTES) {
    console.warn('[inboundMediaPersist] arquivo muito grande (content-length):', mensagem_id)
    return
  }

  const arrayBuffer = await upstream.arrayBuffer()
  if (arrayBuffer.byteLength > MAX_BYTES) {
    console.warn('[inboundMediaPersist] arquivo muito grande (body):', mensagem_id)
    return
  }

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
  const storedName = pickStoredFilename({
    company_id,
    mensagem_id,
    contentType,
    nome_arquivo: row.nome_arquivo,
    tipo: row.tipo,
  })

  const root = ensureUploadsRootExists()
  const absPath = path.join(root, storedName)
  await fs.promises.writeFile(absPath, Buffer.from(arrayBuffer))

  const publicPath = `/uploads/${storedName}`
  const nomeFinal = row.nome_arquivo && String(row.nome_arquivo).trim() ? String(row.nome_arquivo).trim() : storedName

  const { data: updated, error: upErr } = await supabase
    .from('mensagens')
    .update({ url: publicPath, nome_arquivo: nomeFinal })
    .eq('id', mensagem_id)
    .eq('company_id', company_id)
    .ilike('url', 'https%')
    .select(MSG_SELECT_PERSIST)
    .maybeSingle()

  if (upErr) {
    try {
      await fs.promises.unlink(absPath)
    } catch (_) {}
    console.warn('[inboundMediaPersist] update DB:', mensagem_id, upErr.message)
    return
  }

  if (!updated) {
    // Outro processo já trocou a URL, ou concorrente: remove ficheiro órfão
    try {
      await fs.promises.unlink(absPath)
    } catch (_) {}
    return
  }

  if (io) {
    const conversa_id = updated.conversa_id
    const rooms = [`conversa_${conversa_id}`, `empresa_${company_id}`]
    const rawStatus = String(updated.status_mensagem ?? updated.status ?? '').toLowerCase()
    const canon =
      rawStatus === 'enviada' || rawStatus === 'enviado'
        ? 'sent'
        : rawStatus === 'entregue' || rawStatus === 'received'
          ? 'delivered'
          : rawStatus || (fromMe ? 'sent' : 'delivered')

    const emitPayload = {
      ...updated,
      criado_em: normalizarTimestampSemFusoAmbiguoParaApi(updated.criado_em),
      conversa_id,
      status: canon,
      status_mensagem: canon,
      fromMe,
      direcao: updated.direcao ?? (fromMe ? 'out' : 'in'),
    }
    io.to(rooms).emit(io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', emitPayload)
  }
}

const TIPOS_HTTPS_RETRY = ['imagem', 'sticker', 'video', 'audio', 'voice']

/**
 * Reprocessa mensagens ainda com URL https (falha transitória na 1ª cópia, ou allowlist ampliada depois).
 * Ajuda a não perder mídia quando o link remoto expira em ~24h.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {any} [io] Socket.IO (opcional; se ausente, não emite nova_mensagem após migrar)
 * @returns {Promise<{ attempted: number, migratedToUploads: number }>}
 */
async function runInboundMediaPersistenceRetryBatch(supabase, io = null) {
  const out = { attempted: 0, migratedToUploads: 0 }
  if (!supabase) return out
  if (String(process.env.INBOUND_MEDIA_RETRY_DISABLED || '').trim() === '1') return out

  const batch = Math.min(
    120,
    Math.max(1, Number(process.env.INBOUND_MEDIA_RETRY_BATCH) || 45)
  )
  const maxAgeH = Math.min(
    720,
    Math.max(6, Number(process.env.INBOUND_MEDIA_RETRY_MAX_AGE_HOURS) || 168)
  )
  const sinceIso = new Date(Date.now() - maxAgeH * 3600000).toISOString()

  const { data: rows, error } = await supabase
    .from('mensagens')
    .select('id, company_id')
    .in('tipo', TIPOS_HTTPS_RETRY)
    .like('url', 'https%')
    .gte('criado_em', sinceIso)
    .order('id', { ascending: true })
    .limit(batch)

  if (error) {
    console.warn('[inboundMediaPersist/retry] query:', error.message)
    return out
  }

  for (const r of rows || []) {
    const mid = Number(r.id)
    const cid = Number(r.company_id)
    if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(cid) || cid <= 0) continue

    let urlBefore = ''
    try {
      const { data: u0, error: e0 } = await supabase
        .from('mensagens')
        .select('url')
        .eq('id', mid)
        .eq('company_id', cid)
        .maybeSingle()
      if (e0 || !u0) continue
      urlBefore = String(u0.url || '').trim()
      if (!urlBefore.startsWith('https://')) continue
    } catch {
      continue
    }

    out.attempted += 1
    try {
      await persistInboundMediaToUploads({ supabase, io, company_id: cid, mensagem_id: mid, fromMe: false })
    } catch (e) {
      console.warn('[inboundMediaPersist/retry] persist', mid, e?.message || e)
      continue
    }

    try {
      const { data: u1 } = await supabase.from('mensagens').select('url').eq('id', mid).eq('company_id', cid).maybeSingle()
      const after = String(u1?.url || '').trim()
      if (after.startsWith('/uploads/')) out.migratedToUploads += 1
    } catch {
      /* ignore */
    }
  }

  return out
}

/**
 * Agenda reintentos periódicos (default: 3h). Desligar: INBOUND_MEDIA_RETRY_DISABLED=1
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {any} [io]
 * @returns {() => void} cancela o intervalo
 */
function startInboundMediaRetryScheduler(supabase, io) {
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return () => {}
  if (String(process.env.INBOUND_MEDIA_RETRY_DISABLED || '').trim() === '1') return () => {}

  const intervalMs = Math.max(
    30 * 60 * 1000,
    Number(process.env.INBOUND_MEDIA_RETRY_INTERVAL_MS) || 3 * 60 * 60 * 1000
  )

  const tick = async () => {
    try {
      const r = await runInboundMediaPersistenceRetryBatch(supabase, io)
      if (r.attempted > 0) {
        console.log('[inboundMediaPersist/retry]', {
          attempted: r.attempted,
          migratedToUploads: r.migratedToUploads,
        })
      }
    } catch (e) {
      console.warn('[inboundMediaPersist/retry] tick', e?.message || e)
    }
  }

  setImmediate(tick)
  const id = setInterval(tick, intervalMs)
  return () => clearInterval(id)
}

module.exports = {
  tipoQualificaPersistencia,
  schedulePersistInboundMediaIfNeeded,
  runInboundMediaPersistenceRetryBatch,
  startInboundMediaRetryScheduler,
}
