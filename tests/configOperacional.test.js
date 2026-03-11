/**
 * Testes de configOperacionalService.
 * Usa mock do Supabase (setup.js).
 */
const { getConfig, updateConfig, DEFAULTS } = require('../services/configOperacionalService')

describe('configOperacionalService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('getConfig', () => {
    it('retorna DEFAULTS quando company_id é null', async () => {
      const config = await getConfig(null)
      expect(config).toEqual(DEFAULTS)
    })

    it('retorna objeto com campos esperados', async () => {
      const config = await getConfig(1)
      expect(config).toHaveProperty('lote_max')
      expect(config).toHaveProperty('intervalo_lotes_seg')
      expect(config).toHaveProperty('modo_seguro')
      expect(config).toHaveProperty('processamento_pausado')
    })
  })

  describe('DEFAULTS', () => {
    it('modo_seguro é true por padrão', () => {
      expect(DEFAULTS.modo_seguro).toBe(true)
    })
    it('processamento_pausado é false por padrão', () => {
      expect(DEFAULTS.processamento_pausado).toBe(false)
    })
    it('lote_max é número positivo', () => {
      expect(typeof DEFAULTS.lote_max).toBe('number')
      expect(DEFAULTS.lote_max).toBeGreaterThan(0)
    })
  })
})
