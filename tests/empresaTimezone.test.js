/**
 * Fuso horário da empresa (Configurações → Geral → Estado).
 *
 * O par (estado, timezone) mora em `ia_config.config.chatbot_triage` — mesma fonte que
 * horário comercial, almoço, chatbot, SLA e alertas já leem. Os riscos cobertos aqui:
 *  - gravar uma zona inválida (quebraria todo Intl que depende dela);
 *  - escrever por cima do resto da `ia_config` (bot, roteamento, triagem);
 *  - gravar quando a leitura da config atual falhou.
 */

jest.mock('../config/supabase', () => ({
  from: jest.fn(),
}))

jest.mock('../services/chatbotTriageService', () => ({
  invalidateChatbotConfigCache: jest.fn(),
}))

const supabase = require('../config/supabase')
const { invalidateChatbotConfigCache } = require('../services/chatbotTriageService')
const {
  getEmpresaTimezone,
  setEmpresaTimezone,
  descreverFuso,
  fusoMudou,
} = require('../helpers/empresaTimezone')

/** Encadeamento de leitura: from('ia_config').select().eq().maybeSingle() */
function mockLeitura(result) {
  const chain = {}
  chain.select = jest.fn(() => chain)
  chain.eq = jest.fn(() => chain)
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  return chain
}

