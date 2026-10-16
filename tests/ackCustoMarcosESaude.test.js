/**
 * F7, F8 e F9 da auditoria das setas (doc 33).
 *
 * F7 — o ACK faz UMA leitura da linha (antes três) e grava por id: 5 → 3 round trips no `read`.
 * F9 — `entregue_em`/`lida_em` gravados uma única vez, só quando o status AVANÇA, e tolerantes à
 *      migration pendente.
 * F8 — saúde do ACK por canal: "sem_ack" quando nada foi confirmado na janela.
 */

const { marcosDeAck, patchMensagemStatusById, _marcosDeAck } =
  require('../controllers/webhookInbound/whatsappIdLookup')

describe('F9 — marcos de horário (entregue_em / lida_em)', () => {
  test('grava só quando o status AVANÇA para aquele nível', () => {
    expect(marcosDeAck('sent', 'delivered')).toEqual({ entregue_em: expect.any(String) })
    expect(marcosDeAck('delivered', 'read')).toEqual({ lida_em: expect.any(String) })
    // Salto pending→read: leitura implica entrega, grava os dois.
    expect(Object.keys(marcosDeAck('pending', 'read')).sort()).toEqual(['entregue_em', 'lida_em'])
  })

  test('ACK reentregue NÃO reescreve horário (a Whapi reentrega statuses no reconnect)', () => {
    expect(marcosDeAck('delivered', 'delivered')).toEqual({})
    expect(marcosDeAck('read', 'read')).toEqual({})
    expect(marcosDeAck('read', 'delivered')).toEqual({})
    expect(marcosDeAck('played', 'read')).toEqual({})
  })

  test('erro e pending não geram marco', () => {
    expect(marcosDeAck('pending', 'erro')).toEqual({})
    expect(marcosDeAck('sent', 'pending')).toEqual({})
    expect(marcosDeAck('erro', 'sent')).toEqual({})
  })

  test('read → played grava nada novo (lida_em já existia); sent → played grava os dois', () => {
    expect(marcosDeAck('read', 'played')).toEqual({})
    expect(Object.keys(marcosDeAck('sent', 'played')).sort()).toEqual(['entregue_em', 'lida_em'])
  })

  test('sem statusAtual não crava horário (nulo é mais honesto que chute)', () => {
    expect(marcosDeAck(null, 'read')).toEqual({})
    expect(marcosDeAck('', 'read')).toEqual({})
    expect(marcosDeAck(undefined, 'delivered')).toEqual({})
  })

  test('apelido de provedor é entendido na comparação', () => {
    expect(marcosDeAck('server', 'delivered')).toEqual({ entregue_em: expect.any(String) })
    expect(marcosDeAck('device', 'read')).toEqual({ lida_em: expect.any(String) })
    expect(marcosDeAck('device', 'delivered')).toEqual({})
  })
})

