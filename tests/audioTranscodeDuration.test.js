/**
 * Regressão de DURAÇÃO no envio de áudio de voz.
 *
 * Garante que normalizeAudioForUltraMsg(tipo='voice') produz um OGG/Opus com a duração REAL do
 * áudio — inclusive quando a gravação chega com timestamps deslocados (o MediaRecorder do navegador
 * grava o 1º bloco com PTS inicial grande, o que já inflou "10s → 5min" no WhatsApp). O fix é o
 * `aresample=async=1:first_pts=0` no perfil voice_ogg_opus. Ver project_audio_duracao_inflada_raw_webm.
 *
 * Depende do ffmpeg (mesmo binário usado em produção via resolveFfmpegPath). Se indisponível, os
 * testes são pulados (não falham o CI), pois o comportamento em produção nesse caso é abortar o
 * envio com erro claro — nunca enviar áudio quebrado.
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _test } = require('../controllers/chatController')

const { normalizeAudioForUltraMsg, resolveFfmpegPath } = _test

function ffmpegAvailable() {
  try {
    const p = resolveFfmpegPath()
    if (!p) return false
    if (p === 'ffmpeg') return false // não confiar no PATH do sistema no ambiente de teste
    return fs.existsSync(p)
  } catch {
    return false
  }
}

const FF = ffmpegAvailable() ? resolveFfmpegPath() : null
const maybe = FF ? test : test.skip

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FF, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += String(d || '') })
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ code, stderr }))
  })
}

/** Duração em segundos lida do stderr do ffmpeg (linha "Duration: HH:MM:SS.ss"). */
async function probeDurationSec(file) {
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', file])
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** Gera um webm/opus de `durationSec` com offset de timestamp `tsOffsetSec` (simula MediaRecorder). */
async function gerarWebmOpus(outPath, durationSec, tsOffsetSec = 0) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    `sine=frequency=440:duration=${durationSec}`]
  if (tsOffsetSec > 0) args.push('-output_ts_offset', String(tsOffsetSec), '-muxdelay', '0')
  args.push('-c:a', 'libopus', outPath)
  const { code } = await runFfmpeg(args)
  if (code !== 0 || !fs.existsSync(outPath)) throw new Error('falha ao gerar webm de teste')
}

let tmpDir
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaperp-audiocert-'))
})
afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function fakeMulterFile(inPath) {
  return {
    path: inPath,
    filename: path.basename(inPath),
    originalname: path.basename(inPath),
    mimetype: 'audio/webm',
  }
}

if (!FF) {
  // eslint-disable-next-line no-console
  console.warn('[audioTranscodeDuration] ffmpeg indisponível — testes de duração pulados.')
}

maybe('áudio de voz de 10s mantém ~10s após transcode (sem inflar/cortar)', async () => {
  const inPath = path.join(tmpDir, 'in10.webm')
  await gerarWebmOpus(inPath, 10, 0)

  const res = await normalizeAudioForUltraMsg(fakeMulterFile(inPath), 'voice')

  expect(res.converted).toBe(true)
  expect(res.error).toBeNull()
  expect(res.file.mimetype).toBe('audio/ogg')
  expect(fs.existsSync(res.file.path)).toBe(true)
  expect(fs.statSync(res.file.path).size).toBeGreaterThan(0)

  const durOut = await probeDurationSec(res.file.path)
  expect(durOut).not.toBeNull()
  expect(durOut).toBeGreaterThan(9.3)
  expect(durOut).toBeLessThan(10.7)
}, 30000)

maybe('gravação com PTS deslocado (+300s) NÃO infla a duração — volta para ~10s', async () => {
  const inPath = path.join(tmpDir, 'inOffset.webm')
  await gerarWebmOpus(inPath, 10, 300)

  // Sanidade: o container de entrada "parece" ter ~310s (é o bug que o transcode precisa corrigir).
  const durIn = await probeDurationSec(inPath)
  expect(durIn).toBeGreaterThan(300)

  const res = await normalizeAudioForUltraMsg(fakeMulterFile(inPath), 'voice')
  expect(res.converted).toBe(true)

  const durOut = await probeDurationSec(res.file.path)
  expect(durOut).not.toBeNull()
  // O essencial: NÃO inflou (nada de ~310s); ficou na duração real do áudio.
  expect(durOut).toBeLessThan(15)
  expect(durOut).toBeGreaterThan(9.3)
}, 30000)
