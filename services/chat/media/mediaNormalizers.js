/**
 * Normalização de mídia para envio via UltraMSG (FFmpeg + filesystem): áudio/voz, vídeo e imagem.
 *
 * Extraído de controllers/chatController.js (Fase 7 da modularização) sem alteração de comportamento.
 * São funções com efeitos de I/O (spawn de ffmpeg, leitura/escrita/remoção de arquivos temporários),
 * isoladas do HTTP. As decisões puras (quando normalizar, perfil de transcode, extensões/limites)
 * vêm de ./mediaType.
 */

const {
  getAudioFileExtension,
  mimeBase,
  shouldNormalizeVideoForUltraMsg,
  ULTRAMSG_VIDEO_MAX_BYTES,
  ULTRAMSG_VIDEO_TARGET_BYTES,
  buildVideoTranscodeProfile,
  shouldNormalizeImageForWhatsapp,
} = require('./mediaType')

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

module.exports = {
  resolveFfmpegPath,
  convertAudioWithFfmpeg,
  probeAudioDurationSec,
  normalizeAudioForUltraMsg,
  probeVideoDurationSec,
  convertVideoToUltraMsgMp4,
  normalizeVideoForUltraMsg,
  convertImageToWhatsappJpeg,
  normalizeImageForWhatsapp,
}
