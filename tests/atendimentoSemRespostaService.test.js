const mockSendText = jest.fn()
let mockFrom = jest.fn(() => {
  throw new Error('Supabase nao deveria ser chamado neste teste')
})

jest.mock('../config/supabase', () => ({
  from: (...args) => mockFrom(...args),
}))

jest.mock('../services/providers', () => ({
  getProvider: jest.fn(() => ({ sendText: mockSendText })),
}))

function createServiceSupabaseMock({
  config,
  conversations = [],
  lastMessage = null,
  attendant = { id: 20, nome: 'Atendente Teste' },
  managers = [{ id: 99, perfil: 'admin' }],
  duplicateEventTypes = [],
}) {
  const calls = []

  function resultFor(table, op) {
    if (table === 'ia_config') return { data: { config: { alerta_sem_resposta: config } }, error: null }
    if (table === 'conversas' && op === 'select') return { data: conversations, error: null }
    if (table === 'mensagens') return { data: lastMessage, error: null }
    if (table === 'usuarios') return { data: managers, error: null }
    return { data: null, error: null }
  }

  function singleResultFor(table, op) {
    if (table === 'ia_config') return { data: { config: { alerta_sem_resposta: config } }, error: null }
    if (table === 'mensagens') return { data: lastMessage, error: null }
    if (table === 'usuarios') return { data: attendant, error: null }
    if (table === 'tags') return { data: null, error: null }
    if (table === 'conversa_tags') return { data: null, error: null }
    return resultFor(table, op)
  }

  function builder(table) {
    let op = 'select'
    let updateSelect = false
    const api = {
      select: jest.fn(() => {
        if (op === 'update') updateSelect = true
        else op = 'select'
        return api
      }),
      eq: jest.fn(() => api),
      in: jest.fn(() => api),
      not: jest.fn(() => api),
      or: jest.fn(() => api),
      order: jest.fn(() => api),
      limit: jest.fn(() => api),
      is: jest.fn(() => api),
      maybeSingle: jest.fn(async () => {
        if (table === 'conversas' && updateSelect) {
          return { data: { id: conversations[0]?.id || 123 }, error: null }
        }
        return singleResultFor(table, op)
      }),
      insert: jest.fn((payload) => {
        calls.push({ table, op: 'insert', payload })
        const insertApi = {
          select: jest.fn(() => insertApi),
          single: jest.fn(async () => {
            if (table === 'alerta_sem_resposta_eventos' && duplicateEventTypes.includes(payload?.tipo)) {
              return { error: { code: '23505', message: 'duplicate key' }, data: null }
            }
            if (table === 'tags') return { error: null, data: { id: 777 } }
            return { error: null, data: null }
          }),
        }
        if (table === 'alerta_sem_resposta_eventos' && duplicateEventTypes.includes(payload?.tipo)) {
          return { error: { code: '23505', message: 'duplicate key' } }
        }
        return insertApi
      }),
      update: jest.fn((payload) => {
        op = 'update'
        updateSelect = false
        calls.push({ table, op: 'update', payload })
        return api
      }),
      upsert: jest.fn((payload) => {
        calls.push({ table, op: 'upsert', payload })
        return { error: null, data: null }
      }),
      then: (resolve, reject) => Promise.resolve(resultFor(table, op)).then(resolve, reject),
    }
    return api
  }

  mockFrom = jest.fn((table) => builder(table))
  return { calls }
}

