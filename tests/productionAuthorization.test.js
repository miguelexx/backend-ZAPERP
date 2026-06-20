const request = require('supertest')
const jwt = require('jsonwebtoken')

const supabase = require('../config/supabase')

let app

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret'
  app = require('../app')
})

function token(payload = {}) {
  return jwt.sign({ id: 2, company_id: 1, perfil: 'atendente', ...payload }, process.env.JWT_SECRET)
}

describe('Autorizacoes criticas de producao', () => {
  it('bloqueia atendente ao apagar todos os clientes', async () => {
    const res = await request(app)
      .delete('/api/clientes/todos')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)

    expect(res.status).toBe(403)
  })

  it('bloqueia atendente ao limpar mensagens de uma conversa', async () => {
    const res = await request(app)
      .post('/api/chats/10/limpar-mensagens')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)

    expect(res.status).toBe(403)
  })

  it('bloqueia supervisor ao apagar uma conversa inteira', async () => {
    const res = await request(app)
      .delete('/api/chats/10')
      .set('Authorization', `Bearer ${token({ perfil: 'supervisor' })}`)

    expect(res.status).toBe(403)
  })

  it('bloqueia supervisor ao alterar perfil publico do WhatsApp', async () => {
    const res = await request(app)
      .put('/api/config/whatsapp/profile-name')
      .set('Authorization', `Bearer ${token({ perfil: 'supervisor' })}`)
      .send({ value: 'Atendimento' })

    expect(res.status).toBe(403)
  })

  it('nao expoe o token real na rota publica de instrucao do webhook', async () => {
    const oldWebhookToken = process.env.WHATSAPP_WEBHOOK_TOKEN
    process.env.WHATSAPP_WEBHOOK_TOKEN = 'segredo-real-nao-vazar'

    try {
      const res = await request(app).get('/webhooks/ultramsg')

      expect(res.status).toBe(200)
      expect(JSON.stringify(res.body)).not.toContain('segredo-real-nao-vazar')
      expect(res.body.webhook_url).toContain('<WHATSAPP_WEBHOOK_TOKEN>')
    } finally {
      process.env.WHATSAPP_WEBHOOK_TOKEN = oldWebhookToken
    }
  })
})

describe('Permissao de envio de mensagens', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    const chain = supabase.from()
    if (!chain.is) chain.is = jest.fn().mockReturnThis()
  })

  it('nao permite enviar em conversa fechada sem reabrir', async () => {
    const { _test } = require('../controllers/chatController')
    const chain = supabase.from()

    chain.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 10,
        atendente_id: 2,
        tipo: null,
        telefone: '5534999999999',
        status_atendimento: 'fechada',
      },
      error: null,
    })

    const result = await _test.assertPodeEnviarMensagem({
      company_id: 1,
      conversa_id: 10,
      user_id: 2,
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(409)
  })

  it('assume automaticamente conversa sem atendente no primeiro envio manual sem depender de bot_logs', async () => {
    const { _test } = require('../controllers/chatController')
    const chain = supabase.from()
    const conversaInicial = {
      id: 10,
      atendente_id: null,
      departamento_id: null,
      tipo: null,
      telefone: '5534999999999',
      status_atendimento: 'aberta',
    }
    const conversaAssumida = {
      ...conversaInicial,
      atendente_id: 2,
      status_atendimento: 'em_atendimento',
    }

    chain.maybeSingle
      .mockResolvedValueOnce({ data: conversaInicial, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: conversaAssumida, error: null })
    chain.single
      .mockResolvedValueOnce({ data: conversaInicial, error: null })
      .mockResolvedValueOnce({ data: { limite_chats_por_atendente: 0 }, error: null })
      .mockResolvedValueOnce({ data: { id: 123 }, error: null })

    const result = await _test.assertPodeEnviarMensagem({
      company_id: 1,
      conversa_id: 10,
      user_id: 2,
      role: 'atendente',
      user_dep_ids: [],
      autoAssumirAoEnviar: true,
    })

    expect(result.ok).toBe(true)
    expect(result.reason).toBe('auto_assumida_envio_manual')
    expect(result.conversa).toEqual(expect.objectContaining({
      atendente_id: 2,
      status_atendimento: 'em_atendimento',
    }))
    expect(supabase.from).not.toHaveBeenCalledWith('bot_logs')
  })

  it('mantem bloqueio quando conversa sem atendente pertence a setor sem permissao', async () => {
    const { _test } = require('../controllers/chatController')
    const chain = supabase.from()
    const conversaSetorRestrito = {
      id: 10,
      atendente_id: null,
      departamento_id: 99,
      tipo: null,
      telefone: '5534999999999',
      status_atendimento: 'aberta',
    }

    chain.maybeSingle.mockResolvedValueOnce({ data: conversaSetorRestrito, error: null })
    chain.single.mockResolvedValueOnce({ data: conversaSetorRestrito, error: null })

    const result = await _test.assertPodeEnviarMensagem({
      company_id: 1,
      conversa_id: 10,
      user_id: 2,
      role: 'atendente',
      user_dep_ids: [10],
      autoAssumirAoEnviar: true,
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
    expect(result.error).toBe('Conversa de outro setor')
  })
})

describe('Compatibilidade de schema para co-atendimento', () => {
  it('classifica erros de conversa_atendentes com cache/coluna ausente como migration pendente', () => {
    const { _test } = require('../controllers/chatController')

    expect(_test.isConversaAtendentesMissingTable({ code: '42P01' })).toBe(true)
    expect(_test.isConversaAtendentesMissingTable({ code: 'PGRST205' })).toBe(true)
    expect(_test.isConversaAtendentesSchemaMissing({ code: 'PGRST204' })).toBe(true)
    expect(_test.isConversaAtendentesSchemaMissing({ code: '42703' })).toBe(true)
    expect(_test.isConversaAtendentesSchemaMissing({
      message: "Could not find the 'adicionado_por' column of 'conversa_atendentes' in the schema cache",
    })).toBe(true)
    expect(_test.isConversaAtendentesAdicionadoPorFkError({
      code: '23503',
      message: 'insert or update on table "conversa_atendentes" violates foreign key constraint "conversa_atendentes_adicionado_por_fkey"',
    })).toBe(true)
  })
})
