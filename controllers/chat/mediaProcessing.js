const supabase = require('../../config/supabase')
const _chatShared = require('./shared')
const {
  mergeConversaClienteTags,
  resolveTelefoneFromLidSiblingConversation,
  safeWhatsappInstanceMeta,
  loadWhatsappInstanceMetaMap,
  statusAtendimentoParaLista,
  applyDetalharChatMensagensCursor,
  parsePositiveInt,
  parseBooleanQuery,
  isFlagAtivo,
  isMensagemColumnFallbackError,
  parseChatListPagination,
  applyChatListCursor,
  splitChatListPage,
  parseMessageHistoryPagination,
  splitMessageHistoryPage,
  shouldIncludeClientesSemConversa,
  setChatListPaginationHeaders,
  ordenarMensagensHistoricoAsc,
  textoRevogadoApagadaParaTodos,
  aplicarApagadaParaTodosNaMensagem,
  enrichMensagensComAutorUsuario,
  assertPermissaoConversa,
  marcarComoLidaPorUsuario,
  obterUnreadMap,
  getSearchMessagesPageSize,
  getChatSearchScanLimit,
  getChatSearchIdLimit,
  getChatFilterIdLimit,
  getConversaMessagesSearchLimit,
  buscarConversaIdsPorTextoMensagens,
  isConversaAtendentesMissingTable,
  getConversaIdsParticipanteAtivo,
  usuarioParticipaAtivamenteDaConversa,
  deveIncluirGruposSemDepartamentoNoFiltroTodos,
} = _chatShared
// __CHAT_MODULE_IMPORTS__
const {
  registrarAtendimento,
  buildMensagemInternaMovimentacao,
  listarMensagensInternasMovimentacao,
  perfilPodeVerMovimentacaoInterna,
  isMensagemLegadaMovimentacaoInterna,
} = require('../../services/atendimentosRegistroService')
const { ensureConversaForCliente } = require('../../services/conversaAbrirClienteService')
const { executarAssumirConversa } = require('../../services/conversaAssumirInternoService')
const { resetAlertaSemRespostaAoAssumirReaberta } = require('../../services/atendimentoSemRespostaService')
const { getProvider } = require('../../services/providers')
const { getStatus } = require('../../services/ultramsgIntegrationService')
const { getDefaultWhatsappInstance, listWhatsappInstances, resolveWhatsappInstanceForManualAction, sanitizeWhatsappInstance } = require('../../services/whatsappInstanceService')
const { isGroupConversation, isClosedAttendanceStatus } = require('../../helpers/conversaHelper')
const {
  normalizePhoneBR,
  possiblePhonesBR,
  phoneKeyBR,
  isLidPhoneKey,
  pickRealPhoneCandidate,
} = require('../../helpers/phoneHelper')
const { deduplicateConversationsByContact, sortConversationsByRecent, sortConversationsPinThenRecent, sortConversationsBySearchRelevance, getCanonicalPhone, getCanonicalPhoneAnyIntl, getOrCreateCliente, findOrCreateConversation, mergeConversasIntoCanonico } = require('../../helpers/conversationSync')
const { enrichConversationsWithContactData } = require('../../helpers/conversaEnrichment')
const {
  resolveReabertaPorFaltaInteracao,
  enrichConversasReabertaFaltaInteracao,
  clearReabertaFaltaInteracao,
} = require('../../helpers/reabertaFaltaInteracaoHelper')
const { getDisplayName, normalizeName, isBadName } = require('../../helpers/contactEnrichment')
const { tryMarkWaitingAfterHumanOutbound } = require('../../services/absenceFinalizationService')
const {
  aplicarModoSimplesNoPayload,
  recalcularStatusPorUltimaMensagem,
  limparAguardandoAtendenteModoSimples,
  getUltimaMensagemReal,
  resolverModoSimplesAguardando,
} = require('../../services/atendimentoModoSimplesService')
const { empresaModoSimplesAtivo } = require('../../helpers/empresaModoSimplesFlag')
const {
  resolveGrupoIdsComUnreadParaUsuario,
  applyAguardandoAtendenteModoSimplesQuery,
  rowAguardandoAtendenteModoSimples,
} = require('../../helpers/modoSimplesGrupoUnread')
const { syncOldMessagesForConversation } = require('../../services/oldMessagesSyncService')
const {
  marcarAguardandoClienteManual,
  retomarEmAtendimentoManual,
} = require('../../services/conversaStatusManualService')
const {
  marcarAguardandoPagamento,
  retomarDeCobrancaFinanceira,
} = require('../../services/conversaPagamentoFinanceiroService')
const { usuarioPertenceSetorFinanceiro } = require('../../helpers/financeiroSetorHelper')
const {
  buildClienteSearchOr,
  buildTelefoneSearchOr,
  buildPhoneSearchTerms,
  chatIdentityMatchesSearch,
  escapeIlikePattern,
} = require('../../helpers/chatSearchHelper')
const {
  getGrupoDepartamentoIds,
  getGrupoIdsPorDepartamentos,
  getGrupoIdsSemDepartamento,
  usuarioPodeVerGrupo,
  pushNonGroupVisibilityParts,
  pushAllowedGroupIdsPart,
} = require('../../helpers/departamentoGruposHelper')
const {
  countConversasWithFilter,
  overridesFromListQuery,
  getChatFilterCounts,
  parseConversaIdsQuery,
  getStartOfTodayIso,
  getEndOfTodayIso,
} = require('../../services/chatListCountsService')
const { normalizarTimestampSemFusoAmbiguoParaApi } = require('../../helpers/timestampApiCompat')
const { isRealWhatsAppId, isUltramsgNumericQueueId } = require('../../helpers/whatsappMessageIdHelper')
const { schedulePendingOutboundReconciliation } = require('../../services/pendingOutboundReconciliationService')
const {
  INTERNAL_NOTE_PERMISSAO,
  INTERNAL_NOTE_STATUS,
  REAL_MESSAGE_DIRECOES,
  isInternalNoteRow,
  sanitizeInternalNoteTexto,
  buildInternalNoteInsert,
} = require('../../helpers/internalNote')
const { usuarioTemPermissao } = require('../../helpers/permissoesService')

const {
  _clientTempIdDeduplicationMap, _sendMemo, clientTempIdDedupeKey, normalizeClientTempId,
  parseAudioDuracaoSecFromBody, isMissingMensagemColumnError, isGenericMissingColumnError,
  isClientTempIdUniqueViolation, buildClientTempIdDedupResponse, findMensagemByClientTempId,
  resolveConversationWhatsappInstance, getUsuarioParaEnvioCliente, textoParaEnvioWhatsapp,
  enrichMensagemComAutorUsuario, recalcularEMesclarModoSimples, aplicarAguardandoClienteNoPayload,
  assertPodeEnviarMensagem
} = require('./sendShared')
const { emitirConversaAtualizada, emitirEventoEmpresaConversa } = require('./realtime')

/**
 * controllers/chat/mediaProcessing.js
 *
 * Processamento de MÍDIA para envio via UltraMSG: sniff/normalização de tipo, transcode de
 * áudio/vídeo/imagem (ffmpeg), envio de um arquivo (enviarArquivoProcessarUm) e resolução de
 * mídia para encaminhamento. Camada de apoio dos handlers sendMediaController.
 *
 * Invariantes: NUNCA duplicar mídia — idempotência por client_temp_id (dedup em sendShared);
 * status unidirecional; isolamento por company_id; caption <= limite; sem retry cego ao provider.
 */

/** MIME base sem parâmetros (ex.: codecs) */
function mimeBase(file) {
  const m = String(file?.mimetype || '').toLowerCase().trim()
  return m.split(';')[0].trim()
}

/**
 * Permite forçar envio como figurinha (endpoint /messages/sticker) quando o front envia
 * PNG/JPEG recortado na área "Criar" — sem depender só de .webp no nome/MIME.
 */
const IMAGE_FILE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif'])

const VIDEO_FILE_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', '3gp', 'mpeg', 'mpg', 'ogv'])

// Contrato oficial do endpoint UltraMSG /messages/video.
const ULTRAMSG_VIDEO_FILE_EXTENSIONS = new Set(['mp4', '3gp', 'mov'])

const ULTRAMSG_VIDEO_MAX_BYTES = 32 * 1024 * 1024

// Margem para overhead do container/CDN e diferenças entre MB decimal e MiB.
const ULTRAMSG_VIDEO_TARGET_BYTES = 29 * 1024 * 1024

const AUDIO_FILE_EXTENSIONS = new Set(['ogg', 'mp3', 'wav', 'm4a', 'aac', 'opus', 'amr'])

const DOCUMENT_FILE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'csv', 'md', 'html', 'htm', 'rtf',
  'json', 'xml', 'sql', 'zip', 'rar', '7z',
])

