/**
 * Testes unitários — regras de limites, janelas, fuso e simulação (Etapa 5).
 * Puros (sem mocks de banco/R2/UltraMSG).
 */

const {
  validarLimitesGlobais,
  validarJanelas,
  detectarSobreposicoes,
  proximoHorarioPermitido,
  estaNaJanela,
  simularDuracao,
  PERFIS,
  FUSO_PADRAO,
  DateTime,
  LIMITES_TECNICOS,
} = require('../helpers/disparoLimitesHelper')

describe('disparoLimitesHelper — validação global', () => {
  it('aceita perfil moderado padrão', () => {
    const r = validarLimitesGlobais({ ...PERFIS.moderado, perfil: 'moderado' })
    expect(r.ok).toBe(true)
    expect(r.cleaned.fuso_horario).toBe(FUSO_PADRAO)
  })

  it('rejeita intervalo mínimo > máximo', () => {
    const r = validarLimitesGlobais({
      ...PERFIS.moderado,
      intervalo_min_sec: 50,
      intervalo_max_sec: 10,
    })
    expect(r.ok).toBe(false)
    expect(r.erros.join(' ')).toMatch(/mínimo/i)
  })

  it('rejeita valores zero/negativos em limites', () => {
    const r = validarLimitesGlobais({
      ...PERFIS.moderado,
      limite_por_hora: 0,
      limite_por_dia: -1,
    })
    expect(r.ok).toBe(false)
  })

  it('rejeita intervalo abaixo do mínimo do provedor', () => {
    const r = validarLimitesGlobais({
      ...PERFIS.moderado,
      intervalo_min_sec: 1,
      intervalo_max_sec: 2,
    })
    expect(r.ok).toBe(false)
    expect(r.erros.join(' ')).toMatch(/provedor/i)
  })

  it('rejeita agendamento no passado', () => {
    const past = DateTime.utc().minus({ days: 1 }).toISO()
    const r = validarLimitesGlobais({
      ...PERFIS.moderado,
      inicio_modo: 'agendado',
      agendado_para: past,
    })
    expect(r.ok).toBe(false)
    expect(r.erros.join(' ')).toMatch(/passado/i)
  })

  it('aceita agendamento futuro em America/Sao_Paulo', () => {
    const future = DateTime.utc().plus({ days: 2 }).toISO()
    const r = validarLimitesGlobais({
      ...PERFIS.moderado,
      fuso_horario: 'America/Sao_Paulo',
      inicio_modo: 'agendado',
      agendado_para: future,
    })
    expect(r.ok).toBe(true)
    expect(r.cleaned.agendado_para).toBeTruthy()
  })

  it('rejeita fuso inválido', () => {
    const r = validarLimitesGlobais({ ...PERFIS.moderado, fuso_horario: 'Marte/Olympus' })
    expect(r.ok).toBe(false)
  })

  it('rejeita limite/hora acima do teto do provedor', () => {
    const r = validarLimitesGlobais({
      ...PERFIS.moderado,
      limite_por_hora: LIMITES_TECNICOS.LIMITE_HORA_PROVEDOR + 50,
      intervalo_min_sec: 5,
      intervalo_max_sec: 10,
    })
    expect(r.ok).toBe(false)
  })
})

