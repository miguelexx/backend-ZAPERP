/**
 * Guarda de GRAVAÇÃO INCOMPLETA no envio de áudio de voz.
 *
 * Sintoma relatado: gravação de ~30s chegando ao contato com ~3s, começando muda e com a
 * voz cortada. Quando o arquivo que sobe perde blocos (microfone desconectado no meio,
 * chunks perdidos no caminho), o ffmpeg converte só o pedaço legível e sai com sucesso —
 * antes o pedaço era enviado ao WhatsApp como se fosse o áudio inteiro.
 *
 * O composer manda junto a duração medida no navegador (`audio_duration_ms`). Aqui
 * garantimos que `enviarArquivoProcessarUm` compara essa duração com a do arquivo
 * transcodificado e ABORTA com 422 em vez de entregar o áudio cortado — e que uma
 * gravação íntegra continua passando normalmente.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { _test } = require('../controllers/chatController')

const { enviarArquivoProcessarUm, resolveFfmpegPath } = _test

function ffmpegAvailable() {
  try {
    const p = resolveFfmpegPath()
    if (!p || p === 'ffmpeg') return false
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

async function gerarWebmOpus(outPath, durationSec) {
  const { code } = await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}`,
    '-c:a', 'libopus', outPath,
  ])
  if (code !== 0 || !fs.existsSync(outPath)) throw new Error('falha ao gerar webm de teste')
}

let tmpDir
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaperp-audioinc-'))
})
afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** Arquivo do multer, marcado como nota de voz (é o que o composer envia). */
function fakeVoiceUpload(inPath) {
  return {
    path: inPath,
    filename: path.basename(inPath),
    originalname: path.basename(inPath),
    mimetype: 'audio/webm',
    __tipoForcado: 'voice',
  }
}

function fakeReq(body) {
  return { body, app: { get: () => null } }
}

const contexto = {
  company_id: 1,
  user_id: 1,
  conversa_id: 10,
  telefoneParaEnvio: '5511999999999',
  io: null,
  captionUsuario: '',
  clientTempId: null,
}

maybe('gravação que chegou cortada (30s viraram ~3s) é recusada com 422', async () => {
  const src = path.join(tmpDir, 'src30.webm')
  await gerarWebmOpus(src, 30)
  // Perda de blocos no caminho: só o começo do arquivo chegou ao servidor.
  const truncado = path.join(tmpDir, 'truncado.webm')
  const buf = fs.readFileSync(src)
  fs.writeFileSync(truncado, buf.subarray(0, Math.floor(buf.length * 0.1)))

  const file = fakeVoiceUpload(truncado)
  const r = await enviarArquivoProcessarUm(
    fakeReq({ audio_duration_ms: '30000' }),
    file,
    contexto
  )

  expect(r.ok).toBe(false)
  expect(r.status).toBe(422)
  expect(String(r.error)).toMatch(/incompleta/i)
  // O pedaço convertido não pode ficar no disco para ser reenviado depois.
  const convertido = truncado.replace(/\.webm$/, '.ogg')
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(fs.existsSync(convertido)).toBe(false)
}, 60000)

maybe('gravação íntegra de 30s passa pela guarda (não bloqueia envio bom)', async () => {
  const inPath = path.join(tmpDir, 'integra.webm')
  await gerarWebmOpus(inPath, 30)

  const r = await enviarArquivoProcessarUm(
    fakeReq({ audio_duration_ms: '30000' }),
    fakeVoiceUpload(inPath),
    contexto
  )

  // Passou da guarda: qualquer falha daqui em diante é do supabase/provider mockado,
  // nunca o 422 de gravação incompleta.
  expect(r.status).not.toBe(422)
  // Prova de que chegou a usar o arquivo convertido (a guarda apaga o .ogg quando recusa).
  expect(fs.existsSync(inPath.replace(/\.webm$/, '.ogg'))).toBe(true)
}, 60000)

maybe('áudio anexado sem duração declarada não é bloqueado', async () => {
  const src = path.join(tmpDir, 'srcAnexo.webm')
  await gerarWebmOpus(src, 30)
  const truncado = path.join(tmpDir, 'anexoTruncado.webm')
  const buf = fs.readFileSync(src)
  fs.writeFileSync(truncado, buf.subarray(0, Math.floor(buf.length * 0.1)))

  // Sem audio_duration_ms (arquivo escolhido pelo usuário, não gravado no composer):
  // não há com o que comparar, então a guarda não pode inventar um bloqueio.
  const r = await enviarArquivoProcessarUm(fakeReq({}), fakeVoiceUpload(truncado), contexto)
  expect(r.status).not.toBe(422)
}, 60000)

maybe('diferença pequena de duração não bloqueia (tolerância)', async () => {
  const inPath = path.join(tmpDir, 'quase.webm')
  await gerarWebmOpus(inPath, 30)

  // O navegador mede o tempo de parede (inclui o handshake do microfone), então é normal
  // declarar um pouco mais do que o áudio tem.
  const r = await enviarArquivoProcessarUm(
    fakeReq({ audio_duration_ms: '31500' }),
    fakeVoiceUpload(inPath),
    contexto
  )
  expect(r.status).not.toBe(422)
}, 60000)

maybe('duração inflada pelo container não recusa gravação boa (regressão da guarda)', async () => {
  const inPath = path.join(tmpDir, 'inflada.webm')
  await gerarWebmOpus(inPath, 30)

  // O <audio> do navegador pode reportar 310s para uma gravação de 30s (é o defeito que o
  // transcode corrige). A guarda usa o menor valor, então o tempo de relógio manda.
  const r = await enviarArquivoProcessarUm(
    fakeReq({ audio_duration_ms: '310000', audio_elapsed_ms: '30200' }),
    fakeVoiceUpload(inPath),
    contexto
  )
  expect(r.status).not.toBe(422)
}, 60000)

maybe('upload múltiplo não aplica a duração do corpo a cada arquivo', async () => {
  const src = path.join(tmpDir, 'srcMulti.webm')
  await gerarWebmOpus(src, 30)
  const curto = path.join(tmpDir, 'curtoDoLote.webm')
  await gerarWebmOpus(curto, 3)

  // Corpo declara 30s (de outro arquivo do lote); o de 3s não pode ser recusado por isso.
  const r = await enviarArquivoProcessarUm(
    fakeReq({ audio_elapsed_ms: '30000' }),
    fakeVoiceUpload(curto),
    { ...contexto, totalArquivos: 2 }
  )
  expect(r.status).not.toBe(422)
}, 60000)
