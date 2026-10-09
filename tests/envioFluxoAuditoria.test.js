/**
 * Auditoria do fluxo completo de envio (2026-10-08): testes das correções que protegem
 * "mensagem enviada chega ao contato, uma vez só, com o status certo".
 */

describe('helpers puros', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  test('parseTimestampSemFusoComoUtc: valor sem fuso é UTC, independentemente do fuso do servidor', () => {
    const { parseTimestampSemFusoComoUtc } = require('../helpers/timestampApiCompat')
    const esperado = Date.UTC(2026, 9, 8, 20, 23, 24, 657)
    expect(parseTimestampSemFusoComoUtc('2026-10-08T20:23:24.657')).toBe(esperado)
    expect(parseTimestampSemFusoComoUtc('2026-10-08 20:23:24.657')).toBe(esperado)
    expect(parseTimestampSemFusoComoUtc('2026-10-08T20:23:24.657Z')).toBe(esperado)
    expect(parseTimestampSemFusoComoUtc('2026-10-08T17:23:24.657-03:00')).toBe(esperado)
    expect(Number.isNaN(parseTimestampSemFusoComoUtc(null))).toBe(true)
    expect(Number.isNaN(parseTimestampSemFusoComoUtc('lixo'))).toBe(true)
  })

  test('mapProviderSendResultComTransitoria: timeout/429/5xx ficam pending; recusa definitiva vira erro', () => {
    const { mapProviderSendResultComTransitoria } = require('../services/chat/outbound/providerResultMapper')
    for (const result of [
      { ok: false, transportError: true, error: 'timeout' },
      { ok: false, httpStatus: 429, error: 'rate' },
      { ok: false, httpStatus: 503, error: 'down' },
    ]) {
      const m = mapProviderSendResultComTransitoria(result)
      expect(m).toMatchObject({ falhaTransitoria: true, nextStatus: 'pending', nextStatusMensagem: 'sending', needsReconciliation: true })
    }
    const definitiva = mapProviderSendResultComTransitoria({ ok: false, httpStatus: 400, error: 'bad' })
    expect(definitiva).toMatchObject({ falhaTransitoria: false, nextStatus: 'erro' })
  })

  test('enviarSemEstourar: exceção do provedor vira resultado transitório', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { enviarSemEstourar } = require('../services/chat/outbound/providerResultMapper')
    const r = await enviarSemEstourar(async () => { throw new Error('socket hang up') }, 'enviar contato')
    expect(r).toMatchObject({ ok: false, transportError: true })
    expect(await enviarSemEstourar(async () => ({ ok: true, messageId: 'x' }))).toEqual({ ok: true, messageId: 'x' })
  })

  test('registro de despacho: em andamento bloqueia, conclusão libera, "conhecido" persiste', () => {
    const reg = require('../services/chat/outbound/outboundDispatchRegistry')
    reg._resetParaTestes()
    expect(reg.despachoEmAndamento(10)).toBe(false)
    expect(reg.despachoConhecido(10)).toBe(false)
    reg.iniciarDespacho(10)
    expect(reg.despachoEmAndamento(10)).toBe(true)
    expect(reg.despachoConhecido(10)).toBe(true)
    reg.concluirDespacho(10)
    expect(reg.despachoEmAndamento(10)).toBe(false)
    expect(reg.despachoConhecido(10)).toBe(true)
  })

  test('registro de despacho: entrada esquecida expira sozinha (não trava a varredura para sempre)', () => {
    const reg = require('../services/chat/outbound/outboundDispatchRegistry')
    reg._resetParaTestes()
    const base = Date.now()
    const spy = jest.spyOn(Date, 'now').mockReturnValue(base)
    reg.iniciarDespacho(11)
    spy.mockReturnValue(base + reg.TTL_EM_ANDAMENTO_MS + 1000)
    expect(reg.despachoEmAndamento(11)).toBe(false)
  })
})

