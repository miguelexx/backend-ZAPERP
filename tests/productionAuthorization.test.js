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
})
