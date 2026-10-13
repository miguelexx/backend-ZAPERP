/**
 * Fallback de reconciliacao Whapi por ID no historico do chat.
 *
 * Contexto medido em producao em 13/10/2026: `GET /messages/{id}` da Whapi responde 404 para
 * parte dos ids mesmo quando a mensagem foi entregue e lida, enquanto a LISTA do mesmo chat
 * mostra a linha com `status: read`. Sem este caminho a linha virava `erro` depois do prazo e
 * o atendente reenviava uma mensagem que o cliente ja tinha recebido.
 */
const { _test } = require('../services/pendingOutboundReconciliationService')
const { mapWhapiMessageForSync } = require('../services/providers/whapi/chatMessages')

const { encontrarNoHistoricoPorId, consultarHistoricoWhapiPorId } = _test

const ID = 'PspI8aQmjtEcPq8-wGeA2z_ovQ'
const ID2 = 'PsoY2FxCUermdoE-wLEFBMI0JH4'
const ROW = {
  id: 9001,
  company_id: 1,
  conversa_id: 34075,
  whatsapp_id: ID,
  criado_em: '2026-10-13T05:30:00',
  whatsapp_instance_id: null,
}

function providerComHistorico(data, { ok = true, throws = false } = {}) {
  return {
    chamadas: 0,
    async getChatMessages() {
      this.chamadas += 1
      if (throws) throw new Error('rede caiu')
      return ok ? { ok: true, data } : { ok: false, data: [] }
    },
  }
}

describe('encontrarNoHistoricoPorId', () => {
  test('acha a linha from_me com o id exato', () => {
    const lista = [
      { id: 'outro', from_me: true },
      { id: ID, from_me: true, whapi_status_raw: 'read' },
    ]
    expect(encontrarNoHistoricoPorId(lista, ID).whapi_status_raw).toBe('read')
  })

  test('ignora mensagem recebida mesmo com o id igual', () => {
    expect(encontrarNoHistoricoPorId([{ id: ID, from_me: false }], ID)).toBeNull()
  })

  test('aceita a forma camelCase fromMe', () => {
    expect(encontrarNoHistoricoPorId([{ id: ID, fromMe: true }], ID)).not.toBeNull()
  })

  test('nao faz match parcial: prefixo ou sufixo do id nao vale', () => {
    expect(encontrarNoHistoricoPorId([{ id: ID + 'X', from_me: true }], ID)).toBeNull()
    expect(encontrarNoHistoricoPorId([{ id: ID.slice(0, -1), from_me: true }], ID)).toBeNull()
  })

  test('entradas invalidas nao explodem', () => {
    expect(encontrarNoHistoricoPorId(null, ID)).toBeNull()
    expect(encontrarNoHistoricoPorId([{ id: ID, from_me: true }], '')).toBeNull()
    expect(encontrarNoHistoricoPorId([null, undefined, 7], ID)).toBeNull()
  })
})

describe('mapWhapiMessageForSync preserva o status de entrega', () => {
  test('status cru vai para whapi_status_raw, sem colidir com status', () => {
    const m = mapWhapiMessageForSync({
      id: ID, from_me: true, type: 'text', text: { body: 'ok' }, status: 'read',
    })
    expect(m.whapi_status_raw).toBe('read')
    expect(m.status).toBeUndefined()
  })

  test('sem status no provedor a chave nao aparece', () => {
    const m = mapWhapiMessageForSync({ id: ID, from_me: true, type: 'text', text: { body: 'ok' } })
    expect('whapi_status_raw' in m).toBe(false)
  })

  test('status em branco nao cria chave', () => {
    expect('whapi_status_raw' in mapWhapiMessageForSync({ id: ID, status: '   ' })).toBe(false)
  })

  test('status de midia tambem e preservado (o match por id serve midia)', () => {
    const m = mapWhapiMessageForSync({
      id: ID, from_me: true, type: 'image', image: { link: 'https://x/y.jpg' }, status: 'delivered',
    })
    expect(m.whapi_status_raw).toBe('delivered')
    expect(m.imageUrl).toBe('https://x/y.jpg')
  })
})