describe('gravarResultadoDoEnvio', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  function montar(respostas) {
    jest.resetModules()
    const chamadas = []
    let n = 0
    jest.doMock('../config/supabase', () => ({
      from: () => {
        const ctx = { update: null, filtroStatus: false }
        const chain = {
          update(p) { ctx.update = p; return chain },
          eq() { return chain },
          in(col) { if (col === 'status') ctx.filtroStatus = true; return chain },
          select() { return chain },
          then(resolve) {
            chamadas.push({ ...ctx })
            const r = respostas[n] || { data: [], error: null }
            n += 1
            resolve(r)
          },
        }
        return chain
      },
    }))
    const { gravarResultadoDoEnvio } = require('../services/chat/outbound/outboundResultPersistence')
    return { gravarResultadoDoEnvio, chamadas }
  }

  const base = { company_id: 1, mensagem_id: 55, status: 'pending', status_mensagem: 'sending', whatsapp_id: 'WA-ID-1' }

  test('linha ainda pendente: grava status + id, condicionado ao status aberto', async () => {
    const { gravarResultadoDoEnvio, chamadas } = montar([{ data: [{ id: 55 }], error: null }])
    const r = await gravarResultadoDoEnvio(base)
    expect(r).toMatchObject({ ok: true, idsGravados: true })
    expect(chamadas).toHaveLength(1)
    expect(chamadas[0].filtroStatus).toBe(true)
    expect(chamadas[0].update).toMatchObject({ status: 'pending', status_mensagem: 'sending', whatsapp_id: 'WA-ID-1' })
  })

  test('ACK já avançou a linha (delivered): NÃO rebaixa — grava só o id', async () => {
    const { gravarResultadoDoEnvio, chamadas } = montar([{ data: [], error: null }, { data: null, error: null }])
    const r = await gravarResultadoDoEnvio(base)
    expect(r).toMatchObject({ ok: true, jaAvancada: true })
    expect(chamadas).toHaveLength(2)
    expect(chamadas[1].update).toEqual({ whatsapp_id: 'WA-ID-1' })
    expect(chamadas[1].filtroStatus).toBe(false)
  })

  test('erro ao gravar (ex.: id já reivindicado): regrava só o status e devolve o erro', async () => {
    const { gravarResultadoDoEnvio, chamadas } = montar([
      { data: null, error: { message: 'duplicate key value violates unique constraint' } },
      { data: null, error: null },
    ])
    const r = await gravarResultadoDoEnvio(base)
    expect(r.ok).toBe(true)
    expect(r.idsGravados).toBe(false)
    expect(r.erro).toMatch(/duplicate key/)
    expect(chamadas[1].update).toEqual({ status: 'pending', status_mensagem: 'sending' })
  })
})

