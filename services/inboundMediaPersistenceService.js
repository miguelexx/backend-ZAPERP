/**
 * Copia mídia inbound (imagem, vídeo, figurinha, áudio/voz, documento/arquivo) da URL remota da UltraMSG para /uploads,
 * para não depender de links com TTL curto. Fluxo do webhook inalterado: corre em background.
 * Não remove arquivos: permanecem no disco enquanto UPLOADS_DIR for persistente (meta: ≥ 3 dias no histórico;
 * depende de volume em disco + backup; URLs remotas da UltraMsg podem expirar em ~24h se a cópia falhar).
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { ensureUploadsRootExists } = require('../config/uploadsRoot')
const { isAllowedInboundMediaUrl } = require('../helpers/allowedInboundMediaUrl')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../helpers/timestampApiCompat')

const MAX_BYTES = Math.max(
  80 * 1024 * 1024,
  (Number(process.env.INBOUND_MEDIA_MAX_MB) || 512) * 1024 * 1024
)
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.INBOUND_MEDIA_FETCH_TIMEOUT_MS) || 30000)
const MAX_REDIRECTS = 3

const MSG_SELECT_PERSIST =
  'id, conversa_id, company_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'

/** Imagem, vídeo, figurinha, áudio/voz e documento — mesma lógica de URL remota com TTL curto (UltraMSG/S3). */
function tipoQualificaPersistencia(tipo) {
  const t = String(tipo || '').toLowerCase()
  return (
    t === 'imagem' ||
    t === 'sticker' ||
    t === 'video' ||
    t === 'audio' ||
    t === 'voice' ||
    t === 'arquivo'
  )
}

function extFromContentType(ct) {
  const c = String(ct || '').split(';')[0].trim().toLowerCase()
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
    'video/3gpp': '.3gp',
    'video/x-m4v': '.m4v',
    'video/x-matroska': '.mkv',
    'video/mpeg': '.mpeg',
    'audio/ogg': '.ogg',
    'audio/opus': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/wav': '.wav',
    'audio/webm': '.webm',
    'audio/amr': '.amr',
    'audio/flac': '.flac',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/msword': '.doc',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.ms-powerpoint': '.ppt',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'application/rtf': '.rtf',
    'text/rtf': '.rtf',
    'application/vnd.oasis.opendocument.text': '.odt',
    'application/vnd.oasis.opendocument.spreadsheet': '.ods',
    'application/vnd.oasis.opendocument.presentation': '.odp',
    'application/epub+zip': '.epub',
  }
  return map[c] || null
}

const ALLOW_EXT_FROM_NAME = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.avif',
  '.heic',
  '.heif',
  '.bmp',
  '.tif',
  '.tiff',
  '.mp4',
  '.mov',
  '.avi',
  '.3gp',
  '.m4v',
  '.mkv',
  '.mpeg',
  '.mpg',
  '.ogg',
  '.opus',
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.webm',
  '.amr',
  '.flac',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
  '.csv',
  '.zip',
  '.rar',
  '.7z',
  '.apk',
  '.json',
  '.xml',
  '.svg',
  '.rtf',
  '.odt',
  '.ods',
  '.odp',
  '.epub',
  '.pages',
  '.numbers',
  '.key',
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
  let ext =
    fromNome ||
    fromCt ||
    (t === 'imagem' ? '.jpg' : t === 'video' ? '.mp4' : t === 'sticker' ? '.webp' : t === 'arquivo' ? '.bin' : '.ogg')
  if (!ext.startsWith('.')) ext = `.${ext}`
  const rand = crypto.randomBytes(6).toString('hex')
  return `inbound-c${Number(company_id)}-m${Number(mensagem_id)}-${rand}${ext}`
}

async function streamBodyToFileWithLimit(webBody, filePath, maxBytes) {
  let received = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      if (received > maxBytes) {
        const error = new Error('inbound_media_too_large')
        error.code = 'INBOUND_MEDIA_TOO_LARGE'
        callback(error)
        return
      }
      callback(null, chunk)
    },
  })
  await pipeline(
    Readable.fromWeb(webBody),
    limiter,
    fs.createWriteStream(filePath, { flags: 'wx' })
  )
  return received
}

