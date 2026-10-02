/**
 * Fuso horário por estado (UF) — mapeamento + horário de atendimento local por empresa.
 *
 * Garante que empresas em fusos diferentes (MG, MT, AC, AM, DF) avaliem início/fim,
 * almoço, dias sem atendimento e feriados no HORÁRIO LOCAL delas — independente do
 * fuso do servidor. Cobre bordas: abertura, fechamento, meia-noite, virada de dia,
 * sábado/domingo, feriado e pausa de almoço.
 */
const tz = require('../helpers/brazilTimezones')
const {
  isWithinBusinessHours,
  isOutsideBusinessDays,
  isWithinLunchBreak,
  validateChatbotConfig,
} = require('../services/chatbotTriageService')

// Um instante UTC fixo. Cada UF o "vê" na sua hora local.
const at = (iso) => new Date(iso)

describe('mapeamento UF → timezone', () => {
  test.each([
    ['MG', 'America/Sao_Paulo'],
    ['SP', 'America/Sao_Paulo'],
    ['RJ', 'America/Sao_Paulo'],
    ['DF', 'America/Sao_Paulo'],
    ['MT', 'America/Cuiaba'],
    ['MS', 'America/Campo_Grande'],
    ['AC', 'America/Rio_Branco'],
    ['RO', 'America/Porto_Velho'],
    ['RR', 'America/Boa_Vista'],
    ['AM', 'America/Manaus'],
    ['PA', 'America/Belem'],
    ['PE', 'America/Recife'],
    ['BA', 'America/Bahia'],
    ['CE', 'America/Fortaleza'],
    ['TO', 'America/Araguaina'],
    ['AL', 'America/Maceio'],
  ])('%s → %s (padrão)', (uf, esperado) => {
    expect(tz.defaultTimezoneForUf(uf)).toBe(esperado)
  })

  test('todas as 27 UFs mapeadas para zonas IANA válidas', () => {
    const ufs = Object.keys(tz.BR_UF_TIMEZONES)
    expect(ufs).toHaveLength(27)
    for (const uf of ufs) {
      for (const z of tz.BR_UF_TIMEZONES[uf].zones) {
        expect(tz.isValidTimezone(z.tz)).toBe(true)
      }
    }
  })

  test('estados multi-fuso expõem opções (AM, PA, PE)', () => {
    expect(tz.zonesForUf('AM')).toEqual(expect.arrayContaining(['America/Manaus', 'America/Eirunepe']))
    expect(tz.zonesForUf('PA')).toEqual(expect.arrayContaining(['America/Belem', 'America/Santarem']))
    expect(tz.zonesForUf('PE')).toEqual(expect.arrayContaining(['America/Recife', 'America/Noronha']))
  })

  test('resolveTimezoneForUf: UF manda, respeitando escolha multi-fuso', () => {
    expect(tz.resolveTimezoneForUf('MT', 'America/Sao_Paulo')).toBe('America/Cuiaba') // tz stale ignorado
    expect(tz.resolveTimezoneForUf('AM', 'America/Eirunepe')).toBe('America/Eirunepe') // escolha válida respeitada
    expect(tz.resolveTimezoneForUf('AM', 'America/Cuiaba')).toBe('America/Manaus') // fora da UF → padrão
    expect(tz.resolveTimezoneForUf('', 'America/Cuiaba')).toBe('America/Cuiaba') // sem UF → tz válido
    expect(tz.resolveTimezoneForUf('', 'zona/invalida')).toBe('America/Sao_Paulo') // fallback
  })

  test('validateChatbotConfig deriva timezone da UF e nunca grava zona inválida', () => {
    expect(validateChatbotConfig({ estado: 'MT' }).timezone).toBe('America/Cuiaba')
    expect(validateChatbotConfig({ estado: 'mt' }).estado).toBe('MT')
    expect(validateChatbotConfig({ estado: 'XX', timezone: 'zona/invalida' }).timezone).toBe('America/Sao_Paulo')
    expect(validateChatbotConfig({ estado: 'AM', timezone: 'America/Eirunepe' }).timezone).toBe('America/Eirunepe')
    expect(validateChatbotConfig({}).timezone).toBe('America/Sao_Paulo')
  })
})

