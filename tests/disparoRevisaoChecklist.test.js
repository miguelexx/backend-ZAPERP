/**
 * Testes unitários — checklist e status da Etapa 6.
 * Sem banco / R2 / UltraMSG.
 */

const {
  montarChecklist,
  mascararTelefone,
  montarPayloadHash,
  hashConfig,
  DECLARACAO_AUTORIZACAO,
} = require('../helpers/disparoRevisaoChecklist')
const {
  statusPermiteEdicao,
  statusEstaCongelado,
  statusPermiteVoltarEdicao,
  STATUS_TODOS,
} = require('../helpers/disparoStatusHelper')

function baseCtx(over = {}) {
  return {
    companyIdToken: 10,
    isAdmin: true,
    campanha: {
      company_id: 10,
      distribuicao_confirmada: true,
      distribuicao_revisao: false,
      variacao_confirmada: true,
      variacao_revisao: false,
      limites_confirmados: true,
      limites_revisao: false,
    },
    destinatarios: [
      { id: 1, status: 'pendente', telefone_normalizado: '5511999990001', instancia_id: 1, variacao_id: 1 },
      { id: 2, status: 'pendente', telefone_normalizado: '5511999990002', instancia_id: 1, variacao_id: 1 },
    ],
    instanciasStatus: [{ id: 1, nome: 'WA', status: 'connected', ativo: true }],
    variacoes: [{ id: 1, ativa: true, tipo_mensagem: 'texto', texto: 'Oi {{nome}}' }],
    limites: {
      limite_por_hora: 60,
      limite_por_dia: 500,
      intervalo_min_sec: 8,
      intervalo_max_sec: 20,
      inicio_modo: 'imediato',
      fuso_horario: 'America/Sao_Paulo',
    },
    janelas: [{ dia_semana: 1, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null }],
    conflitos: { conflito_impeditivo: false, conflitos: [] },
    midiasInvalidas: [],
    varsAusentesCount: 0,
    autorizacaoAceita: true,
    ...over,
  }
}

describe('disparoStatusHelper', () => {
  it('inclui status pronta', () => {
    expect(STATUS_TODOS.has('pronta')).toBe(true)
  })

  it('pronta/agendada estão congelados e não editáveis', () => {
    expect(statusPermiteEdicao('pronta')).toBe(false)
    expect(statusEstaCongelado('pronta')).toBe(true)
    expect(statusPermiteVoltarEdicao('pronta')).toBe(true)
    expect(statusPermiteVoltarEdicao('em_execucao')).toBe(false)
  })
})

describe('disparoRevisaoChecklist', () => {
  it('checklist completo aprovado quando tudo ok', () => {
    const r = montarChecklist(baseCtx())
    expect(r.ok).toBe(true)
    expect(r.bloqueios).toHaveLength(0)
  })

  it('bloqueia destinatário sem instância', () => {
    const r = montarChecklist(baseCtx({
      destinatarios: [
        { id: 1, status: 'pendente', telefone_normalizado: '5511999990001', instancia_id: null, variacao_id: 1 },
      ],
    }))
    expect(r.ok).toBe(false)
    expect(r.bloqueios.some((b) => b.codigo === 'dest_inst')).toBe(true)
  })

  it('bloqueia destinatário sem variação', () => {
    const r = montarChecklist(baseCtx({
      destinatarios: [
        { id: 1, status: 'pendente', telefone_normalizado: '5511999990001', instancia_id: 1, variacao_id: null },
      ],
    }))
    expect(r.ok).toBe(false)
    expect(r.bloqueios.some((b) => b.codigo === 'dest_var')).toBe(true)
  })

  it('bloqueia instância desconectada', () => {
    const r = montarChecklist(baseCtx({
      instanciasStatus: [{ id: 1, nome: 'WA', status: 'disconnected', ativo: true }],
    }))
    expect(r.ok).toBe(false)
    expect(r.bloqueios.some((b) => b.codigo === 'inst_conn')).toBe(true)
  })

  it('bloqueia variável ausente', () => {
    const r = montarChecklist(baseCtx({ varsAusentesCount: 3 }))
    expect(r.ok).toBe(false)
    expect(r.bloqueios.some((b) => b.codigo === 'vars')).toBe(true)
  })

  it('bloqueia mídia inválida', () => {
    const r = montarChecklist(baseCtx({
      midiasInvalidas: [{ motivo: 'Variação X sem arquivo' }],
    }))
    expect(r.ok).toBe(false)
  })

  it('bloqueia etapa necessitando revisão', () => {
    const r = montarChecklist(baseCtx({
      campanha: { ...baseCtx().campanha, limites_revisao: true },
    }))
    expect(r.ok).toBe(false)
    expect(r.bloqueios.some((b) => b.codigo === 'revisao')).toBe(true)
  })

  it('bloqueia agendamento inválido', () => {
    const r = montarChecklist(baseCtx({
      limites: {
        ...baseCtx().limites,
        inicio_modo: 'agendado',
        agendado_para: '2020-01-01T10:00:00.000Z',
      },
    }))
    expect(r.ok).toBe(false)
    expect(r.bloqueios.some((b) => b.codigo === 'agenda')).toBe(true)
  })

  it('bloqueia conflito impeditivo', () => {
    const r = montarChecklist(baseCtx({
      conflitos: { conflito_impeditivo: true, conflitos: [{ campanha_id: 9 }] },
    }))
    expect(r.ok).toBe(false)
  })

  it('bloqueia confirmação sem autorização', () => {
    const r = montarChecklist(baseCtx({ autorizacaoAceita: false }))
    expect(r.ok).toBe(false)
    expect(r.bloqueios.some((b) => b.codigo === 'autorizacao')).toBe(true)
  })

  it('mascara telefone', () => {
    expect(mascararTelefone('5511999887766')).toMatch(/5511\*\*\*\*7766|5511\*\*\*\*/)
  })

  it('hash é estável para mesmo payload', () => {
    const p = montarPayloadHash({
      campanhaId: 1,
      companyId: 10,
      nome: 'Teste',
      instanciaIds: [2, 1],
      variacaoIds: [5],
      limites: baseCtx().limites,
      janelas: baseCtx().janelas,
      totalDest: 2,
      distribuicaoModo: 'equilibrada',
      variacaoModo: 'unica',
    })
    expect(hashConfig(p)).toBe(hashConfig(p))
    expect(hashConfig(p)).toHaveLength(64)
  })

  it('declaração de autorização está definida', () => {
    expect(DECLARACAO_AUTORIZACAO).toMatch(/autorização|legítima/i)
  })
})