function extBaseArquivo(file) {
  const candidates = [file?.originalname, file?.filename, file?.path]
  for (const candidate of candidates) {
    const match = String(candidate || '').toLowerCase().match(/\.([a-z0-9]{2,8})$/i)
    if (match?.[1]) return match[1].toLowerCase()
  }
  return ''
}

/**
 * Nota de voz gravada no browser: MIME costuma ser audio/webm, mas em alguns clients
 * chega vazio, application/octet-stream ou até video/webm com extensão .webm.
 * Sem este aceite, tipo=voice era ignorado e o arquivo caía como vídeo.
 */
function isForcedVoiceAudioish(file) {
  const base = mimeBase(file)
  const ext = extBaseArquivo(file)
  if (base.startsWith('audio/')) return true
  if (AUDIO_FILE_EXTENSIONS.has(ext)) return true
  if (ext === 'webm') return true
  if (base === 'video/webm') return true
  return false
}

function aplicarTipoForcadoSticker(file, tipoInferido) {
  const forced = String(file?.__tipoForcado || '').toLowerCase().trim()
  if (forced === 'video' || forced === 'vídeo') {
    const base = mimeBase(file)
    const ext = extBaseArquivo(file)
    // Aceita MIME video/* e extensões de vídeo conhecidas.
    // Também aceita application/octet-stream e MIME ausente: browsers Android/iOS
    // frequentemente enviam MIME genérico para vídeos de câmera — o frontend
    // já validou via isVideoFile (extensão/tipo) antes de forçar tipo=video.
    // Rejeita apenas tipos que são claramente não-vídeo (ex.: application/pdf).
    const videoish =
      base.startsWith('video/') ||
      VIDEO_FILE_EXTENSIONS.has(ext) ||
      base === 'application/octet-stream' ||
      !base
    return videoish ? 'video' : tipoInferido
  }
  if (forced === 'voice' || forced === 'ptt') {
    return isForcedVoiceAudioish(file) ? 'voice' : tipoInferido
  }
  if (forced !== 'sticker') return tipoInferido
  const base = mimeBase(file)
  const ext = extBaseArquivo(file)
  const stickerish =
    ['image/webp', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif'].includes(base) ||
    ['webp', 'png', 'jpg', 'jpeg', 'gif'].includes(ext)
  return stickerish ? 'sticker' : tipoInferido
}

function inferirTipoArquivo(file) {
  const m = mimeBase(file)
  const ext = extBaseArquivo(file)

  if (m.startsWith('image/')) return 'imagem'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'

  if (IMAGE_FILE_EXTENSIONS.has(ext)) return 'imagem'
  if (VIDEO_FILE_EXTENSIONS.has(ext)) return 'video'
  if (AUDIO_FILE_EXTENSIONS.has(ext)) return 'audio'
  if (DOCUMENT_FILE_EXTENSIONS.has(ext)) return 'arquivo'

  return 'arquivo'
}

function getAudioFileExtension(file) {
  const byOriginal = String(file?.originalname || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/i)
  if (byOriginal?.[1]) return byOriginal[1].toLowerCase()
  const byStored = String(file?.filename || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/i)
  if (byStored?.[1]) return byStored[1].toLowerCase()
  return ''
}

function resolveFfmpegPath() {
  try {
    const p = require('ffmpeg-static')
    if (p) return p
  } catch {}
  return null
}

async function convertAudioWithFfmpeg(inputPath, outputPath, profile = 'audio_mp3') {
  const { spawn } = require('child_process')
  const ffmpegPath = resolveFfmpegPath()
  if (!ffmpegPath) throw new Error('ffmpeg-static não disponível')

  let args
  // Voice (PTT): asetpts=N/SR/TB reescreve os timestamps de saída com base na contagem de
  // amostras decodificadas, ignorando completamente os timestamps irregulares do WebM do
  // MediaRecorder (dispositivos Android podem ter lacunas ou saltos que inflam a duração).
  // aresample=async=0 impede que o resampler ajuste o áudio com base nos timestamps de entrada.
  if (profile === 'voice_ogg_opus') {
    args = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-af', 'aresample=async=0,asetpts=N/SR/TB',
      '-ac', '1',
      '-ar', '48000',
      '-c:a', 'libopus',
      '-b:a', '48k',
      '-compression_level', '10',
      '-application', 'voip',
      '-fflags', '+bitexact',
      '-flags', '+bitexact',
      '-map_metadata', '-1',
      '-map_chapters', '-1',
      outputPath,
    ]
  } else {
    args = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '44100',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      '-write_xing', '0',
      '-id3v2_version', '0',
      '-map_metadata', '-1',
      '-map_chapters', '-1',
      outputPath,
    ]
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += String(d || '') })
    const tid = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      reject(new Error('ffmpeg timeout (60s)'))
    }, 60000)
    proc.on('error', (err) => { clearTimeout(tid); reject(err) })
    proc.on('close', (code) => {
      clearTimeout(tid)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exit=${code} ${stderr.slice(-240)}`.trim()))
    })
  })
}

/** Mede duração real de um arquivo de áudio via ffmpeg -i (parse do stderr). */
async function probeAudioDurationSec(filePath) {
  const { spawn } = require('child_process')
  const ffmpegPath = resolveFfmpegPath()
  if (!ffmpegPath) return null
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', filePath], { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += String(d || '') })
    const tid = setTimeout(() => { try { proc.kill('SIGKILL') } catch {}; resolve(null) }, 8000)
    proc.on('error', () => { clearTimeout(tid); resolve(null) })
    proc.on('close', () => {
      clearTimeout(tid)
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      if (!m) { resolve(null); return }
      resolve(parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]))
    })
  })
}

async function normalizeAudioForUltraMsg(file, tipo) {
  if (!file || !file.path || (tipo !== 'audio' && tipo !== 'voice')) {
    return { file, converted: false, error: null, required: false }
  }
  const ext = getAudioFileExtension(file)
  const isVoice = tipo === 'voice'
  const isAudio = tipo === 'audio'
  const allowedAudioExt = ['mp3', 'ogg', 'aac']
  const mime = mimeBase(file)
  // Voice: se já for OGG/Opus (ex.: Firefox MediaRecorder), pula ffmpeg — reduz latência até o CDN.
  // WebM/outros containers continuam obrigatórios a transcodificar (compatibilidade iPhone/WhatsApp).
  if (isVoice) {
    const alreadyOggOpus =
      ext === 'ogg' &&
      (mime === 'audio/ogg' || mime === 'audio/opus' || mime.includes('opus'))
    if (alreadyOggOpus) {
      return {
        file: { ...file, mimetype: file.mimetype || 'audio/ogg' },
        converted: false,
        error: null,
        required: false,
      }
    }
  }
  // Para audio comum, mp3/ogg/aac já são aceitos no endpoint /messages/audio.
  if (isAudio && allowedAudioExt.includes(ext)) {
    return { file, converted: false, error: null, required: false }
  }

  const path = require('path')
  const fs = require('fs')
  const dir = path.dirname(file.path)
  const currentStoredName = String(file.filename || path.basename(file.path))
  const baseStoredName = currentStoredName.replace(/\.[a-z0-9]{2,5}$/i, '')
  const originalName = String(file.originalname || currentStoredName)
  // Voice: ogg/opus | Audio: mp3 (mais compatível no endpoint /messages/audio).
  const targetExt = isVoice ? 'ogg' : 'mp3'
  const targetStoredName = `${baseStoredName}.${targetExt}`
  const targetPath = path.join(dir, targetStoredName)
  const targetOriginalName = originalName.replace(/\.[a-z0-9]{2,5}$/i, `.${targetExt}`)
  const ffmpegProfile = isVoice ? 'voice_ogg_opus' : 'audio_mp3'

  try {
    await convertAudioWithFfmpeg(file.path, targetPath, ffmpegProfile)
    fs.unlink(file.path, () => {})

    return {
      converted: true,
      error: null,
      required: true,
      file: {
        ...file,
        path: targetPath,
        filename: targetStoredName,
        originalname: targetOriginalName,
        mimetype: isVoice ? 'audio/ogg' : 'audio/mpeg',
      },
    }
  } catch (e) {
    // Não apaga o original: o caller decide se aborta (voice) ou reporta falha.
    return {
      file,
      converted: false,
      required: true,
      error: e?.message || 'Falha ao converter áudio com ffmpeg',
    }
  }
}

/** Voice (e áudio que precisa transcodificar) não pode seguir com o arquivo cru — UltraMSG/iPhone falham. */
function shouldAbortAudioAfterNormalize(tipo, normalized) {
  if (tipo !== 'voice' && tipo !== 'audio') return false
  if (normalized?.converted) return false
  if (!normalized?.required) return false
  return !!normalized?.error
}

function shouldNormalizeVideoForUltraMsg(file, tipo) {
  if (tipo !== 'video' || !file?.path) return false
  // Todo vídeo enviado pelo painel passa pela preparação determinística:
  // garante H.264/AAC dentro de um MP4 compatível com WhatsApp independente do
  // MIME ou extensão original (inclusive application/octet-stream de alguns browsers).
  return true
}

function shouldForceProviderUploadForMedia(tipo) {
  const normalized = String(tipo || '').toLowerCase().trim()
  return normalized === 'audio' || normalized === 'voice' || normalized === 'video'
}

function buildVideoTranscodeProfile(durationSec, opts = {}) {
  const duration = Number(durationSec)
  if (!Number.isFinite(duration) || duration <= 0) return null

  const targetBytes = Math.max(4 * 1024 * 1024, Number(opts.targetBytes) || ULTRAMSG_VIDEO_TARGET_BYTES)
  // Reserva 6% para índices/metadata do MP4. O áudio reduz dinamicamente em vídeos longos.
  const totalKbps = Math.max(48, Math.floor((targetBytes * 8 * 0.94) / duration / 1000))
  const audioKbps = totalKbps >= 500 ? 64 : totalKbps >= 260 ? 48 : totalKbps >= 120 ? 32 : 24
  const videoKbps = Math.max(24, Math.min(4000, totalKbps - audioKbps))
  const maxWidth = videoKbps >= 1800 ? 1280 : videoKbps >= 900 ? 960 : videoKbps >= 450 ? 720 : videoKbps >= 240 ? 540 : 360

  return {
    durationSec: duration,
    targetBytes,
    totalKbps,
    videoKbps,
    audioKbps,
    maxWidth,
  }
}

async function probeVideoDurationSec(filePath) {
  return probeAudioDurationSec(filePath)
}

async function convertVideoToUltraMsgMp4(inputPath, outputPath, opts = {}) {
  const { spawn } = require('child_process')
  const ffmpegPath = resolveFfmpegPath()
  if (!ffmpegPath) throw new Error('ffmpeg-static nao disponivel')

  const profile = opts.profile || null
  const maxWidth = Number(profile?.maxWidth) || 1280
  const videoCodecArgs = profile
    ? [
        '-b:v', `${profile.videoKbps}k`,
        '-maxrate', `${Math.max(profile.videoKbps, Math.ceil(profile.videoKbps * 1.08))}k`,
        '-bufsize', `${Math.max(96, profile.videoKbps * 2)}k`,
      ]
    : ['-crf', '28']
  const audioKbps = Number(profile?.audioKbps) || 96

  const args = [
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    ...videoCodecArgs,
    '-profile:v', 'main',
    '-level:v', '4.0',
    '-tag:v', 'avc1',
    '-vf', `scale=${maxWidth}:${maxWidth}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
    '-c:a', 'aac',
    '-b:a', `${audioKbps}k`,
    '-ac', '2',
    '-ar', '44100',
    '-sn',
    '-dn',
    '-movflags', '+faststart',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    outputPath,
  ]

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(tid)
      fn(value)
    }
    proc.stderr.on('data', (d) => { stderr += String(d || '') })
    const timeoutMs = Math.max(5 * 60 * 1000, Math.min(15 * 60 * 1000, Number(opts.timeoutMs) || 10 * 60 * 1000))
    const tid = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      finish(reject, new Error(`ffmpeg video timeout (${Math.round(timeoutMs / 60000)} min)`))
    }, timeoutMs)
    proc.on('error', (error) => finish(reject, error))
    proc.on('close', (code) => {
      if (code === 0) finish(resolve)
      else finish(reject, new Error(`ffmpeg video exit=${code} ${stderr.slice(-300)}`.trim()))
    })
  })
}

