const { contactSyncDb } = require('./support/contactSyncDb')

describe('sincronização manual da agenda — persistência e recuperação', () => {
  let db, provider, service
  beforeEach(() => {
    jest.resetModules()
    db = contactSyncDb()
    provider = { getContacts: jest.fn(), getProfilePicture: jest.fn(async () => 'https://cdn.test/foto.jpg') }
    jest.doMock('../config/supabase', () => db)
    jest.doMock('../services/providers', () => ({ getProvider: () => provider }))
    jest.doMock('../services/whatsappConfigService', () => ({ getEmpresaWhatsappConfig: async () => ({ config: { instance_id: 'test' } }) }))
    jest.doMock('../services/configOperacionalService', () => ({ getConfig: async () => ({}), isProcessamentoPausado: async () => true }))
    jest.doMock('../services/operationalAuditService', () => ({ registrarEvento: jest.fn(), TIPOS: {} }))
    service = require('../services/contactSyncService')
  })
  const agenda = (data) => ({ data, rawCount: data.length, hasMore: false })
  const contact = (phone = '5511987654321', name = 'Nome Agenda') => ({ phone: `${phone}@c.us`, name })

  test('importa mais de 1000 contatos com fotos e informa progresso; segundo clique é idempotente', async () => {
    const contacts = Array.from({ length: 1005 }, (_, i) => contact(String(5511987600000 + i), `Pessoa ${i}`))
    provider.getContacts.mockResolvedValue(agenda(contacts))
    const onProgress = jest.fn()
    const first = await service.runContactSyncFull(7, { manual: true, jobId: 90, onProgress })
    expect(first).toMatchObject({ ok: true, totalCriados: 1005, totalFotosAtualizadas: 1005, totalVerificados: 1005 })
    expect(db.tables.clientes).toHaveLength(1005)
    expect(db.tables.clientes.every((c) => c.company_id === 7 && c.nome && c.foto_perfil)).toBe(true)
    expect(onProgress.mock.calls.some(([p]) => p.totalVerificados === 10)).toBe(true)
    expect(provider.getContacts).toHaveBeenCalledTimes(1)
    expect(provider.getProfilePicture).toHaveBeenCalledWith('5511987600000@c.us', { companyId: 7 })
    const again = await service.runContactSyncFull(7, { manual: true })
    expect(again).toMatchObject({ ok: true, totalCriados: 0 })
    expect(db.tables.clientes).toHaveLength(1005)
    expect(db.tables.sync_locks).toHaveLength(0)
  }, 30000)

  test('preserva nome protegido, foto indisponível e outra empresa; não confunde números com/sem 9', async () => {
    db.tables.clientes.push(
      { id: 1, company_id: 7, telefone: '5511987654321', nome: 'Nome editado', nome_protegido: true, foto_perfil: 'https://cdn.test/antiga.jpg' },
      { id: 2, company_id: 8, telefone: '5511987654321', nome: 'Outra empresa' },
    )
    provider.getProfilePicture.mockResolvedValue(null)
    provider.getContacts.mockResolvedValue(agenda([contact(), contact('551187654321'), contact('14155552671', 'Internacional')]))
    const result = await service.runContactSyncFull(7, { manual: true })
    expect(result).toMatchObject({ ok: true, totalCriados: 2, totalFotosIndisponiveis: 3 })
    expect(db.tables.clientes[0]).toMatchObject({ nome: 'Nome editado', foto_perfil: 'https://cdn.test/antiga.jpg' })
    expect(db.tables.clientes[1]).toEqual({ id: 2, company_id: 8, telefone: '5511987654321', nome: 'Outra empresa' })
    expect(db.tables.clientes.some((c) => c.telefone === '14155552671')).toBe(true)
  })

  test('erros HTTP, agenda vazia e falha de gravação nunca são sucesso', async () => {
    provider.getContacts.mockRejectedValueOnce(new Error('API indisponível'))
    expect(await service.runContactSyncFull(7, { manual: true })).toMatchObject({ ok: false, error: 'API indisponível' })
    provider.getContacts.mockResolvedValueOnce(agenda([]))
    expect(await service.runContactSyncFull(7, { manual: true })).toMatchObject({ ok: false })
    provider.getContacts.mockResolvedValue(agenda([contact()]))
    db.failures['clientes:upsert'] = { message: 'banco indisponível' }
    db.failures['clientes:insert'] = { message: 'banco indisponível' }
    expect(await service.runContactSyncFull(7, { manual: true })).toMatchObject({ ok: false, totalErros: 1 })
    expect(db.tables.sync_locks).toHaveLength(0)
  })

  test('falha no update de cliente existente é reportada', async () => {
    db.tables.clientes.push({ id: 1, company_id: 7, telefone: '5511987654321', nome: 'Nome Agenda' })
    db.failures['clientes:update'] = { message: 'write failed' }
    provider.getContacts.mockResolvedValue(agenda([contact()]))
    expect(await service.runContactSyncFull(7, { manual: true })).toMatchObject({ ok: false, totalErros: 1, totalAtualizados: 0 })
  })

  test('página repetida é erro, página filtrada vazia não corta a próxima', async () => {
    provider.getContacts.mockResolvedValue({ ...agenda([contact()]), hasMore: true })
    expect(await service.runContactSyncFull(7, { manual: true })).toMatchObject({ ok: false })
    expect(provider.getContacts).toHaveBeenCalledTimes(2)
    provider.getContacts.mockReset().mockResolvedValueOnce({ data: [], rawCount: 1000, hasMore: true }).mockResolvedValueOnce(agenda([contact()]))
    expect(await service.runContactSyncFull(7, { manual: true })).toMatchObject({ ok: true, totalCriados: 1 })
  })

  test('recupera lock órfão antigo sem remover lock recente ou de outra empresa', async () => {
    db.tables.sync_locks.push({ id: 1, company_id: 7, tipo: 'contact_sync', locked_at: '2020-01-01' },
      { id: 2, company_id: 8, tipo: 'contact_sync', locked_at: '2020-01-01' })
    provider.getContacts.mockResolvedValue(agenda([contact()]))
    expect(await service.runContactSyncFull(7, { manual: true })).toMatchObject({ ok: true })
    expect(db.tables.sync_locks.map((l) => l.company_id)).toEqual([8])
    db.tables.sync_locks.push({ id: 3, company_id: 7, tipo: 'contact_sync', locked_at: new Date().toISOString() })
    expect(await service.runContactSyncFull(7, { manual: true })).toMatchObject({ ok: false })
    expect(db.tables.sync_locks).toHaveLength(2)
  })
})
