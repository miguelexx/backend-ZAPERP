jest.mock('../services/whatsappInstanceService', () => ({
  listWhatsappInstances: jest.fn(),
  getWhatsappInstanceById: jest.fn(),
}))

const whatsappInstances = require('../services/whatsappInstanceService')
const {
  resolveDashboardInstanceScope,
  applyDashboardInstanceScope,
} = require('../services/dashboardInstanceScopeService')

describe('dashboardInstanceScopeService', () => {
  beforeEach(() => jest.clearAllMocks())

  test('uma única instância ativa inclui somente o legado controlado da mesma empresa', async () => {
    whatsappInstances.listWhatsappInstances.mockResolvedValue({
      instances: [{ id: 8, company_id: 4, ativo: true, is_default: true, nome: 'Principal' }],
      error: null,
    })
    const scope = await resolveDashboardInstanceScope(4)
    expect(scope).toMatchObject({
      company_id: 4,
      whatsapp_instance_id: 8,
      include_legacy_null: true,
    })

    const query = { or: jest.fn(() => 'scoped') }
    expect(applyDashboardInstanceScope(query, scope)).toBe('scoped')
    expect(query.or).toHaveBeenCalledWith('whatsapp_instance_id.eq.8,whatsapp_instance_id.is.null')
  })

  test('instância explícita de outra empresa é rejeitada', async () => {
    whatsappInstances.getWhatsappInstanceById.mockResolvedValue({
      instance: null,
      error: 'Instancia WhatsApp nao encontrada',
    })
    await expect(resolveDashboardInstanceScope(4, 99)).rejects.toThrow(
      'Instância WhatsApp inválida ou inativa para esta empresa'
    )
    expect(whatsappInstances.getWhatsappInstanceById).toHaveBeenCalledWith(
      4,
      99,
      { requireActive: true }
    )
  })

  test('múltiplas instâncias usam somente a default sem incluir legado ambíguo', async () => {
    whatsappInstances.listWhatsappInstances.mockResolvedValue({
      instances: [
        { id: 8, ativo: true, is_default: false },
        { id: 9, ativo: true, is_default: true },
      ],
      error: null,
    })
    const scope = await resolveDashboardInstanceScope(4)
    expect(scope.whatsapp_instance_id).toBe(9)
    expect(scope.include_legacy_null).toBe(false)
  })
})
