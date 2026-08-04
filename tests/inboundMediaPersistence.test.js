/**
 * Cobre a cópia da mídia inbound para /uploads: retentativas com backoff, classificação de falhas,
 * proteção contra execução duplicada e a garantia de só trocar a URL depois do arquivo íntegro.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  RETRY_DELAYS_MS,
  MAX_TENTATIVAS,
  STATUS,
  FALHA,
  classificarFalha,
  planejarProximaTentativa,
  resumoUrlParaLog,
} = require('../helpers/inboundMediaRetryPolicy')
const servico = require('../services/inboundMediaPersistenceService')

const { persistInboundMediaToUploads, resetEstadoPersistenciaFlag } = servico._test

const URL_REMOTA = 'https://s3.amazonaws.com/ultramsgmedia/instance1/abc123?X-Amz-Signature=segredo'
const CONTEUDO = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(60, 7)])

let uploadsDir
let uploadsAnterior
let fetchAnterior
let avisos

beforeEach(() => {
  resetEstadoPersistenciaFlag()
  servico.limparRetentativasAgendadas()
  uploadsAnterior = process.env.UPLOADS_DIR
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaperp-persist-'))
  process.env.UPLOADS_DIR = uploadsDir
  fetchAnterior = global.fetch
  avisos = []
  jest.spyOn(console, 'warn').mockImplementation((...args) => avisos.push(args))
  jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  global.fetch = fetchAnterior
  if (uploadsAnterior === undefined) delete process.env.UPLOADS_DIR
  else process.env.UPLOADS_DIR = uploadsAnterior
  fs.rmSync(uploadsDir, { recursive: true, force: true })
  servico.limparRetentativasAgendadas()
  jest.restoreAllMocks()
})

function arquivosSalvos() {
  return fs.readdirSync(uploadsDir)
}

/**
 * Supabase de mentira que entende as três formas usadas pelo serviço: leitura da mensagem, lock por
 * compare-and-swap (update com `or`) e troca condicional da URL (update com `ilike`).
 */
function criarSupabase(linhaInicial, opcoes = {}) {
  const linha = { midia_persist_tentativas: 0, ...linhaInicial }
  const registro = { estados: [], lockTentado: 0, urlUpdates: 0 }

  function executar(op) {
    // Consulta sem maybeSingle é listagem de fila: devolve a linha só quando ela está mesmo pendente.
    if (op.tipo === 'select' && op.viaThen) {
      const pendente =
        linha.midia_persist_status === STATUS.PENDENTE && String(linha.url || '').startsWith('https://')
      return { data: pendente ? [{ id: linha.id, company_id: linha.company_id }] : [], error: null }
    }
    if (op.tipo === 'select') return { data: { ...linha }, error: null }

    if (op.temOr) {
      registro.lockTentado += 1
      if (opcoes.lockOcupado) return { data: null, error: null }
      Object.assign(linha, op.payload)
      return { data: { id: linha.id }, error: null }
    }

    if (op.temIlike) {
      registro.urlUpdates += 1
      if (opcoes.erroUpdateUrl) return { data: null, error: { message: 'update falhou' } }
      if (opcoes.urlJaTrocada) return { data: null, error: null }
      Object.assign(linha, op.payload)
      return { data: { ...linha }, error: null }
    }

    registro.estados.push({ ...op.payload })
    Object.assign(linha, op.payload)
    return { data: null, error: null }
  }

  function builder() {
    const op = { tipo: null, payload: null, temOr: false, temIlike: false }
    const api = {
      select(...args) {
        if (!op.tipo) op.tipo = 'select'
        return api
      },
      update(payload) {
        op.tipo = 'update'
        op.payload = payload
        return api
      },
      eq: () => api,
      neq: () => api,
      in: () => api,
      like: () => api,
      gte: () => api,
      lte: () => api,
      order: () => api,
      limit: () => api,
      or() {
        op.temOr = true
        return api
      },
      ilike() {
        op.temIlike = true
        return api
      },
      maybeSingle: async () => executar(op),
      then: (resolve, reject) => {
        op.viaThen = true
        return Promise.resolve().then(() => executar(op)).then(resolve, reject)
      },
    }
    return api
  }

  return { supabase: { from: () => builder() }, linha, registro }
}

