/**
 * Regressão de DURAÇÃO no envio de áudio de voz.
 *
 * Garante que normalizeAudioForUltraMsg(tipo='voice') produz um OGG/Opus com a duração REAL do
 * áudio — inclusive quando a gravação chega com timestamps deslocados (o MediaRecorder do navegador
 * grava o 1º bloco com PTS inicial grande, o que já inflou "10s → 5min" no WhatsApp) ou com
 * timestamps não-monotônicos (30s de fala chegavam ao contato como ~1-3s, começando mudo e com a
 * voz cortada). O fix é o `aresample=async=0,asetpts=N/SR/TB` no perfil voice_ogg_opus: a duração de
 * saída passa a ser a contagem de amostras decodificadas, e não o que o container de entrada diz.
 * Ver project_audio_duracao_inflada_raw_webm.
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

const {
  normalizeAudioForUltraMsg,
  resolveFfmpegPath,
  probeAudioDurationSec,
  audioDurationShortfall,
  expectedAudioDurationMsFromRequest,
} = _test

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

/** Corta [inicio, fim) do fonte, opcionalmente deslocando os timestamps. */
async function fatiar(src, out, { ss = null, t = null, tsOffsetSec = 0 } = {}) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  if (ss != null) args.push('-ss', String(ss))
  args.push('-i', src)
  if (t != null) args.push('-t', String(t))
  if (tsOffsetSec > 0) args.push('-output_ts_offset', String(tsOffsetSec), '-muxdelay', '0')
  args.push('-c', 'copy', out)
  const { code } = await runFfmpeg(args)
  if (code !== 0 || !fs.existsSync(out)) throw new Error('falha ao fatiar webm de teste')
}

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

/**
 * BUG REPRODUZIDO: gravação de ~30s chegando ao contato com ~1-3s, começando muda e com a
 * voz cortada. A gravação do navegador junta blocos cujos timestamps não são monotônicos
 * (1º bloco com PTS grande, o resto voltando para perto de zero). Com o filtro antigo
 * (`aresample=async=1`) o ffmpeg DESCARTAVA todo o áudio até a linha do tempo alcançar o
 * primeiro bloco: 31s de fala saíam como 1s de OGG — com exit 0, sem erro nenhum.
 */
maybe('gravação com timestamps NÃO-MONOTÔNICOS mantém todo o áudio (não corta para ~1s)', async () => {
  const src = path.join(tmpDir, 'srcNaoMono.webm')
  await gerarWebmOpus(src, 30, 0)
  const bloco1 = path.join(tmpDir, 'naoMono-1.webm')
  const bloco2 = path.join(tmpDir, 'naoMono-2.webm')
  await fatiar(src, bloco1, { t: 1, tsOffsetSec: 300 })
  await fatiar(src, bloco2, { ss: 1 })
  const inPath = path.join(tmpDir, 'naoMono.webm')
  fs.writeFileSync(inPath, Buffer.concat([fs.readFileSync(bloco1), fs.readFileSync(bloco2)]))

  const res = await normalizeAudioForUltraMsg(fakeMulterFile(inPath), 'voice')
  expect(res.converted).toBe(true)

  const durOut = await probeDurationSec(res.file.path)
  expect(durOut).not.toBeNull()
  // Antes do fix: ~1.0s. Agora precisa conter a gravação inteira.
  expect(durOut).toBeGreaterThan(28)
  expect(durOut).toBeLessThan(34)
}, 60000)

/**
 * Contraparte do mesmo defeito: salto de timestamp PARA FRENTE no meio da gravação.
 * O filtro antigo enchia o vão com silêncio — 33s de fala viravam 327s, quase todo mudo.
 */
maybe('salto de timestamp no meio NÃO vira silêncio de minutos', async () => {
  const src = path.join(tmpDir, 'srcSalto.webm')
  await gerarWebmOpus(src, 30, 0)
  const bloco1 = path.join(tmpDir, 'salto-1.webm')
  const bloco2 = path.join(tmpDir, 'salto-2.webm')
  await fatiar(src, bloco1, { t: 3 })
  await fatiar(src, bloco2, { ss: 3, tsOffsetSec: 300 })
  const inPath = path.join(tmpDir, 'salto.webm')
  fs.writeFileSync(inPath, Buffer.concat([fs.readFileSync(bloco1), fs.readFileSync(bloco2)]))

  const res = await normalizeAudioForUltraMsg(fakeMulterFile(inPath), 'voice')
  expect(res.converted).toBe(true)

  const durOut = await probeDurationSec(res.file.path)
  expect(durOut).not.toBeNull()
  // Antes do fix: ~327s (294s de silêncio no meio).
  expect(durOut).toBeGreaterThan(28)
  expect(durOut).toBeLessThan(40)
}, 60000)

