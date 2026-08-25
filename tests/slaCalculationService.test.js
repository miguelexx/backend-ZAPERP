const {
  resolveMetaMinutos,
  analyzeSlaCycle,
  classifyOutbound,
  calcDiffMinutes,
  carveBreakFromWindows,
} = require('../services/slaCalculationService')
const { businessMinutesBetween } = require('../services/atendimentoSemRespostaService')

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

  describe('carveBreakFromWindows (exclusão de almoço)', () => {
    const almoco = { start: 12 * 60, end: 14 * 60 } // 12:00–14:00

    test('divide a janela 07:00–18:00 em duas ao redor do almoço', () => {
      const out = carveBreakFromWindows([{ start: 7 * 60, end: 18 * 60 }], almoco)
      expect(out).toEqual([
        { start: 7 * 60, end: 12 * 60 },
        { start: 14 * 60, end: 18 * 60 },
      ])
    })

    test('janela inteiramente dentro do almoço é removida', () => {
      const out = carveBreakFromWindows([{ start: 12 * 60 + 30, end: 13 * 60 + 30 }], almoco)
      expect(out).toEqual([])
    })

    test('janela sem sobreposição fica intacta', () => {
      const janelas = [{ start: 14 * 60, end: 18 * 60 }]
      expect(carveBreakFromWindows(janelas, almoco)).toEqual(janelas)
    })

    test('almoço "off" (brk nulo) não altera as janelas', () => {
      const janelas = [{ start: 7 * 60, end: 18 * 60 }]
      expect(carveBreakFromWindows(janelas, null)).toEqual(janelas)
    })

    test('integração: businessMinutesBetween ignora o almoço nas janelas carvadas', () => {
      const schedule = {
        enabled: true,
        timezone: 'America/Sao_Paulo',
        diasSemanaDesativados: [],
        datasEspecificasFechadas: [],
        windows: carveBreakFromWindows([{ start: 7 * 60, end: 18 * 60 }], almoco),
      }
      // 11:30 → 14:30 (horário local SP = UTC-3): conta 11:30–12:00 (30) + 14:00–14:30 (30) = 60
      const min = businessMinutesBetween('2026-06-15T14:30:00.000Z', new Date('2026-06-15T17:30:00.000Z'), schedule)
      expect(min).toBe(60)
    })
  })
})