function respostaOk({ corpo = CONTEUDO, contentType = 'audio/ogg', contentLength } = {}) {
  return async () => ({
    ok: true,
    status: 200,
    headers: new Headers({
      'content-type': contentType,
      'content-length': String(contentLength ?? corpo.length),
    }),
    arrayBuffer: async () => corpo.buffer.slice(corpo.byteOffset, corpo.byteOffset + corpo.byteLength),
  })
}

function linhaPadrao(extra = {}) {
  return {
    id: 55,
    company_id: 3,
    conversa_id: 9,
    direcao: 'in',
    tipo: 'voice',
    url: URL_REMOTA,
    nome_arquivo: 'audio',
    ...extra,
  }
}

async function persistir(supabase, extra = {}) {
  return persistInboundMediaToUploads({
    supabase,
    io: null,
    company_id: 3,
    mensagem_id: 55,
    fromMe: false,
    ...extra,
  })
}

function ultimoEstado(registro) {
  return registro.estados[registro.estados.length - 1] || null
}

// ---------------------------------------------------------------- política pura

test('backoff progressivo segue 1min, 5min, 15min, 30min e 1h', () => {
  assert.deepEqual(RETRY_DELAYS_MS, [60000, 300000, 900000, 1800000, 3600000])
  const agora = new Date('2026-08-04T12:00:00.000Z')
  const esperados = [60000, 300000, 900000, 1800000, 3600000]

  esperados.forEach((atraso, i) => {
    const plano = planejarProximaTentativa({ tentativas: i + 1, tipo: FALHA.TEMPORARIA, motivo: 'rede', agora })
    assert.equal(plano.status, STATUS.PENDENTE)
    assert.equal(plano.proximaEm.getTime() - agora.getTime(), atraso)
  })
})

test('depois do limite de tentativas a falha vira definitiva', () => {
  assert.equal(MAX_TENTATIVAS, RETRY_DELAYS_MS.length + 1)
  const plano = planejarProximaTentativa({ tentativas: MAX_TENTATIVAS, tipo: FALHA.TEMPORARIA, motivo: 'rede' })
  assert.equal(plano.status, STATUS.FALHA_DEFINITIVA)
  assert.equal(plano.proximaEm, null)
})

test('falha definitiva não agenda nova tentativa mesmo na primeira vez', () => {
  const plano = planejarProximaTentativa({ tentativas: 1, tipo: FALHA.DEFINITIVA, motivo: 'arquivo_grande_demais' })
  assert.equal(plano.status, STATUS.FALHA_DEFINITIVA)
  assert.equal(plano.proximaEm, null)
})

test('classifica falhas temporárias e definitivas', () => {
  for (const motivo of ['timeout', 'rede', 'corpo_vazio', 'escrita_disco', 'update_db', 'arquivo_incompleto']) {
    assert.equal(classificarFalha({ motivo }).tipo, FALHA.TEMPORARIA, motivo)
  }
  for (const motivo of ['url_fora_allowlist', 'arquivo_grande_demais', 'formato_nao_identificado', 'redirect_fora_allowlist']) {
    assert.equal(classificarFalha({ motivo }).tipo, FALHA.DEFINITIVA, motivo)
  }
  for (const status of [500, 502, 503, 429, 408]) {
    assert.equal(classificarFalha({ motivo: 'http', status }).tipo, FALHA.TEMPORARIA, String(status))
  }
  for (const status of [400, 403, 404, 410]) {
    assert.equal(classificarFalha({ motivo: 'http', status }).tipo, FALHA.DEFINITIVA, String(status))
  }
})

test('log nunca carrega query string da URL assinada', () => {
  const resumo = resumoUrlParaLog(URL_REMOTA)
  assert.ok(!resumo.includes('X-Amz-Signature'))
  assert.ok(!resumo.includes('segredo'))
  assert.ok(!resumo.includes('?'))
  assert.ok(resumo.startsWith('s3.amazonaws.com/'))
  assert.equal(resumoUrlParaLog('nem url'), '(url inválida)')
})

