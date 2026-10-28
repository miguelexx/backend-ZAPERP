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

  describe('getGrupoIdsFixadosPeloUsuario', () => {
    test('retorna só os ids fixados que são GRUPO (ignora pin de individuais)', async () => {
      const { helper } = loadHelperWithResponses({
        // o usuário fixou as conversas 1, 2 e 3...
        conversa_usuario_prefs: [{ data: [{ conversa_id: 1 }, { conversa_id: 2 }, { conversa_id: 3 }], error: null }],
        // ...mas só 2 e 3 são grupos
        conversas: [{ data: [{ id: 2 }, { id: 3 }], error: null }],
      })
      await expect(helper.getGrupoIdsFixadosPeloUsuario(1, 10)).resolves.toEqual([2, 3])
    })

    test('sem nenhum pin → [] sem consultar conversas', async () => {
      const { helper, supabase } = loadHelperWithResponses({
        conversa_usuario_prefs: [{ data: [], error: null }],
      })
      await expect(helper.getGrupoIdsFixadosPeloUsuario(1, 10)).resolves.toEqual([])
      // só a tabela de prefs foi consultada
      expect(supabase.from).toHaveBeenCalledTimes(1)
      expect(supabase.from).toHaveBeenCalledWith('conversa_usuario_prefs')
    })

    test('tabela de prefs ausente (migration não aplicada) → [] sem lançar', async () => {
      const { helper } = loadHelperWithResponses({
        conversa_usuario_prefs: [{
          data: null,
          error: { code: '42P01', message: 'relation "public.conversa_usuario_prefs" does not exist' },
        }],
      })
      await expect(helper.getGrupoIdsFixadosPeloUsuario(1, 10)).resolves.toEqual([])
    })

    test('company_id / usuario_id inválidos → [] sem consultar', async () => {
      const { helper, supabase } = loadHelperWithResponses({})
      await expect(helper.getGrupoIdsFixadosPeloUsuario(0, 10)).resolves.toEqual([])
      await expect(helper.getGrupoIdsFixadosPeloUsuario(1, null)).resolves.toEqual([])
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
