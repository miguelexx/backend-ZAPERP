/**
 * Setup para testes: mock do Supabase para evitar conexão real.
 */
jest.mock('../config/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    ilike: jest.fn().mockReturnThis(),
    filter: jest.fn().mockReturnThis(),
    overlaps: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(),
    lt: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: { id: 1 }, error: null }),
    single: jest.fn().mockResolvedValue({ data: { id: 1 }, error: null }),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    throwOnError: jest.fn().mockReturnThis(),
  }
  return {
    from: jest.fn(() => chain),
  }
})

beforeEach(() => {
  const moduloCampanhas = require('../helpers/moduloCampanhas')
  if (jest.isMockFunction(moduloCampanhas.empresaModuloCampanhasAtivo)) {
    moduloCampanhas.empresaModuloCampanhasAtivo.mockResolvedValue(true)
  } else {
    jest.spyOn(moduloCampanhas, 'empresaModuloCampanhasAtivo').mockResolvedValue(true)
  }
})