// ---------------------------------------------------------------- caminho feliz

test('copia a mídia e só então troca a URL do banco', async () => {
  const { supabase, linha, registro } = criarSupabase(linhaPadrao())
  global.fetch = respostaOk()

  const r = await persistir(supabase)

  assert.equal(r.ok, true)
  assert.equal(arquivosSalvos().length, 1)
  assert.match(linha.url, /^\/uploads\/inbound-c3-m55-[0-9a-f]{12}\.ogg$/)
  assert.equal(fs.readFileSync(path.join(uploadsDir, arquivosSalvos()[0])).length, CONTEUDO.length)

  const estado = ultimoEstado(registro)
  assert.equal(estado.midia_persist_status, STATUS.CONCLUIDA)
  assert.equal(estado.midia_persist_tentativas, 1)
  assert.equal(estado.midia_persist_erro, null)
  assert.equal(estado.midia_persist_proxima_em, null)
  assert.equal(estado.midia_persist_lock_ate, null)
})

test('não sobra arquivo parcial em /uploads', async () => {
  const { supabase } = criarSupabase(linhaPadrao())
  global.fetch = respostaOk()
  await persistir(supabase)
  assert.equal(arquivosSalvos().filter((f) => f.endsWith('.part')).length, 0)
})

// ---------------------------------------------------------------- falhas

test('timeout no download é falha temporária e reagenda em 1 minuto', async () => {
  const { supabase, linha, registro } = criarSupabase(linhaPadrao())
  global.fetch = async () => {
    throw Object.assign(new Error('abortado'), { name: 'AbortError' })
  }

  const antes = Date.now()
  const r = await persistir(supabase)

  assert.equal(r.ok, false)
  assert.equal(r.motivo, 'timeout')
  assert.equal(r.tipo, FALHA.TEMPORARIA)
  assert.equal(r.status, STATUS.PENDENTE)
  assert.ok(r.proximaEm.getTime() - antes >= 59000)
  assert.equal(linha.url, URL_REMOTA, 'a URL remota tem de continuar servindo a reprodução')
  assert.equal(arquivosSalvos().length, 0)

  const estado = ultimoEstado(registro)
  assert.equal(estado.midia_persist_tentativas, 1)
  assert.equal(estado.midia_persist_erro, 'timeout')
  assert.equal(estado.midia_persist_erro_tipo, FALHA.TEMPORARIA)
  assert.ok(estado.midia_persist_ultima_em)
  assert.ok(estado.midia_persist_proxima_em)
})

test('erro HTTP 5xx do provedor é temporário e 404 é definitivo', async () => {
  const resposta = (status) => async () => ({
    ok: false,
    status,
    headers: new Headers({}),
    arrayBuffer: async () => new ArrayBuffer(0),
  })

  const temporario = criarSupabase(linhaPadrao())
  global.fetch = resposta(503)
  const r1 = await persistir(temporario.supabase)
  assert.equal(r1.motivo, 'http_503')
  assert.equal(r1.tipo, FALHA.TEMPORARIA)
  assert.equal(r1.status, STATUS.PENDENTE)
  assert.equal(temporario.linha.url, URL_REMOTA)

  resetEstadoPersistenciaFlag()
  const definitivo = criarSupabase(linhaPadrao())
  global.fetch = resposta(404)
  const r2 = await persistir(definitivo.supabase)
  assert.equal(r2.motivo, 'http_404')
  assert.equal(r2.tipo, FALHA.DEFINITIVA)
  assert.equal(r2.status, STATUS.FALHA_DEFINITIVA)
  assert.equal(r2.proximaEm, null)
  assert.equal(definitivo.linha.url, URL_REMOTA)
})