/** Captura o upsert para inspecionar o que seria gravado. */
function mockLeituraEEscrita(result, upsertResult = { error: null }) {
  const chain = mockLeitura(result)
  chain.upsert = jest.fn().mockResolvedValue(upsertResult)
  return chain
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('descreverFuso', () => {
  test('UF manda no fuso — Mato Grosso é Cuiabá, uma hora atrás de Brasília', () => {
    expect(descreverFuso('MT')).toEqual({
      estado: 'MT',
      estado_nome: 'Mato Grosso',
      timezone: 'America/Cuiaba',
      timezone_label: 'Horário de Cuiabá',
    })
  })

  test('sigla minúscula/com espaço é normalizada', () => {
    expect(descreverFuso(' mt ').estado).toBe('MT')
    expect(descreverFuso(' mt ').timezone).toBe('America/Cuiaba')
  })

  test('estado multi-fuso respeita a região escolhida', () => {
    expect(descreverFuso('AM', 'America/Eirunepe').timezone).toBe('America/Eirunepe')
    expect(descreverFuso('PA', 'America/Santarem').timezone).toBe('America/Santarem')
    expect(descreverFuso('PE', 'America/Noronha').timezone).toBe('America/Noronha')
  })

  test('zona que não pertence à UF é descartada em favor do padrão do estado', () => {
    expect(descreverFuso('MT', 'America/Noronha').timezone).toBe('America/Cuiaba')
  })

  test('sem estado e sem zona válida cai no Horário de Brasília', () => {
    expect(descreverFuso('', '')).toEqual({
      estado: '',
      estado_nome: '',
      timezone: 'America/Sao_Paulo',
      timezone_label: 'Horário de Brasília',
    })
    expect(descreverFuso('XX', 'Marte/Olympus').estado).toBe('')
    expect(descreverFuso('XX', 'Marte/Olympus').timezone).toBe('America/Sao_Paulo')
  })

  test('todas as 27 UFs resolvem para uma zona que o runtime conhece', () => {
    const ufs = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']
    expect(ufs).toHaveLength(27)
    for (const uf of ufs) {
      const { estado, timezone } = descreverFuso(uf)
      expect(estado).toBe(uf)
      expect(() => new Intl.DateTimeFormat('pt-BR', { timeZone: timezone })).not.toThrow()
    }
  })

  test('MT fica mesmo uma hora atrás de SP na mesma data', () => {
    const quando = new Date('2026-11-03T18:30:00Z')
    const hora = (tz) => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(quando)
    expect(hora(descreverFuso('SP').timezone)).toBe('15:30')
    expect(hora(descreverFuso('MT').timezone)).toBe('14:30')
  })
})

describe('fusoMudou', () => {
  test('mesmo par não é mudança (evita reescrever ia_config a cada save geral)', () => {
    const atual = descreverFuso('MT')
    expect(fusoMudou(atual, descreverFuso('MT'))).toBe(false)
    expect(fusoMudou(atual, descreverFuso('MS'))).toBe(true)
    expect(fusoMudou(descreverFuso('AM'), descreverFuso('AM', 'America/Eirunepe'))).toBe(true)
  })
})

describe('getEmpresaTimezone', () => {
  test('lê o par gravado em chatbot_triage', async () => {
    supabase.from.mockReturnValue(
      mockLeitura({ data: { config: { chatbot_triage: { estado: 'MT', timezone: 'America/Cuiaba' } } }, error: null })
    )
    await expect(getEmpresaTimezone(1)).resolves.toEqual({
      estado: 'MT',
      estado_nome: 'Mato Grosso',
      timezone: 'America/Cuiaba',
      timezone_label: 'Horário de Cuiabá',
    })
  })

  test('empresa sem config cai no padrão sem lançar', async () => {
    supabase.from.mockReturnValue(mockLeitura({ data: null, error: null }))
    await expect(getEmpresaTimezone(1)).resolves.toMatchObject({ estado: '', timezone: 'America/Sao_Paulo' })
  })

  test('erro de leitura não derruba o endpoint — devolve o padrão', async () => {
    supabase.from.mockReturnValue(mockLeitura({ data: null, error: { message: 'relation does not exist' } }))
    await expect(getEmpresaTimezone(1)).resolves.toMatchObject({ estado: '', timezone: 'America/Sao_Paulo' })
  })

  test('zona inválida já gravada é saneada na leitura', async () => {
    supabase.from.mockReturnValue(
      mockLeitura({ data: { config: { chatbot_triage: { estado: '', timezone: 'Marte/Olympus' } } }, error: null })
    )
    await expect(getEmpresaTimezone(1)).resolves.toMatchObject({ timezone: 'America/Sao_Paulo' })
  })
})

describe('setEmpresaTimezone', () => {
  test('preserva o resto da ia_config e do chatbot_triage', async () => {
    const chain = mockLeituraEEscrita({
      data: {
        config: {
          bot_global: { ativo: true },
          ia: { modelo: 'x' },
          chatbot_triage: { enabled: true, horarioInicio: '08:00', estado: '', timezone: 'America/Sao_Paulo' },
        },
      },
      error: null,
    })
    supabase.from.mockReturnValue(chain)

    const salvo = await setEmpresaTimezone(1, { estado: 'MT' })
    expect(salvo).toMatchObject({ estado: 'MT', timezone: 'America/Cuiaba' })

    const gravado = chain.upsert.mock.calls[0][0]
    expect(gravado.company_id).toBe(1)
    expect(gravado.config.bot_global).toEqual({ ativo: true })
    expect(gravado.config.ia).toEqual({ modelo: 'x' })
    expect(gravado.config.chatbot_triage).toEqual({
      enabled: true,
      horarioInicio: '08:00',
      estado: 'MT',
      timezone: 'America/Cuiaba',
    })
    expect(invalidateChatbotConfigCache).toHaveBeenCalledWith(1)
  })

  test('nunca grava zona inválida', async () => {
    const chain = mockLeituraEEscrita({ data: { config: {} }, error: null })
    supabase.from.mockReturnValue(chain)

    await setEmpresaTimezone(1, { estado: 'XX', timezone: 'Marte/Olympus' })
    expect(chain.upsert.mock.calls[0][0].config.chatbot_triage).toEqual({
      estado: '',
      timezone: 'America/Sao_Paulo',
    })
  })

  test('leitura falhou: não grava nada (senão apagaria a config inteira)', async () => {
    const chain = mockLeituraEEscrita({ data: null, error: { message: 'timeout' } })
    supabase.from.mockReturnValue(chain)

    await expect(setEmpresaTimezone(1, { estado: 'MT' })).rejects.toThrow(/configuração atual/i)
    expect(chain.upsert).not.toHaveBeenCalled()
    expect(invalidateChatbotConfigCache).not.toHaveBeenCalled()
  })

  test('falha de escrita vira erro (não finge que salvou)', async () => {
    const chain = mockLeituraEEscrita({ data: { config: {} }, error: null }, { error: { message: 'permission denied' } })
    supabase.from.mockReturnValue(chain)

    await expect(setEmpresaTimezone(1, { estado: 'MT' })).rejects.toThrow(/permission denied/)
    expect(invalidateChatbotConfigCache).not.toHaveBeenCalled()
  })
})