describe('disparoLimitesHelper — janelas e sobreposição', () => {
  it('detecta horários sobrepostos no mesmo dia', () => {
    const erros = detectarSobreposicoes([
      { dia_semana: 1, hora_inicio: '08:00:00', hora_fim: '12:00:00', ativo: true },
      { dia_semana: 1, hora_inicio: '11:00:00', hora_fim: '14:00:00', ativo: true },
    ])
    expect(erros.length).toBeGreaterThan(0)
    expect(erros[0]).toMatch(/sobrepost/i)
  })

  it('permite múltiplas janelas sem sobreposição', () => {
    const r = validarJanelas([
      { dia_semana: 1, hora_inicio: '08:00', hora_fim: '12:00', ativo: true },
      { dia_semana: 1, hora_inicio: '13:30', hora_fim: '18:00', ativo: true },
      { dia_semana: 6, hora_inicio: '08:00', hora_fim: '12:00', ativo: true },
    ])
    expect(r.ok).toBe(true)
  })

  it('rejeita configuração sem nenhuma janela ativa', () => {
    const r = validarJanelas([
      { dia_semana: 0, hora_inicio: '08:00', hora_fim: '12:00', ativo: false },
    ])
    expect(r.ok).toBe(false)
  })

  it('estaNaJanela respeita fuso America/Sao_Paulo (segunda 10h)', () => {
    // 2026-08-24 é segunda-feira
    const dt = DateTime.fromObject(
      { year: 2026, month: 8, day: 24, hour: 10, minute: 0 },
      { zone: 'America/Sao_Paulo' },
    )
    const janelas = [
      { dia_semana: 1, hora_inicio: '08:00:00', hora_fim: '12:00:00', ativo: true },
    ]
    expect(estaNaJanela(dt, janelas)).toBe(true)
    expect(estaNaJanela(dt.set({ hour: 13 }), janelas)).toBe(false)
  })

  it('proximoHorarioPermitido aponta para próxima janela', () => {
    const dt = DateTime.fromObject(
      { year: 2026, month: 8, day: 24, hour: 19, minute: 0 },
      { zone: 'America/Sao_Paulo' },
    )
    const janelas = [
      { dia_semana: 1, hora_inicio: '08:00:00', hora_fim: '12:00:00', ativo: true },
      { dia_semana: 2, hora_inicio: '08:00:00', hora_fim: '12:00:00', ativo: true },
    ]
    const prox = proximoHorarioPermitido(dt, janelas)
    expect(prox).toBeTruthy()
    expect(prox.weekday).toBe(2) // terça
    expect(prox.hour).toBe(8)
  })
})

describe('disparoLimitesHelper — simulação', () => {
  const janelas = [
    { dia_semana: 1, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true },
    { dia_semana: 2, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true },
    { dia_semana: 3, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true },
    { dia_semana: 4, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true },
    { dia_semana: 5, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true },
  ]

  const globalCfg = {
    ...PERFIS.moderado,
    fuso_horario: 'America/Sao_Paulo',
    inicio_modo: 'imediato',
  }

  it('simula uma instância sem pular destinatários', () => {
    // Segunda 09:00 SP
    const agora = DateTime.fromObject(
      { year: 2026, month: 8, day: 24, hour: 9, minute: 0 },
      { zone: 'America/Sao_Paulo' },
    ).toUTC().toISO()

    const r = simularDuracao({
      destinatariosPorInstancia: [{ instancia_id: 1, nome: 'WA1', quantidade: 25 }],
      globalCfg,
      janelasGlobais: janelas,
      agoraIso: agora,
    })
    expect(r.ok).toBe(true)
    expect(r.instancias[0].quantidade_simulada).toBe(25)
    expect(r.instancias[0].lotes).toBe(2) // lote 20 → ceil(25/20)=2
    expect(r.resumo.total_destinatarios).toBe(25)
    expect(r.resumo.disclaimer).toMatch(/estimativa|sujeita/i)
  })

  it('simula várias instâncias independentemente', () => {
    const agora = DateTime.fromObject(
      { year: 2026, month: 8, day: 24, hour: 9, minute: 0 },
      { zone: 'America/Sao_Paulo' },
    ).toUTC().toISO()

    const r = simularDuracao({
      destinatariosPorInstancia: [
        { instancia_id: 1, nome: 'A', quantidade: 10 },
        { instancia_id: 2, nome: 'B', quantidade: 15 },
      ],
      globalCfg,
      janelasGlobais: janelas,
      agoraIso: agora,
    })
    expect(r.ok).toBe(true)
    expect(r.instancias).toHaveLength(2)
    expect(r.resumo.total_destinatarios).toBe(25)
  })

  it('aviso quando início está fora da janela', () => {
    const agora = DateTime.fromObject(
      { year: 2026, month: 8, day: 24, hour: 22, minute: 0 },
      { zone: 'America/Sao_Paulo' },
    ).toUTC().toISO()

    const r = simularDuracao({
      destinatariosPorInstancia: [{ instancia_id: 1, nome: 'A', quantidade: 5 }],
      globalCfg,
      janelasGlobais: janelas,
      agoraIso: agora,
    })
    expect(r.avisos.join(' ')).toMatch(/fora da janela|próximo horário/i)
  })

  it('documenta que retentativa conta no limite (regra futura)', () => {
    const { REGRA_RETENTATIVA } = require('../helpers/disparoLimitesHelper')
    expect(REGRA_RETENTATIVA.contabiliza_no_limite).toBe(true)
    expect(REGRA_RETENTATIVA.implementada).toBe(false)
  })
})
