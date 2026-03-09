/**
 * Setup para testes: mock do Supabase para evitar conexão real.
 */
jest.mock('../config/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: { id: 1 }, error: null }),
    single: jest.fn().mockResolvedValue({ data: { id: 1 }, error: null }),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
  }
  return {
    from: jest.fn(() => chain),
  }
})