test('arquivo vazio não é gravado e continua elegível a nova tentativa', async () => {
  const { supabase, linha, registro } = criarSupabase(linhaPadrao())
  global.fetch = respostaOk({ corpo: Buffer.alloc(0) })

  const r = await persistir(supabase)

  assert.equal(r.motivo, 'corpo_vazio')
  assert.equal(r.tipo, FALHA.TEMPORARIA)
  assert.equal(arquivosSalvos().length, 0)
  assert.equal(linha.url, URL_REMOTA)
  assert.equal(ultimoEstado(registro).midia_persist_status, STATUS.PENDENTE)
})

test('arquivo acima do limite é falha definitiva, pelo header e pelo corpo', async () => {
  const acimaDoLimite = 81 * 1024 * 1024

  const porHeader = criarSupabase(linhaPadrao())
  global.fetch = respostaOk({ contentLength: acimaDoLimite })
  const r1 = await persistir(porHeader.supabase)
  assert.equal(r1.motivo, 'arquivo_grande_demais')
  assert.equal(r1.tipo, FALHA.DEFINITIVA)
  assert.equal(arquivosSalvos().length, 0)

  resetEstadoPersistenciaFlag()
  const porCorpo = criarSupabase(linhaPadrao())
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'audio/ogg' }),
    arrayBuffer: async () => new ArrayBuffer(acimaDoLimite),
  })
  const r2 = await persistir(porCorpo.supabase)
  assert.equal(r2.motivo, 'arquivo_grande_demais')
  assert.equal(r2.tipo, FALHA.DEFINITIVA)
  assert.equal(porCorpo.linha.url, URL_REMOTA)
  assert.equal(arquivosSalvos().length, 0)
})

test('falha ao atualizar o banco remove o arquivo e mantém a URL remota', async () => {
  const { supabase, linha, registro } = criarSupabase(linhaPadrao(), { erroUpdateUrl: true })
  global.fetch = respostaOk()

  const r = await persistir(supabase)

  assert.equal(r.motivo, 'update_db')
  assert.equal(r.tipo, FALHA.TEMPORARIA)
  assert.equal(r.status, STATUS.PENDENTE)
  assert.equal(linha.url, URL_REMOTA)
  assert.equal(arquivosSalvos().length, 0, 'arquivo órfão não pode ficar em /uploads')
  assert.equal(ultimoEstado(registro).midia_persist_erro, 'update_db')
})

test('URL fora da allowlist não gera download nem consome tentativa', async () => {
  const { supabase, linha, registro } = criarSupabase(linhaPadrao({ url: 'https://evil.example.com/audio.ogg' }))
  let chamou = false
  global.fetch = async () => {
    chamou = true
    throw new Error('não deveria baixar')
  }

  const r = await persistir(supabase)

  assert.equal(chamou, false)
  assert.equal(r.ignorado, 'url_fora_allowlist')
  assert.equal(linha.url, 'https://evil.example.com/audio.ogg')
  assert.equal(arquivosSalvos().length, 0)
  // A allowlist é configuração: bloquear agora não pode marcar a mídia como perdida para sempre.
  assert.equal(registro.estados.length, 0)
  assert.notEqual(linha.midia_persist_status, STATUS.FALHA_DEFINITIVA)
})

// ---------------------------------------------------------------- concorrência

test('execução duplicada no mesmo processo copia uma vez só', async () => {
  const { supabase, registro } = criarSupabase(linhaPadrao())
  let downloads = 0
  global.fetch = async (...args) => {
    downloads += 1
    return respostaOk()(...args)
  }

  const [a, b] = await Promise.all([persistir(supabase), persistir(supabase)])

  assert.equal(downloads, 1)
  assert.equal(registro.urlUpdates, 1)
  assert.equal(arquivosSalvos().length, 1)
  const ignorados = [a, b].filter((r) => r.ignorado === 'em_execucao')
  assert.equal(ignorados.length, 1)
})

