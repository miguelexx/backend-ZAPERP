/**
 * Adapter UltraMSG recusa instância provider=whapi (não manda channel id para api.ultramsg.com).
 */

describe('ultramsg resolveConfig — guarda de provider', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  test('instância provider=whapi devolve null e não monta basePath UltraMSG', async () => {
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async () => ({
        instance: {
          id: 30,
          company_id: 1,
          provider: 'whapi',
          instance_id: 'NEBULA-AER3B',
          instance_token: 'whapi-token-test',
        },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'none' })),
    }))
    const { resolveConfig } = require('../services/providers/ultramsg/config')
    const cfg = await resolveConfig({ companyId: 1, whatsappInstanceId: 30 })
    expect(cfg).toBeNull()
  })

  test('instância ultramsg continua resolvendo basePath instance…', async () => {
    jest.doMock('../services/whatsappInstanceService', () => ({
      getWhatsappInstanceById: jest.fn(async () => ({
        instance: {
          id: 8,
          company_id: 1,
          provider: 'ultramsg',
          instance_id: 'instance173587',
          instance_token: 'ultra-token-test',
        },
        error: null,
      })),
      getDefaultWhatsappInstance: jest.fn(async () => ({ instance: null, error: 'none' })),
    }))
    const { resolveConfig } = require('../services/providers/ultramsg/config')
    const cfg = await resolveConfig({ companyId: 1, whatsappInstanceId: 8 })
    expect(cfg).toMatchObject({
      token: 'ultra-token-test',
      instanceId: 'instance173587',
      companyId: 1,
      whatsappInstanceId: 8,
    })
    expect(String(cfg.basePath)).toMatch(/ultramsg\.com\/instance173587/i)
  })
})