describe('atendimentoSemRespostaService', () => {
  afterEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    mockSendText.mockReset()
    mockFrom = jest.fn(() => {
      throw new Error('Supabase nao deveria ser chamado neste teste')
    })
  })

  test('normaliza configuracao com defaults seguros', () => {
    const { normalizeAlertaSemRespostaConfig } = require('../services/atendimentoSemRespostaService')

    const cfg = normalizeAlertaSemRespostaConfig({
      ativo: 'true',
      tempo_primeiro_alerta_minutos: '0',
      tempo_alerta_critico_minutos: '1',
      tempo_notificar_gestor_minutos: '1',
      notificar_interno: undefined,
      responsaveis_notificacao_ids: ['2', 2, 'abc', 3],
      gestor_notificado_id: '4',
      nome_tag_automatica: '',
    })

    expect(cfg.alerta_sem_resposta_ativo).toBe(true)
    expect(cfg.tempo_primeiro_alerta_minutos).toBe(1)
    expect(cfg.tempo_alerta_critico_minutos).toBeGreaterThan(cfg.tempo_primeiro_alerta_minutos)
    expect(cfg.tempo_notificar_gestor_minutos).toBeGreaterThan(cfg.tempo_alerta_critico_minutos)
    expect(cfg.notificar_interno).toBe(true)
    expect(cfg.responsaveis_notificacao_ids).toEqual([4, 2, 3])
    expect(cfg.nome_tag_automatica).toBe('Reaberta por falta de resposta')
  })

  test('mantem recurso desligado por padrao', () => {
    const { normalizeAlertaSemRespostaConfig } = require('../services/atendimentoSemRespostaService')

    const cfg = normalizeAlertaSemRespostaConfig({})

    expect(cfg.alerta_sem_resposta_ativo).toBe(false)
    expect(cfg.reabrir_conversa_automaticamente).toBe(true)
    expect(cfg.aplicar_tag_automatica).toBe(true)
  })

  test('recusa e-mail enquanto nao houver provedor configurado', () => {
    const { validateAlertaSemRespostaConfigInput } = require('../services/atendimentoSemRespostaService')

    expect(() => validateAlertaSemRespostaConfigInput({
      alerta_sem_resposta_ativo: true,
      tempo_primeiro_alerta_minutos: 2,
      tempo_alerta_critico_minutos: 10,
      tempo_notificar_gestor_minutos: 15,
      notificar_por_email: true,
      notificar_interno: true,
    })).toThrow('e-mail')
  })

  test('exige ao menos um canal disponivel', () => {
    const { validateAlertaSemRespostaConfigInput } = require('../services/atendimentoSemRespostaService')

    expect(() => validateAlertaSemRespostaConfigInput({
      tempo_primeiro_alerta_minutos: 2,
      tempo_alerta_critico_minutos: 10,
      tempo_notificar_gestor_minutos: 15,
      notificar_por_whatsapp: false,
      notificar_interno: false,
    })).toThrow('canal')
  })

  test('texto do gestor respeita reabertura automatica desligada', () => {
    const { buildManagerMessage, normalizeAlertaSemRespostaConfig } = require('../services/atendimentoSemRespostaService')
    const cfg = normalizeAlertaSemRespostaConfig({ reabrir_conversa_automaticamente: false })

    const texto = buildManagerMessage({
      company_id: 1,
      conv: { id: 10, nome_contato_cache: 'Cliente Teste' },
      cfg,
      minutos: 15,
      clienteNome: 'Cliente Teste',
      atendenteNome: 'Atendente Teste',
    })

    expect(texto).toContain('conversa permanece com o atendente')
    expect(texto).not.toContain('foi liberada')
  })

  test('texto do gestor inclui empresa e link quando APP_URL esta configurado', () => {
    const prevAppUrl = process.env.APP_URL
    process.env.APP_URL = 'https://app.zaperp.test'
    const { buildManagerMessage, normalizeAlertaSemRespostaConfig } = require('../services/atendimentoSemRespostaService')
    const cfg = normalizeAlertaSemRespostaConfig({ reabrir_conversa_automaticamente: true })

    const texto = buildManagerMessage({
      company_id: 7,
      conv: { id: 321, nome_contato_cache: 'Cliente Link' },
      cfg,
      minutos: 4,
      clienteNome: 'Cliente Link',
      atendenteNome: 'Atendente Link',
    })

    expect(texto).toContain('Empresa: 7')
    expect(texto).toContain('Abrir conversa: https://app.zaperp.test/atendimento?conversa=321')
    if (prevAppUrl == null) delete process.env.APP_URL
    else process.env.APP_URL = prevAppUrl
  })

  test('alerta desativado nao consulta conversas nem envia WhatsApp', async () => {
    createServiceSupabaseMock({
      config: { alerta_sem_resposta_ativo: false, notificar_interno: true },
    })
    const { processCompanyAlertaSemResposta } = require('../services/atendimentoSemRespostaService')

    const result = await processCompanyAlertaSemResposta({ company_id: 1 })

    expect(result.ativo).toBe(false)
    expect(mockFrom).not.toHaveBeenCalledWith('conversas')
    expect(mockSendText).not.toHaveBeenCalled()
  })

  test('evento duplicado de gestor bloqueia envio WhatsApp externo', async () => {
    const now = Date.now()
    const { calls } = createServiceSupabaseMock({
      config: {
        alerta_sem_resposta_ativo: true,
        tempo_primeiro_alerta_minutos: 2,
        tempo_alerta_critico_minutos: 10,
        tempo_notificar_gestor_minutos: 15,
        notificar_por_whatsapp: true,
        notificar_interno: true,
        telefone_gestor: '5511999999999',
        gestor_notificado_id: 99,
        responsaveis_notificacao_ids: [99],
        aplicar_tag_automatica: false,
        reabrir_conversa_automaticamente: false,
      },
      conversations: [{
        id: 123,
        company_id: 1,
        telefone: '5511888888888',
        tipo: 'privado',
        status_atendimento: 'em_atendimento',
        atendente_id: 20,
        ultima_mensagem_cliente_em: new Date(now - 20 * 60000).toISOString(),
        primeiro_alerta_enviado_em: new Date(now - 18 * 60000).toISOString(),
        alerta_critico_enviado_em: new Date(now - 10 * 60000).toISOString(),
        gestor_notificado_em: null,
        nome_contato_cache: 'Cliente Teste',
      }],
      lastMessage: {
        id: 500,
        direcao: 'in',
        criado_em: new Date(now - 20 * 60000).toISOString(),
        texto: 'Oi',
      },
      duplicateEventTypes: ['gestor_notificado'],
    })
    const { processCompanyAlertaSemResposta } = require('../services/atendimentoSemRespostaService')

    const result = await processCompanyAlertaSemResposta({ company_id: 1 })

    expect(result.ok).toBe(true)
    expect(mockSendText).not.toHaveBeenCalled()
    expect(calls.some((c) => c.table === 'alerta_sem_resposta_eventos' && c.payload?.tipo === 'gestor_notificado')).toBe(true)
  })

  test('mensagem outbound do bot nao reseta o SLA nem dispara alertas', async () => {
    const now = Date.now()
    createServiceSupabaseMock({
      config: {
        alerta_sem_resposta_ativo: true,
        tempo_primeiro_alerta_minutos: 1,
        tempo_alerta_critico_minutos: 2,
        tempo_notificar_gestor_minutos: 3,
        notificar_interno: true,
        aplicar_tag_automatica: false,
        reabrir_conversa_automaticamente: false,
      },
      conversations: [{
        id: 123,
        company_id: 1,
        telefone: '5511888888888',
        tipo: 'privado',
        status_atendimento: 'em_atendimento',
        atendente_id: 20,
        ultima_mensagem_cliente_em: new Date(now - 5 * 60000).toISOString(),
        primeiro_alerta_enviado_em: null,
        alerta_critico_enviado_em: null,
        gestor_notificado_em: null,
        nome_contato_cache: 'Cliente Teste',
      }],
      lastMessage: {
        id: 501,
        direcao: 'out',
        autor_usuario_id: null,
        criado_em: new Date(now - 1 * 60000).toISOString(),
        texto: 'Resposta automatica do bot',
      },
    })
    const { processCompanyAlertaSemResposta } = require('../services/atendimentoSemRespostaService')

    const result = await processCompanyAlertaSemResposta({ company_id: 1 })
    const detail = result.detalhes.find((d) => d.conversa_id === 123)

    expect(detail?.action).toBe('skip_last_not_human')
    expect(mockSendText).not.toHaveBeenCalled()
  })

  test('escalonamento completo usa mensagens e acoes esperadas', async () => {
    const now = Date.now()
    const { calls } = createServiceSupabaseMock({
      config: {
        alerta_sem_resposta_ativo: true,
        tempo_primeiro_alerta_minutos: 1,
        tempo_alerta_critico_minutos: 2,
        tempo_notificar_gestor_minutos: 3,
        notificar_por_whatsapp: true,
        notificar_interno: true,
        telefone_gestor: '5511999999999',
        gestor_notificado_id: 99,
        responsaveis_notificacao_ids: [99],
        aplicar_tag_automatica: true,
        nome_tag_automatica: 'Reaberta por falta de resposta',
        reabrir_conversa_automaticamente: true,
      },
      conversations: [{
        id: 123,
        company_id: 1,
        telefone: '5511888888888',
        tipo: 'privado',
        status_atendimento: 'em_atendimento',
        atendente_id: 20,
        ultima_mensagem_cliente_em: new Date(now - 5 * 60000).toISOString(),
        primeiro_alerta_enviado_em: null,
        alerta_critico_enviado_em: null,
        gestor_notificado_em: null,
        tag_aplicada_por_sla: false,
        conversa_reaberta_por_sla_em: null,
        nome_contato_cache: 'Cliente Teste',
      }],
      lastMessage: {
        id: 500,
        direcao: 'in',
        criado_em: new Date(now - 5 * 60000).toISOString(),
        texto: 'Oi',
      },
      managers: [{ id: 99, perfil: 'admin' }],
    })
    const { processCompanyAlertaSemResposta, EVENT_TYPES } = require('../services/atendimentoSemRespostaService')

    const result = await processCompanyAlertaSemResposta({ company_id: 1 })
    const detail = result.detalhes.find((d) => d.conversa_id === 123)
    const eventos = calls.filter((c) => c.table === 'alerta_sem_resposta_eventos').map((c) => c.payload)

    expect(detail?.action).toBe('processed')
    expect(detail?.actions).toEqual(expect.arrayContaining([
      EVENT_TYPES.FIRST,
      EVENT_TYPES.CRITICAL,
      EVENT_TYPES.MANAGER,
      EVENT_TYPES.TAG,
      EVENT_TYPES.REOPEN,
    ]))
    expect(eventos.find((e) => e.tipo === EVENT_TYPES.FIRST)?.mensagem).toContain('⚠️ Atencao:')
    expect(eventos.find((e) => e.tipo === EVENT_TYPES.CRITICAL)?.mensagem).toContain('🚨 Alerta critico:')
    expect(eventos.find((e) => e.tipo === EVENT_TYPES.MANAGER)?.mensagem).toContain('🚨 Atendimento sem resposta no ZapERP')
    expect(mockSendText).toHaveBeenCalledTimes(1)
  })

  test('falha de WhatsApp gera evento e historico sem quebrar cron', async () => {
    const now = Date.now()
    const { calls } = createServiceSupabaseMock({
      config: {
        alerta_sem_resposta_ativo: true,
        tempo_primeiro_alerta_minutos: 2,
        tempo_alerta_critico_minutos: 10,
        tempo_notificar_gestor_minutos: 15,
        notificar_por_whatsapp: true,
        notificar_interno: true,
        telefone_gestor: '5511999999999',
        gestor_notificado_id: 99,
        responsaveis_notificacao_ids: [99],
        aplicar_tag_automatica: false,
        reabrir_conversa_automaticamente: false,
      },
      conversations: [{
        id: 123,
        company_id: 1,
        telefone: '5511888888888',
        tipo: 'privado',
        status_atendimento: 'em_atendimento',
        atendente_id: 20,
        ultima_mensagem_cliente_em: new Date(now - 20 * 60000).toISOString(),
        primeiro_alerta_enviado_em: new Date(now - 18 * 60000).toISOString(),
        alerta_critico_enviado_em: new Date(now - 10 * 60000).toISOString(),
        gestor_notificado_em: null,
        nome_contato_cache: 'Cliente Teste',
      }],
      lastMessage: {
        id: 500,
        direcao: 'in',
        criado_em: new Date(now - 20 * 60000).toISOString(),
        texto: 'Oi',
      },
    })
    mockSendText.mockRejectedValueOnce(new Error('UltraMSG indisponivel'))
    const { processCompanyAlertaSemResposta, EVENT_TYPES } = require('../services/atendimentoSemRespostaService')

    const result = await processCompanyAlertaSemResposta({ company_id: 1 })

    expect(result.ok).toBe(true)
    expect(mockSendText).toHaveBeenCalledTimes(1)
    expect(calls.some((c) => c.table === 'alerta_sem_resposta_eventos' && c.payload?.tipo === EVENT_TYPES.WHATSAPP_FAILED)).toBe(true)
    expect(calls.some((c) => c.table === 'historico_atendimentos' && c.payload?.acao === EVENT_TYPES.WHATSAPP_FAILED)).toBe(true)
  })

  test('retorno ok false do provider WhatsApp gera evento de falha', async () => {
    const now = Date.now()
    const { calls } = createServiceSupabaseMock({
      config: {
        alerta_sem_resposta_ativo: true,
        tempo_primeiro_alerta_minutos: 2,
        tempo_alerta_critico_minutos: 10,
        tempo_notificar_gestor_minutos: 15,
        notificar_por_whatsapp: true,
        notificar_interno: true,
        telefone_gestor: '5511999999999',
        gestor_notificado_id: 99,
        responsaveis_notificacao_ids: [99],
        aplicar_tag_automatica: false,
        reabrir_conversa_automaticamente: false,
      },
      conversations: [{
        id: 123,
        company_id: 1,
        telefone: '5511888888888',
        tipo: 'privado',
        status_atendimento: 'em_atendimento',
        atendente_id: 20,
        ultima_mensagem_cliente_em: new Date(now - 20 * 60000).toISOString(),
        primeiro_alerta_enviado_em: new Date(now - 18 * 60000).toISOString(),
        alerta_critico_enviado_em: new Date(now - 10 * 60000).toISOString(),
        gestor_notificado_em: null,
        nome_contato_cache: 'Cliente Teste',
      }],
      lastMessage: {
        id: 500,
        direcao: 'in',
        criado_em: new Date(now - 20 * 60000).toISOString(),
        texto: 'Oi',
      },
    })
    mockSendText.mockResolvedValueOnce({ ok: false, error: 'token invalido' })
    const { processCompanyAlertaSemResposta, EVENT_TYPES } = require('../services/atendimentoSemRespostaService')

    await processCompanyAlertaSemResposta({ company_id: 1 })

    expect(calls.some((c) => c.table === 'alerta_sem_resposta_eventos' && c.payload?.tipo === EVENT_TYPES.WHATSAPP_FAILED && String(c.payload?.mensagem || '').includes('token invalido'))).toBe(true)
  })
})
