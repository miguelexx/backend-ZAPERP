/**
 * Testes unitários da classificação de "Minhas Pendências" (sem Supabase real).
 */
const {
  _test: {
    isAguardandoCliente,
    isConversaElegivelBase,
    buildUltimaTransferenciaRecebidaMap,
    buildRespostaAposTransferenciaSet,
    isTransferidoParaVoce,
    isAguardandoSuaResposta,
    isEmAtraso,
    classificarPendencias,
    DELAY_MINUTES,
  },
} = require('../services/minhasPendenciasService')

const USER_B = 2

function conversaBase(overrides = {}) {
  return {
    id: 10,
    tipo: 'cliente',
    status_atendimento: 'em_atendimento',
    atendente_id: USER_B,
    aguardando_cliente_desde: null,
    finalizacao_motivo: null,
    finalizada_automaticamente: false,
    ...overrides,
  }
}

describe('minhasPendenciasService — regras de elegibilidade', () => {
  it('exclui aguardando cliente manual', () => {
    expect(isAguardandoCliente({ status_atendimento: 'aguardando_cliente' })).toBe(true)
    expect(isConversaElegivelBase(
      conversaBase({ status_atendimento: 'aguardando_cliente' }),
      USER_B
    )).toBe(false)
  })

  it('exclui aguardando cliente automático (em_atendimento + aguardando_cliente_desde)', () => {
    expect(isAguardandoCliente(
      conversaBase({ aguardando_cliente_desde: '2026-05-30T10:00:00.000Z' })
    )).toBe(true)
    expect(isConversaElegivelBase(
      conversaBase({ aguardando_cliente_desde: '2026-05-30T10:00:00.000Z' }),
      USER_B
    )).toBe(false)
  })

  it('exclui finalizada, fechada e conversa de outro atendente', () => {
    expect(isConversaElegivelBase(conversaBase({ status_atendimento: 'finalizada' }), USER_B)).toBe(false)
    expect(isConversaElegivelBase(conversaBase({ status_atendimento: 'fechada' }), USER_B)).toBe(false)
    expect(isConversaElegivelBase(conversaBase({ atendente_id: 99 }), USER_B)).toBe(false)
    expect(isConversaElegivelBase(conversaBase({ atendente_id: null }), USER_B)).toBe(false)
  })
})

describe('minhasPendenciasService — cenários de validação', () => {
  const transferMap = buildUltimaTransferenciaRecebidaMap(
    [{ conversa_id: 10, acao: 'transferiu', para_usuario_id: USER_B, criado_em: '2026-05-30T12:00:00.000Z' }],
    USER_B
  )

  it('1. transferência para usuário B conta só para B sem resposta pós-transferência', () => {
    const conv = conversaBase()
    const semResposta = buildRespostaAposTransferenciaSet([], transferMap, USER_B)
    expect(isTransferidoParaVoce(conv, transferMap, semResposta, USER_B)).toBe(true)
    expect(isTransferidoParaVoce(conv, transferMap, semResposta, 99)).toBe(false)
  })

  it('2. resposta do usuário B remove transferido e aguardando resposta', () => {
    const conv = conversaBase()
    const lastOut = { direcao: 'out', criado_em: '2026-05-30T12:05:00.000Z' }
    const comResposta = buildRespostaAposTransferenciaSet(
      [{ conversa_id: 10, direcao: 'out', autor_usuario_id: USER_B, criado_em: '2026-05-30T12:05:00.000Z' }],
      transferMap,
      USER_B
    )
    expect(isTransferidoParaVoce(conv, transferMap, comResposta, USER_B)).toBe(false)
    expect(isAguardandoSuaResposta(conv, lastOut, USER_B)).toBe(false)
  })

  it('3. última mensagem do cliente entra em aguardando sua resposta', () => {
    const conv = conversaBase()
    const lastIn = { direcao: 'in', criado_em: new Date().toISOString() }
    expect(isAguardandoSuaResposta(conv, lastIn, USER_B)).toBe(true)
  })

  it('4. aguardando cliente não entra em nenhuma pendência', () => {
    const convManual = conversaBase({ status_atendimento: 'aguardando_cliente' })
    const convAuto = conversaBase({ aguardando_cliente_desde: '2026-05-30T09:00:00.000Z' })
    const lastIn = { direcao: 'in', criado_em: new Date().toISOString() }
    const map = new Map()
    const semResp = new Set()
    expect(isAguardandoSuaResposta(convManual, lastIn, USER_B)).toBe(false)
    expect(isAguardandoSuaResposta(convAuto, lastIn, USER_B)).toBe(false)
    expect(isTransferidoParaVoce(convManual, map, semResp, USER_B)).toBe(false)
  })

  it('5. finalizada não entra em pendências', () => {
    const conv = conversaBase({ status_atendimento: 'finalizada' })
    const lastIn = { direcao: 'in', criado_em: new Date().toISOString() }
    expect(isAguardandoSuaResposta(conv, lastIn, USER_B)).toBe(false)
  })

  it('6. conversa de outro atendente não aparece para B', () => {
    const conv = conversaBase({ atendente_id: 7 })
    const lastIn = { direcao: 'in', criado_em: new Date().toISOString() }
    expect(isAguardandoSuaResposta(conv, lastIn, USER_B)).toBe(false)
  })

  it(`7. cliente aguardando mais de ${DELAY_MINUTES} min entra em em atraso`, () => {
    const conv = conversaBase()
    const old = new Date(Date.now() - (DELAY_MINUTES + 5) * 60 * 1000).toISOString()
    const lastIn = { direcao: 'in', criado_em: old }
    expect(isEmAtraso(conv, lastIn, USER_B)).toBe(true)
    expect(isEmAtraso(conv, { direcao: 'in', criado_em: new Date().toISOString() }, USER_B)).toBe(false)
  })
})

describe('minhasPendenciasService — classificarPendencias', () => {
  it('contadores batem com listas por categoria', () => {
    const conversas = [conversaBase({ id: 1 }), conversaBase({ id: 2 })]
    const lastMessagesMap = new Map([
      [1, { direcao: 'in', criado_em: new Date(Date.now() - 40 * 60 * 1000).toISOString() }],
      [2, { direcao: 'out', criado_em: new Date().toISOString() }],
    ])
    const transferMap = buildUltimaTransferenciaRecebidaMap(
      [{ conversa_id: 2, acao: 'transferiu', para_usuario_id: USER_B, criado_em: '2026-05-30T08:00:00.000Z' }],
      USER_B
    )
    const respostaAposTransferencia = new Set()

    const { transferidos, aguardandoResposta, emAtraso } = classificarPendencias(conversas, {
      usuarioId: USER_B,
      lastMessagesMap,
      transferMap,
      respostaAposTransferencia,
    })

    expect(aguardandoResposta).toHaveLength(1)
    expect(emAtraso).toHaveLength(1)
    expect(transferidos).toHaveLength(1)
    expect(transferidos[0].id).toBe(2)
    expect(aguardandoResposta[0].id).toBe(1)
  })
})
