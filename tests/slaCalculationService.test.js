const {
  resolveMetaMinutos,
  analyzeSlaCycle,
  classifyOutbound,
  calcDiffMinutes,
  formatSaoPauloDateKey,
  analyzeConversationSlaCycles,
  summarizeResponseCycleTimes,
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

  test('conversa com apenas bot permanece aguardando primeira resposta humana', () => {
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
    const pendenteAposBot = analyzeSlaCycle({
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
    expect(pendenteAposBot.status_sla).toBe('sem_resposta')
    expect(pendenteAposBot.tipo_resposta).toBe('automacao')
  })

  test.each([
    ['sistema', { autor_usuario_id: 7, origem: 'sistema_humano' }],
    ['celular', { autor_usuario_id: null, origem: 'whatsapp_celular' }],
  ])('cliente 08:00 e humano pelo %s 08:05 resulta em 5 minutos', (_, outbound) => {
    const result = analyzeSlaCycle({
      msgs: [
        { id: 1, direcao: 'in', origem: 'cliente', criado_em: '2026-07-29T11:00:00Z', texto: 'Oi' },
        { id: 2, direcao: 'out', criado_em: '2026-07-29T11:05:00Z', texto: 'Olá', ...outbound },
      ],
      anchorTs: 0,
      tipoSla: 'primeira_resposta',
      limiteMin: 30,
      metaOrigem: 'empresa',
      metaOrigemLabel: 'Empresa',
      schedule: scheduleCorrido,
      ctx: baseCtx,
      base: { conversa_id: 20 },
    })
    expect(result.tempo_resposta_min).toBe(5)
    expect(result.status_sla).toBe('cumpriu')
    expect(result.origem_resposta).toBe(outbound.origem)
  })

  test('bot em 1 minuto e humano em 6 minutos encerra o SLA somente no humano', () => {
    const result = analyzeSlaCycle({
      msgs: [
        { id: 1, direcao: 'in', origem: 'cliente', criado_em: '2026-07-29T11:00:00Z', texto: 'Oi' },
        { id: 2, direcao: 'out', origem: 'automacao', criado_em: '2026-07-29T11:01:00Z', texto: 'Menu' },
        { id: 3, direcao: 'out', origem: 'sistema_humano', autor_usuario_id: 7, criado_em: '2026-07-29T11:06:00Z', texto: 'Olá' },
      ],
      anchorTs: 0,
      tipoSla: 'primeira_resposta',
      limiteMin: 30,
      metaOrigem: 'empresa',
      metaOrigemLabel: 'Empresa',
      schedule: scheduleCorrido,
      ctx: baseCtx,
      base: { conversa_id: 21 },
    })
    expect(result.tempo_resposta_min).toBe(6)
    expect(result.tipo_resposta).toBe('humana')
  })

  test('reabertura usa somente mensagens posteriores ao novo ciclo', () => {
    const result = analyzeSlaCycle({
      msgs: [
        { id: 1, direcao: 'in', criado_em: '2026-07-29T10:00:00Z', texto: 'Ciclo antigo' },
        { id: 2, direcao: 'out', origem: 'sistema_humano', criado_em: '2026-07-29T10:02:00Z', texto: 'Resposta antiga' },
        { id: 3, direcao: 'in', criado_em: '2026-07-29T12:00:00Z', texto: 'Novo ciclo' },
        { id: 4, direcao: 'out', origem: 'whatsapp_celular', criado_em: '2026-07-29T12:07:00Z', texto: 'Nova resposta' },
      ],
      anchorTs: new Date('2026-07-29T11:59:00Z').getTime(),
      anchorEm: '2026-07-29T11:59:00Z',
      tipoSla: 'reabertura',
      limiteMin: 30,
      metaOrigem: 'empresa',
      metaOrigemLabel: 'Empresa',
      schedule: scheduleCorrido,
      ctx: baseCtx,
      base: { conversa_id: 22 },
    })
    expect(result.primeira_mensagem_cliente_em).toBe('2026-07-29T12:00:00Z')
    expect(result.tempo_resposta_min).toBe(7)
  })

  test('conversa persistente gera um ciclo por nova espera do cliente', () => {
    const cycles = analyzeConversationSlaCycles({
      msgs: [
        { id: 1, direcao: 'in', criado_em: '2026-07-29T11:00:00Z', texto: 'Oi' },
        { id: 2, direcao: 'in', criado_em: '2026-07-29T11:01:00Z', texto: 'Consegue me ajudar?' },
        { id: 3, direcao: 'out', origem: 'sistema_humano', criado_em: '2026-07-29T11:03:00Z', texto: 'Claro' },
        { id: 4, direcao: 'out', origem: 'sistema_humano', criado_em: '2026-07-29T11:04:00Z', texto: 'Pode enviar' },
        { id: 5, direcao: 'in', criado_em: '2026-07-29T11:10:00Z', texto: 'Enviei' },
        { id: 6, direcao: 'out', origem: 'whatsapp_celular', criado_em: '2026-07-29T11:12:00Z', texto: 'Recebi' },
      ],
      limiteMin: 30,
      metaOrigem: 'empresa',
      metaOrigemLabel: 'Empresa',
      schedule: scheduleCorrido,
      ctx: baseCtx,
      base: { conversa_id: 30 },
    })
    expect(cycles).toHaveLength(2)
    expect(cycles.map((item) => item.tempo_resposta_min)).toEqual([3, 2])
    expect(cycles.map((item) => item.tipo_sla)).toEqual(['primeira_resposta', 'nova_interacao'])
  })

  test('automação não encerra ciclo e nova mensagem após resposta abre outro ciclo pendente', () => {
    const cycles = analyzeConversationSlaCycles({
      msgs: [
        { id: 1, direcao: 'in', criado_em: '2026-07-29T11:00:00Z', texto: 'Oi' },
        { id: 2, direcao: 'out', origem: 'automacao', criado_em: '2026-07-29T11:01:00Z', texto: 'Menu' },
        { id: 3, direcao: 'out', origem: 'sistema_humano', criado_em: '2026-07-29T11:04:00Z', texto: 'Olá' },
        { id: 4, direcao: 'in', criado_em: '2026-07-29T11:10:00Z', texto: 'Outra dúvida' },
      ],
      limiteMin: 30,
      metaOrigem: 'empresa',
      metaOrigemLabel: 'Empresa',
      schedule: scheduleCorrido,
      ctx: baseCtx,
      base: { conversa_id: 31 },
    })
    expect(cycles).toHaveLength(2)
    expect(cycles[0].tempo_resposta_min).toBe(4)
    expect(cycles[0].tipo_resposta).toBe('humana')
    expect(cycles[1].status_sla).toBe('sem_resposta')
  })

  test('ciclo iniciado depois de evento de reabertura é identificado', () => {
    const cycles = analyzeConversationSlaCycles({
      msgs: [
        { id: 1, direcao: 'out', origem: 'sistema_humano', criado_em: '2026-07-29T10:00:00Z', texto: 'Anterior' },
        { id: 2, direcao: 'in', criado_em: '2026-07-29T12:00:00Z', texto: 'Voltei' },
        { id: 3, direcao: 'out', origem: 'whatsapp_celular', criado_em: '2026-07-29T12:05:00Z', texto: 'Olá' },
      ],
      reopenAnchors: ['2026-07-29T11:59:00Z'],
      limiteMin: 30,
      metaOrigem: 'empresa',
      metaOrigemLabel: 'Empresa',
      schedule: scheduleCorrido,
      ctx: baseCtx,
      base: { conversa_id: 32 },
    })
    expect(cycles).toHaveLength(1)
    expect(cycles[0].tipo_sla).toBe('reabertura')
    expect(cycles[0].tempo_resposta_min).toBe(5)
  })

  test('reabertura descarta espera antiga não respondida e inicia um ciclo limpo', () => {
    const cycles = analyzeConversationSlaCycles({
      msgs: [
        { id: 1, direcao: 'in', criado_em: '2026-07-29T10:00:00Z', texto: 'Mensagem antiga' },
        { id: 2, direcao: 'in', criado_em: '2026-07-29T12:00:00Z', texto: 'Novo contato' },
        { id: 3, direcao: 'out', origem: 'sistema_humano', criado_em: '2026-07-29T12:04:00Z', texto: 'Olá' },
      ],
      reopenAnchors: ['2026-07-29T11:59:00Z'],
      limiteMin: 30,
      metaOrigem: 'empresa',
      metaOrigemLabel: 'Empresa',
      schedule: scheduleCorrido,
      ctx: baseCtx,
      base: { conversa_id: 33 },
    })
    expect(cycles).toHaveLength(1)
    expect(cycles[0].tipo_sla).toBe('reabertura')
    expect(cycles[0].primeira_mensagem_cliente_em).toBe('2026-07-29T12:00:00Z')
    expect(cycles[0].tempo_resposta_min).toBe(4)
  })

  test('mensagem próxima da meia-noite entra no dia de São Paulo', () => {
    expect(formatSaoPauloDateKey('2026-07-30T02:59:59Z')).toBe('2026-07-29')
    expect(formatSaoPauloDateKey('2026-07-30T03:00:00Z')).toBe('2026-07-30')
  })

  test('calcDiffMinutes usa tempo corrido sem horário comercial', () => {
    const min = calcDiffMinutes('2026-06-22T10:00:00Z', '2026-06-22T10:30:00Z', { enabled: false })
    expect(min).toBe(30)
  })

  test('separa média de todas as respostas da primeira resposta de cada cliente no período', () => {
    const summary = summarizeResponseCycleTimes([
      { conversa_id: 1, cliente_id: 101, primeira_mensagem_cliente_em: '2026-07-29T10:00:00Z', status_sla: 'cumpriu', tempo_resposta_min: 5 },
      { conversa_id: 1, cliente_id: 101, primeira_mensagem_cliente_em: '2026-07-29T11:00:00Z', status_sla: 'cumpriu', tempo_resposta_min: 15 },
      { conversa_id: 2, cliente_id: 102, primeira_mensagem_cliente_em: '2026-07-29T12:00:00Z', status_sla: 'cumpriu', tempo_resposta_min: 10 },
    ])
    expect(summary.tempo_medio_resposta_min).toBe(10)
    expect(summary.tempo_medio_primeira_resposta_min).toBe(7.5)
    expect(summary.firstResponded).toHaveLength(2)
  })
})