describe('F9 — gravação dos marcos no patch', () => {
  function fakeSupabase(linha, { erroDeColuna = false } = {}) {
    const estado = { ...linha }
    const corpos = []
    const api = (modo, patch) => {
      const q = {
        eq: () => q,
        not: () => q,
        select: () => q,
        async maybeSingle() {
          if (modo === 'update') {
            corpos.push(patch)
            if (erroDeColuna && ('entregue_em' in patch || 'lida_em' in patch)) {
              return { data: null, error: { message: 'column mensagens.entregue_em does not exist' } }
            }
            Object.assign(estado, patch)
          }
          return { data: { ...estado }, error: null }
        },
      }
      return q
    }
    return {
      estado,
      corpos,
      from: () => ({ update: (patch) => api('update', patch), select: () => api('select') }),
    }
  }

  beforeEach(() => { _marcosDeAck.religar() })

  test('ACK de entrega grava entregue_em junto do status', async () => {
    const sb = fakeSupabase({ id: 9, status: 'sent' })
    await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'delivered', statusAtual: 'sent' })
    expect(sb.corpos[0]).toMatchObject({ status: 'delivered', status_mensagem: 'delivered' })
    expect(sb.corpos[0].entregue_em).toBeTruthy()
    expect(sb.corpos[0]).not.toHaveProperty('lida_em')
  })

  test('o patch devolve os marcos gravados (vão para o socket)', async () => {
    const sb = fakeSupabase({ id: 9, status: 'delivered' })
    const r = await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'read', statusAtual: 'delivered' })
    expect(r.marcos.lida_em).toBeTruthy()
    expect(r.marcos).not.toHaveProperty('entregue_em')
  })

  test('sem avanço de status, nenhum horário no corpo do update', async () => {
    const sb = fakeSupabase({ id: 9, status: 'delivered' })
    const r = await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'delivered', statusAtual: 'delivered' })
    expect(sb.corpos[0]).not.toHaveProperty('entregue_em')
    expect(r.marcos).toEqual({})
  })

  test('migration pendente: regrava só o status, avisa e NÃO perde o ACK', async () => {
    const sb = fakeSupabase({ id: 9, status: 'sent' }, { erroDeColuna: true })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await patchMensagemStatusById(sb, { company_id: 1, mensagem_id: 9, effectiveStatus: 'delivered', statusAtual: 'sent' })
    expect(r.error).toBeFalsy()
    expect(r.data.status).toBe('delivered')
    expect(sb.estado.status).toBe('delivered')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('20261016120000'))
    expect(r.marcos).toEqual({})
    // 1ª tentativa com os horários, 2ª só com o status.
    expect(sb.corpos).toHaveLength(2)
    expect(sb.corpos[1]).not.toHaveProperty('entregue_em')
    warn.mockRestore()
  })

  test('depois de detectar a ausência, não tenta de novo no mesmo processo', async () => {
    const sb1 = fakeSupabase({ id: 9, status: 'sent' }, { erroDeColuna: true })
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    await patchMensagemStatusById(sb1, { company_id: 1, mensagem_id: 9, effectiveStatus: 'delivered', statusAtual: 'sent' })
    const sb2 = fakeSupabase({ id: 9, status: 'sent' })
    await patchMensagemStatusById(sb2, { company_id: 1, mensagem_id: 9, effectiveStatus: 'delivered', statusAtual: 'sent' })
    expect(sb2.corpos).toHaveLength(1)
    expect(sb2.corpos[0]).not.toHaveProperty('entregue_em')
    jest.restoreAllMocks()
  })
})