describe('consultarHistoricoWhapiPorId', () => {
  test('encontra a mensagem entregue que o GET por id nao devolve', async () => {
    const provider = providerComHistorico([
      mapWhapiMessageForSync({ id: 'irmao', from_me: true, text: { body: 'ok' }, status: 'read' }),
      mapWhapiMessageForSync({ id: ID, from_me: true, text: { body: 'ok' }, status: 'delivered' }),
    ])
    const r = await consultarHistoricoWhapiPorId({ row: ROW, provider, telefone: '553499911246' })
    expect(r).toMatchObject({ consultaOk: true, encontrado: true })
    expect(r.mensagem.whapi_status_raw).toBe('delivered')
  })

  test('ausencia no historico e confirmada (consultaOk) e nao cura nada', async () => {
    const provider = providerComHistorico([
      mapWhapiMessageForSync({ id: 'outro', from_me: true, text: { body: 'ok' }, status: 'read' }),
    ])
    const r = await consultarHistoricoWhapiPorId({ row: ROW, provider, telefone: '5534000001' })
    expect(r).toEqual({ consultaOk: true, encontrado: false })
  })

  test('falha de rede fica inconclusiva, nunca afirma ausencia', async () => {
    const provider = providerComHistorico([], { throws: true })
    const r = await consultarHistoricoWhapiPorId({ row: ROW, provider, telefone: '5534000002' })
    expect(r).toEqual({ consultaOk: false })
  })

  test('provedor que recusa a consulta fica inconclusivo', async () => {
    const provider = providerComHistorico([], { ok: false })
    const r = await consultarHistoricoWhapiPorId({ row: ROW, provider, telefone: '5534000003' })
    expect(r).toEqual({ consultaOk: false })
  })

  test('linha sem whatsapp_id nao consulta nada (nao ha id para casar)', async () => {
    const provider = providerComHistorico([])
    const r = await consultarHistoricoWhapiPorId({
      row: { ...ROW, whatsapp_id: null }, provider, telefone: '5534000004',
    })
    expect(r).toEqual({ consultaOk: false })
    expect(provider.chamadas).toBe(0)
  })

  test('queue id numerico da UltraMSG nao e id real: nao consulta', async () => {
    const provider = providerComHistorico([])
    const r = await consultarHistoricoWhapiPorId({
      row: { ...ROW, whatsapp_id: '35096' }, provider, telefone: '5534000005',
    })
    expect(r).toEqual({ consultaOk: false })
    expect(provider.chamadas).toBe(0)
  })

  test('provider sem getChatMessages fica inconclusivo', async () => {
    const r = await consultarHistoricoWhapiPorId({ row: ROW, provider: {}, telefone: '5534000006' })
    expect(r).toEqual({ consultaOk: false })
  })

  test('duas linhas da mesma conversa reaproveitam UMA consulta (cache)', async () => {
    const provider = providerComHistorico([
      mapWhapiMessageForSync({ id: ID, from_me: true, text: { body: 'ok' }, status: 'read' }),
      mapWhapiMessageForSync({ id: ID2, from_me: true, text: { body: 'ok2' }, status: 'read' }),
    ])
    const tel = '5534' + String(Date.now())
    const a = await consultarHistoricoWhapiPorId({ row: ROW, provider, telefone: tel })
    const b = await consultarHistoricoWhapiPorId({
      row: { ...ROW, id: 9002, whatsapp_id: ID2 }, provider, telefone: tel,
    })
    expect(a.encontrado).toBe(true)
    expect(b.encontrado).toBe(true)
    expect(provider.chamadas).toBe(1)
  })

  test('o status do historico alimenta o mapeamento unico de status', () => {
    // O caminho novo nao decide status: entrega { status } ao mapeador que ja existia.
    expect(_test.mapProviderAckToStatus({ status: 'read' })).toBe('read')
    expect(_test.mapProviderAckToStatus({ status: 'delivered' })).toBe('delivered')
    expect(_test.providerRowIndicatesSuccess({ status: 'delivered' })).toBe(true)
    expect(_test.providerRowIndicatesFailure({ status: 'failed' })).toBe(true)
    expect(_test.providerRowIndicatesPending({ status: 'pending' })).toBe(true)
  })

  test('mensagem com id nunca entra no reenvio automatico', () => {
    // Garante que o fallback nao pode, nem indiretamente, duplicar no cliente.
    expect(_test.provedorNuncaAceitou({ whatsapp_id: ID })).toBe(false)
  })
})