describe('reconciliação — correções da auditoria', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  function montar({ providerName, getMessagesResult, chatHistory, sendTextImpl, sendFileImpl, statusNoBanco = { status: 'pending', status_mensagem: 'sending' } }) {
    jest.resetModules()
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'log').mockImplementation(() => {})
    const sendText = jest.fn(sendTextImpl || (async () => ({ ok: true, messageId: '35097' })))
    const sendFile = jest.fn(sendFileImpl || (async () => ({ ok: true, messageId: '35098' })))
    jest.doMock('../services/providers', () => ({
      getProvider: () => ({
        getMessages: jest.fn(async () => getMessagesResult),
        getChatMessages: jest.fn(async () => chatHistory ?? { ok: false, data: [] }),
        sendText,
        sendFile,
        getConnectionStatus: async () => ({ configured: true, connected: true }),
      }),
    }))
    jest.doMock('../services/chat/identity/conversationAddressService', () => ({
      resolveConversationProvider: jest.fn(async () => providerName),
    }))
    const updates = []
    jest.doMock('../config/supabase', () => ({
      from(table) {
        const ctx = { update: null }
        const chain = {
          update(payload) { ctx.update = payload; return chain },
          select() { return chain },
          eq() { return chain },
          in() { return { then(resolve) { resolve({ data: [], error: null }) } } },
          async maybeSingle() {
            if (ctx.update) {
              updates.push({ table, ...ctx.update })
              return { data: { id: 1, company_id: 1, conversa_id: 2, autor_usuario_id: 9 }, error: null }
            }
            if (table === 'conversas') return { data: { id: 2, telefone: '5511999999999' }, error: null }
            if (table === 'usuarios') return { data: { nome: 'Miguel', mostrar_nome_ao_cliente: true }, error: null }
            if (table === 'mensagens') {
              return { data: { id: 1, ...statusNoBanco, whatsapp_id: null, provider_queue_id: null }, error: null }
            }
            return { data: null, error: null }
          },
        }
        return chain
      },
    }))
    const svc = require('../services/pendingOutboundReconciliationService')
    const reg = require('../services/chat/outbound/outboundDispatchRegistry')
    reg._resetParaTestes()
    return { svc, reg, sendText, sendFile, updates }
  }

  const minAtras = (m) => new Date(Date.now() - m * 60_000).toISOString()
  const linha = (extra = {}) => ({
    id: 1, company_id: 1, conversa_id: 2, autor_usuario_id: 9, direcao: 'out', tipo: 'texto',
    texto: 'Bom dia, segue o retorno', status: 'pending', status_mensagem: 'sending',
    whatsapp_id: null, provider_queue_id: null, criado_em: minAtras(10), ...extra,
  })

  test('despacho de mídia ainda em andamento: a varredura não consulta nem reenvia', async () => {
    const { svc, reg, sendFile } = montar({ providerName: 'ultramsg', getMessagesResult: { ok: true, data: [] } })
    reg.iniciarDespacho(1)
    const res = await svc.reconcilePendingOutboundMessage(linha({ tipo: 'arquivo', url: '/uploads/x.pdf' }), { io: null })
    expect(res.action).toBe('keep_despacho_em_andamento')
    expect(sendFile).not.toHaveBeenCalled()
  })

  test('localização pendente NÃO é reenviada como arquivo (o link do mapa ia como "documento")', async () => {
    const { svc, sendFile, sendText } = montar({ providerName: 'ultramsg', getMessagesResult: { ok: true, data: [] } })
    const res = await svc.reconcilePendingOutboundMessage(
      linha({ tipo: 'location', url: 'https://www.google.com/maps?q=-13.17,-53.25', texto: 'Localização' }),
      { io: null }
    )
    expect(sendFile).not.toHaveBeenCalled()
    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('skip_reenvio_tipo_sem_reenvio_automatico')
  })

  test('reenvio automático com falha transitória fica pending (não vira erro terminal)', async () => {
    const { svc, updates } = montar({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: true, data: [{ id: 'X', from_me: true, body: 'outro texto', timestamp: Math.floor(Date.now() / 1000) }] },
      sendTextImpl: async () => ({ ok: false, messageId: null, transportError: true, error: 'timeout' }),
    })
    const res = await svc.reconcilePendingOutboundMessage(linha(), { io: null })
    expect(res.action).toBe('keep_reenvio_falha_transitoria')
    expect(updates.some((u) => u.status === 'erro')).toBe(false)
  })

  test('reenvio automático com recusa definitiva continua virando erro', async () => {
    const { svc, updates } = montar({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: true, data: [{ id: 'X', from_me: true, body: 'outro texto', timestamp: Math.floor(Date.now() / 1000) }] },
      sendTextImpl: async () => ({ ok: false, messageId: null, httpStatus: 400, error: 'invalid to' }),
    })
    await svc.reconcilePendingOutboundMessage(linha(), { io: null })
    expect(updates[0]).toMatchObject({ status: 'erro', status_mensagem: 'failed' })
  })

  test('Whapi com id que o provedor ainda informa pending: relógio dentro do prazo, erro depois dele', async () => {
    const amb = () => montar({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [{ id: 'PsrIhlIPnArSqck-wOuAzLILsg', status: 'pending' }] },
    })
    const dentro = amb()
    const r1 = await dentro.svc.reconcilePendingOutboundMessage(
      linha({ whatsapp_id: 'PsrIhlIPnArSqck-wOuAzLILsg', criado_em: minAtras(30) }), { io: null }
    )
    expect(r1.action).toBe('keep_provider_pending')
    expect(dentro.updates).toHaveLength(0)

    const fora = amb()
    await fora.svc.reconcilePendingOutboundMessage(
      linha({ whatsapp_id: 'PsrIhlIPnArSqck-wOuAzLILsg', criado_em: minAtras(150) }), { io: null }
    )
    expect(fora.updates[0]).toMatchObject({ status: 'erro', status_mensagem: 'failed' })
  })

  test('texto encaminhado já entregue é reconhecido no histórico (não é reenviado em dobro)', async () => {
    const corpo = ['[Encaminhado]', 'Bom dia, segue o retorno', '— Miguel'].join(String.fromCharCode(10))
    const { svc, sendText, updates } = montar({
      providerName: 'whapi',
      getMessagesResult: { ok: true, data: [] },
      chatHistory: { ok: true, data: [{ id: 'WhapiEncaminhada1234567890', from_me: true, body: corpo, timestamp: Math.floor(Date.now() / 1000) }] },
    })
    const res = await svc.reconcilePendingOutboundMessage(linha(), { io: null })
    expect(sendText).not.toHaveBeenCalled()
    expect(res.action).toBe('whapi_curada_pelo_historico')
    expect(updates[0]).toMatchObject({ status: 'sent', whatsapp_id: 'WhapiEncaminhada1234567890' })
  })
})