async function fetchAllowedInboundMedia(target, signal) {
  let current = target
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const upstream = await fetch(current.href, {
      redirect: 'manual',
      headers: { 'User-Agent': 'ZapERP-InboundMediaPersist/1.0' },
      signal,
    })

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location')
      if (!location) return upstream
      const next = new URL(location, current)
      if (!isAllowedInboundMediaUrl(next)) {
        const err = new Error('redirect_not_allowed')
        err.code = 'REDIRECT_NOT_ALLOWED'
        throw err
      }
      current = next
      continue
    }

    return upstream
  }

  const err = new Error('too_many_redirects')
  err.code = 'TOO_MANY_REDIRECTS'
  throw err
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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    upstream = await fetchAllowedInboundMedia(parsed, controller.signal)
  } catch (e) {
    const timedOut = e?.name === 'AbortError'
    console.warn('[inboundMediaPersist] fetch:', mensagem_id, timedOut ? 'timeout' : (e?.message || e))
    return
  } finally {
    clearTimeout(timeout)
  }

  if (!upstream.ok) {
    console.warn('[inboundMediaPersist] upstream não OK:', mensagem_id, upstream.status)
    return
  }

  const cl = upstream.headers.get('content-length')
  const esperado = Number(cl)
  if (Number.isFinite(esperado) && esperado > MAX_BYTES) {
    console.warn('[inboundMediaPersist] arquivo muito grande (content-length):', mensagem_id)
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
  const partialPath = `${absPath}.part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  let recebido = 0

  try {
    if (upstream.body && typeof upstream.body.getReader === 'function') {
      // A resposta real do fetch é um Web ReadableStream. Grave por streaming para que
      // documentos grandes não ocupem centenas de MB de heap e possam ser preservados.
      recebido = await streamBodyToFileWithLimit(upstream.body, partialPath, MAX_BYTES)
      if (Number.isFinite(esperado) && esperado > 0 && recebido !== esperado) {
        console.warn('[inboundMediaPersist] download incompleto; não persiste:', {
          company_id, mensagem_id, tipo: row.tipo, esperado, recebido,
        })
        await fs.promises.unlink(partialPath).catch(() => {})
        return
      }
      if (recebido === 0) {
        console.warn('[inboundMediaPersist] corpo vazio; não persiste:', { company_id, mensagem_id, tipo: row.tipo })
        await fs.promises.unlink(partialPath).catch(() => {})
        return
      }
      await fs.promises.rename(partialPath, absPath)
    } else {
      // Compatibilidade com respostas simuladas nos testes e runtimes antigos sem body stream.
      const arrayBuffer = await upstream.arrayBuffer()
      recebido = arrayBuffer.byteLength
      if (recebido > MAX_BYTES) {
        console.warn('[inboundMediaPersist] arquivo muito grande (body):', mensagem_id)
        return
      }
      if (Number.isFinite(esperado) && esperado > 0 && recebido !== esperado) {
        console.warn('[inboundMediaPersist] download incompleto; não persiste:', {
          company_id, mensagem_id, tipo: row.tipo, esperado, recebido,
        })
        return
      }
      if (recebido === 0) {
        console.warn('[inboundMediaPersist] corpo vazio; não persiste:', { company_id, mensagem_id, tipo: row.tipo })
        return
      }
      await fs.promises.writeFile(absPath, Buffer.from(arrayBuffer))
    }
  } catch (e) {
    await fs.promises.unlink(partialPath).catch(() => {})
    await fs.promises.unlink(absPath).catch(() => {})
    if (e?.code === 'INBOUND_MEDIA_TOO_LARGE') {
      console.warn('[inboundMediaPersist] arquivo muito grande (stream):', mensagem_id)
      return
    }
    console.warn('[inboundMediaPersist] falha ao salvar arquivo:', mensagem_id, e?.message || e)
    return
  }

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
    // fromMe deriva da direção real gravada (row/updated), não do parâmetro: o retry batch
    // passa fromMe:false fixo, o que inverteria o flag para mídia outbound e poderia
    // disparar notificação/som de mensagem nossa no frontend.
    const fromMeReal = String(updated.direcao ?? row.direcao ?? '').toLowerCase() === 'out'
    const rawStatus = String(updated.status_mensagem ?? updated.status ?? '').toLowerCase()
    const canon =
      rawStatus === 'enviada' || rawStatus === 'enviado'
        ? 'sent'
        : rawStatus === 'entregue' || rawStatus === 'received'
          ? 'delivered'
          : rawStatus || (fromMeReal ? 'sent' : 'delivered')

    const emitPayload = {
      ...updated,
      criado_em: normalizarTimestampSemFusoAmbiguoParaApi(updated.criado_em),
      conversa_id,
      status: canon,
      status_mensagem: canon,
      fromMe: fromMeReal,
      direcao: updated.direcao ?? (fromMeReal ? 'out' : 'in'),
    }
    try {
      const { emitirParaUsuariosQuePodemVerConversa } = require('../controllers/chatController')
      const emitted = await emitirParaUsuariosQuePodemVerConversa(
        io,
        company_id,
        conversa_id,
        io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem',
        emitPayload
      )
      if (!emitted) io.to(`conversa_${conversa_id}`).emit(io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', emitPayload)
    } catch (_) {
      io.to(`conversa_${conversa_id}`).emit(io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', emitPayload)
    }
  }
}

const TIPOS_HTTPS_RETRY = ['imagem', 'sticker', 'video', 'audio', 'voice', 'arquivo']

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
  _test: {
    persistInboundMediaToUploads,
    extFromContentType,
    safeExtFromNomeArquivo,
    pickStoredFilename,
  },
}