async function normalizeVideoForUltraMsg(file, tipo, opts = {}) {
  if (!file || tipo !== 'video') {
    return { file, converted: false, required: false, error: null }
  }

  const fs = require('fs')
  const path = require('path')
  const currentSize = Number(file.size) || (() => {
    try { return fs.statSync(file.path).size } catch { return 0 }
  })()
  if (!shouldNormalizeVideoForUltraMsg(file, tipo)) {
    if (currentSize > ULTRAMSG_VIDEO_MAX_BYTES) {
      return {
        file,
        converted: false,
        required: true,
        error: 'Video maior que o limite de 32 MB da UltraMSG.',
      }
    }
    return { file, converted: false, required: false, error: null }
  }

  const sourcePath = file.path
  const parsedStored = path.parse(file.filename || path.basename(sourcePath))
  const parsedOriginal = path.parse(file.originalname || parsedStored.base || 'video')
  const targetFilename = `${parsedStored.name || `video-${Date.now()}`}-wa.mp4`
  const targetPath = path.join(path.dirname(sourcePath), targetFilename)

  try {
    const durationSec = await probeVideoDurationSec(sourcePath)
    let profile = buildVideoTranscodeProfile(durationSec)
    await convertVideoToUltraMsgMp4(sourcePath, targetPath, { profile })
    let stat = fs.statSync(targetPath)
    if (!stat.size) throw new Error('MP4 convertido ficou vazio')

    // Bitrate médio pode variar em encode de uma passagem. Se ultrapassar o teto,
    // recalcula com margem adicional e tenta uma única vez a partir do original.
    if (stat.size > ULTRAMSG_VIDEO_MAX_BYTES) {
      const measuredDuration = durationSec || await probeVideoDurationSec(targetPath)
      profile = buildVideoTranscodeProfile(measuredDuration, {
        targetBytes: Math.floor(ULTRAMSG_VIDEO_TARGET_BYTES * 0.88),
      })
      if (!profile) throw new Error('Nao foi possivel medir a duracao para compactar o video')
      await convertVideoToUltraMsgMp4(sourcePath, targetPath, { profile })
      stat = fs.statSync(targetPath)
      if (!stat.size || stat.size > ULTRAMSG_VIDEO_MAX_BYTES) {
        throw new Error('Video muito longo para compactacao abaixo de 32 MB')
      }
    }
    // O arquivo recebido por upload e temporario. Remova-o antes de retornar
    // para que o contrato seja deterministico e nao deixe WebM/MOV orfao.
    // Encaminhamentos passam removeSource=false porque reutilizam midia salva.
    if (opts.removeSource !== false && sourcePath !== targetPath) {
      try { fs.unlinkSync(sourcePath) } catch (_) {}
    }
    return {
      file: {
        ...file,
        path: targetPath,
        filename: targetFilename,
        originalname: `${parsedOriginal.name || 'video'}.mp4`,
        mimetype: 'video/mp4',
        size: stat.size,
      },
      converted: true,
      required: true,
      error: null,
    }
  } catch (error) {
    try {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath)
    } catch (_) {}
    return {
      file,
      converted: false,
      required: true,
      error: error?.message || 'Falha ao converter video para MP4',
    }
  }
}

function shouldNormalizeImageForWhatsapp(file, tipo) {
  if (tipo !== 'imagem' || !file?.path) return false
  const base = mimeBase(file)
  const ext = extBaseArquivo(file)
  if (base === 'image/gif' || ext === 'gif') return false
  return base.startsWith('image/') || IMAGE_FILE_EXTENSIONS.has(ext)
}