test('lock de outra instância impede a cópia concorrente', async () => {
  const { supabase, linha } = criarSupabase(linhaPadrao(), { lockOcupado: true })
  let chamou = false
  global.fetch = async () => {
    chamou = true
    throw new Error('não deveria baixar')
  }

  const r = await persistir(supabase)

  assert.equal(r.ignorado, 'lock_de_outra_instancia')
  assert.equal(chamou, false)
  assert.equal(linha.url, URL_REMOTA)
  assert.equal(arquivosSalvos().length, 0)
})

test('quando outra tentativa já trocou a URL, o arquivo baixado é descartado', async () => {
  const { supabase } = criarSupabase(linhaPadrao(), { urlJaTrocada: true })
  global.fetch = respostaOk()

  const r = await persistir(supabase)

  assert.equal(r.ignorado, 'ja_persistido')
  assert.equal(arquivosSalvos().length, 0)
})

test('mídia já copiada não é baixada de novo', async () => {
  const { supabase } = criarSupabase(linhaPadrao({ url: '/uploads/inbound-c3-m55-aaaaaaaaaaaa.ogg' }))
  let chamou = false
  global.fetch = async () => {
    chamou = true
    throw new Error('não deveria baixar')
  }

  const r = await persistir(supabase)

  assert.equal(r.ignorado, 'ja_persistido')
  assert.equal(chamou, false)
})

test('falha definitiva não é retentada, mas pode ser forçada', async () => {
  const { supabase } = criarSupabase(
    linhaPadrao({ midia_persist_status: STATUS.FALHA_DEFINITIVA, midia_persist_tentativas: 6 })
  )
  let downloads = 0
  global.fetch = async (...args) => {
    downloads += 1
    return respostaOk()(...args)
  }

  const r1 = await persistir(supabase)
  assert.equal(r1.ignorado, 'falha_definitiva')
  assert.equal(downloads, 0)

  const r2 = await persistir(supabase, { force: true })
  assert.equal(r2.ok, true)
  assert.equal(downloads, 1)
})

// ---------------------------------------------------------------- recuperação