maybe('transcode devolve a duração medida da saída (base da verificação de corte)', async () => {
  const inPath = path.join(tmpDir, 'inDur.webm')
  await gerarWebmOpus(inPath, 10, 0)
  const res = await normalizeAudioForUltraMsg(fakeMulterFile(inPath), 'voice')
  expect(res.converted).toBe(true)
  expect(res.durationSec).toBeGreaterThan(9.3)
  expect(res.durationSec).toBeLessThan(10.7)

  const medido = await probeAudioDurationSec(res.file.path)
  expect(medido).toBeCloseTo(res.durationSec, 2)
}, 30000)

test('probeAudioDurationSec devolve null para arquivo inexistente', async () => {
  const d = await probeAudioDurationSec(path.join(os.tmpdir(), 'nao-existe-zaperp.ogg'))
  expect(d).toBeNull()
})

describe('audioDurationShortfall (guarda de gravação incompleta)', () => {
  test('acusa corte quando a saída cobre bem menos que o gravado', () => {
    const r = audioDurationShortfall(30000, 3.3)
    expect(r).not.toBeNull()
    expect(r.expectedMs).toBe(30000)
    expect(r.actualMs).toBe(3300)
    expect(r.faltandoMs).toBe(26700)
  })

  test('não acusa quando a duração bate', () => {
    expect(audioDurationShortfall(30000, 30.0)).toBeNull()
    expect(audioDurationShortfall(30000, 29.4)).toBeNull()
  })

  test('não acusa diferenças pequenas mesmo em áudio curto', () => {
    // 1s gravado, 0.9s de saída: proporção baixa não importa, a diferença é irrisória.
    expect(audioDurationShortfall(1000, 0.9)).toBeNull()
    expect(audioDurationShortfall(4000, 2.0)).toBeNull()
  })

  test('não acusa quando a saída é maior que o gravado', () => {
    expect(audioDurationShortfall(30000, 33.0)).toBeNull()
  })

  test('sem duração declarada ou sem medição, não bloqueia nada', () => {
    expect(audioDurationShortfall(null, 3)).toBeNull()
    expect(audioDurationShortfall(undefined, 3)).toBeNull()
    expect(audioDurationShortfall(0, 3)).toBeNull()
    expect(audioDurationShortfall('abc', 3)).toBeNull()
    expect(audioDurationShortfall(30000, null)).toBeNull()
    expect(audioDurationShortfall(30000, 0)).toBeNull()
  })
})

describe('expectedAudioDurationMsFromRequest', () => {
  test('aceita cada campo isoladamente', () => {
    expect(expectedAudioDurationMsFromRequest({ body: { audio_duration_ms: '30120' } })).toBe(30120)
    expect(expectedAudioDurationMsFromRequest({ body: { audio_elapsed_ms: '29800' } })).toBe(29800)
    expect(
      expectedAudioDurationMsFromRequest({ body: { audio_duration_ms: '0', audio_elapsed_ms: '29800' } })
    ).toBe(29800)
  })

  /**
   * O <audio> lendo o WebM cru pode reportar duração INFLADA (é o defeito que o transcode
   * corrige). Se a guarda confiasse nesse número, recusaria gravação boa: 10s reais contra
   * "310s declarados" viraria 422. O tempo de relógio é o piso confiável.
   */
  test('usa o MENOR dos dois — duração inflada do container não pode recusar áudio bom', () => {
    expect(
      expectedAudioDurationMsFromRequest({ body: { audio_duration_ms: '310000', audio_elapsed_ms: '10200' } })
    ).toBe(10200)
    expect(audioDurationShortfall(
      expectedAudioDurationMsFromRequest({ body: { audio_duration_ms: '310000', audio_elapsed_ms: '10200' } }),
      10.0
    )).toBeNull()
  })

  test('upload de vários arquivos não usa a duração do corpo (não descreve arquivo nenhum)', () => {
    const req = { body: { audio_elapsed_ms: '30000' } }
    expect(expectedAudioDurationMsFromRequest(req, { totalArquivos: 1 })).toBe(30000)
    expect(expectedAudioDurationMsFromRequest(req, { totalArquivos: 3 })).toBeNull()
  })

  test('campo repetido no multipart vira array — usa o primeiro válido', () => {
    expect(expectedAudioDurationMsFromRequest({ body: { audio_duration_ms: ['30120', '1'] } })).toBe(30120)
  })

  test('sem metadados (arquivo anexado, não gravado) devolve null', () => {
    expect(expectedAudioDurationMsFromRequest({ body: {} })).toBeNull()
    expect(expectedAudioDurationMsFromRequest({})).toBeNull()
    expect(expectedAudioDurationMsFromRequest(null)).toBeNull()
    expect(expectedAudioDurationMsFromRequest({ body: { audio_duration_ms: 'abc' } })).toBeNull()
  })
})
