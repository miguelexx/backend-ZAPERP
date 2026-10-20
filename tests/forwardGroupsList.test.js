const {
  parseForwardGroupsLimit,
  resolveForwardGroupAllowlist,
  buildForwardGroupSearchOr,
  mapGrupoEncaminharRow,
  sortGruposEncaminhar,
  chunkIds,
  FORWARD_GROUPS_DEFAULT_LIMIT,
  FORWARD_GROUPS_MAX_LIMIT,
} = require('../services/chat/read/forwardGroupsList')

describe('forwardGroupsList', () => {
  test('limite padrão e teto', () => {
    expect(parseForwardGroupsLimit(undefined)).toBe(FORWARD_GROUPS_DEFAULT_LIMIT)
    expect(parseForwardGroupsLimit('0')).toBe(FORWARD_GROUPS_DEFAULT_LIMIT)
    expect(parseForwardGroupsLimit('40')).toBe(40)
    expect(parseForwardGroupsLimit('9999')).toBe(FORWARD_GROUPS_MAX_LIMIT)
  })

  test('admin não restringe por id; demais perfis unem setor e grupos sem setor', () => {
    expect(resolveForwardGroupAllowlist({ isAdmin: true, gruposDoSetor: [1], gruposSemDepartamento: [2] })).toBeNull()
    expect(
      resolveForwardGroupAllowlist({
        isAdmin: false,
        gruposDoSetor: [3, 3, 'x'],
        gruposSemDepartamento: [4, 3],
      })
    ).toEqual([3, 4])
    expect(resolveForwardGroupAllowlist({ isAdmin: false, gruposDoSetor: [], gruposSemDepartamento: [] })).toEqual([])
  })

  test('busca por nome escapa curingas e parenteses', () => {
    expect(buildForwardGroupSearchOr('a')).toBeNull()
    const or = buildForwardGroupSearchOr('Vendas (loja)_%')
    expect(or.startsWith('nome_grupo.ilike.')).toBe(true)
    expect(or).toContain('telefone.ilike.')
    expect(or).toContain('\\%')
    expect(or).toContain('\\_')
    expect(or).toContain('"')
  })

  test('item do modal marca grupo e ordena pela atividade mais recente', () => {
    expect(mapGrupoEncaminharRow({ id: 9, nome_grupo: '  Equipe  ', telefone: '1@g.us', foto_grupo: null })).toMatchObject({
      id: 9,
      tipo: 'grupo',
      is_group: true,
      nome_grupo: 'Equipe',
      contato_nome: 'Equipe',
    })
    const sorted = sortGruposEncaminhar([
      { id: 1, ultima_atividade: '2026-01-01T00:00:00.000Z' },
      { id: 2, ultima_atividade: '2026-06-01T00:00:00.000Z' },
    ])
    expect(sorted.map((r) => r.id)).toEqual([2, 1])
    expect(chunkIds([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
  })
})