test('recupera depois de uma falha temporária, continuando a contagem de tentativas', async () => {
  const { supabase, linha, registro } = criarSupabase(linhaPadrao())

  global.fetch = async () => {
    throw Object.assign(new Error('conexão caiu'), { name: 'TypeError' })
  }
  const falha = await persistir(supabase)
  assert.equal(falha.tipo, FALHA.TEMPORARIA)
  assert.equal(falha.status, STATUS.PENDENTE)
  assert.equal(linha.midia_persist_tentativas, 1)
  assert.equal(linha.url, URL_REMOTA)

  global.fetch = respostaOk()
  const sucesso = await persistir(supabase)

  assert.equal(sucesso.ok, true)
  assert.match(linha.url, /^\/uploads\//)
  assert.equal(arquivosSalvos().length, 1)

  const estado = ultimoEstado(registro)
  assert.equal(estado.midia_persist_status, STATUS.CONCLUIDA)
  assert.equal(estado.midia_persist_tentativas, 2)
  assert.equal(estado.midia_persist_erro, null)
  assert.equal(estado.midia_persist_proxima_em, null)
})

test('tentativas sucessivas avançam o backoff até esgotar', async () => {
  const { supabase, linha, registro } = criarSupabase(linhaPadrao())
  global.fetch = async () => {
    throw Object.assign(new Error('timeout'), { name: 'AbortError' })
  }

  const status = []
  for (let i = 0; i < MAX_TENTATIVAS; i += 1) {
    const r = await persistir(supabase)
    status.push(r.status)
  }

  assert.deepEqual(status, [
    STATUS.PENDENTE,
    STATUS.PENDENTE,
    STATUS.PENDENTE,
    STATUS.PENDENTE,
    STATUS.PENDENTE,
    STATUS.FALHA_DEFINITIVA,
  ])
  assert.equal(ultimoEstado(registro).midia_persist_tentativas, MAX_TENTATIVAS)
  assert.equal(ultimoEstado(registro).midia_persist_proxima_em, null)
  assert.equal(linha.url, URL_REMOTA)
})

// ---------------------------------------------------------------- degradação sem migration

test('sem as colunas de estado, a cópia continua funcionando', async () => {
  const linha = linhaPadrao()
  let selectsComEstado = 0
  const supabase = {
    from: () => {
      const op = { tipo: null, payload: null, temIlike: false, cols: '' }
      const api = {
        select(cols) {
          if (!op.tipo) op.tipo = 'select'
          op.cols = String(cols || '')
          return api
        },
        update(payload) {
          op.tipo = 'update'
          op.payload = payload
          return api
        },
        eq: () => api,
        or: () => api,
        ilike() {
          op.temIlike = true
          return api
        },
        maybeSingle: async () => {
          if (op.cols.includes('midia_persist')) {
            selectsComEstado += 1
            return { data: null, error: { message: 'column mensagens.midia_persist_status does not exist' } }
          }
          if (op.tipo === 'select') return { data: { ...linha }, error: null }
          if (op.temIlike) {
            Object.assign(linha, op.payload)
            return { data: { ...linha }, error: null }
          }
          return { data: null, error: { message: 'column midia_persist_status does not exist' } }
        },
        then: (resolve, reject) =>
          Promise.resolve()
            .then(() => ({ data: null, error: { message: 'column midia_persist_status does not exist' } }))
            .then(resolve, reject),
      }
      return api
    },
  }

  global.fetch = respostaOk()
  const r = await persistir(supabase)

  assert.equal(selectsComEstado, 1)
  assert.equal(r.ok, true)
  assert.match(linha.url, /^\/uploads\//)
  assert.equal(servico._test.estadoPersistenciaIndisponivel(), true)
  assert.ok(
    avisos.some((a) => String(a[0]).includes('colunas de estado ausentes')),
    'deve avisar que a migration não foi aplicada'
  )
})

// ---------------------------------------------------------------- fila de retentativas vencidas

test('a fila de vencidas retoma a cópia depois de uma falha temporária', async () => {
  const { supabase, linha } = criarSupabase(linhaPadrao())

  global.fetch = async () => {
    throw Object.assign(new Error('timeout'), { name: 'AbortError' })
  }
  await persistir(supabase)
  assert.equal(linha.midia_persist_status, STATUS.PENDENTE)
  assert.equal(linha.url, URL_REMOTA)

  global.fetch = respostaOk()
  const r = await servico.runInboundMediaDueRetryBatch(supabase, null)

  assert.equal(r.due, 1)
  assert.equal(r.migratedToUploads, 1)
  assert.match(linha.url, /^\/uploads\//)
  assert.equal(linha.midia_persist_status, STATUS.CONCLUIDA)
})

test('a fila de vencidas ignora mídia já concluída', async () => {
  const { supabase } = criarSupabase(
    linhaPadrao({ url: '/uploads/inbound-c3-m55-aaaaaaaaaaaa.ogg', midia_persist_status: STATUS.CONCLUIDA })
  )
  global.fetch = async () => {
    throw new Error('não deveria baixar')
  }

  const r = await servico.runInboundMediaDueRetryBatch(supabase, null)
  assert.equal(r.due, 0)
})

test('a fila de vencidas não roda quando as colunas de estado não existem', async () => {
  const { supabase } = criarSupabase(linhaPadrao({ midia_persist_status: STATUS.PENDENTE }))
  const semColunas = {
    from: () => ({
      select: () => semColunas.from(),
      eq: () => semColunas.from(),
      lte: () => semColunas.from(),
      order: () => semColunas.from(),
      limit: () => semColunas.from(),
      then: (resolve, reject) =>
        Promise.resolve()
          .then(() => ({ data: null, error: { message: 'column midia_persist_status does not exist' } }))
          .then(resolve, reject),
    }),
  }

  const r = await servico.runInboundMediaDueRetryBatch(semColunas, null)

  assert.equal(r.due, 0)
  assert.equal(servico._test.estadoPersistenciaIndisponivel(), true)

  // Uma vez detectada a ausência, a fila para de consultar em vez de errar a cada ciclo.
  const r2 = await servico.runInboundMediaDueRetryBatch(supabase, null)
  assert.equal(r2.due, 0)
})
