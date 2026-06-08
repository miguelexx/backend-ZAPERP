const request = require('supertest')
const jwt = require('jsonwebtoken')

let app

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-granular'
  app = require('../app')
})

function token(payload = {}) {
  return jwt.sign(
    { id: 2, company_id: 1, perfil: 'atendente', departamento_ids: [1], ...payload },
    process.env.JWT_SECRET
  )
}

describe('Permissoes granulares no backend', () => {
  it('bloqueia atendente ao alterar pix-config', async () => {
    const res = await request(app)
      .put('/api/chats/pix-config')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
      .send({ tipo_chave: 'email', chave_pix: 'a@b.com', nome_recebedor: 'Teste' })

    expect(res.status).toBe(403)
  })

  it('bloqueia atendente ao transferir setor', async () => {
    const res = await request(app)
      .put('/api/chats/10/departamento')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
      .send({ departamento_id: 2 })

    expect(res.status).toBe(403)
  })

  it('bloqueia atendente ao sincronizar contatos', async () => {
    const res = await request(app)
      .post('/api/chats/sincronizar-contatos')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)

    expect([403, 500]).toContain(res.status)
  })

  it('bloqueia atendente no debug-sync-contatos', async () => {
    const res = await request(app)
      .get('/api/chats/debug-sync-contatos')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)

    expect(res.status).toBe(403)
  })

  it('permite admin alterar pix-config (nao retorna 403)', async () => {
    const res = await request(app)
      .put('/api/chats/pix-config')
      .set('Authorization', `Bearer ${token({ perfil: 'admin', id: 1 })}`)
      .send({ tipo_chave: 'email', chave_pix: 'admin@b.com', nome_recebedor: 'Admin' })

    expect(res.status).not.toBe(403)
  })
})
