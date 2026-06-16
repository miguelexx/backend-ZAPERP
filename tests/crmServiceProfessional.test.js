jest.mock('../repositories/crmRepository', () => ({
  getLeadById: jest.fn(),
  getLostReasonById: jest.fn(),
  listStages: jest.fn(),
  getStageById: jest.fn(),
  getPipelineById: jest.fn(),
  maxOrdemInStage: jest.fn(),
  insertMovement: jest.fn(),
  updateLead: jest.fn(),
  insertTimeline: jest.fn(),
  listMovements: jest.fn(),
  getFirstOpenStage: jest.fn(),
  listPipelines: jest.fn(),
  getDefaultPipeline: jest.fn(),
  listLeads: jest.fn(),
  fetchTagsForLeads: jest.fn(),
  fetchUsuarioMap: jest.fn(),
}))

jest.mock('../helpers/auditoriaLog', () => ({
  registrar: jest.fn().mockResolvedValue(undefined),
}))

const repo = require('../repositories/crmRepository')
const crmService = require('../services/crmService')

describe('crmService professional rules', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('bloqueia perda de lead sem motivo', async () => {
    repo.getLeadById.mockResolvedValue({
      id: 10,
      company_id: 1,
      pipeline_id: 5,
      stage_id: 2,
      status: 'ativo',
    })

    await expect(crmService.perderLead(1, 7, 10, {})).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Motivo'),
    })
  })

  it('registrar contato atualiza somente pelo companyId informado e grava timeline', async () => {
    repo.getLeadById.mockResolvedValue({
      id: 10,
      company_id: 1,
      pipeline_id: 5,
      stage_id: 2,
      status: 'ativo',
      data_primeiro_contato: null,
    })
    repo.updateLead.mockResolvedValue({ id: 10, company_id: 1 })
    repo.insertTimeline.mockResolvedValue({ id: 99 })

    await crmService.registrarContato(1, 7, 10, {
      canal: 'whatsapp',
      resultado: 'falou com cliente',
      data_contato: '2026-06-16T12:00:00.000Z',
    })

    expect(repo.updateLead).toHaveBeenCalledWith(
      1,
      10,
      expect.objectContaining({
        data_primeiro_contato: '2026-06-16T12:00:00.000Z',
        data_ultimo_contato: '2026-06-16T12:00:00.000Z',
        atualizado_por: 7,
      })
    )
    expect(repo.insertTimeline).toHaveBeenCalledWith(expect.objectContaining({
      company_id: 1,
      lead_id: 10,
      usuario_id: 7,
      tipo: 'contato_realizado',
    }))
  })

  it('kanban consulta leads ativos do pipeline dentro do tenant', async () => {
    repo.getPipelineById.mockResolvedValue({ id: 5, company_id: 1, nome: 'Vendas' })
    repo.listPipelines.mockResolvedValue([{ id: 5, company_id: 1, nome: 'Vendas' }])
    repo.listStages.mockResolvedValue([{ id: 2, pipeline_id: 5, nome: 'Novo', ordem: 1 }])
    repo.listLeads.mockResolvedValue({ items: [], total: 0 })
    repo.fetchTagsForLeads.mockResolvedValue({ byLead: {} })
    repo.fetchUsuarioMap.mockResolvedValue({})

    await crmService.getKanban(1, 5, { q: 'ana' })

    expect(repo.listLeads).toHaveBeenCalledWith(1, expect.objectContaining({
      pipeline_id: 5,
      status: 'ativo',
      q: 'ana',
    }))
  })
})
