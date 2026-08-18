/**
 * Copia mídia inbound (imagem, vídeo, figurinha, áudio/voz, documento/arquivo) da URL remota da UltraMSG para /uploads,
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
const {
  resolveInboundAudioExtension,
  audioExtensionFromContentType,
} = require('../helpers/audioFormatSniffer')
const {
  MAX_TENTATIVAS,
  STATUS,
  classificarFalha,
  planejarProximaTentativa,
  resumoUrlParaLog,
} = require('../helpers/inboundMediaRetryPolicy')

const MAX_BYTES = 80 * 1024 * 1024
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.INBOUND_MEDIA_FETCH_TIMEOUT_MS) || 30000)
const MAX_REDIRECTS = 3

/** Um pouco acima do timeout de download: se o processo morrer no meio, o lock expira sozinho. */
const LOCK_TTL_MS = FETCH_TIMEOUT_MS + 60 * 1000

const MSG_SELECT_PERSIST =
  'id, conversa_id, company_id, whatsapp_id, texto, url, tipo, direcao, criado_em, status, autor_usuario_id, reply_meta, nome_arquivo, contact_meta, location_meta, remetente_nome, remetente_telefone'

const ESTADO_COLUNAS =
  'midia_persist_status, midia_persist_tentativas, midia_persist_erro, midia_persist_erro_tipo, midia_persist_ultima_em, midia_persist_proxima_em, midia_persist_lock_ate'

/**
 * A migration 20260804153000 pode não estar aplicada. Nesse caso o serviço continua copiando e
 * retentando — apenas em memória, sem estado entre reinícios e sem lock entre instâncias.
 */
let _estadoPersistenciaIndisponivel = false

function isEstadoColunaAusente(error) {
  const texto = [error?.message, error?.details, error?.hint, error?.code].filter(Boolean).join(' ').toLowerCase()
  if (!texto) return false
  return (
    texto.includes('midia_persist') ||
    texto.includes('does not exist') ||
    texto.includes('schema cache') ||
    texto.includes('could not find') ||
    texto.includes('42703') ||
    texto.includes('pgrst204')
  )
}

/** Uma cópia por mídia dentro deste processo; entre instâncias quem protege é midia_persist_lock_ate. */
const emExecucao = new Set()
const retentativasAgendadas = new Map()

function chaveMidia(company_id, mensagem_id) {
  return `${Number(company_id)}:${Number(mensagem_id)}`
}

function retentativaEmProcessoDesligada() {
  return (
    process.env.NODE_ENV === 'test' ||
    !!process.env.JEST_WORKER_ID ||
    String(process.env.INBOUND_MEDIA_RETRY_DISABLED || '').trim() === '1'
  )
}

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

/** Áudio e voz decidem a extensão pelo conteúdo real, não pelo Content-Type/nome. */
function ehTipoAudio(tipo) {
  const t = String(tipo || '').toLowerCase()
  return t === 'audio' || t === 'voice'
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
  }
  if (map[c]) return map[c]
  const audioExt = audioExtensionFromContentType(c)
  return audioExt ? `.${audioExt}` : null
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
  '.oga',
  '.opus',
  '.mp3',
  '.m4a',
  '.aac',
  '.amr',
  '.wav',
  '.webm',
  '.3gp',
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
])

function safeExtFromNomeArquivo(nome) {
  const base = path.basename(String(nome || ''))
  const m = base.match(/(\.[a-z0-9]{2,8})$/i)
  if (!m) return null
  const e = m[1].toLowerCase()
  if (e === '.jpeg') return '.jpg'
  return ALLOW_EXT_FROM_NAME.has(e) ? e : null
}

/**
 * Nome exibido/baixado. A UltraMSG manda literalmente "audio" para voz, sem extensão; nesse caso
 * usa o nome em disco, que já carrega a extensão do formato real. Nomes que o provedor mandou
 * completos são preservados.
 */
