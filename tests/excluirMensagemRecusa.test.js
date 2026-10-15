/**
 * Apagar PARA TODOS: separar recusa definitiva de falha passageira.
 *
 * Em 13/10/2026 o console de producao mostrou DELETE /mensagens/775947 e /775950 devolvendo
 * 502 "Falha ao apagar a mensagem no WhatsApp. Tente novamente." — e a 775950 recusada DUAS
 * vezes seguidas, porque a propria mensagem mandava tentar de novo. O 502 nao era queda do
 * servidor: o controller o devolvia de proposito, e o provider so sabia dizer `false`, sem o
 * motivo. Agora o motivo sobe do provedor e a resposta distingue:
 *
 *   4xx (fora da janela de ~2 dias, id fora do channel-store)  -> 409, nao mandar repetir
 *   429/5xx/timeout                                            -> 502, repetir faz sentido
 */

const { deleteMessage: whapiDelete } = require('../services/providers/whapi/messages')

jest.mock('../services/providers/whapi/config', () => ({
  resolveConfig: jest.fn(async () => ({ token: 't', companyId: 1, whatsappInstanceId: 10 })),
}))

const http = require('../services/providers/whapi/http')
jest.mock('../services/providers/whapi/http', () => ({
  del: jest.fn(),
  post: jest.fn(),
  get: jest.fn(),
  head: jest.fn(),
  postMultipart: jest.fn(),
  patch: jest.fn(),
  put: jest.fn(),
}))

const ID = 'PsqS0Txeyym96r8-wDuA3ypkTg'
const TEL = '553499911246'

describe('whapi deleteMessage devolve o motivo', () => {
  beforeEach(() => jest.clearAllMocks())

  test('sucesso', async () => {
    http.del.mockResolvedValue({ ok: true, status: 200, data: { success: true } })
    const r = await whapiDelete(TEL, ID, {})
    expect(r).toMatchObject({ ok: true })
  })

  test('404 do provedor e recusa DEFINITIVA, com o motivo preservado', async () => {
    http.del.mockResolvedValue({
      ok: false,
      status: 404,
      data: { error: { message: 'message not found in channel store' } },
    })
    const r = await whapiDelete(TEL, ID, {})
    expect(r.ok).toBe(false)
    expect(r.permanente).toBe(true)
    expect(r.httpStatus).toBe(404)
    expect(r.error).toContain('not found')
  })

  test('400 tambem e definitiva', async () => {
    http.del.mockResolvedValue({ ok: false, status: 400, data: { error: 'too old to revoke' } })
    const r = await whapiDelete(TEL, ID, {})
    expect(r).toMatchObject({ ok: false, permanente: true, httpStatus: 400 })
    expect(r.error).toBe('too old to revoke')
  })

  test('429 NAO e definitiva (repetir faz sentido)', async () => {
    http.del.mockResolvedValue({ ok: false, status: 429, data: { error: 'rate limited' } })
    const r = await whapiDelete(TEL, ID, {})
    expect(r).toMatchObject({ ok: false, permanente: false })
  })

  test('5xx NAO e definitiva', async () => {
    http.del.mockResolvedValue({ ok: false, status: 503, data: null, text: 'upstream down' })
    const r = await whapiDelete(TEL, ID, {})
    expect(r).toMatchObject({ ok: false, permanente: false })
    expect(r.error).toBe('upstream down')
  })

  test('excecao de transporte NAO e definitiva', async () => {
    http.del.mockRejectedValue(new Error('socket hang up'))
    const r = await whapiDelete(TEL, ID, {})
    expect(r).toMatchObject({ ok: false, permanente: false })
    expect(r.error).toContain('socket hang up')
  })

  test('corpo 200 com success:false conta como recusa', async () => {
    http.del.mockResolvedValue({ ok: true, status: 200, data: { success: false } })
    const r = await whapiDelete(TEL, ID, {})
    expect(r.ok).toBe(false)
  })

  test('sem id do WhatsApp nem chama o provedor', async () => {
    const r = await whapiDelete(TEL, '  ', {})
    expect(r).toMatchObject({ ok: false, permanente: true })
    expect(http.del).not.toHaveBeenCalled()
  })

  test('o contrato antigo do chamador continua valendo', async () => {
    http.del.mockResolvedValue({ ok: true, status: 200, data: { success: true } })
    const r = await whapiDelete(TEL, ID, {})
    // controller: `deleteResult === true || deleteResult?.ok === true`
    expect(r === true || r?.ok === true).toBe(true)
    http.del.mockResolvedValue({ ok: false, status: 404, data: null })
    const r2 = await whapiDelete(TEL, ID, {})
    expect(r2 === true || r2?.ok === true).toBe(false)
  })
})

