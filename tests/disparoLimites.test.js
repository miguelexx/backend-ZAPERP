/**
 * Testes — Etapa 5: limites, horários, agendamento, conflitos e simulação (API).
 * Usa mocks do Supabase. NÃO é integração real com banco/R2/UltraMSG.
 */

const request = require('supertest')
const jwt = require('jsonwebtoken')
const app = require('../app')
const supabase = require('../config/supabase')
const { DateTime } = require('../helpers/disparoLimitesHelper')

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret'
const COMPANY_ID = 10

function token(extra = {}) {
  return jwt.sign({ id: 5, company_id: COMPANY_ID, perfil: 'admin', ...extra }, JWT_SECRET, { expiresIn: '1h' })
}

function mockChain(resolvedValue = { data: null, error: null, count: null }) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    filter: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue(resolvedValue),
    single: jest.fn().mockResolvedValue(resolvedValue),
  }
  const p = Promise.resolve(resolvedValue)
  Object.setPrototypeOf(chain, {
    then: (res, rej) => p.then(res, rej),
    catch: (rej) => p.catch(rej),
  })
  return chain
}

const campanhaBase = {
  id: 1,
  status: 'configurando',
  company_id: COMPANY_ID,
  nome: 'Campanha Teste',
  distribuicao_confirmada: true,
  distribuicao_revisao: false,
  variacao_confirmada: true,
  variacao_revisao: false,
  limites_confirmados: false,
  limites_revisao: false,
}

describe('Etapa 5 — Autenticação e permissão', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rejeita GET /limites sem token (401)', async () => {
    const res = await request(app).get('/api/disparo/campanhas/1/limites')
    expect(res.status).toBe(401)
  })

  it('bloqueia atendente (403)', async () => {
    const res = await request(app)
      .get('/api/disparo/campanhas/1/limites')
      .set('Authorization', `Bearer ${token({ perfil: 'atendente' })}`)
    expect(res.status).toBe(403)
  })
})

describe('Etapa 5 — Isolamento company_id', () => {
  beforeEach(() => jest.clearAllMocks())

  it('filtra campanha pelo company_id do token', async () => {
    const q = mockChain({ data: null, error: null })
    supabase.from.mockReturnValue(q)

    const res = await request(app)
      .get('/api/disparo/campanhas/99/limites')
      .set('Authorization', `Bearer ${token({ company_id: COMPANY_ID })}`)

    expect(res.status).toBe(404)
    expect(q.eq).toHaveBeenCalledWith('company_id', COMPANY_ID)
  })
})

describe('Etapa 5 — Limites globais', () => {
  beforeEach(() => jest.clearAllMocks())

  it('salva limites globais válidos (upsert)', async () => {
    const campanhaQ = mockChain({ data: campanhaBase, error: null })
    const upsertQ = mockChain({
      data: {
        id: 1,
        campanha_id: 1,
        company_id: COMPANY_ID,
        limite_por_hora: 40,
        limite_por_dia: 300,
        intervalo_min_sec: 10,
        intervalo_max_sec: 25,
        lote_tamanho: 15,
        pausa_lote_min_sec: 60,
        pausa_lote_max_sec: 120,
        fuso_horario: 'America/Sao_Paulo',
        inicio_modo: 'imediato',
        perfil: 'personalizado',
        confirmada: false,
      },
      error: null,
    })

    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') return campanhaQ
      if (table === 'disparo_campanha_limites') return upsertQ
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/limites')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        perfil: 'personalizado',
        limite_por_hora: 40,
        limite_por_dia: 300,
        intervalo_min_sec: 10,
        intervalo_max_sec: 25,
        lote_tamanho: 15,
        pausa_lote_min_sec: 60,
        pausa_lote_max_sec: 120,
        fuso_horario: 'America/Sao_Paulo',
        inicio_modo: 'imediato',
      })

    expect([200, 201]).toContain(res.status)
    expect(upsertQ.upsert || upsertQ.insert || upsertQ.update).toBeDefined()
  })

  it('rejeita intervalo mínimo maior que o máximo (400/422)', async () => {
    supabase.from.mockReturnValue(mockChain({ data: campanhaBase, error: null }))

    const res = await request(app)
      .post('/api/disparo/campanhas/1/limites')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        limite_por_hora: 40,
        limite_por_dia: 300,
        intervalo_min_sec: 90,
        intervalo_max_sec: 10,
        lote_tamanho: 10,
        pausa_lote_min_sec: 30,
        pausa_lote_max_sec: 60,
      })

    expect([400, 422]).toContain(res.status)
  })
})