describe('F7 — uma leitura só por ACK', () => {
  afterEach(() => { jest.resetModules(); jest.restoreAllMocks() })

  test('ACK read faz 1 leitura da mensagem + 1 de conversas + 1 UPDATE (eram 5 idas)', async () => {
    jest.resetModules()
    const leiturasDeMensagem = []
    const leiturasDeConversa = []
    jest.doMock('../config/supabase', () => ({
      from(tabela) {
        const q = {
          select: () => q, eq: () => q, order: () => q, limit: () => q, is: () => q,
          async maybeSingle() {
            if (tabela === 'conversas') {
              leiturasDeConversa.push(1)
              return { data: { tipo: 'individual', telefone: '5534999' }, error: null }
            }
            return { data: null, error: null }
          },
        }
        return q
      },
    }))
    jest.doMock('../services/whatsappConfigService', () => ({ getCompanyIdByInstanceId: jest.fn() }))
    jest.doMock('../services/whatsappInstanceService', () => ({ getWhatsappInstanceByProviderInstanceId: jest.fn() }))
    jest.doMock('../services/disparoWebhookHook', () => ({ aplicarStatusDisparoFromWebhook: jest.fn(async () => {}) }))
    jest.doMock('../services/mediaR2MirrorService', () => ({ scheduleR2MirrorIfNeeded: jest.fn() }))
    jest.doMock('../controllers/webhookInbound/fromMeReconcile', () => ({
      filterRowsForFromMeReconcile: jest.fn(() => []),
      findPendingOutboundByAckPhone: jest.fn(async () => null),
    }))
    const gravacoes = []
    jest.doMock('../controllers/webhookInbound/whatsappIdLookup', () => ({
      selectSingleMensagemByWhatsappId: jest.fn(async (_s, args) => {
        leiturasDeMensagem.push(args.select)
        return { data: { id: 9, conversa_id: 2, status: 'delivered', whatsapp_id: 'W-1' }, error: null }
      }),
      selectSingleMensagemByWhatsappIdRelaxed: jest.fn(async () => ({ data: null, error: null })),
      patchMensagemStatusById: jest.fn(async (_s, args) => {
        gravacoes.push(args)
        return { data: { id: 9, conversa_id: 2, company_id: 1, status: args.effectiveStatus }, error: null, marcos: {} }
      }),
      updateSingleMensagemByWhatsappId: jest.fn(async () => ({ data: null, error: null })),
      applyWhatsappInstanceFilterOrLegacy: jest.fn((q) => q),
      logAmbiguousWhatsappId: jest.fn(),
    }))

    const { statusZapi } = require('../controllers/webhookInbound/statusZapi')
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json() { return this } }
    await statusZapi({
      path: '/webhooks/whapi',
      body: { id: 'W-1', ids: ['W-1'], status: 'read' },
      zapiContext: { company_id: 1, whatsapp_instance_id: 5, provider: 'whapi' },
      app: { get: () => null },
    }, res)

    expect(leiturasDeMensagem).toHaveLength(1)
    expect(leiturasDeMensagem[0]).toBe('id, conversa_id, status, whatsapp_id')
    expect(leiturasDeConversa).toHaveLength(1)
    expect(gravacoes).toHaveLength(1)
    // E o status atual segue chegando ao patch (marcos + guarda dependem dele).
    expect(gravacoes[0].statusAtual).toBe('delivered')
    expect(res.statusCode).toBe(200)
  })

  test('ACK delivered não lê conversas (cap de grupo só interessa a read/played)', async () => {
    jest.resetModules()
    const leiturasDeConversa = []
    jest.doMock('../config/supabase', () => ({
      from(tabela) {
        const q = {
          select: () => q, eq: () => q, order: () => q, limit: () => q, is: () => q,
          async maybeSingle() {
            if (tabela === 'conversas') leiturasDeConversa.push(1)
            return { data: null, error: null }
          },
        }
        return q
      },
    }))
    jest.doMock('../services/whatsappConfigService', () => ({ getCompanyIdByInstanceId: jest.fn() }))
    jest.doMock('../services/whatsappInstanceService', () => ({ getWhatsappInstanceByProviderInstanceId: jest.fn() }))
    jest.doMock('../services/disparoWebhookHook', () => ({ aplicarStatusDisparoFromWebhook: jest.fn(async () => {}) }))
    jest.doMock('../services/mediaR2MirrorService', () => ({ scheduleR2MirrorIfNeeded: jest.fn() }))
    jest.doMock('../controllers/webhookInbound/fromMeReconcile', () => ({
      filterRowsForFromMeReconcile: jest.fn(() => []),
      findPendingOutboundByAckPhone: jest.fn(async () => null),
    }))
    jest.doMock('../controllers/webhookInbound/whatsappIdLookup', () => ({
      selectSingleMensagemByWhatsappId: jest.fn(async () => ({ data: { id: 9, conversa_id: 2, status: 'sent', whatsapp_id: 'W-1' }, error: null })),
      selectSingleMensagemByWhatsappIdRelaxed: jest.fn(async () => ({ data: null, error: null })),
      patchMensagemStatusById: jest.fn(async (_s, args) => ({ data: { id: 9, conversa_id: 2, company_id: 1, status: args.effectiveStatus }, error: null, marcos: {} })),
      updateSingleMensagemByWhatsappId: jest.fn(async () => ({ data: null, error: null })),
      applyWhatsappInstanceFilterOrLegacy: jest.fn((q) => q),
      logAmbiguousWhatsappId: jest.fn(),
    }))

    const { statusZapi } = require('../controllers/webhookInbound/statusZapi')
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this }, json() { return this } }
    await statusZapi({
      path: '/webhooks/whapi',
      body: { id: 'W-1', ids: ['W-1'], status: 'delivered' },
      zapiContext: { company_id: 1, whatsapp_instance_id: 5, provider: 'whapi' },
      app: { get: () => null },
    }, res)
    expect(leiturasDeConversa).toHaveLength(0)
  })
})