describe('resposta ao atendente: 409 definitivo vs 502 passageiro', () => {
  const { _test } = require('../controllers/chat/messageDeletionController')
  const { respostaDeRecusa, JANELA_APAGAR_PARA_TODOS_H } = _test

  function resFake() {
    const r = { code: null, body: null }
    r.status = (c) => { r.code = c; return r }
    r.json = (b) => { r.body = b; return r }
    return r
  }
  const horasAtras = (h) => new Date(Date.now() - h * 3_600_000).toISOString()

  test('recusa definitiva em mensagem ANTIGA explica o prazo e nao manda repetir', () => {
    const res = resFake()
    respostaDeRecusa(
      res,
      { ok: false, permanente: true, httpStatus: 404, error: 'not found in channel store' },
      { criado_em: horasAtras(JANELA_APAGAR_PARA_TODOS_H + 10) }
    )
    expect(res.code).toBe(409)
    expect(res.body.error).toMatch(/recentes/i)
    expect(res.body.error).not.toMatch(/tente novamente/i)
    expect(res.body.pode_apagar_para_mim).toBe(true)
    expect(res.body.motivo_provedor).toBe('not found in channel store')
  })

  test('recusa definitiva em mensagem RECENTE nao inventa o motivo do prazo', () => {
    const res = resFake()
    respostaDeRecusa(res, { ok: false, permanente: true, httpStatus: 400 }, { criado_em: horasAtras(1) })
    expect(res.code).toBe(409)
    expect(res.body.error).not.toMatch(/recentes/i)
    expect(res.body.error).toMatch(/recusou/i)
    expect(res.body.error).not.toMatch(/tente novamente/i)
  })

  test('falha passageira continua 502 e mantem o convite a repetir', () => {
    const res = resFake()
    respostaDeRecusa(res, { ok: false, permanente: false, httpStatus: 503 }, { criado_em: horasAtras(1) })
    expect(res.code).toBe(502)
    expect(res.body.error).toMatch(/tente novamente/i)
    expect(res.body.permanente).toBe(false)
  })

  test('toda recusa definitiva oferece a saida de apagar so para mim', () => {
    for (const idade of [0, 1, 50, 200]) {
      const res = resFake()
      respostaDeRecusa(res, { ok: false, permanente: true, httpStatus: 404 }, { criado_em: horasAtras(idade) })
      expect(res.code).toBe(409)
      expect(res.body.error).toMatch(/só para você/i)
    }
  })

  test('data ilegivel nao quebra nem inventa prazo', () => {
    const res = resFake()
    respostaDeRecusa(res, { ok: false, permanente: true, httpStatus: 404 }, { criado_em: 'xx' })
    expect(res.code).toBe(409)
    expect(res.body.error).toMatch(/recusou/i)
    expect(_test.idadeEmHoras('xx')).toBeNull()
  })
})

describe('idade sem fuso (armadilha desta codebase)', () => {
  const { _test } = require('../controllers/chat/messageDeletionController')

  test('timestamp SEM fuso e lido como UTC, nao como hora local do servidor', () => {
    // Formato real do banco (o SQL do Miguel devolveu exatamente assim).
    const agoraUtcSemFuso = new Date().toISOString().replace('T', ' ').replace('Z', '')
    const idade = _test.idadeEmHoras(agoraUtcSemFuso)
    expect(idade).not.toBeNull()
    // Com Date.parse cru, um servidor em UTC-3 acusaria 3 (ou -3) aqui.
    expect(Math.abs(idade)).toBeLessThanOrEqual(0)
  })

  test('6 horas atras conta 6, independente do fuso do processo', () => {
    const seisHoras = new Date(Date.now() - 6 * 3_600_000).toISOString().replace('T', ' ').replace('Z', '')
    expect(_test.idadeEmHoras(seisHoras)).toBe(6)
  })

  test('formato ISO com Z continua funcionando', () => {
    expect(_test.idadeEmHoras(new Date(Date.now() - 2 * 3_600_000).toISOString())).toBe(2)
  })

  test('data invalida devolve null (e a resposta nao inventa prazo)', () => {
    expect(_test.idadeEmHoras('nao e data')).toBeNull()
    expect(_test.idadeEmHoras(null)).toBeNull()
    expect(_test.idadeEmHoras('')).toBeNull()
  })
})
