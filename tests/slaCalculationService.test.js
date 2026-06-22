const {
  resolveMetaMinutos,
  analyzeSlaCycle,
  classifyOutbound,
  calcDiffMinutes,
} = require('../services/slaCalculationService')

describe('slaCalculationService', () => {
  const baseCtx = {
    triageMerged: {},
    absenceCfg: { mensagem: 'Estamos ausentes' },
    contarBot: false,
  }

  const scheduleCorrido = { enabled: false }

  test('resolveMetaMinutos prioriza atendente > setor > empresa', () => {
    const cfg = {
      sla_minutos_sem_resposta: 30,
      metas_departamentos: { '2': 20 },
      metas_usuarios: { '5': 10 },
    }
    expect(resolveMetaMinutos(cfg, { atendente_id: 5, departamento_id: 2 }).limite_min).toBe(10)
    expect(resolveMetaMinutos(cfg, { atendente_id: 9, departamento_id: 2 }).limite_min).toBe(20)
    expect(resolveMetaMinutos(cfg, { atendente_id: 9, departamento_id: 99 }).limite_min).toBe(30)
  })

  test('classifyOutbound ignora bot quando contarBot é false', () => {
    const botMsg = { direcao: 'out', criado_em: '2026-06-22T10:05:00Z', texto: '1 - Financeiro\n2 - Suporte', autor_usuario_id: null }
    const humanMsg = { direcao: 'out', criado_em: '2026-06-22T10:05:00Z', texto: 'Olá, como posso ajudar?', autor_usuario_id: 12 }
    expect(classifyOutbound(botMsg, baseCtx).valida).toBe(false)
    expect(classifyOutbound(humanMsg, baseCtx).valida).toBe(true)
  })

  test('analyzeSlaCycle marca violação quando tempo excede meta', () => {
    const msgs = [
      { id: 1, direcao: 'in', criado_em: '2026-06-22T10:00:00Z', texto: 'Oi' },
      { id: 2, direcao: 'out', criado_em: '2026-06-22T10:45:00Z', texto: 'Olá!', autor_usuario_id: 3 },
    ]
    const result = analyzeSlaCycle({
      msgs,
      anchorTs: 0,
      tipoSla: 'primeira_resposta',
      limiteMin: 30,
      metaOrigem: 'empresa',
      metaOrigemLabel: 'Empresa',
      schedule: scheduleCorrido,
      ctx: baseCtx,
      base: { conversa_id: 1 },
    })
    expect(result.status_sla).toBe('violou')
    expect(result.cumpriu_sla).toBe(false)
    expect(result.tempo_resposta_min).toBe(45)
    expect(result.meta_origem).toBe('empresa')
  })

  test('analyzeSlaCycle separa sem resposta de dados insuficientes (só bot)', () => {
    const msgsBot = [
      { id: 1, direcao: 'in', criado_em: '2026-06-22T10:00:00Z', texto: 'Oi' },
      { id: 2, direcao: 'out', criado_em: '2026-06-22T10:01:00Z', texto: '1 - Financeiro\n2 - Suporte', autor_usuario_id: null },
    ]
    const semResp = analyzeSlaCycle({
      msgs: [{ id: 1, direcao: 'in', criado_em: '2026-06-22T10:00:00Z', texto: 'Oi' }],
      anchorTs: 0,
      tipoSla: 'primeira_resposta',
      limiteMin: 30,
      metaOrigem: 'empresa',
      metaOrigemLabel: 'Empresa',
      schedule: scheduleCorrido,
      ctx: baseCtx,
      base: { conversa_id: 2 },
    })
    const dadosInsuf = analyzeSlaCycle({
      msgs: msgsBot,
      anchorTs: 0,
      tipoSla: 'primeira_resposta',
      limiteMin: 30,
      metaOrigem: 'empresa',
      metaOrigemLabel: 'Empresa',
      schedule: scheduleCorrido,
      ctx: baseCtx,
      base: { conversa_id: 3 },
    })
    expect(semResp.status_sla).toBe('sem_resposta')
    expect(dadosInsuf.status_sla).toBe('dados_insuficientes')
  })

  test('calcDiffMinutes usa tempo corrido sem horário comercial', () => {
    const min = calcDiffMinutes('2026-06-22T10:00:00Z', '2026-06-22T10:30:00Z', { enabled: false })
    expect(min).toBe(30)
  })
})