describe('F8 — saúde do ACK por canal', () => {
  afterEach(() => { jest.resetModules(); jest.restoreAllMocks() })

  /**
   * O serviço lê UMA amostra de `status` por canal (bounded) e conta em memória — era 3 counts
   * exatos, que custaram 24 s para 21 canais na medição. O fake devolve a amostra e, quando
   * pedido, a linha do último ACK.
   */
  function montar({ enviadas, confirmadas, ultimoAck = '2026-10-16T10:00:00' }) {
    jest.resetModules()
    const consultas = []
    const amostra = [
      ...Array.from({ length: confirmadas }, () => ({ status: 'delivered' })),
      ...Array.from({ length: Math.max(0, enviadas - confirmadas) }, () => ({ status: 'sent' })),
    ]
    jest.doMock('../config/supabase', () => ({
      from() {
        const estado = { in: false, colunas: null }
        const q = {
          select(cols) { estado.colunas = cols; return q },
          eq: () => q, gte: () => q, not: () => q, order: () => q, limit: () => q,
          in() { estado.in = true; return q },
          then(resolve) {
            consultas.push({ ...estado })
            // A consulta do último ACK é a que filtra por `in('status', ...)`.
            const data = estado.in ? [{ criado_em: ultimoAck }] : amostra
            return Promise.resolve({ data, error: null }).then(resolve)
          },
        }
        return q
      },
    }))
    const svc = require('../services/ackHealthService')
    svc._consultas = consultas
    return svc
  }

  test('nada confirmado com volume relevante → sem_ack', async () => {
    const svc = montar({ enviadas: 40, confirmadas: 0 })
    const r = await svc.avaliarCanal({ company_id: 1, whatsapp_instance_id: 5 })
    expect(r.estado).toBe('sem_ack')
    expect(r.enviadas).toBe(40)
    expect(r.mensagem).toMatch(/statuses/)
  })

  test('tudo confirmado → ok', async () => {
    const svc = montar({ enviadas: 40, confirmadas: 38 })
    const r = await svc.avaliarCanal({ company_id: 1, whatsapp_instance_id: 5 })
    expect(r.estado).toBe('ok')
    expect(r.taxa_confirmacao).toBeCloseTo(0.95, 2)
  })

  test('menos da metade confirmada → parcial', async () => {
    const svc = montar({ enviadas: 40, confirmadas: 10 })
    expect((await svc.avaliarCanal({ company_id: 1, whatsapp_instance_id: 5 })).estado).toBe('parcial')
  })

  test('canal ocioso não vira alarme → sem_dados', async () => {
    const svc = montar({ enviadas: 2, confirmadas: 0 })
    const r = await svc.avaliarCanal({ company_id: 1, whatsapp_instance_id: 5 })
    expect(r.estado).toBe('sem_dados')
  })

  test('company_id é obrigatório (isolamento é app-layer)', async () => {
    const svc = montar({ enviadas: 10, confirmadas: 10 })
    await expect(svc.avaliarCanal({ whatsapp_instance_id: 5 })).rejects.toThrow(/company_id/)
  })

  test('a varredura periódica NÃO faz a consulta sem janela do último ACK (custo medido)', async () => {
    const svc = montar({ enviadas: 10, confirmadas: 10 })
    await svc.avaliarCanal({ company_id: 1, whatsapp_instance_id: 5, incluirUltimoAck: false })
    expect(svc._consultas).toHaveLength(1)
    expect(svc._consultas[0].in).toBe(false)
    expect(svc._consultas[0].colunas).toBe('status')
  })

  test('sob demanda (endpoint) inclui o último ACK: 2 consultas', async () => {
    const svc = montar({ enviadas: 10, confirmadas: 10 })
    const r = await svc.avaliarCanal({ company_id: 1, whatsapp_instance_id: 5 })
    expect(svc._consultas).toHaveLength(2)
    expect(r.ultimo_ack_em).toBe('2026-10-16T10:00:00')
  })

  test('amostra no teto é sinalizada (enviadas/confirmadas não são o total da janela)', async () => {
    const svc = montar({ enviadas: 300, confirmadas: 0 })
    const r = await svc.avaliarCanal({ company_id: 1, whatsapp_instance_id: 5, incluirUltimoAck: false })
    expect(r.amostra_truncada).toBe(true)
    expect(r.estado).toBe('sem_ack')
    expect(r.mensagem).toMatch(/mais recentes/)
  })

  test('a lista de status confirmados cobre os apelidos e não inclui erro/pending', () => {
    const svc = montar({ enviadas: 1, confirmadas: 1 })
    expect(svc.STATUS_CONFIRMADOS).toEqual(expect.arrayContaining(['delivered', 'device', 'entregue', 'read', 'lida', 'played']))
    expect(svc.STATUS_CONFIRMADOS).not.toEqual(expect.arrayContaining(['erro', 'failed', 'pending', 'sent']))
  })

  test('aviso no log é limitado a 1 por canal por hora', () => {
    const svc = montar({ enviadas: 1, confirmadas: 1 })
    svc._test.resetAvisos()
    const agora = Date.now()
    expect(svc._test.deveAvisar('1:5', agora)).toBe(true)
    expect(svc._test.deveAvisar('1:5', agora + 60_000)).toBe(false)
    expect(svc._test.deveAvisar('1:5', agora + svc._test.INTERVALO_AVISO_MS + 1)).toBe(true)
    // Canal diferente avisa na hora.
    expect(svc._test.deveAvisar('1:6', agora + 60_000)).toBe(true)
  })
})
