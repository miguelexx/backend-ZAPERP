function makeThenableQuery(response) {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(response).then(resolve, reject),
  }
  return query
}

function loadHelperWithResponses(responsesByTable) {
  jest.resetModules()
  const supabase = {
    from: jest.fn((table) => {
      const responses = responsesByTable[table] || [{ data: [], error: null }]
      return makeThenableQuery(responses.shift() || { data: [], error: null })
    }),
  }
  jest.doMock('../config/supabase', () => supabase)
  const helper = require('../helpers/departamentoGruposHelper')
  return { helper, supabase }
}

describe('departamentoGruposHelper', () => {
  afterEach(() => {
    jest.dontMock('../config/supabase')
  })

  test('falls back to no linked departments when departamento_grupos table is unavailable', async () => {
    const { helper } = loadHelperWithResponses({
      departamento_grupos: [
        {
          data: null,
          error: { code: '42P01', message: 'relation "public.departamento_grupos" does not exist' },
        },
      ],
    })

    await expect(helper.getGrupoDepartamentoIds(1, 10)).resolves.toEqual([])
  })

  test('falls back to no department-linked groups when grants are missing', async () => {
    const { helper } = loadHelperWithResponses({
      departamento_grupos: [
        {
          data: null,
          error: { code: '42501', message: 'permission denied for table departamento_grupos' },
        },
      ],
    })

    await expect(helper.getGrupoIdsPorDepartamentos(1, [2])).resolves.toEqual([])
  })

  test('treats all groups as legacy unlinked groups when link lookup is unavailable', async () => {
    const { helper } = loadHelperWithResponses({
      conversas: [
        {
          data: [{ id: 11 }, { id: 12 }],
          error: null,
        },
      ],
      departamento_grupos: [
        {
          data: null,
          error: { code: 'PGRST205', message: 'Could not find table departamento_grupos in schema cache' },
        },
      ],
    })

    await expect(helper.getGrupoIdsSemDepartamento(1)).resolves.toEqual([11, 12])
  })
})