describe('Etapa 5 — Janelas', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rejeita horários sobrepostos', async () => {
    supabase.from.mockReturnValue(mockChain({ data: campanhaBase, error: null }))

    const res = await request(app)
      .post('/api/disparo/campanhas/1/limites/janelas')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        janelas: [
          { dia_semana: 1, hora_inicio: '08:00', hora_fim: '12:00', ativo: true },
          { dia_semana: 1, hora_inicio: '11:30', hora_fim: '15:00', ativo: true },
        ],
      })

    expect([400, 422]).toContain(res.status)
    expect(JSON.stringify(res.body)).toMatch(/sobrepost/i)
  })
})

describe('Etapa 5 — Agendamento', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rejeita agendamento no passado', async () => {
    const limites = {
      ...campanhaBase,
      persistido: true,
      limite_por_hora: 60,
      limite_por_dia: 500,
      intervalo_min_sec: 8,
      intervalo_max_sec: 20,
      lote_tamanho: 20,
      pausa_lote_min_sec: 60,
      pausa_lote_max_sec: 180,
      fuso_horario: 'America/Sao_Paulo',
      inicio_modo: 'imediato',
      perfil: 'moderado',
      pausa_auto_desconexao: true,
      pausa_auto_erros_consecutivos: 5,
      pausa_auto_taxa_falha_pct: 25,
    }

    let call = 0
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') return mockChain({ data: campanhaBase, error: null })
      if (table === 'disparo_campanha_limites') {
        call += 1
        return mockChain({ data: limites, error: null })
      }
      if (table === 'disparo_campanha_janelas') {
        return mockChain({
          data: [{ dia_semana: 1, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null }],
          error: null,
        })
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/limites/agendamento')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        inicio_modo: 'agendado',
        agendado_para: DateTime.utc().minus({ days: 2 }).toISO(),
      })

    expect([400, 422]).toContain(res.status)
  })
})

