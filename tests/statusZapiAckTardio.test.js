/**
 * ACK TARDIO (Whapi): o ACK chega ANTES de o whatsapp_id estar gravado na linha.
 * Antes o ACK era descartado ("mensagem não encontrada") e o tique ficava no relógio até o
 * próximo ACK ou a varredura. Agora é reaplicado por match EXATO de whatsapp_id.
 */

describe('statusZapi — ACK tardio', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  function montar({ linha, conversa = { tipo: 'privado', telefone: '5588999990000' } }) {
    jest.resetModules()
    const patches = []
    jest.doMock('../config/supabase', () => ({
      from: () => {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: conversa, error: null }) }
        return q
      },
    }))
    jest.doMock('../services/whatsappConfigService', () => ({ getCompanyIdByInstanceId: jest.fn() }))
    jest.doMock('../services/whatsappInstanceService', () => ({ getWhatsappInstanceByProviderInstanceId: jest.fn() }))
    jest.doMock('../controllers/webhookInbound/fromMeReconcile', () => ({
      filterRowsForFromMeReconcile: jest.fn(() => []),
      findPendingOutboundByAckPhone: jest.fn(async () => null),
    }))
    const buscar = jest.fn(async () => ({ data: typeof linha === 'function' ? linha() : linha }))
    jest.doMock('../controllers/webhookInbound/whatsappIdLookup', () => ({
      selectSingleMensagemByWhatsappId: jest.fn(async () => ({ data: null })),
      updateSingleMensagemByWhatsappId: jest.fn(async () => ({ data: null })),
      selectSingleMensagemByWhatsappIdRelaxed: buscar,
      patchMensagemStatusById: jest.fn(async (_s, args) => {
        patches.push(args)
        return {
          data: { id: args.mensagem_id, conversa_id: 2, company_id: 1, autor_usuario_id: 4, whatsapp_id: 'PsrIhlIPnArSqck-wOuAzLILsg' },
        }
      }),
      applyWhatsappInstanceFilterOrLegacy: jest.fn((q) => q),
      logAmbiguousWhatsappId: jest.fn(),
    }))

    const mod = require('../controllers/webhookInbound/statusZapi')
    const emitted = []
    const chain = { to: () => chain, emit: (ev, payload) => emitted.push({ ev, payload }) }
    const io = { to: () => chain }
    return { ackTardio: mod._ackTardio, patches, emitted, io, buscar }
  }

  const ID_WHAPI = 'PsrIhlIPnArSqck-wOuAzLILsg'

  test('linha ainda sem o id gravado → não encontra, não grava nada', async () => {
    const { ackTardio, patches, emitted, io } = montar({ linha: null })
    const achou = await ackTardio.reaplicarAckTardio({ company_id: 1, idStr: ID_WHAPI, status: 'sent', io })
    expect(achou).toBe(false)
    expect(patches).toHaveLength(0)
    expect(emitted).toHaveLength(0)
  })

  test('id já gravado e linha pending → aplica sent e emite status_mensagem em tempo real', async () => {
    const { ackTardio, patches, emitted, io } = montar({
      linha: { id: 9, conversa_id: 2, company_id: 1, autor_usuario_id: 4, whatsapp_id: ID_WHAPI, status: 'pending' },
    })
    const achou = await ackTardio.reaplicarAckTardio({ company_id: 1, idStr: ID_WHAPI, status: 'sent', io })
    expect(achou).toBe(true)
    expect(patches[0]).toMatchObject({ mensagem_id: 9, effectiveStatus: 'sent' })
    expect(emitted[0].ev).toBe('status_mensagem')
    expect(emitted[0].payload).toMatchObject({ mensagem_id: 9, conversa_id: 2, status: 'sent', status_mensagem: 'sent' })
  })

  test('ACK atrasado nunca regride: linha já read + ACK sent tardio → não grava nem emite', async () => {
    const { ackTardio, patches, emitted, io } = montar({
      linha: { id: 9, conversa_id: 2, company_id: 1, autor_usuario_id: 4, whatsapp_id: ID_WHAPI, status: 'read' },
    })
    const achou = await ackTardio.reaplicarAckTardio({ company_id: 1, idStr: ID_WHAPI, status: 'sent', io })
    expect(achou).toBe(true)
    expect(patches).toHaveLength(0)
    expect(emitted).toHaveLength(0)
  })

  test('grupo: read tardio é limitado a delivered (mesma regra do fluxo principal)', async () => {
    const { ackTardio, patches, io } = montar({
      linha: { id: 9, conversa_id: 2, company_id: 1, autor_usuario_id: 4, whatsapp_id: ID_WHAPI, status: 'sent' },
      conversa: { tipo: 'grupo', telefone: '120363000000000000@g.us' },
    })
    await ackTardio.reaplicarAckTardio({ company_id: 1, idStr: ID_WHAPI, status: 'read', io })
    expect(patches[0]).toMatchObject({ effectiveStatus: 'delivered' })
  })

  test('agendamento fica desligado em ambiente de teste (sem timers pendurados)', () => {
    const { ackTardio, io } = montar({ linha: null })
    expect(ackTardio.agendarAckTardio({ company_id: 1, idStr: ID_WHAPI, status: 'sent', io })).toBe(false)
    expect(ackTardio.pendentes()).toBe(0)
  })
})
