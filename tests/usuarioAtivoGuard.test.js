/**
 * Revogação de acesso: usuarios.ativo=false bloqueia; erro de banco/linha ausente
 * NUNCA bloqueia (fail-open); cache evita query por request; invalidação é imediata.
 */

const mockMaybeSingle = jest.fn()

jest.mock('../config/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: (...args) => mockMaybeSingle(...args),
  }
  return { from: jest.fn(() => chain) }
})

const { usuarioEstaAtivo, invalidateUsuarioAtivoCache, _test } = require('../helpers/usuarioAtivoGuard')

beforeEach(() => {
  mockMaybeSingle.mockReset()
  _test.cache.clear()
})

describe('usuarioEstaAtivo', () => {
  test('bloqueia quando o banco confirma ativo === false', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { ativo: false }, error: null })
    await expect(usuarioEstaAtivo(10, 1)).resolves.toBe(false)
  })

  test('permite quando ativo === true', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { ativo: true }, error: null })
    await expect(usuarioEstaAtivo(11, 1)).resolves.toBe(true)
  })

  test('fail-open: linha ausente permite', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })
    await expect(usuarioEstaAtivo(12, 1)).resolves.toBe(true)
  })

  test('fail-open: erro de banco permite', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'db down' } })
    await expect(usuarioEstaAtivo(13, 1)).resolves.toBe(true)
    mockMaybeSingle.mockRejectedValue(new Error('network'))
    await expect(usuarioEstaAtivo(14, 1)).resolves.toBe(true)
  })

  test('ids inválidos permitem sem consultar o banco', async () => {
    await expect(usuarioEstaAtivo(null, 1)).resolves.toBe(true)
    await expect(usuarioEstaAtivo(10, 'abc')).resolves.toBe(true)
    expect(mockMaybeSingle).not.toHaveBeenCalled()
  })

  test('cache: segunda chamada na janela não vai ao banco', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { ativo: true }, error: null })
    await usuarioEstaAtivo(20, 2)
    await usuarioEstaAtivo(20, 2)
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1)
  })

  test('invalidateUsuarioAtivoCache força nova consulta (revogação imediata)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { ativo: true }, error: null })
    await expect(usuarioEstaAtivo(30, 3)).resolves.toBe(true)

    invalidateUsuarioAtivoCache(30, 3)
    mockMaybeSingle.mockResolvedValue({ data: { ativo: false }, error: null })
    await expect(usuarioEstaAtivo(30, 3)).resolves.toBe(false)
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2)
  })

  test('empresas diferentes têm entradas de cache separadas', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ativo: false }, error: null })
    mockMaybeSingle.mockResolvedValueOnce({ data: { ativo: true }, error: null })
    await expect(usuarioEstaAtivo(40, 1)).resolves.toBe(false)
    await expect(usuarioEstaAtivo(40, 2)).resolves.toBe(true)
  })
})