async function convertImageToWhatsappJpeg(inputPath, outputPath) {
  const { spawn } = require('child_process')
  return new Promise((resolve, reject) => {
    let ffmpegPath
    try {
      ffmpegPath = require('ffmpeg-static')
    } catch {
      ffmpegPath = null
    }
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static não disponível'))
      return
    }
    const args = [
      '-y',
      '-i', inputPath,
      '-frames:v', '1',
      '-map_metadata', '-1',
      '-pix_fmt', 'yuvj420p',
      '-q:v', '3',
      outputPath,
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += String(d || '') })
    proc.on('error', (err) => reject(err))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg image exit=${code} ${stderr.slice(-240)}`.trim()))
    })
  })
}

async function normalizeImageForWhatsapp(file, tipo) {
  if (!shouldNormalizeImageForWhatsapp(file, tipo)) return { file, converted: false, error: null }
  const fs = require('fs')
  const path = require('path')
  const sourcePath = file.path
  const parsedStored = path.parse(file.filename || path.basename(sourcePath))
  const parsedOriginal = path.parse(file.originalname || parsedStored.base || 'imagem')
  const targetFilename = `${parsedStored.name || `img-${Date.now()}`}-wa.jpg`
  const targetPath = path.join(path.dirname(sourcePath), targetFilename)

  try {
    await convertImageToWhatsappJpeg(sourcePath, targetPath)
    const stat = fs.statSync(targetPath)
    if (!stat.size) throw new Error('JPEG normalizado ficou vazio')
    return {
      file: {
        ...file,
        path: targetPath,
        filename: targetFilename,
        originalname: `${parsedOriginal.name || 'imagem'}.jpg`,
        mimetype: 'image/jpeg',
        size: stat.size,
      },
      converted: true,
      error: null,
    }
  } catch (error) {
    try {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath)
    } catch (_) {}
    return { file, converted: false, error: error?.message || 'Falha ao normalizar imagem para JPEG' }
  }
}

/** Lote de fotos/arquivos (galeria): mesmo contrato do WhatsApp Web. */
const MAX_ARQUIVOS_LOTE_ENVIO = 30

/** Evita processar o mesmo upload duas vezes quando multer recebe campos duplicados. */
function dedupeMulterFiles(files) {
  if (!Array.isArray(files) || files.length < 2) return files
  const seen = new Set()
  const out = []
  for (const f of files) {
    if (!f) continue
    const key = `${String(f.originalname || '')}|${Number(f.size) || 0}|${String(f.path || f.filename || '')}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/** Legenda enviada com foto/vídeo/documento — mesmo limite prático da UltraMsg */
const MAX_MEDIA_CAPTION_CHARS = 1024

/**
 * Uma unidade de upload após multer; conversa e telefone já validados.
 * @returns {Promise<{ ok: true, msg: object } | { ok: false, status: number, error: string }>}
 */
async function enviarArquivoProcessarUm(req, file, { company_id, user_id, conversa_id, telefoneParaEnvio, whatsappInstanceId = null, io, captionUsuario = '', clientTempId = null }) {
  const { extFromOriginalName, isBlockedRiskExtension, blockedUploadErrorMessage } = require('../../middleware/upload')
  clientTempId = normalizeClientTempId(clientTempId)
  if (clientTempId) {
    const existing = await findMensagemByClientTempId(
      company_id,
      conversa_id,
      clientTempId,
      'id, conversa_id, company_id, status, status_mensagem, whatsapp_id, client_temp_id, texto, tipo, url, nome_arquivo, criado_em'
    )
    if (existing?.id) {
      return { ok: true, msg: existing, deduplicated: true }
    }
  }

  let fileWork = file
  const extUpload = extFromOriginalName(fileWork?.originalname)
  if (isBlockedRiskExtension(extUpload)) {
    return { ok: false, status: 400, error: blockedUploadErrorMessage(extUpload) }
  }
  const avisoWhatsapp = null
  const tipo = aplicarTipoForcadoSticker(fileWork, inferirTipoArquivo(fileWork))
  if (tipo === 'audio' || tipo === 'voice') {
    let normalized
    try {
      normalized = await normalizeAudioForUltraMsg(fileWork, tipo)
    } catch (e) {
      // normalizeAudioForUltraMsg já captura falhas do ffmpeg; este catch é rede de segurança.
      normalized = {
        file: fileWork,
        converted: false,
        required: true,
        error: e?.message || 'Falha ao converter áudio',
      }
    }
    if (normalized?.converted && normalized?.file) {
      const beforeName = fileWork.originalname
      fileWork = normalized.file
      req.file = fileWork
      console.log('[ULTRAMSG][AUDIO] Áudio convertido para formato compatível antes do envio:', {
        tipo,
        from: beforeName,
        to: fileWork.originalname,
        mime: fileWork.mimetype,
      })
      // Guard de duração: confere se o OGG produzido é coerente com o tempo gravado.
      // Protege contra timestamp irregulares do WebM de celulares que causam OGG inflado ou truncado.
      if (tipo === 'voice') {
        const elapsedMs = Number(req?.body?.audio_elapsed_ms || 0)
        if (elapsedMs >= 1000) {
          const probedSec = await probeAudioDurationSec(fileWork.path)
          if (probedSec !== null) {
            const elapsedSec = elapsedMs / 1000
            const isInflated = probedSec > elapsedSec * 2 && (probedSec - elapsedSec) > 30
            const isTruncated = probedSec < elapsedSec * 0.6 && (elapsedSec - probedSec) > 3
            if (isInflated || isTruncated) {
              console.error('[AUDIO][GUARD] OGG com duração incoerente após transcode:', {
                probedSec, elapsedSec, isInflated, isTruncated,
              })
              try { require('fs').unlink(fileWork.path, () => {}) } catch {}
              return {
                ok: false,
                status: 422,
                error: 'Não foi possível processar o áudio. Grave novamente e tente enviar.',
              }
            }
          }
        }
      }
    } else if (shouldAbortAudioAfterNormalize(tipo, normalized)) {
      console.warn('[ULTRAMSG][AUDIO] Conversão obrigatória falhou; abortando envio:', {
        tipo,
        error: normalized?.error,
        original: fileWork?.originalname,
        mime: fileWork?.mimetype,
      })
      return {
        ok: false,
        status: 422,
        error:
          tipo === 'voice'
            ? 'Não foi possível converter o áudio de voz. Grave novamente e tente enviar.'
            : 'Não foi possível converter o áudio para um formato compatível com o WhatsApp.',
      }
    } else if (normalized?.error) {
      console.warn('[ULTRAMSG][AUDIO] Conversão/normalização indisponível:', normalized.error)
    }
  }
  if (tipo === 'video') {
    const normalizedVideo = await normalizeVideoForUltraMsg(fileWork, tipo)
    if (normalizedVideo?.converted && normalizedVideo?.file) {
      const beforeName = fileWork.originalname
      fileWork = normalizedVideo.file
      req.file = fileWork
      console.log('[ULTRAMSG][VIDEO] Video convertido para MP4 compativel antes do envio:', {
        from: beforeName,
        to: fileWork.originalname,
        mime: fileWork.mimetype,
        size: fileWork.size,
      })
    } else if (normalizedVideo?.required && normalizedVideo?.error) {
      console.warn('[ULTRAMSG][VIDEO] Conversao obrigatoria falhou; abortando envio:', {
        original: fileWork?.originalname,
        mime: fileWork?.mimetype,
        error: normalizedVideo.error,
      })
      try {
        if (fileWork?.path && require('fs').existsSync(fileWork.path)) require('fs').unlinkSync(fileWork.path)
      } catch (_) {}
      return {
        ok: false,
        status: 422,
        error: 'Não foi possível compactar o vídeo para envio. O arquivo original pode ter até 128 MB; tente reduzir a duração se o problema continuar.',
      }
    }
  }
  if (tipo === 'imagem') {
    try {
      const normalizedImage = await normalizeImageForWhatsapp(fileWork, tipo)
      if (normalizedImage?.converted && normalizedImage?.file) {
        const beforeName = fileWork.originalname
        fileWork = normalizedImage.file
        req.file = fileWork
        console.log('[ULTRAMSG][IMAGE] Imagem normalizada para JPEG compatível antes do envio:', {
          from: beforeName,
          to: fileWork.originalname,
          mime: fileWork.mimetype,
        })
      } else if (normalizedImage?.error) {
        console.warn('[ULTRAMSG][IMAGE] Normalização JPEG indisponível:', normalizedImage.error)
      }
    } catch (e) {
      console.warn('[ULTRAMSG][IMAGE] Falha ao normalizar imagem para JPEG:', e?.message || e)
    }
  }

  let captionUsuarioTrim =
    tipo === 'audio' || tipo === 'voice' || tipo === 'sticker'
      ? ''
      : String(captionUsuario || '').trim().slice(0, MAX_MEDIA_CAPTION_CHARS)

  const { textoMensagemMidiaParaBanco, captionWhatsappParaMidia } = require('../../helpers/midiaMensagemHelper')
  const textoMensagem = textoMensagemMidiaParaBanco({
    tipo,
    captionUsuarioTrim,
    originalname: fileWork.originalname,
  })

  const pathUrl = `/uploads/${fileWork.filename}`
  const audioDuracaoSec =
    (tipo === 'audio' || tipo === 'voice') && !_sendMemo.audioColumnUnavailable
      ? parseAudioDuracaoSecFromBody(req?.body)
      : null

  const insertArquivoPayload = {
    conversa_id: Number(conversa_id),
    texto: textoMensagem,
    tipo,
    url: pathUrl,
    nome_arquivo: fileWork.originalname,
    direcao: "out",
    autor_usuario_id: user_id,
    company_id,
    // Explicito como nos demais envios: o despacho ao provedor ocorre depois do INSERT,
    // e a reconciliacao/reenvio so varre status pending|sending. Depender do default do
    // banco deixaria a midia invisivel para esse laco caso o default mude.
    status: 'pending',
    ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
    ...(clientTempId && !_sendMemo.dbDedupeUnavailable ? { client_temp_id: clientTempId } : {}),
    ...(audioDuracaoSec != null ? { audio_duracao_sec: audioDuracaoSec } : {}),
  }

  let { data: msg, error } = await supabase.from("mensagens").insert(insertArquivoPayload).select().single()

  if (error && clientTempId && isClientTempIdUniqueViolation(error)) {
    const existing = await findMensagemByClientTempId(
      company_id,
      conversa_id,
      clientTempId,
      'id, conversa_id, company_id, status, status_mensagem, whatsapp_id, client_temp_id, texto, tipo, url, nome_arquivo, criado_em' +
        (_sendMemo.audioColumnUnavailable ? '' : ', audio_duracao_sec')
    )
    if (existing?.id) {
      return { ok: true, msg: existing, deduplicated: true }
    }
  }

  // Coluna nova: tenta de novo sem ela antes de mexer em client_temp_id (evita falso positivo no "does not exist").
  if (
    error &&
    insertArquivoPayload.audio_duracao_sec != null &&
    (isMissingMensagemColumnError(error, 'audio_duracao_sec') || isGenericMissingColumnError(error))
  ) {
    _sendMemo.audioColumnUnavailable = true
    delete insertArquivoPayload.audio_duracao_sec
    ;({ data: msg, error } = await supabase.from("mensagens").insert(insertArquivoPayload).select().single())
  }

  if (error && insertArquivoPayload.client_temp_id && (isMissingMensagemColumnError(error, 'client_temp_id') || isGenericMissingColumnError(error))) {
    _sendMemo.dbDedupeUnavailable = true
    delete insertArquivoPayload.client_temp_id
    ;({ data: msg, error } = await supabase.from("mensagens").insert(insertArquivoPayload).select().single())
  }

  if (error) return { ok: false, status: 500, error: error.message }

    // Rollout R2 (empresa 1): espelha a mídia enviada para o Cloudflare R2 JÁ NO ENVIO, sem esperar
    // confirmação do provedor. A entrega ao WhatsApp usa a URL /uploads capturada abaixo (não a url
    // do banco), e o reenvio automático usa URL assinada do R2 — então isto não interfere no envio.
    // No-op para outras empresas / R2 desligado / tipo não-mídia.
    try {
      const { scheduleR2MirrorIfNeeded } = require('../../services/mediaR2MirrorService')
      scheduleR2MirrorIfNeeded({ supabase, io, company_id, mensagem_id: msg.id })
    } catch (_) { /* espelhamento é best-effort; nunca afeta o envio */ }

    const modoSimplesEnvio = await empresaModoSimplesAtivo(company_id).catch(() => false)
    const timestampAtividade = new Date().toISOString()

    const [waitingAfterOutbound, modoSimplesResult] = await Promise.all([
      modoSimplesEnvio
        ? Promise.resolve(null)
        : tryMarkWaitingAfterHumanOutbound({
            company_id,
            conversa_id: Number(conversa_id),
            texto: String(msg?.texto || '').trim(),
            criado_em: msg.criado_em,
            autor_usuario_id: Number(user_id),
            permitir_conteudo_sem_texto: true,
          }).catch(() => null),
      recalcularEMesclarModoSimples({
        company_id,
        conversa_id: Number(conversa_id),
        mensagemNova: msg,
        io: null,
      }).catch(() => null),
      supabase
        .from('conversas')
        .update({ lida: true, ultima_atividade: timestampAtividade })
        .eq('company_id', Number(company_id))
        .eq('id', Number(conversa_id)),
    ])

    // Emitir eventos para o frontend
    if (io) {
      const basePayload = {
        ...msg,
        conversa_id: msg.conversa_id ?? Number(conversa_id),
        status: msg.status || 'pending',
        status_mensagem: msg.status_mensagem || msg.status || 'pending',
        direcao: 'out',
        ...(clientTempId ? { client_temp_id: clientTempId } : {}),
        // Mesmo sem a coluna no banco, a bolha recebe a duração medida no upload.
        ...(audioDuracaoSec != null && msg.audio_duracao_sec == null
          ? { audio_duracao_sec: audioDuracaoSec }
          : {}),
      }
      const novaMsgPayload = await enrichMensagemComAutorUsuario(supabase, company_id, basePayload)
      emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', novaMsgPayload)
      
      const convPayload = aplicarAguardandoClienteNoPayload({
        id: Number(conversa_id),
        ultima_atividade: timestampAtividade,
        reordenar_suave: true,
      }, waitingAfterOutbound, {
        ...(modoSimplesResult?.conversa || {}),
        atendimento_modo_simples: modoSimplesEnvio,
        modo_simples_aguardando: modoSimplesResult?.modo_simples_aguardando ?? null,
      })
      
      // Adicionar preview da última mensagem baseado no tipo
      if (msg.tipo === 'contact' && msg.contact_meta) {
        convPayload.ultima_mensagem_preview = {
          texto: msg.texto,
          criado_em: novaMsgPayload.criado_em,
          direcao: 'out',
          tipo: 'contact',
          contact_meta: msg.contact_meta,
        }
      } else if (msg.tipo === 'location' && (msg.location_meta || msg.url)) {
        convPayload.ultima_mensagem_preview = {
          texto: msg.texto,
          criado_em: novaMsgPayload.criado_em,
          direcao: 'out',
          tipo: 'location',
          ...(msg.location_meta ? { location_meta: msg.location_meta } : {}),
          ...(msg.url ? { url: msg.url } : {}),
        }
      } else {
        // Para outros tipos de mídia
        convPayload.ultima_mensagem_preview = {
          texto: msg.texto,
          criado_em: novaMsgPayload.criado_em,
          direcao: 'out',
          tipo: msg.tipo,
          ...(msg.url ? { url: msg.url } : {}),
          ...(msg.nome_arquivo ? { nome_arquivo: msg.nome_arquivo } : {}),
        }
      }
      
      emitirConversaAtualizada(io, company_id, conversa_id, convPayload, { skipAtualizarConversa: true })
    }

    const { nome: usuarioNome } = await getUsuarioParaEnvioCliente(supabase, company_id, user_id)
    const waCaption = captionWhatsappParaMidia({
      tipo,
      captionUsuarioTrim,
      usuarioNome,
    })
    const baseUrl = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/$/, '')
    const fullUrl = baseUrl ? `${baseUrl}${pathUrl}` : null
    const isLocalhost = /localhost|127\.0\.0\.1/i.test(baseUrl)
    // Para áudio/voice/video, prioriza sempre CDN da UltraMsg:
    // evita problemas de disponibilidade/headers em URLs próprias do backend
    // e melhora a reprodução no WhatsApp mobile e desktop.
    // O vídeo chega ao upload como MP4 H.264/AAC e o multipart informa video/mp4;
    // assim /messages/video não depende do APP_URL estar acessível naquele instante.
    const forceUploadMedia = shouldForceProviderUploadForMedia(tipo)

    const sendMediaWithUrl = (mediaUrl) => {
      const provider = getProvider()
      const phone = telefoneParaEnvio
      const isAudioTipo = tipo === 'voice' || tipo === 'audio'
      const opts = {
        companyId: company_id,
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'atendimento_humano_midia',
        referenceId: `crm-${msg.id}`,
        returnDetails: true,
        ...(isAudioTipo ? { audioMeta: { originalName: fileWork.originalname, mimeType: fileWork.mimetype } } : {}),
      }
      const promise =
        tipo === 'voice' && provider.sendVoice
          ? provider.sendVoice(phone, mediaUrl, opts)
          : tipo === 'audio' && provider.sendAudio
          ? provider.sendAudio(phone, mediaUrl, opts)
          : tipo === 'sticker' && provider.sendSticker
            ? provider.sendSticker(phone, mediaUrl, { ...opts, stickerAuthor: 'ZapERP' })
            : tipo === 'imagem' && provider.sendImage
              ? provider.sendImage(phone, mediaUrl, waCaption, opts)
              : tipo === 'video' && provider.sendVideo
                ? provider.sendVideo(phone, mediaUrl, waCaption, { ...opts, returnDetails: true })
                : provider.sendFile
                  ? provider.sendFile(phone, mediaUrl, fileWork.originalname || '', {
                      ...opts,
                      caption: waCaption,
                      returnDetails: true,
                    })
                  : Promise.resolve({ ok: false, error: 'Envio de documento indisponível' })
      promise
        .then(async (result) => {
          const normalizedResult = typeof result === 'boolean'
            ? { ok: result, error: null, messageId: null }
            : (result || { ok: false, error: 'resultado_provider_vazio', messageId: null })
          const ok = normalizedResult.ok === true
          const waMessageId = normalizedResult?.messageId ? String(normalizedResult.messageId).trim() : null
          const hasTraceableMediaId = isRealWhatsAppId(waMessageId)
          const hasQueueMediaId = !!waMessageId && isUltramsgNumericQueueId(waMessageId)
          const nextStatus = ok ? (hasTraceableMediaId ? 'sent' : 'pending') : 'erro'
          const nextStatusMensagem = ok ? (hasTraceableMediaId ? 'sent' : 'sending') : 'erro'
          
          if (!ok) {
            console.warn('WhatsApp: falha ao enviar mídia', {
              phone: String(phone || '').slice(-12),
              tipo,
              mediaUrl: String(mediaUrl || '').slice(0, 180),
              erro: normalizedResult?.error || 'sem detalhes',
            })
          } else {
            console.log('✅ WhatsApp mídia enviada:', phone?.slice(-12), tipo, waMessageId ? `(${waMessageId})` : '')
          }
          
          // whatsapp_id só recebe ID real; queue ID numérico vai para provider_queue_id (reconciliação de ACK)
          await supabase
            .from('mensagens')
            .update({
              status: nextStatus,
              status_mensagem: nextStatusMensagem,
              ...(hasTraceableMediaId ? { whatsapp_id: waMessageId } : {}),
              ...(hasQueueMediaId ? { provider_queue_id: waMessageId } : {})
            })
            .eq('company_id', company_id)
            .eq('id', msg.id)

          const io2 = req.app?.get('io')
          if (io2) {
            const payload = {
              mensagem_id: msg.id,
              conversa_id: Number(conversa_id),
              status: nextStatus,
              status_mensagem: nextStatusMensagem,
              ...(hasTraceableMediaId ? { whatsapp_id: waMessageId } : {})
            }
            io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`).emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', payload)
          }

          if (ok && !hasTraceableMediaId) {
            schedulePendingOutboundReconciliation({
              companyId: company_id,
              mensagemId: msg.id,
              io: io2,
            })
          }

          // Rollout R2 (empresa 1): assim que a mídia enviada é confirmada (status sent),
          // espelha para o Cloudflare R2 na hora, sem esperar a varredura periódica.
          // No-op para outras empresas / R2 desligado. Mídia sem ID rastreável fica pending
          // e será espelhada pela varredura quando a reconciliação confirmar o envio.
          if (ok && hasTraceableMediaId) {
            try {
              const { scheduleR2MirrorIfNeeded } = require('../../services/mediaR2MirrorService')
              scheduleR2MirrorIfNeeded({ supabase, io: io2, company_id, mensagem_id: msg.id })
            } catch (_) { /* espelhamento é best-effort; nunca afeta o envio */ }
          }
        })
        .catch(async (e) => {
          console.error('WhatsApp enviar mídia (erro de rede/provider):', e?.message || e)
          await supabase.from('mensagens').update({ status: 'erro', status_mensagem: 'erro' }).eq('company_id', company_id).eq('id', msg.id)
          const io2 = req.app?.get('io')
          if (io2) {
            const payload = { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro', status_mensagem: 'erro' }
            io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`).emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', payload)
          }
        })
    }

    if (telefoneParaEnvio) {
      if (fullUrl && !isLocalhost && !forceUploadMedia) {
        setImmediate(() => sendMediaWithUrl(fullUrl))
      } else if ((!baseUrl || isLocalhost || forceUploadMedia) && fileWork.path) {
        const provider = getProvider()
        if (provider?.uploadMedia) {
          setImmediate(async () => {
            try {
              const providerUploadFilename = tipo === 'video'
                ? (fileWork.filename || fileWork.originalname || 'video.mp4')
                : (fileWork.originalname || 'file')
              const result = await provider.uploadMedia(fileWork.path, providerUploadFilename, { companyId: company_id, whatsappInstanceId: whatsappInstanceId || undefined })
              if (result?.ok && result?.url) {
                console.log('[ULTRAMSG] Upload bem-sucedido, enviando mídia via CDN:', result.url.slice(0, 50) + '...')
                sendMediaWithUrl(result.url)
              } else {
                console.warn('[ULTRAMSG] Upload de mídia falhou:', {
                  ok: result?.ok,
                  error: result?.error,
                  filename: fileWork.originalname,
                  tipo,
                  forceUploadMedia
                })
                // Fallback seguro: se temos URL pública do backend, tenta enviar direto sem upload.
                if (tipo !== 'video' && fullUrl && !isLocalhost) {
                  console.warn('[ULTRAMSG] Tentando fallback com URL pública do backend após falha no upload.')
                  sendMediaWithUrl(fullUrl)
                } else {
                  console.warn('⚠️ UltraMsg uploadMedia falhou; mídia não enviada.', result?.error || '')
                  await supabase.from('mensagens').update({ status: 'erro', status_mensagem: 'erro' }).eq('company_id', company_id).eq('id', msg.id)
                  const io2 = req.app?.get('io')
                  if (io2) {
                    io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`).emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro', status_mensagem: 'erro' })
                  }
                }
              }
            } catch (e) {
              console.error('WhatsApp uploadMedia:', e)
              await supabase.from('mensagens').update({ status: 'erro', status_mensagem: 'erro' }).eq('company_id', company_id).eq('id', msg.id)
              const io2 = req.app?.get('io')
              if (io2) {
                io2.to(`empresa_${company_id}`).to(`conversa_${conversa_id}`).to(`usuario_${user_id}`).emit(io2.EVENTS?.STATUS_MENSAGEM || 'status_mensagem', { mensagem_id: msg.id, conversa_id: Number(conversa_id), status: 'erro', status_mensagem: 'erro' })
              }
            }
          })
        } else if (!baseUrl && !forceUploadMedia) {
          console.warn('⚠️ APP_URL/BASE_URL não configurado; mídia não enviada ao WhatsApp.')
        } else {
          console.warn('⚠️ APP_URL é localhost e provider sem uploadMedia; mídia não enviada ao WhatsApp.')
        }
      } else if (!baseUrl) {
        console.warn('⚠️ APP_URL/BASE_URL não configurado; mídia não enviada ao WhatsApp.')
      }
    }

  // Não retornar mensagem completa no HTTP — evita duplicação (API + socket). Mensagem chega via nova_mensagem.
  return { ok: true, msg, aviso_whatsapp: avisoWhatsapp }
}

const MAX_ENC_AMINHAR_LOTE = 30

/**
 * Normaliza `mensagem_id` ou `mensagem_ids` do body para uma lista ordenada de IDs (sem duplicados).
 * @param {Record<string, unknown>} body
 * @returns {number[]}
 */
function collectOrderedMessageIds(body) {
  const raw =
    Array.isArray(body?.mensagem_ids) && body.mensagem_ids.length > 0
      ? body.mensagem_ids
      : body?.mensagem_id != null && body?.mensagem_id !== ''
        ? [body.mensagem_id]
        : []
  const seen = new Set()
  const ordered = []
  for (const x of raw) {
    const n = Number(x)
    if (!Number.isFinite(n) || n <= 0) continue
    if (seen.has(n)) continue
    seen.add(n)
    ordered.push(n)
  }
  return ordered
}

function normalizeForwardTipo(tipo) {
  const t = String(tipo || '').toLowerCase().trim()
  if (t === 'image' || t === 'foto' || t === 'photo') return 'imagem'
  if (t === 'vídeo') return 'video'
  if (t === 'document' || t === 'documento' || t === 'file' || t === 'pdf') return 'arquivo'
  if (t === 'ptt') return 'voice'
  return t || 'texto'
}

function getForwardMediaUrlCandidate(mensagem) {
  return String(
    mensagem?.url ||
    mensagem?.url_absoluta ||
    mensagem?.media_url ||
    mensagem?.mediaUrl ||
    ''
  ).trim()
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function resolveLocalUploadPathFromMediaUrl(mediaUrl) {
  const raw = String(mediaUrl || '').trim()
  if (!raw) return null
  let pathname = raw
  if (/^https?:\/\//i.test(raw)) {
    try {
      pathname = new URL(raw).pathname
    } catch {
      return null
    }
  }
  pathname = safeDecodeURIComponent(String(pathname || '').split('?')[0])
  if (!pathname.startsWith('/uploads/')) return null

  const path = require('path')
  const fs = require('fs')
  const { getUploadsRoot } = require('../../config/uploadsRoot')
  const uploadsRoot = path.resolve(getUploadsRoot())
  const rel = pathname.replace(/^\/uploads\//, '').replace(/^[\\/]+/, '')
  const full = path.resolve(uploadsRoot, rel)
  if (full !== uploadsRoot && !full.startsWith(`${uploadsRoot}${path.sep}`)) return null
  if (!fs.existsSync(full)) return null
  return full
}

/**
 * Baixa mídia armazenada no R2 (url "/media/r2/<key>") para um arquivo temporário efêmero em
 * os.tmpdir(). Usado no encaminhamento quando a empresa usa R2 como armazenamento único (sem
 * cópia local). Retorna o caminho do temporário, ou null se o R2 não estiver configurado / chave
 * inválida. O chamador é responsável por remover o temporário (try/finally).
 */
async function downloadR2MediaToTemp(mediaUrl) {
  const os = require('os')
  const path = require('path')
  const fs = require('fs')
  const { isR2Configured, getPresignExpiresSeconds } = require('../../config/r2')
  if (!isR2Configured()) return null

  const key = String(mediaUrl || '').replace(/^\/media\/r2\//, '').split('?')[0]
  if (!key || key.includes('..') || !key.startsWith('media/')) return null

  const { presignGetUrl } = require('../../services/storage/r2Client')
  const signed = presignGetUrl(key, Math.min(120, getPresignExpiresSeconds()))
  const res = await fetch(signed)
  if (!res.ok) throw new Error(`R2 GET ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('R2 corpo vazio')

  const base = path.basename(key).replace(/[^A-Za-z0-9._-]/g, '_') || 'midia'
  const tmp = path.join(os.tmpdir(), `zaperp-fwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}`)
  await fs.promises.writeFile(tmp, buf)
  return tmp
}

async function resolveForwardMediaForProvider({ provider, mensagemOriginal, company_id, whatsappInstanceId, baseUrl }) {
  const rawUrl = getForwardMediaUrlCandidate(mensagemOriginal)
  if (!rawUrl) return { ok: false, error: 'Mensagem sem URL de mídia para encaminhamento.' }

  const isLocalBase = !baseUrl || /localhost|127\.0\.0\.1/i.test(baseUrl)
  let publicUrl = rawUrl.startsWith('http')
    ? rawUrl
    : baseUrl
      ? `${baseUrl}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`
      : null

  const tipo = normalizeForwardTipo(mensagemOriginal.tipo)
  let localPath = resolveLocalUploadPathFromMediaUrl(rawUrl)
  let uploadName = mensagemOriginal.nome_arquivo || 'arquivo'

  // R2 como armazenamento único (empresa 1): quando não há arquivo local mas a mídia está no R2,
  // baixa os bytes para um temporário efêmero. Assim uploadMedia/normalização funcionam sem
  // depender de o provedor seguir o redirect 302. Removido no finally.
  let tempR2Path = null
  if (!localPath && rawUrl.startsWith('/media/r2/')) {
    tempR2Path = await downloadR2MediaToTemp(rawUrl).catch((e) => {
      console.warn('[ULTRAMSG][FORWARD] download do R2 para encaminhamento falhou:', e?.message || e)
      return null
    })
    if (tempR2Path) localPath = tempR2Path
  }

  try {
  if (tipo === 'video' && localPath) {
    const path = require('path')
    const normalizedVideo = await normalizeVideoForUltraMsg({
      path: localPath,
      filename: path.basename(localPath),
      originalname: uploadName,
      mimetype: '',
    }, 'video', { removeSource: false })
    if (normalizedVideo?.converted && normalizedVideo?.file) {
      localPath = normalizedVideo.file.path
      uploadName = normalizedVideo.file.originalname
      if (baseUrl && !isLocalBase) {
        publicUrl = `${baseUrl}/uploads/${encodeURIComponent(normalizedVideo.file.filename)}`
      }
    } else if (normalizedVideo?.required && normalizedVideo?.error) {
      return { ok: false, error: 'Não foi possível preparar o vídeo para encaminhamento.' }
    }

    // O MP4 preparado segue primeiro para o CDN da UltraMSG com MIME video/mp4.
    // A URL própria permanece abaixo apenas como fallback se o upload falhar.
  }

  if (provider?.uploadMedia && localPath) {
    try {
      let uploadPath = localPath
      if (tipo === 'imagem') {
        const path = require('path')
        const normalizedImage = await normalizeImageForWhatsapp({
          path: localPath,
          filename: path.basename(localPath),
          originalname: uploadName,
          mimetype: '',
        }, 'imagem')
        if (normalizedImage?.converted && normalizedImage?.file) {
          uploadPath = normalizedImage.file.path
          uploadName = normalizedImage.file.originalname
          console.log('[ULTRAMSG][FORWARD_IMAGE] Imagem encaminhada normalizada para JPEG:', {
            from: mensagemOriginal.nome_arquivo || path.basename(localPath),
            to: uploadName,
          })
        } else if (normalizedImage?.error) {
          console.warn('[ULTRAMSG][FORWARD_IMAGE] Normalização JPEG indisponível:', normalizedImage.error)
        }
      }
      const providerUploadName = tipo === 'video'
        ? require('path').basename(uploadPath)
        : uploadName
      const upload = await provider.uploadMedia(
        uploadPath,
        providerUploadName,
        { companyId: company_id, whatsappInstanceId: whatsappInstanceId || undefined }
      )
      if (upload?.ok && upload?.url) return { ok: true, url: upload.url, source: 'provider_upload' }
      if (tipo === 'video' || !publicUrl || isLocalBase) {
        return { ok: false, error: upload?.error || 'Falha ao preparar mídia para encaminhamento.' }
      }
    } catch (error) {
      if (tipo === 'video' || !publicUrl || isLocalBase) {
        return { ok: false, error: error?.message || 'Falha ao preparar mídia para encaminhamento.' }
      }
    }
  }

  if (publicUrl && !isLocalBase) return { ok: true, url: publicUrl, source: 'public_url' }
  if (publicUrl && rawUrl.startsWith('http')) return { ok: true, url: publicUrl, source: 'remote_url' }
  return {
    ok: false,
    error: provider?.uploadMedia
      ? 'URL local da mídia indisponível para encaminhamento.'
      : 'Provider não suporta uploadMedia e a URL pública da mídia não está configurada.',
  }
  } finally {
    // Remove o temporário baixado do R2 (se houver). Só chega aqui após uploadMedia ter lido o arquivo.
    if (tempR2Path) {
      try { require('fs').unlinkSync(tempR2Path) } catch (_) { /* já removido */ }
    }
  }
}

/**
 * Encaminha uma mensagem já carregada para a conversa de destino (persistência + WhatsApp + socket).
 * @returns {Promise<{ ok: true, mensagem: object, enviado_whatsapp: boolean } | { ok: false, status: number, error: string }>}
 */
async function encaminharUmaMensagemParaConversa(ctx) {
  const {
    io,
    supabase,
    company_id,
    user_id,
    conversa_id,
    telefoneParaEnvio,
    whatsappInstanceId = null,
    provider,
    usuarioNome,
    mensagemOriginal,
    tipo_encaminhamento,
    timestamp,
  } = ctx

  const fail = (status, error) => ({ ok: false, status, error })
  const prefixoEncaminhado = '[Encaminhado]'

  let novaMensagem = null
  let resultadoEnvio = false

  const tipoOriginal = normalizeForwardTipo(mensagemOriginal.tipo)
  const mediaUrlOriginal = getForwardMediaUrlCandidate(mensagemOriginal)
  const temUrl = !!mediaUrlOriginal

  if (tipo_encaminhamento === 'texto' || (!temUrl && tipoOriginal === 'texto')) {
    const textoOriginal = mensagemOriginal.texto && !mensagemOriginal.texto.startsWith('[Encaminhado]')
      ? mensagemOriginal.texto
      : (mensagemOriginal.texto || '(mídia)')

    const textoParaWhatsApp = usuarioNome
      ? `${prefixoEncaminhado}\n${textoOriginal}\n— ${usuarioNome}`
      : `${prefixoEncaminhado}\n${textoOriginal}`

    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: textoOriginal,
      tipo: 'texto',
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio && provider.sendText) {
      resultadoEnvio = await provider.sendText(telefoneParaEnvio, textoParaWhatsApp, {
        companyId: company_id,
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'encaminhamento_atendimento',
      })
    }
  } else if (temUrl && (tipoOriginal === 'imagem' || tipoOriginal === 'video' || tipoOriginal === 'audio' || tipoOriginal === 'voice' || tipoOriginal === 'arquivo' || tipoOriginal === 'sticker')) {
    const baseUrl = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/$/, '')
    const resolvedMedia = await resolveForwardMediaForProvider({
      provider,
      mensagemOriginal: { ...mensagemOriginal, url: mediaUrlOriginal },
      company_id,
      whatsappInstanceId,
      baseUrl,
    })

    if (!resolvedMedia.ok || !resolvedMedia.url) {
      return fail(400, resolvedMedia.error || 'URL da mídia não pode ser resolvida para encaminhamento')
    }
    const mediaUrl = resolvedMedia.url

    const captionEncaminhado = usuarioNome ? `${prefixoEncaminhado} — ${usuarioNome}` : prefixoEncaminhado

    const textoPlaceholderPorTipo = {
      imagem: '(imagem)',
      video: '(vídeo)',
      audio: '(áudio)',
      voice: '(áudio de voz)',
      sticker: '(figurinha)',
      arquivo: mensagemOriginal.nome_arquivo || '(arquivo)',
    }
    const textoParaBanco = textoPlaceholderPorTipo[tipoOriginal] || mensagemOriginal.nome_arquivo || `(${tipoOriginal})`

    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: textoParaBanco,
      tipo: tipoOriginal,
      url: mediaUrlOriginal,
      nome_arquivo: mensagemOriginal.nome_arquivo,
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio) {
      const opts = {
        companyId: company_id,
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'encaminhamento_atendimento',
        returnDetails: true,
      }

      switch (tipoOriginal) {
        case 'imagem':
          if (provider.sendImage) {
            resultadoEnvio = await provider.sendImage(telefoneParaEnvio, mediaUrl, captionEncaminhado, opts)
          }
          break
        case 'video':
          if (provider.sendVideo) {
            resultadoEnvio = await provider.sendVideo(telefoneParaEnvio, mediaUrl, captionEncaminhado, opts)
          }
          break
        case 'audio':
          if (provider.sendAudio) {
            resultadoEnvio = await provider.sendAudio(telefoneParaEnvio, mediaUrl, opts)
          }
          break
        case 'voice':
          if (provider.sendVoice) {
            resultadoEnvio = await provider.sendVoice(telefoneParaEnvio, mediaUrl, opts)
          } else if (provider.sendAudio) {
            resultadoEnvio = await provider.sendAudio(telefoneParaEnvio, mediaUrl, opts)
          }
          break
        case 'sticker':
          if (provider.sendSticker) {
            resultadoEnvio = await provider.sendSticker(telefoneParaEnvio, mediaUrl, opts)
          }
          break
        default:
          if (provider.sendFile) {
            resultadoEnvio = await provider.sendFile(telefoneParaEnvio, mediaUrl, mensagemOriginal.nome_arquivo || 'arquivo', { ...opts, caption: captionEncaminhado })
          }
      }
    }
  } else if (tipoOriginal === 'contact') {
    let contactMeta = mensagemOriginal.contact_meta
    if (!contactMeta || typeof contactMeta !== 'object') {
      contactMeta = null
    }

    const contactName = contactMeta?.nome || contactMeta?.name || mensagemOriginal.texto || 'Contato'
    const contactPhoneRaw = String(contactMeta?.telefone || contactMeta?.phone || '').replace(/\D/g, '')
    const contactPhone = contactPhoneRaw || null

    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: contactName,
      tipo: 'contact',
      contact_meta: contactMeta || { nome: contactName },
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio && provider.sendContact && contactPhone) {
      resultadoEnvio = await provider.sendContact(
        telefoneParaEnvio,
        contactName,
        contactPhone,
        {
          companyId: company_id,
          conversaId: conversa_id,
          whatsappInstanceId: whatsappInstanceId || undefined,
          sendOrigin: 'encaminhamento_atendimento',
        },
      )
    } else if (telefoneParaEnvio && provider.sendText && !contactPhone) {
      const textoContato = `${prefixoEncaminhado}\n${contactName}`
      resultadoEnvio = await provider.sendText(telefoneParaEnvio, textoContato, {
        companyId: company_id,
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'encaminhamento_atendimento',
      })
    }
  } else if (tipoOriginal === 'location' && mensagemOriginal.location_meta) {
    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: `${prefixoEncaminhado}\n${mensagemOriginal.texto}`,
      tipo: 'location',
      url: mensagemOriginal.url,
      location_meta: mensagemOriginal.location_meta,
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio && provider.sendLocation && mensagemOriginal.location_meta) {
      const { latitude, longitude, nome, endereco } = mensagemOriginal.location_meta
      const addressParaCliente = usuarioNome
        ? `${usuarioNome} — ${[nome, endereco].filter(Boolean).join('\n') || `${latitude},${longitude}`}`
        : [nome, endereco].filter(Boolean).join('\n') || `${latitude},${longitude}`

      resultadoEnvio = await provider.sendLocation(telefoneParaEnvio, {
        address: addressParaCliente,
        lat: latitude,
        lng: longitude,
      }, {
        companyId: company_id,
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'encaminhamento_atendimento',
      })
    }
  } else {
    const textoFallback = mensagemOriginal.texto || '(mídia não suportada para encaminhamento)'
    const textoEncaminhado = `${prefixoEncaminhado}\n${textoFallback}`
    const textoComUsuario = usuarioNome ? `${textoEncaminhado}\n— ${usuarioNome}` : textoEncaminhado

    const { data: msg, error } = await supabase.from('mensagens').insert({
      conversa_id: Number(conversa_id),
      texto: textoEncaminhado,
      tipo: 'texto',
      direcao: 'out',
      autor_usuario_id: user_id,
      company_id,
      ...(whatsappInstanceId ? { whatsapp_instance_id: whatsappInstanceId } : {}),
      status: 'pending',
      criado_em: timestamp,
    }).select().single()

    if (error) return fail(500, error.message)
    novaMensagem = msg

    if (telefoneParaEnvio && provider.sendText) {
      resultadoEnvio = await provider.sendText(telefoneParaEnvio, textoComUsuario, {
        companyId: company_id,
        conversaId: conversa_id,
        whatsappInstanceId: whatsappInstanceId || undefined,
        sendOrigin: 'encaminhamento_atendimento',
      })
    }
  }

  const ok = resultadoEnvio === true || resultadoEnvio?.ok === true
  const waMessageId = (typeof resultadoEnvio === 'object' && resultadoEnvio?.messageId)
    ? String(resultadoEnvio.messageId).trim() : null
  const hasTraceableForwardId = isRealWhatsAppId(waMessageId)
  const hasQueueForwardId = !!waMessageId && isUltramsgNumericQueueId(waMessageId)
  const nextStatus = ok ? (hasTraceableForwardId ? 'sent' : 'pending') : 'erro'
  const nextStatusMensagem = ok ? (hasTraceableForwardId ? 'sent' : 'sending') : 'erro'

  await supabase
    .from('mensagens')
    .update({
      status: nextStatus,
      status_mensagem: nextStatusMensagem,
      ...(hasTraceableForwardId ? { whatsapp_id: waMessageId } : {}),
      ...(hasQueueForwardId ? { provider_queue_id: waMessageId } : {}),
    })
    .eq('company_id', company_id)
    .eq('id', novaMensagem.id)

  await supabase
    .from('conversas')
    .update({ lida: true, ultima_atividade: timestamp })
    .eq('company_id', Number(company_id))
    .eq('id', Number(conversa_id))

  if (io) {
    const msgParaEmissao = {
      ...novaMensagem,
      status: nextStatus,
      status_mensagem: nextStatusMensagem,
      whatsapp_id: hasTraceableForwardId ? waMessageId : null,
      encaminhado: true,
    }
    const payload = await enrichMensagemComAutorUsuario(supabase, company_id, msgParaEmissao)
    emitirEventoEmpresaConversa(io, company_id, conversa_id, io.EVENTS?.NOVA_MENSAGEM || 'nova_mensagem', payload)

    const convPayload = { id: Number(conversa_id) }
    emitirConversaAtualizada(io, company_id, conversa_id, convPayload)
  }

  return {
    ok: true,
    mensagem: {
      ...novaMensagem,
      status: nextStatus,
      status_mensagem: nextStatusMensagem,
      whatsapp_id: hasTraceableForwardId ? waMessageId : null,
      encaminhado: true,
    },
    enviado_whatsapp: ok,
  }
}

module.exports = {
  IMAGE_FILE_EXTENSIONS,
  VIDEO_FILE_EXTENSIONS,
  ULTRAMSG_VIDEO_FILE_EXTENSIONS,
  ULTRAMSG_VIDEO_MAX_BYTES,
  ULTRAMSG_VIDEO_TARGET_BYTES,
  AUDIO_FILE_EXTENSIONS,
  DOCUMENT_FILE_EXTENSIONS,
  MAX_ARQUIVOS_LOTE_ENVIO,
  MAX_MEDIA_CAPTION_CHARS,
  MAX_ENC_AMINHAR_LOTE,
  mimeBase,
  extBaseArquivo,
  isForcedVoiceAudioish,
  aplicarTipoForcadoSticker,
  inferirTipoArquivo,
  getAudioFileExtension,
  resolveFfmpegPath,
  convertAudioWithFfmpeg,
  probeAudioDurationSec,
  normalizeAudioForUltraMsg,
  shouldAbortAudioAfterNormalize,
  shouldNormalizeVideoForUltraMsg,
  shouldForceProviderUploadForMedia,
  buildVideoTranscodeProfile,
  probeVideoDurationSec,
  convertVideoToUltraMsgMp4,
  normalizeVideoForUltraMsg,
  shouldNormalizeImageForWhatsapp,
  convertImageToWhatsappJpeg,
  normalizeImageForWhatsapp,
  dedupeMulterFiles,
  enviarArquivoProcessarUm,
  collectOrderedMessageIds,
  normalizeForwardTipo,
  getForwardMediaUrlCandidate,
  safeDecodeURIComponent,
  resolveLocalUploadPathFromMediaUrl,
  downloadR2MediaToTemp,
  resolveForwardMediaForProvider,
  encaminharUmaMensagemParaConversa,
}
