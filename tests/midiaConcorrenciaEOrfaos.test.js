/**
 * Doc 29 §3 item 11 — mídia sem teto de concorrência e arquivos órfãos.
 *
 *  1. `helpers/limiteConcorrencia` — fila FIFO, teto respeitado, falha não trava a fila;
 *  2. os dois agendadores sem teto (download inbound e espelhamento R2) passam pelo limitador;
 *  3. encaminhamento de vídeo/imagem não deixa mais `<nome>-wa.mp4` / `-wa.jpg` em /uploads —
 *     exceto o arquivo que o provedor ainda vai buscar pela URL devolvida;
 *  4. o 422 de áudio apaga o upload abortado.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

describe('helpers/limiteConcorrencia', () => {
  const { criarLimiteConcorrencia } = require('../helpers/limiteConcorrencia')

  test('nunca passa do teto de tarefas simultâneas', async () => {
    const limite = criarLimiteConcorrencia(2)
    let ativos = 0
    let pico = 0
    const tarefa = async () => {
      ativos += 1
      pico = Math.max(pico, ativos)
      await new Promise((r) => setTimeout(r, 10))
      ativos -= 1
    }
    await Promise.all(Array.from({ length: 8 }, () => limite.run(tarefa)))
    expect(pico).toBe(2)
    expect(limite.emExecucao()).toBe(0)
    expect(limite.naFila()).toBe(0)
  })

  test('todas as tarefas rodam (nada é descartado) e em ordem de entrada', async () => {
    const limite = criarLimiteConcorrencia(1)
    const ordem = []
    await Promise.all([1, 2, 3, 4].map((n) => limite.run(async () => { ordem.push(n) })))
    expect(ordem).toEqual([1, 2, 3, 4])
  })

  test('tarefa que rejeita não trava a fila e o erro chega a quem chamou', async () => {
    const limite = criarLimiteConcorrencia(1)
    const p1 = limite.run(async () => { throw new Error('boom') })
    const p2 = limite.run(async () => 'ok')
    await expect(p1).rejects.toThrow('boom')
    await expect(p2).resolves.toBe('ok')
    expect(limite.emExecucao()).toBe(0)
  })

  test('tarefa síncrona que estoura também é capturada', async () => {
    const limite = criarLimiteConcorrencia(1)
    await expect(limite.run(() => { throw new Error('sync') })).rejects.toThrow('sync')
    await expect(limite.run(async () => 1)).resolves.toBe(1)
  })

  test('teto inválido cai em 1 (nunca ilimitado por acidente)', () => {
    expect(criarLimiteConcorrencia(0).max).toBe(1)
    expect(criarLimiteConcorrencia(undefined).max).toBe(1)
    expect(criarLimiteConcorrencia(-5).max).toBe(1)
  })
})

describe('os agendadores de mídia passam pelo limitador', () => {
  test('download de mídia inbound tem teto', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'inboundMediaPersistenceService.js'), 'utf8')
    expect(src).toContain('criarLimiteConcorrencia')
    expect(src).toContain('_limiteDownloadInbound.run(')
    // O agendamento NÃO pode mais chamar a persistência direto dentro do setImmediate.
    const bloco = src.slice(src.indexOf('function schedulePersistInboundMediaIfNeeded'))
    const corpo = bloco.slice(0, bloco.indexOf('\n}\n') + 3)
    expect(corpo).toContain('_limiteDownloadInbound.run(')
  })

  test('espelhamento R2 tem teto', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'mediaR2MirrorService.js'), 'utf8')
    expect(src).toContain('criarLimiteConcorrencia')
    const bloco = src.slice(src.indexOf('function scheduleR2MirrorIfNeeded'))
    const corpo = bloco.slice(0, bloco.indexOf('\n}\n') + 3)
    expect(corpo).toContain('_limiteEspelhamentoR2.run(')
  })
})

describe('encaminhamento não deixa convertido órfão em /uploads', () => {
  let dir
  let uploadsAntes

  beforeEach(() => {
    jest.resetModules()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-'))
    // O resolver resolve /uploads/<x> contra getUploadsRoot() — aponta para o temporário.
    uploadsAntes = process.env.UPLOADS_DIR
    process.env.UPLOADS_DIR = dir
  })

  afterEach(() => {
    jest.resetModules()
    if (uploadsAntes === undefined) delete process.env.UPLOADS_DIR
    else process.env.UPLOADS_DIR = uploadsAntes
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
  })

  function montar({ uploadOk }) {
    const origem = path.join(dir, 'video-1.mov')
    const convertido = path.join(dir, 'video-1-wa.mp4')
    fs.writeFileSync(origem, 'origem')

    jest.doMock('../services/chat/media/mediaNormalizers', () => ({
      normalizeVideoForUltraMsg: async () => {
        fs.writeFileSync(convertido, 'convertido')
        return {
          converted: true,
          required: true,
          error: null,
          file: {
            path: convertido,
            filename: path.basename(convertido),
            originalname: 'video-1.mp4',
            mimetype: 'video/mp4',
            size: 10,
          },
        }
      },
      normalizeImageForWhatsapp: async () => ({ converted: false }),
    }))

    const resolver = require('../services/chat/outbound/forwardMediaResolver')
    const provider = {
      uploadMedia: async () => (uploadOk
        ? { ok: true, url: 'https://cdn.ultramsg.test/media/abc.mp4' }
        : { ok: false, error: 'upload falhou' }),
    }
    return { resolver, provider, convertido, origem }
  }

  const mensagem = { tipo: 'video', url: '/uploads/video-1.mov', nome_arquivo: 'video-1.mov' }

  test('o convertido é de facto criado (a montagem exercita a normalização)', async () => {
    const { resolver, provider } = montar({ uploadOk: true })
    const r = await resolver.resolveForwardMediaForProvider({
      provider, company_id: 1, mensagemOriginal: mensagem, baseUrl: 'https://app.example.com',
    })
    expect(r.source).toBe('provider_upload')
  })

  test('upload ao CDN concluído: o `-wa.mp4` é removido e a mídia salva permanece', async () => {
    const { resolver, provider, convertido, origem } = montar({ uploadOk: true })
    const r = await resolver.resolveForwardMediaForProvider({
      provider, company_id: 1, mensagemOriginal: mensagem, baseUrl: 'https://app.example.com',
    })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(convertido)).toBe(false) // órfão eliminado
    expect(fs.existsSync(origem)).toBe(true) // mídia salva intacta
  })

  test('falha no upload: nada de convertido sobra (vídeo não tem fallback por URL)', async () => {
    const { resolver, provider, convertido, origem } = montar({ uploadOk: false })
    const r = await resolver.resolveForwardMediaForProvider({
      provider, company_id: 1, mensagemOriginal: mensagem, baseUrl: 'https://app.example.com',
    })
    expect(r.ok).toBe(false)
    expect(fs.existsSync(convertido)).toBe(false)
    expect(fs.existsSync(origem)).toBe(true)
  })

  test('quando a URL devolvida aponta para o convertido, ele NÃO é apagado (senão o provedor leva 404)', async () => {
    const { resolver, convertido } = montar({ uploadOk: true })
    // Sem uploadMedia o resolver cai no fallback por URL pública — que serve o próprio -wa.mp4.
    const r = await resolver.resolveForwardMediaForProvider({
      provider: {}, company_id: 1, mensagemOriginal: mensagem, baseUrl: 'https://app.example.com',
    })
    expect(r.ok).toBe(true)
    expect(r.url).toContain('-wa.mp4')
    expect(fs.existsSync(convertido)).toBe(true)
  })
})

describe('422 de áudio apaga o upload abortado', () => {
  test('o ramo de conversão obrigatória falhada remove o arquivo', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'chat', 'mediaMessageController.js'), 'utf8')
    const marca = 'shouldAbortAudioAfterNormalize(tipo, normalized)'
    const ini = src.indexOf(marca)
    expect(ini).toBeGreaterThan(-1)
    const bloco = src.slice(ini, src.indexOf('formato compatível com o WhatsApp', ini))
    expect(bloco).toContain('unlinkSync(fileWork.path)')
  })

  test('os três ramos de 422 de mídia limpam o upload', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'chat', 'mediaMessageController.js'), 'utf8')
    const ocorrencias = (src.match(/status: 422/g) || []).length
    expect(ocorrencias).toBe(3)
    // Cada 422 tem uma limpeza de arquivo antes dele.
    const limpezas = (src.match(/unlink(Sync)?\(fileWork\.path/g) || []).length
    expect(limpezas).toBeGreaterThanOrEqual(3)
  })
})