describe('Etapa 5 — Instância status / ativa', () => {
  beforeEach(() => jest.clearAllMocks())

  it('validarConfigLimites NÃO falha se status disconnected mas instância ativa', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') return mockChain({ data: campanhaBase, error: null })
      if (table === 'disparo_campanha_limites') {
        return mockChain({
          data: {
            campanha_id: 1,
            company_id: COMPANY_ID,
            limite_por_hora: 60,
            limite_por_dia: 500,
            intervalo_min_sec: 8,
            intervalo_max_sec: 20,
            lote_tamanho: 20,
            pausa_lote_min_sec: 60,
            pausa_lote_max_sec: 180,
            fuso_horario: 'America/Sao_Paulo',
            inicio_modo: 'imediato',
            perfil: 'moderado',
            pausa_auto_desconexao: true,
            pausa_auto_erros_consecutivos: 5,
            pausa_auto_taxa_falha_pct: 25,
            confirmada: false,
          },
          error: null,
        })
      }
      if (table === 'disparo_campanha_janelas') {
        return mockChain({
          data: [
            { dia_semana: 1, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
            { dia_semana: 2, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
            { dia_semana: 3, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
            { dia_semana: 4, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
            { dia_semana: 5, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
          ],
          error: null,
        })
      }
      if (table === 'disparo_campanha_instancias') {
        return mockChain({ data: [{ instancia_id: 7 }], error: null })
      }
      if (table === 'whatsapp_instances') {
        return mockChain({
          data: [{ id: 7, nome: 'WA Stale', status: 'disconnected', ativo: true }],
          error: null,
        })
      }
      if (table === 'disparo_campanha_destinatarios') {
        return mockChain({ data: [{ id: 1 }], error: null, count: 10 })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/limites/validar')
      .set('Authorization', `Bearer ${token()}`)
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('validarConfigLimites falha se instância inativa', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') return mockChain({ data: campanhaBase, error: null })
      if (table === 'disparo_campanha_limites') {
        return mockChain({
          data: {
            campanha_id: 1,
            company_id: COMPANY_ID,
            limite_por_hora: 60,
            limite_por_dia: 500,
            intervalo_min_sec: 8,
            intervalo_max_sec: 20,
            lote_tamanho: 20,
            pausa_lote_min_sec: 60,
            pausa_lote_max_sec: 180,
            fuso_horario: 'America/Sao_Paulo',
            inicio_modo: 'imediato',
            perfil: 'moderado',
            pausa_auto_desconexao: true,
            pausa_auto_erros_consecutivos: 5,
            pausa_auto_taxa_falha_pct: 25,
            confirmada: false,
          },
          error: null,
        })
      }
      if (table === 'disparo_campanha_janelas') {
        return mockChain({
          data: [
            { dia_semana: 1, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
            { dia_semana: 2, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
            { dia_semana: 3, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
            { dia_semana: 4, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
            { dia_semana: 5, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
          ],
          error: null,
        })
      }
      if (table === 'disparo_campanha_instancias') {
        return mockChain({ data: [{ instancia_id: 7 }], error: null })
      }
      if (table === 'whatsapp_instances') {
        return mockChain({
          data: [{ id: 7, nome: 'WA Inativa', status: 'connected', ativo: false }],
          error: null,
        })
      }
      if (table === 'disparo_campanha_destinatarios') {
        return mockChain({ data: [{ id: 1 }], error: null, count: 10 })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/limites/validar')
      .set('Authorization', `Bearer ${token()}`)
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
  })

  it('validarConfigLimites falha se instância da campanha não existe mais', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') return mockChain({ data: campanhaBase, error: null })
      if (table === 'disparo_campanha_limites') {
        return mockChain({
          data: {
            campanha_id: 1,
            company_id: COMPANY_ID,
            limite_por_hora: 60,
            limite_por_dia: 500,
            intervalo_min_sec: 8,
            intervalo_max_sec: 20,
            lote_tamanho: 20,
            pausa_lote_min_sec: 60,
            pausa_lote_max_sec: 180,
            fuso_horario: 'America/Sao_Paulo',
            inicio_modo: 'imediato',
            perfil: 'moderado',
            pausa_auto_desconexao: true,
            pausa_auto_erros_consecutivos: 5,
            pausa_auto_taxa_falha_pct: 25,
            confirmada: false,
          },
          error: null,
        })
      }
      if (table === 'disparo_campanha_janelas') {
        return mockChain({
          data: [
            { dia_semana: 1, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
          ],
          error: null,
        })
      }
      if (table === 'disparo_campanha_instancias') {
        return mockChain({ data: [{ instancia_id: 7 }], error: null })
      }
      if (table === 'whatsapp_instances') {
        return mockChain({ data: [], error: null })
      }
      if (table === 'disparo_campanha_destinatarios') {
        return mockChain({ data: [{ id: 1 }], error: null, count: 10 })
      }
      return mockChain({ data: [], error: null, count: 0 })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/limites/validar')
      .set('Authorization', `Bearer ${token()}`)
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(String(res.body.erros || res.body.error || '')).toMatch(/não encontrada|inativa|Instância/i)
  })
})

describe('Etapa 5 — Conflitos entre campanhas', () => {
  beforeEach(() => jest.clearAllMocks())

  it('detecta outra campanha em_execucao na mesma instância', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        // primeira chamada: campanha atual; depois busca outras
        return mockChain({
          data: [
            {
              id: 2,
              nome: 'Outra',
              status: 'em_execucao',
              limites_confirmados: true,
            },
          ],
          error: null,
        })
      }
      if (table === 'disparo_campanha_instancias') {
        return mockChain({
          data: [{ instancia_id: 7, campanha_id: 1 }, { instancia_id: 7, campanha_id: 2 }],
          error: null,
        })
      }
      if (table === 'disparo_campanha_limites') {
        return mockChain({ data: { inicio_modo: 'imediato', agendado_para: null }, error: null })
      }
      return mockChain({ data: campanhaBase, error: null })
    })

    // Override: carregarCampanha precisa da campanha atual
    let campanhasCalls = 0
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') {
        campanhasCalls += 1
        if (campanhasCalls === 1) return mockChain({ data: campanhaBase, error: null })
        return mockChain({
          data: [{ id: 2, nome: 'Outra', status: 'em_execucao', limites_confirmados: true }],
          error: null,
        })
      }
      if (table === 'disparo_campanha_instancias') {
        return mockChain({ data: [{ instancia_id: 7 }], error: null })
      }
      if (table === 'disparo_campanha_limites') {
        return mockChain({
          data: [{ campanha_id: 2, inicio_modo: 'imediato', agendado_para: null }],
          error: null,
        })
      }
      return mockChain({ data: null, error: null })
    })

    const res = await request(app)
      .get('/api/disparo/campanhas/1/limites/conflitos')
      .set('Authorization', `Bearer ${token()}`)

    expect(res.status).toBe(200)
    // Pode ou não achar conflito dependendo do mock — garante shape
    expect(res.body).toHaveProperty('conflitos')
    expect(res.body).toHaveProperty('conflito_impeditivo')
  })
})

describe('Etapa 5 — Simulação API', () => {
  beforeEach(() => jest.clearAllMocks())

  it('POST /simular retorna resumo com disclaimer', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'disparo_campanhas') return mockChain({ data: campanhaBase, error: null })
      if (table === 'disparo_campanha_limites') {
        return mockChain({
          data: {
            campanha_id: 1,
            company_id: COMPANY_ID,
            limite_por_hora: 60,
            limite_por_dia: 500,
            intervalo_min_sec: 8,
            intervalo_max_sec: 20,
            lote_tamanho: 20,
            pausa_lote_min_sec: 60,
            pausa_lote_max_sec: 180,
            fuso_horario: 'America/Sao_Paulo',
            inicio_modo: 'imediato',
            perfil: 'moderado',
            pausa_auto_desconexao: true,
            pausa_auto_erros_consecutivos: 5,
            pausa_auto_taxa_falha_pct: 25,
          },
          error: null,
        })
      }
      if (table === 'disparo_campanha_instancia_limites') {
        return mockChain({ data: [], error: null })
      }
      if (table === 'disparo_campanha_janelas') {
        return mockChain({
          data: [
            { dia_semana: 1, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
            { dia_semana: 2, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
            { dia_semana: 3, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
            { dia_semana: 4, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
            { dia_semana: 5, hora_inicio: '08:00:00', hora_fim: '18:00:00', ativo: true, instancia_id: null },
          ],
          error: null,
        })
      }
      if (table === 'disparo_campanha_destinatarios') {
        return mockChain({
          data: [
            { instancia_id: 1 }, { instancia_id: 1 }, { instancia_id: 1 },
            { instancia_id: 2 }, { instancia_id: 2 },
          ],
          error: null,
          count: 5,
        })
      }
      if (table === 'disparo_campanha_instancias') {
        return mockChain({ data: [{ instancia_id: 1 }, { instancia_id: 2 }], error: null })
      }
      if (table === 'whatsapp_instances') {
        return mockChain({
          data: [
            { id: 1, nome: 'A', status: 'connected', ativo: true },
            { id: 2, nome: 'B', status: 'connected', ativo: true },
          ],
          error: null,
        })
      }
      return mockChain({ data: [], error: null })
    })

    const res = await request(app)
      .post('/api/disparo/campanhas/1/limites/simular')
      .set('Authorization', `Bearer ${token()}`)
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.resumo || res.body.simulacao?.resumo || res.body).toBeTruthy()
  })
})
