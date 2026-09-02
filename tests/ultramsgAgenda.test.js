describe('contrato oficial GET /contacts', () => {
  let getJson, api
  beforeEach(() => {
    jest.resetModules()
    getJson = jest.fn()
    jest.doMock('../services/providers/ultramsg/config', () => ({ resolveConfig: async (opts) => opts.companyId === 7 ? { companyId: 7, basePath: 'https://test/instance7', token: 'test-only' } : null }))
    jest.doMock('../services/providers/ultramsg/http', () => ({ getJson }))
    api = require('../services/providers/ultramsg/contacts')
  })
  test('lê a lista inteira sem limit/offset; não busca páginas fictícias', async () => {
    const data = Array.from({ length: 1501 }, (_, i) => ({ id: `${5511990000000 + i}@c.us`, name: `Contato ${i}` }))
    getJson.mockResolvedValue({ ok: true, data })
    expect(await api.getContacts(1, 100, { companyId: 7 })).toMatchObject({ rawCount: 1501, hasMore: false, data: expect.any(Array) })
    expect(getJson.mock.calls[0][0]).not.toHaveProperty('extraParams')
    expect((await api.getContacts(2, 100, { companyId: 7 })).data).toEqual([])
    expect(getJson).toHaveBeenCalledTimes(1)
  })
  test('normaliza nome e JID serializado; exclui grupos, LID puro, não salvos e só pushname', async () => {
    getJson.mockResolvedValue({ ok: true, data: { data: { contacts: [
      { id: { _serialized: '5511990000001@c.us' }, formattedName: 'Maria' },
      { id: '123456789012@lid', phone: '5511990000002@c.us', name: 'João' },
      { id: '123456789012@lid', name: 'LID' },
      { id: '123456789012@g.us', name: 'Grupo' },
      { id: '5511990000003@c.us', pushname: 'Perfil' },
      { id: '5511990000004@c.us', name: 'Não salvo', isMyContact: false },
    ] } } })
    expect((await api.getContacts(1, 1000, { companyId: 7 })).data.map((c) => c.name)).toEqual(['Maria', 'João'])
  })
  test.each([
    { ok: false, status: 401, data: { error: 'token-test-only' } },
    { ok: true, status: 200, data: { error: 'instance disconnected' } },
    { ok: true, data: { unknown: [] } },
  ])('erro de API/formato nunca vira lista vazia: %j', async (response) => {
    getJson.mockResolvedValue(response)
    await expect(api.getContacts(1, 1000, { companyId: 7 })).rejects.toThrow()
  })
  test('sem configuração não consulta outro tenant', async () => {
    await expect(api.getContacts(1, 1000, { companyId: 8 })).rejects.toThrow()
    expect(getJson).not.toHaveBeenCalled()
  })
  test('metadata do contato executa a extração (função não fica dentro de comentário)', async () => {
    getJson.mockResolvedValue({ ok: true, data: { id: '5511990000001@c.us', name: 'Maria', imgUrl: 'https://cdn.test/maria.jpg' } })
    expect(await api.getContactMetadata('5511990000001@c.us', { companyId: 7 })).toMatchObject({ name: 'Maria', imgUrl: 'https://cdn.test/maria.jpg' })
  })
})