describe('horário local por empresa (mesmo instante UTC, fusos diferentes)', () => {
  // 2026-10-02 (sexta) 11:30 UTC = 08:30 MG(-3) / 07:30 MT(-4) / 06:30 AC(-5)
  const horario = { inicio: '08:30', fim: '17:30' }
  const dentro = (uf, instante) =>
    isWithinBusinessHours(horario.inicio, horario.fim, at(instante), tz.defaultTimezoneForUf(uf))

  test('11:30 UTC: MG já abriu (08:30), MT ainda não (07:30), AC ainda não (06:30)', () => {
    expect(dentro('MG', '2026-10-02T11:30:00Z')).toBe(true)
    expect(dentro('MT', '2026-10-02T11:30:00Z')).toBe(false)
    expect(dentro('AC', '2026-10-02T11:30:00Z')).toBe(false)
  })

  test('12:30 UTC: MT abre exatamente às 08:30 locais', () => {
    // 12:30 UTC = 08:30 em Cuiabá (-4)
    expect(dentro('MT', '2026-10-02T12:30:00Z')).toBe(true)
    // Mesma hora UTC: MG já são 09:30 (dentro), AC 07:30 (fora)
    expect(dentro('MG', '2026-10-02T12:30:00Z')).toBe(true)
    expect(dentro('AC', '2026-10-02T12:30:00Z')).toBe(false)
  })

  test('fechamento: MT às 17:30 locais (21:30 UTC) ainda dentro; 17:31 fora', () => {
    expect(dentro('MT', '2026-10-02T21:30:00Z')).toBe(true) // 17:30 em Cuiabá
    expect(dentro('MT', '2026-10-02T21:31:00Z')).toBe(false) // 17:31 em Cuiabá
  })

  test('Amazonas (Manaus, -4) abre às 08:30 locais = 12:30 UTC', () => {
    expect(dentro('AM', '2026-10-02T12:30:00Z')).toBe(true)
    expect(dentro('AM', '2026-10-02T11:30:00Z')).toBe(false) // 07:30 local
  })

  test('DF (Brasília, -3) igual a MG', () => {
    expect(dentro('DF', '2026-10-02T11:30:00Z')).toBe(true)
  })
})

describe('virada de dia / meia-noite por fuso', () => {
  // 2026-10-03 02:30 UTC: em MG já é sábado 23:30 do dia 02? Não: -3 → 23:30 dia 02 (sexta→ sábado?).
  // 2026-10-03T02:30Z = 23:30 BRT do dia 02 (sexta). Em Cuiabá (-4) = 22:30 dia 02. Em Rio Branco (-5)=21:30 dia 02.
  test('sábado desativado é avaliado na data local', () => {
    const diasOff = [0, 6] // dom e sáb
    // 2026-10-03T06:00Z: MG(-3)=03:00 sáb (dia 03) → fora (sábado). AC(-5)=01:00 sáb também.
    expect(isOutsideBusinessDays(diasOff, [], at('2026-10-03T06:00:00Z'), 'America/Sao_Paulo')).toBe(true)
    // 2026-10-03T02:30Z: MG(-3)=23:30 sexta (dia 02) → NÃO é sábado ainda.
    expect(isOutsideBusinessDays(diasOff, [], at('2026-10-03T02:30:00Z'), 'America/Sao_Paulo')).toBe(false)
    // Mesmo instante em Rio Branco (-5) = 21:30 sexta (dia 02) → também sexta.
    expect(isOutsideBusinessDays(diasOff, [], at('2026-10-03T02:30:00Z'), 'America/Rio_Branco')).toBe(false)
  })

  test('feriado (data específica) respeita a data local do fuso', () => {
    const feriados = ['2026-10-02']
    // 2026-10-03T02:00Z = 23:00 dia 02 em MG → ainda é o feriado localmente.
    expect(isOutsideBusinessDays([], feriados, at('2026-10-03T02:00:00Z'), 'America/Sao_Paulo')).toBe(true)
    // Em Cuiabá (-4) = 22:00 dia 02 → ainda feriado.
    expect(isOutsideBusinessDays([], feriados, at('2026-10-03T02:00:00Z'), 'America/Cuiaba')).toBe(true)
    // 2026-10-03T04:00Z = 01:00 dia 03 em MG → já passou o feriado.
    expect(isOutsideBusinessDays([], feriados, at('2026-10-03T04:00:00Z'), 'America/Sao_Paulo')).toBe(false)
  })
})

describe('pausa de almoço por fuso', () => {
  // 15:30 UTC = 12:30 MG(-3) / 11:30 MT(-4) / 10:30 AC(-5)
  test('12:00–14:00 locais: MG no almoço às 15:30 UTC; MT ainda não', () => {
    expect(isWithinLunchBreak('12:00', '14:00', at('2026-10-02T15:30:00Z'), 'America/Sao_Paulo')).toBe(true)
    expect(isWithinLunchBreak('12:00', '14:00', at('2026-10-02T15:30:00Z'), 'America/Cuiaba')).toBe(false)
  })
  test('MT entra no almoço às 12:00 locais = 16:00 UTC', () => {
    expect(isWithinLunchBreak('12:00', '14:00', at('2026-10-02T16:00:00Z'), 'America/Cuiaba')).toBe(true)
  })
})
