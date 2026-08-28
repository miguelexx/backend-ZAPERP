const {
  overridesFromListQuery,
  parseConversaIdsQuery,
  rowVisibleInPostFilteredList,
  getStartOfTodayIso,
  getEndOfTodayIso,
  withTimeout,
  getChatCountsTimeoutMs,
} = require('../services/chatListCountsService')

describe('chatListCountsService', () => {
  test('parseConversaIdsQuery parses comma-separated ids', () => {
    expect(parseConversaIdsQuery('1,2, 3')).toEqual([1, 2, 3])
    expect(parseConversaIdsQuery('0')).toEqual([])
    expect(parseConversaIdsQuery('')).toEqual([])
  })

  test('overridesFromListQuery maps active list filters', () => {
    expect(overridesFromListQuery({ conversa_ids: '10,11' })).toEqual({ conversa_ids: [10, 11] })
    expect(overridesFromListQuery({ conversa_ids: '0' })).toEqual({ conversa_ids: [0] })
    expect(overridesFromListQuery({ minha_fila: '1' })).toEqual({ minha_fila: true })
    expect(overridesFromListQuery({ campanhas: '1' })).toEqual({ campanhas: true })
    expect(overridesFromListQuery({ hoje: '1' })).toEqual({ hoje: true })
    expect(overridesFromListQuery({ aguardando_cliente: '1' })).toEqual({ aguardando_cliente: true })
    expect(overridesFromListQuery({ aguardando_atendente: '1' })).toEqual({ aguardando_atendente: true })
    expect(overridesFromListQuery({ status_atendimento: 'fechada' })).toEqual({
      status_atendimento: 'fechada',
    })
    expect(
      overridesFromListQuery({
        status_atendimento: 'fechada',
        finalizacao_motivo: 'ausencia_cliente',
      })
    ).toEqual({
      status_atendimento: 'fechada',
      finalizacao_motivo: 'ausencia_cliente',
    })
    expect(overridesFromListQuery({})).toEqual({})
  })

  test('today bounds cover full local calendar day', () => {
    const start = new Date(getStartOfTodayIso())
    const end = new Date(getEndOfTodayIso())
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
    expect(end.getHours()).toBe(23)
    expect(end.getMinutes()).toBe(59)
    expect(end.getTime()).toBeGreaterThan(start.getTime())
  })

  test('post-list count rules match visible open and queue rows', () => {
    const ctx = { user_id: 84, isAtendente: false, filtroAtendenteInformado: null }

    expect(
      rowVisibleInPostFilteredList(
        { tipo: null, status_atendimento: 'aberta', atendente_id: null, mensagens: [] },
        ctx,
        { status_atendimento: 'aberta' }
      )
    ).toBe(false)

    expect(
      rowVisibleInPostFilteredList(
        { tipo: null, status_atendimento: 'aberta', atendente_id: null, mensagens: [{ id: 1 }] },
        ctx,
        { status_atendimento: 'aberta' }
      )
    ).toBe(true)

    expect(
      rowVisibleInPostFilteredList(
        { tipo: null, status_atendimento: 'aberta', atendente_id: 84, mensagens: [] },
        ctx,
        { minha_fila: true }
      )
    ).toBe(true)

    expect(
      rowVisibleInPostFilteredList(
        {
          tipo: null,
          status_atendimento: 'aberta',
          atendente_id: null,
          aguardando_resposta_campanha: true,
          mensagens: [{ id: 1 }],
        },
        ctx,
        { minha_fila: true }
      )
    ).toBe(false)

    expect(
      rowVisibleInPostFilteredList(
        {
          tipo: null,
          status_atendimento: 'aberta',
          atendente_id: null,
          aguardando_resposta_campanha: true,
          mensagens: [{ id: 1 }],
        },
        ctx,
        { status_atendimento: 'aberta' }
      )
    ).toBe(false)

    expect(
      rowVisibleInPostFilteredList(
        { tipo: 'grupo', status_atendimento: 'aberta', atendente_id: null, mensagens: [{ id: 1 }] },
        ctx,
        { status_atendimento: 'aberta' }
      )
    ).toBe(true)

    expect(
      rowVisibleInPostFilteredList(
        { tipo: 'grupo', status_atendimento: 'aberta', atendente_id: 84, mensagens: [{ id: 1 }] },
        ctx,
        { minha_fila: true }
      )
    ).toBe(false)

    expect(
      rowVisibleInPostFilteredList(
        { tipo: 'grupo', status_atendimento: 'em_atendimento', atendente_id: 84, mensagens: [{ id: 1 }] },
        ctx,
        { status_atendimento: 'em_atendimento' }
      )
    ).toBe(false)
  })

  test('withTimeout resolve rápido e rejeita com CHAT_COUNTS_TIMEOUT', async () => {
    await expect(withTimeout(Promise.resolve(7), 200)).resolves.toBe(7)
    let resolveHang
    const hang = new Promise((resolve) => { resolveHang = resolve })
    await expect(withTimeout(hang, 20)).rejects.toMatchObject({
      code: 'CHAT_COUNTS_TIMEOUT',
    })
    resolveHang()
  })

  test('getChatCountsTimeoutMs usa default e clampa', () => {
    const prev = process.env.CHAT_COUNTS_TIMEOUT_MS
    try {
      delete process.env.CHAT_COUNTS_TIMEOUT_MS
      expect(getChatCountsTimeoutMs()).toBe(20000)
      process.env.CHAT_COUNTS_TIMEOUT_MS = '1000'
      expect(getChatCountsTimeoutMs()).toBe(3000)
      process.env.CHAT_COUNTS_TIMEOUT_MS = '999999'
      expect(getChatCountsTimeoutMs()).toBe(50000)
    } finally {
      if (prev == null) delete process.env.CHAT_COUNTS_TIMEOUT_MS
      else process.env.CHAT_COUNTS_TIMEOUT_MS = prev
    }
  })
})
