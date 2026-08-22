/**
 * Testes unitários — limites em tempo de execução (Etapa 7).
 * Puros: podeEnviarAgora sem banco.
 */

const { DateTime, PERFIS } = require('../helpers/disparoLimitesHelper')
const { podeEnviarAgora, contarEnviosJanela } = require('../services/disparoLimitesRuntime')

const limitesBase = {
  ...PERFIS.moderado,
  fuso_horario: 'America/Sao_Paulo',
  perfil: 'moderado',
}

/** Segunda-feira 10:00 em SP (dentro de janela comercial típica) */
const SEGUNDA_10H_SP = '2026-08-24T13:00:00.000Z' // 10:00 BRT (UTC-3)

const janelaSegunda = [
  { dia_semana: 1, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
]

describe('disparoLimitesRuntime — janela de horário', () => {
  it('fora da janela → adiar com proxima_tentativa_em', () => {
    // Domingo 10:00 SP — fora da janela de segunda
    const domingo = '2026-08-23T13:00:00.000Z'
    const gate = podeEnviarAgora({
      limites: limitesBase,
      janelas: janelaSegunda,
      instanciaId: 5,
      agoraIso: domingo,
      enviadosUltimaHora: 0,
      enviadosHoje: 0,
    })

    expect(gate.ok).toBe(false)
    expect(gate.tipo_espera).toBe('horario')
    expect(gate.motivo).toMatch(/janela/i)
    expect(gate.proxima_tentativa_em).toBeTruthy()
  })

  it('dentro da janela → ok (sem limites atingidos)', () => {
    const gate = podeEnviarAgora({
      limites: limitesBase,
      janelas: janelaSegunda,
      instanciaId: 5,
      agoraIso: SEGUNDA_10H_SP,
      enviadosUltimaHora: 0,
      enviadosHoje: 0,
    })

    expect(gate.ok).toBe(true)
    expect(gate.proxima_tentativa_em).toBeNull()
  })

  it('sem limites configurados → bloqueia', () => {
    const gate = podeEnviarAgora({
      limites: null,
      janelas: [],
      instanciaId: 5,
    })
    expect(gate.ok).toBe(false)
    expect(gate.motivo).toMatch(/não configurados/i)
  })
})

describe('disparoLimitesRuntime — limites hora/dia', () => {
  it('limite diário atingido → adiar até próximo dia', () => {
    const gate = podeEnviarAgora({
      limites: { ...limitesBase, limite_por_dia: 100 },
      janelas: janelaSegunda,
      instanciaId: 5,
      agoraIso: SEGUNDA_10H_SP,
      enviadosUltimaHora: 0,
      enviadosHoje: 100,
    })

    expect(gate.ok).toBe(false)
    expect(gate.tipo_espera).toBe('limite')
    expect(gate.motivo).toMatch(/diário/i)
    expect(gate.proxima_tentativa_em).toBeTruthy()
  })

  it('limite por hora atingido → adiar', () => {
    const gate = podeEnviarAgora({
      limites: { ...limitesBase, limite_por_hora: 10 },
      janelas: janelaSegunda,
      instanciaId: 5,
      agoraIso: SEGUNDA_10H_SP,
      enviadosUltimaHora: 10,
      enviadosHoje: 10,
      ultimoEnvioIso: SEGUNDA_10H_SP,
    })

    expect(gate.ok).toBe(false)
    expect(gate.tipo_espera).toBe('limite')
    expect(gate.motivo).toMatch(/hora/i)
    expect(gate.proxima_tentativa_em).toBeTruthy()
  })

  it('intervalo mínimo entre envios bloqueia envio imediato', () => {
    const ultimoEnvio = DateTime.fromISO(SEGUNDA_10H_SP, { zone: 'utc' }).minus({ seconds: 2 }).toISO()

    const gate = podeEnviarAgora({
      limites: { ...limitesBase, intervalo_min_sec: 8 },
      janelas: janelaSegunda,
      instanciaId: 5,
      agoraIso: SEGUNDA_10H_SP,
      ultimoEnvioIso: ultimoEnvio,
      enviadosUltimaHora: 1,
      enviadosHoje: 1,
    })

    expect(gate.ok).toBe(false)
    expect(gate.motivo).toMatch(/intervalo/i)
    expect(gate.proxima_tentativa_em).toBeTruthy()
  })
})

describe('disparoLimitesRuntime — contarEnviosJanela', () => {
  function mockSupabaseCount(count) {
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
    }
    chain.then = (resolve) => Promise.resolve({ count, error: null }).then(resolve)
    return { from: jest.fn(() => chain) }
  }

  it('retorna 0 com parâmetros ausentes', async () => {
    expect(await contarEnviosJanela(null, {})).toBe(0)
    expect(await contarEnviosJanela({}, { companyId: 10 })).toBe(0)
  })

  it('conta envios na janela via supabase mock', async () => {
    const sb = mockSupabaseCount(7)
    const count = await contarEnviosJanela(sb, {
      companyId: 10,
      instanciaId: 5,
      desdeIso: '2026-08-24T12:00:00.000Z',
    })
    expect(count).toBe(7)
    expect(sb.from).toHaveBeenCalledWith('disparo_fila_itens')
  })
})