function nomeArquivoFinal(nomeOriginal, storedName) {
  const nome = String(nomeOriginal || '').trim()
  if (!nome) return storedName
  return /\.[a-z0-9]{2,8}$/i.test(nome) ? nome : storedName
}

/**
 * Nome do arquivo em /uploads. Para áudio/voz a extensão vem do conteúdo real (ver
 * audioFormatSniffer) e retorna null quando nenhuma fonte confirma o formato: gravar com extensão
 * chutada deixa o áudio inaudível para sempre, enquanto não migrar mantém a URL do provedor
 * funcionando pelo proxy. Os demais tipos preservam a cascata original (nome → Content-Type → padrão
 * do tipo), que já vinha acertando.
 * @returns {{ filename: string, extSource: string }|null}
 */
function pickStoredFilename({ company_id, mensagem_id, contentType, nome_arquivo, tipo, buffer }) {
  const t = String(tipo || '').toLowerCase()
  let ext
  let extSource

  if (ehTipoAudio(t)) {
    const resolvido = resolveInboundAudioExtension({
      buffer,
      contentType,
      filename: nome_arquivo,
    })
    if (!resolvido) return null
    ext = `.${resolvido.ext}`
    extSource = resolvido.source
  } else {
    const fromNome = safeExtFromNomeArquivo(nome_arquivo)
    const fromCt = extFromContentType(contentType)
    ext =
      fromNome ||
      fromCt ||
      (t === 'imagem' ? '.jpg' : t === 'video' ? '.mp4' : t === 'sticker' ? '.webp' : '.bin')
    extSource = fromNome ? 'filename' : fromCt ? 'content-type' : 'tipo-padrao'
  }

  if (!ext.startsWith('.')) ext = `.${ext}`
  const rand = crypto.randomBytes(6).toString('hex')
  return {
    filename: `inbound-c${Number(company_id)}-m${Number(mensagem_id)}-${rand}${ext}`,
    extSource,
  }
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

/** Lê a mensagem com o estado de persistência, degradando se a migration não estiver aplicada. */
async function carregarMensagem(supabase, company_id, mensagem_id) {
  if (!_estadoPersistenciaIndisponivel) {
    const { data, error } = await supabase
      .from('mensagens')
      .select(`${MSG_SELECT_PERSIST}, ${ESTADO_COLUNAS}`)
      .eq('id', mensagem_id)
      .eq('company_id', company_id)
      .maybeSingle()
    if (!error) return data || null
    if (!isEstadoColunaAusente(error)) return null
    _estadoPersistenciaIndisponivel = true
    console.warn(
      '[inboundMediaPersist] colunas de estado ausentes; retentativas seguem só em memória. Aplique a migration 20260804153000_mensagens_midia_persistencia_estado.sql'
    )
  }

  const { data, error } = await supabase
    .from('mensagens')
    .select(MSG_SELECT_PERSIST)
    .eq('id', mensagem_id)
    .eq('company_id', company_id)
    .maybeSingle()
  return error ? null : data || null
}

async function gravarEstado(supabase, company_id, mensagem_id, campos) {
  if (_estadoPersistenciaIndisponivel) return
  const { error } = await supabase
    .from('mensagens')
    .update(campos)
    .eq('id', mensagem_id)
    .eq('company_id', company_id)
  if (!error) return
  if (isEstadoColunaAusente(error)) _estadoPersistenciaIndisponivel = true
  else console.warn('[inboundMediaPersist] não foi possível gravar estado:', { mensagem_id, erro: error.message })
}

/**
 * Lock entre instâncias: o UPDATE condicional só afeta a linha se ninguém mais tiver o lock vigente,
 * e o PostgREST devolve a linha apenas para quem venceu a corrida.
 */
async function adquirirLockRemoto(supabase, company_id, mensagem_id, agora) {
  if (_estadoPersistenciaIndisponivel) return true
  const agoraIso = agora.toISOString()
  const { data, error } = await supabase
    .from('mensagens')
    .update({ midia_persist_lock_ate: new Date(agora.getTime() + LOCK_TTL_MS).toISOString() })
    .eq('id', mensagem_id)
    .eq('company_id', company_id)
    .or(`midia_persist_lock_ate.is.null,midia_persist_lock_ate.lt.${agoraIso}`)
    .select('id')
    .maybeSingle()

  if (error) {
    if (isEstadoColunaAusente(error)) {
      _estadoPersistenciaIndisponivel = true
      return true
    }
    console.warn('[inboundMediaPersist] lock indisponível:', { mensagem_id, erro: error.message })
    return false
  }
  return !!data
}

function agendarRetentativaEmProcesso(ctx, quando) {
  if (!quando || retentativaEmProcessoDesligada()) return false
  const chave = chaveMidia(ctx.company_id, ctx.mensagem_id)
  if (retentativasAgendadas.has(chave)) return false
  const atraso = Math.max(0, quando.getTime() - Date.now())
  const timer = setTimeout(() => {
    retentativasAgendadas.delete(chave)
    persistInboundMediaToUploads(ctx).catch((e) => {
      console.warn('[inboundMediaPersist] retentativa falhou:', { mensagem_id: ctx.mensagem_id, erro: e?.message || String(e) })
    })
  }, atraso)
  if (typeof timer.unref === 'function') timer.unref()
  retentativasAgendadas.set(chave, timer)
  return true
}

/**
 * Fecha uma tentativa que falhou: classifica, decide se ainda vale retentar, grava o estado e agenda
 * a próxima janela. A URL remota permanece intacta em qualquer caso.
 */
async function registrarFalha(ctx, row, { motivo, status }) {
  const { supabase, company_id, mensagem_id } = ctx
  const agora = new Date()
  const classificada = classificarFalha({ motivo, status })
  const tentativas = (Number(row?.midia_persist_tentativas) || 0) + 1
  const plano = planejarProximaTentativa({
    tentativas,
    tipo: classificada.tipo,
    motivo: classificada.motivo,
    agora,
  })

  await gravarEstado(supabase, company_id, mensagem_id, {
    midia_persist_status: plano.status,
    midia_persist_tentativas: plano.tentativas,
    midia_persist_erro: plano.motivo,
    midia_persist_erro_tipo: plano.tipo,
    midia_persist_ultima_em: agora.toISOString(),
    midia_persist_proxima_em: plano.proximaEm ? plano.proximaEm.toISOString() : null,
    midia_persist_lock_ate: null,
  })

  console.warn('[inboundMediaPersist] tentativa falhou', {
    mensagem_id,
    company_id,
    tipo: row?.tipo || null,
    motivo: plano.motivo,
    falha: plano.tipo,
    tentativa: `${plano.tentativas}/${MAX_TENTATIVAS}`,
    status: plano.status,
    proxima_em: plano.proximaEm ? plano.proximaEm.toISOString() : null,
    origem: resumoUrlParaLog(row?.url),
  })

  const agendada = agendarRetentativaEmProcesso(ctx, plano.proximaEm)
  return { ok: false, motivo: plano.motivo, tipo: plano.tipo, status: plano.status, proximaEm: plano.proximaEm, agendada }
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

/**
 * Copia a mídia para /uploads. A URL do banco só muda depois de o arquivo existir em disco com o
 * tamanho exato baixado — até lá a URL do provedor continua servindo a reprodução.
 * @returns {Promise<{ ok: boolean, [k: string]: any }>}
 */
async function persistInboundMediaToUploads({ supabase, io, company_id, mensagem_id, fromMe, force = false }) {
  const ctx = { supabase, io, company_id, mensagem_id, fromMe }
  const chave = chaveMidia(company_id, mensagem_id)
  if (emExecucao.has(chave)) return { ok: false, ignorado: 'em_execucao' }
  emExecucao.add(chave)

  try {
    const row = await carregarMensagem(supabase, company_id, mensagem_id)
    if (!row) return { ok: false, ignorado: 'mensagem_ausente' }
    if (!tipoQualificaPersistencia(row.tipo)) return { ok: false, ignorado: 'tipo_nao_qualifica' }

    const remoteUrl = String(row.url || '').trim()
    // Confirma antes de qualquer download que a cópia não foi concluída por outra tentativa.
    if (remoteUrl.startsWith('/uploads/')) return { ok: true, ignorado: 'ja_persistido' }
    if (!remoteUrl.startsWith('https://')) return { ok: false, ignorado: 'sem_url_remota' }
    if (!force && row.midia_persist_status === STATUS.FALHA_DEFINITIVA) {
      return { ok: false, ignorado: 'falha_definitiva' }
    }

    let parsed
    try {
      parsed = new URL(remoteUrl)
    } catch {
      return registrarFalha(ctx, row, { motivo: 'url_invalida' })
    }
    if (!isAllowedInboundMediaUrl(parsed)) {
      // Sem gastar tentativa nem marcar definitivo: a allowlist é configuração e pode passar a
      // aceitar este host depois, e aí a varredura ampla ainda encontra a mídia.
      console.warn('[inboundMediaPersist] URL fora da allowlist; ignorando:', { mensagem_id, host: parsed.hostname })
      return { ok: false, ignorado: 'url_fora_allowlist' }
    }

    const agora = new Date()
    if (!(await adquirirLockRemoto(supabase, company_id, mensagem_id, agora))) {
      return { ok: false, ignorado: 'lock_de_outra_instancia' }
    }

    let upstream
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      upstream = await fetchAllowedInboundMedia(parsed, controller.signal)
    } catch (e) {
      const timedOut = e?.name === 'AbortError'
      const motivo =
        timedOut ? 'timeout'
          : e?.code === 'REDIRECT_NOT_ALLOWED' ? 'redirect_fora_allowlist'
            : e?.code === 'TOO_MANY_REDIRECTS' ? 'redirects_demais'
              : 'rede'
      return registrarFalha(ctx, row, { motivo })
    } finally {
      clearTimeout(timeout)
    }

    if (!upstream.ok) {
      return registrarFalha(ctx, row, { motivo: 'http', status: upstream.status })
    }

    const cl = upstream.headers.get('content-length')
    if (cl && Number(cl) > MAX_BYTES) {
      return registrarFalha(ctx, row, { motivo: 'arquivo_grande_demais' })
    }

    const arrayBuffer = await upstream.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_BYTES) {
      return registrarFalha(ctx, row, { motivo: 'arquivo_grande_demais' })
    }
    if (arrayBuffer.byteLength === 0) {
      return registrarFalha(ctx, row, { motivo: 'corpo_vazio' })
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
    const bytes = Buffer.from(arrayBuffer)
    const escolhido = pickStoredFilename({
      company_id,
      mensagem_id,
      contentType,
      nome_arquivo: row.nome_arquivo,
      tipo: row.tipo,
      buffer: bytes,
    })

    if (!escolhido) {
      console.warn('[inboundMediaPersist] formato de áudio não identificado; mantém URL remota:', {
        mensagem_id,
        tipo: row.tipo,
        contentType,
        nome_arquivo: row.nome_arquivo || null,
        bytes: bytes.length,
      })
      return registrarFalha(ctx, row, { motivo: 'formato_nao_identificado' })
    }

    const { filename: storedName, extSource } = escolhido

    // Assinatura não reconhecida: a extensão veio de palpite auxiliar e pode não bater com o conteúdo.
    if (ehTipoAudio(row.tipo) && extSource !== 'magic-bytes') {
      console.warn('[inboundMediaPersist] extensão de áudio por fonte auxiliar:', {
        mensagem_id,
        fonte: extSource,
        contentType,
        arquivo: storedName,
      })
    }

    const root = ensureUploadsRootExists()
    const absPath = path.join(root, storedName)
    // Grava num parcial e só renomeia depois de conferir o tamanho: /uploads nunca expõe o nome
    // definitivo apontando para um arquivo truncado.
    const parcialPath = `${absPath}.part`
    try {
      await fs.promises.writeFile(parcialPath, bytes)
      const stat = await fs.promises.stat(parcialPath)
      if (stat.size !== bytes.length) {
        throw Object.assign(new Error('tamanho divergente'), { __motivo: 'arquivo_incompleto' })
      }
      await fs.promises.rename(parcialPath, absPath)
    } catch (e) {
      await removerArquivo(parcialPath)
      await removerArquivo(absPath)
      return registrarFalha(ctx, row, { motivo: e?.__motivo || 'escrita_disco' })
    }

    const publicPath = `/uploads/${storedName}`
    const nomeFinal = nomeArquivoFinal(row.nome_arquivo, storedName)

    const { data: updated, error: upErr } = await supabase
      .from('mensagens')
      .update({ url: publicPath, nome_arquivo: nomeFinal })
      .eq('id', mensagem_id)
      .eq('company_id', company_id)
      .ilike('url', 'https%')
      .select(MSG_SELECT_PERSIST)
      .maybeSingle()

    if (upErr) {
      await removerArquivo(absPath)
      console.warn('[inboundMediaPersist] update DB:', mensagem_id, upErr.message)
      return registrarFalha(ctx, row, { motivo: 'update_db' })
    }

    if (!updated) {
      // Outra tentativa já trocou a URL: o arquivo baixado aqui é órfão.
      await removerArquivo(absPath)
      await gravarEstado(supabase, company_id, mensagem_id, { midia_persist_lock_ate: null })
      return { ok: true, ignorado: 'ja_persistido' }
    }

    await gravarEstado(supabase, company_id, mensagem_id, {
      midia_persist_status: STATUS.CONCLUIDA,
      midia_persist_tentativas: (Number(row.midia_persist_tentativas) || 0) + 1,
      midia_persist_erro: null,
      midia_persist_erro_tipo: null,
      midia_persist_ultima_em: new Date().toISOString(),
      midia_persist_proxima_em: null,
      midia_persist_lock_ate: null,
    })

    console.log('[inboundMediaPersist] mídia copiada', {
      mensagem_id,
      company_id,
      tipo: row.tipo,
      arquivo: storedName,
      bytes: bytes.length,
      tentativa: (Number(row.midia_persist_tentativas) || 0) + 1,
      origem: resumoUrlParaLog(parsed),
    })

    await emitirMidiaAtualizada({ io, company_id, row, updated })
    // Rollout R2 (empresa habilitada): espelha o arquivo recém-copiado para o Cloudflare R2
    // em background. No-op para as demais empresas — o fluxo em disco acima permanece intacto.
    try {
      const { scheduleR2MirrorIfNeeded } = require('./mediaR2MirrorService')
      scheduleR2MirrorIfNeeded({ supabase, io, company_id, mensagem_id })
    } catch (_) { /* espelhamento é best-effort; nunca afeta a cópia local */ }

    return { ok: true, url: publicPath, arquivo: storedName }
  } finally {
    emExecucao.delete(chave)
  }
}

async function removerArquivo(p) {
  try {
    await fs.promises.unlink(p)
  } catch (_) {
    /* arquivo pode nem ter sido criado */
  }
}

async function emitirMidiaAtualizada({ io, company_id, row, updated }) {
  if (!io) return

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

  const consultar = (comEstado) => {
    let q = supabase
      .from('mensagens')
      .select('id, company_id')
      .in('tipo', TIPOS_HTTPS_RETRY)
      .like('url', 'https%')
      .gte('criado_em', sinceIso)
    // Já decidido que não adianta insistir: fora da varredura ampla.
    if (comEstado) q = q.or(`midia_persist_status.is.null,midia_persist_status.neq.${STATUS.FALHA_DEFINITIVA}`)
    return q.order('id', { ascending: true }).limit(batch)
  }

  let { data: rows, error } = await consultar(!_estadoPersistenciaIndisponivel)

  if (error && !_estadoPersistenciaIndisponivel && isEstadoColunaAusente(error)) {
    _estadoPersistenciaIndisponivel = true
    ;({ data: rows, error } = await consultar(false))
  }

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
 * Executa as retentativas cujo horário já chegou. É o que faz o backoff progressivo sobreviver a um
 * restart: os timers em memória morrem com o processo, mas midia_persist_proxima_em permanece.
 * @returns {Promise<{ due: number, migratedToUploads: number }>}
 */
async function runInboundMediaDueRetryBatch(supabase, io = null) {
  const out = { due: 0, migratedToUploads: 0 }
  if (!supabase || _estadoPersistenciaIndisponivel) return out
  if (String(process.env.INBOUND_MEDIA_RETRY_DISABLED || '').trim() === '1') return out

  const batch = Math.min(120, Math.max(1, Number(process.env.INBOUND_MEDIA_DUE_BATCH) || 25))

  const { data: rows, error } = await supabase
    .from('mensagens')
    .select('id, company_id')
    .eq('midia_persist_status', STATUS.PENDENTE)
    .lte('midia_persist_proxima_em', new Date().toISOString())
    .order('midia_persist_proxima_em', { ascending: true })
    .limit(batch)

  if (error) {
    if (isEstadoColunaAusente(error)) {
      _estadoPersistenciaIndisponivel = true
      return out
    }
    console.warn('[inboundMediaPersist/due] query:', error.message)
    return out
  }

  for (const r of rows || []) {
    const mid = Number(r.id)
    const cid = Number(r.company_id)
    if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(cid) || cid <= 0) continue
    out.due += 1
    try {
      const res = await persistInboundMediaToUploads({ supabase, io, company_id: cid, mensagem_id: mid, fromMe: false })
      if (res?.ok && res?.url) out.migratedToUploads += 1
    } catch (e) {
      console.warn('[inboundMediaPersist/due] persist', mid, e?.message || e)
    }
  }

  return out
}

/**
 * Agenda a varredura das retentativas vencidas (default: 60s). Complementa os timers em memória e
 * não substitui a varredura ampla de startInboundMediaRetryScheduler.
 * @returns {() => void} cancela o intervalo
 */
function startInboundMediaDueRetryScheduler(supabase, io) {
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return () => {}
  if (String(process.env.INBOUND_MEDIA_RETRY_DISABLED || '').trim() === '1') return () => {}

  const intervalMs = Math.max(15 * 1000, Number(process.env.INBOUND_MEDIA_DUE_INTERVAL_MS) || 60 * 1000)

  let rodando = false
  const tick = async () => {
    if (rodando) return
    rodando = true
    try {
      const r = await runInboundMediaDueRetryBatch(supabase, io)
      if (r.due > 0) {
        console.log('[inboundMediaPersist/due]', { due: r.due, migratedToUploads: r.migratedToUploads })
      }
    } catch (e) {
      console.warn('[inboundMediaPersist/due] tick', e?.message || e)
    } finally {
      rodando = false
    }
  }

  const id = setInterval(tick, intervalMs)
  if (typeof id.unref === 'function') id.unref()
  return () => clearInterval(id)
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

/** Cancela retentativas agendadas em memória. Usado no shutdown e entre casos de teste. */
function limparRetentativasAgendadas() {
  for (const timer of retentativasAgendadas.values()) clearTimeout(timer)
  retentativasAgendadas.clear()
  emExecucao.clear()
}

module.exports = {
  tipoQualificaPersistencia,
  schedulePersistInboundMediaIfNeeded,
  runInboundMediaPersistenceRetryBatch,
  runInboundMediaDueRetryBatch,
  startInboundMediaRetryScheduler,
  startInboundMediaDueRetryScheduler,
  limparRetentativasAgendadas,
  _test: {
    pickStoredFilename,
    extFromContentType,
    nomeArquivoFinal,
    persistInboundMediaToUploads,
    resetEstadoPersistenciaFlag: () => {
      _estadoPersistenciaIndisponivel = false
    },
    estadoPersistenciaIndisponivel: () => _estadoPersistenciaIndisponivel,
  },
}