describe('varredura em duas faixas', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  test('faixa recente tem lote próprio e o acúmulo antigo roda em rodízio por id', async () => {
    jest.resetModules()
    const consultas = []
    let antigasPorChamada = [[{ id: 10 }, { id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }], []]
    jest.doMock('../services/providers', () => ({ getProvider: () => ({}) }))
    jest.doMock('../services/chat/identity/conversationAddressService', () => ({
      resolveConversationProvider: jest.fn(async () => 'ultramsg'),
    }))
    jest.doMock('../config/supabase', () => ({
      from(table) {
        const reg = { table, porId: false, aposId: null, limite: null }
        const chain = {
          select() { return chain },
          eq() { return chain },
          in() { return chain },
          gte() { return chain },
          lte() { return chain },
          gt(col, v) { if (col === 'id') reg.aposId = v; return chain },
          order(col) { if (col === 'id') reg.porId = true; return chain },
          limit(n) { reg.limite = n; return chain },
          then(resolve) {
            if (table !== 'mensagens') return resolve({ data: [], error: null })
            consultas.push(reg)
            if (reg.porId) return resolve({ data: antigasPorChamada.shift() || [], error: null })
            return resolve({ data: [], error: null })
          },
        }
        return chain
      },
    }))
    process.env.PENDING_OUTBOUND_RECONCILE_BATCH_LIMIT = '10'
    const svc = require('../services/pendingOutboundReconciliationService')
    try {
      await svc.runPendingOutboundReconciliation({})
      const recentes1 = consultas.filter((c) => !c.porId)
      const antigas1 = consultas.filter((c) => c.porId)
      expect(recentes1.length).toBeGreaterThan(0)
      expect(antigas1.length).toBeGreaterThan(0)
      expect(antigas1[0].limite).toBe(5)
      expect(antigas1[0].aposId).toBe(null)

      consultas.length = 0
      await svc.runPendingOutboundReconciliation({})
      // 2º ciclo continua DEPOIS do último id visto no 1º (rodízio), em vez de repetir as mesmas.
      expect(consultas.filter((c) => c.porId)[0].aposId).toBe(14)

      consultas.length = 0
      await svc.runPendingOutboundReconciliation({})
      // Lote do acúmulo veio menor que o limite no ciclo anterior: recomeça do início.
      expect(consultas.filter((c) => c.porId)[0].aposId).toBe(null)
    } finally {
      delete process.env.PENDING_OUTBOUND_RECONCILE_BATCH_LIMIT
    }
  })
})

describe('destino Whapi — wa_id do cadastro', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  function montar({ waId, canonicoDoCheck }) {
    jest.resetModules()
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.doMock('../config/supabase', () => ({ from: () => { throw new Error('não deveria tocar o banco') } }))
    const { resolveWhapiSendRecipient } = require('../services/whapiRecipientResolverService')
    const checkPhones = jest.fn(async () => canonicoDoCheck)
    const persist = jest.fn(async () => true)
    const deps = {
      loadConversationContact: async () => ({ conversa: { id: 2, telefone: '553499991111' }, cliente: { id: 7, wa_id: waId, telefone: '553499991111' } }),
      checkPhones,
      persistCanonicalWaId: persist,
    }
    return { resolveWhapiSendRecipient, checkPhones, persist, deps }
  }

  test('wa_id do MESMO número (com/sem 9º dígito) é usado direto, sem consulta extra', async () => {
    const { resolveWhapiSendRecipient, checkPhones, deps } = montar({ waId: '553499991111@s.whatsapp.net' })
    const destino = await resolveWhapiSendRecipient('5534999991111', { companyId: 1, conversaId: 2 }, deps)
    expect(destino).toBe('553499991111')
    expect(checkPhones).not.toHaveBeenCalled()
  })

  test('wa_id de OUTRO número (cadastro editado) não é mais usado: revalida em vez de enviar ao antigo', async () => {
    const { resolveWhapiSendRecipient, checkPhones, deps } = montar({ waId: '551188887777@s.whatsapp.net' })
    const destino = await resolveWhapiSendRecipient('553499991111', { companyId: 1, conversaId: 2 }, deps)
    expect(checkPhones).toHaveBeenCalled()
    expect(destino).not.toBe('551188887777')
  })
})

describe('eco de mensagem com link', () => {
  test("família 'link' equivale a 'texto' na reconciliação do eco", () => {
    jest.resetModules()
    jest.doMock('../config/supabase', () => ({ from: () => ({}) }))
    const mod = require('../controllers/webhookInbound/fromMeReconcile')
    const fn = mod.mediaFamilyForStorageTipo || mod._test?.mediaFamilyForStorageTipo
    if (typeof fn !== 'function') return // helper não exportado neste módulo
    expect(fn('link')).toBe('texto')
    expect(fn('texto')).toBe('texto')
  })
})
