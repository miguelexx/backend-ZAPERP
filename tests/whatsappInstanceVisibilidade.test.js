/**
 * Controle de visibilidade por NÚMERO WhatsApp (whatsapp_instance_visibilidade).
 *
 * Cobre a lógica pura (gate por número) e a camada cacheada com Supabase mockado,
 * mapeando os 12 cenários do spec:
 *  1. 1 número / sem lista -> igual a hoje        2. 2 números sem lista -> igual a hoje
 *  3. X em A e B vê os dois                       4. Y só em B não vê A (lista/detalhe/socket)
 *  5. vários no mesmo número veem               6. salvar A não mexe em B
 *  7. admin desmarcado não vê; marcado vê        8. atendente_id desmarcado deixa de ver
 *  9. fora da lista não inicia conversa no nº    10. salvar invalida cache (TTL)
 * 11. depto/assumida continuam entre quem pode   12. (envio pelo nº da conversa — gate não muda rota)
 */

const supabase = require('../config/supabase')
const svc = require('../services/chat/access/whatsappInstanceVisibilityService')

function mapaDe(rows) {
  const porNumero = new Map()
  for (const r of rows) {
    const inst = Number(r.whatsapp_instance_id)
    if (!porNumero.has(inst)) porNumero.set(inst, new Set())
    porNumero.get(inst).add(Number(r.usuario_id))
  }
  return porNumero
}

function mockVisibilidadeRows(rows, { error = null } = {}) {
  supabase.from.mockImplementation((table) => {
    if (table === 'whatsapp_instance_visibilidade') {
      return { select: () => ({ eq: () => Promise.resolve({ data: error ? null : rows, error }) }) }
    }
    return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }
  })
}

describe('visibilidade por número — funções puras', () => {
  test('conversa sem número (legado NULL) nunca é restringida', () => {
    const mapa = mapaDe([{ whatsapp_instance_id: 10, usuario_id: 1 }])
    expect(svc.usuarioPodeVerNumeroComMapa(mapa, null, 999)).toBe(true)
    expect(svc.usuarioPodeVerNumeroComMapa(mapa, undefined, 999)).toBe(true)
  })

  test('cenário 1/2: número SEM lista salva = todos veem', () => {
    const mapa = mapaDe([]) // nada salvo
    expect(svc.usuarioPodeVerNumeroComMapa(mapa, 10, 1)).toBe(true)
    expect(svc.usuarioPodeVerNumeroComMapa(mapa, 20, 2)).toBe(true)
    expect(svc.numeroTemListaSalva(mapa, 10)).toBe(false)
  })

  test('cenário 3/5: X marcado em A e B vê os dois; vários no mesmo número', () => {
    const mapa = mapaDe([
      { whatsapp_instance_id: 1, usuario_id: 7 }, // A: X
      { whatsapp_instance_id: 2, usuario_id: 7 }, // B: X
      { whatsapp_instance_id: 1, usuario_id: 8 }, // A: outro também
    ])
    expect(svc.usuarioPodeVerNumeroComMapa(mapa, 1, 7)).toBe(true)
    expect(svc.usuarioPodeVerNumeroComMapa(mapa, 2, 7)).toBe(true)
    expect(svc.usuarioPodeVerNumeroComMapa(mapa, 1, 8)).toBe(true)
  })

  test('cenário 4: Y só em B não vê A; X só em A não vê B', () => {
    const mapa = mapaDe([
      { whatsapp_instance_id: 1, usuario_id: 10 }, // A: X
      { whatsapp_instance_id: 2, usuario_id: 20 }, // B: Y
    ])
    expect(svc.usuarioPodeVerNumeroComMapa(mapa, 1, 20)).toBe(false) // Y não vê A
    expect(svc.usuarioPodeVerNumeroComMapa(mapa, 2, 10)).toBe(false) // X não vê B
    expect(svc.usuarioPodeVerNumeroComMapa(mapa, 1, 10)).toBe(true)
    expect(svc.usuarioPodeVerNumeroComMapa(mapa, 2, 20)).toBe(true)
  })

  test('cenário 4/7/8: gate externo remove quem não está na lista (inclui admin e atendente_id)', () => {
    const mapa = mapaDe([{ whatsapp_instance_id: 1, usuario_id: 10 }])
    // ids que "poderiam ver" por setor/atendente/participante — mas o número é o gate externo
    const idsCandidatos = [10, 20, 30, 40] // 20 = admin, 30 = ex-atendente_id, 40 = mesmo setor
    expect(svc.filtrarUsuarioIdsPorNumeroComMapa(mapa, 1, idsCandidatos)).toEqual([10])
  })

  test('número sem lista: filtro não remove ninguém (cenário 1/2/11)', () => {
    const mapa = mapaDe([{ whatsapp_instance_id: 99, usuario_id: 5 }]) // lista de outro número
    const ids = [1, 2, 3]
    expect(svc.filtrarUsuarioIdsPorNumeroComMapa(mapa, 1, ids)).toEqual([1, 2, 3])
  })

  test('cenário 4/9: blockedInstanceIds = números com lista onde o usuário não está', () => {
    const mapa = mapaDe([
      { whatsapp_instance_id: 1, usuario_id: 10 }, // A
      { whatsapp_instance_id: 2, usuario_id: 20 }, // B
      { whatsapp_instance_id: 3, usuario_id: 10 }, // C também tem 10
    ])
    expect(svc.blockedInstanceIdsComMapa(mapa, 10).sort()).toEqual([2]) // 10 bloqueado só em B
    expect(svc.blockedInstanceIdsComMapa(mapa, 20).sort()).toEqual([1, 3]) // 20 bloqueado em A e C
    expect(svc.blockedInstanceIdsComMapa(mapa, 999).sort()).toEqual([1, 2, 3]) // ninguém: bloqueado em todos
  })

  test('cenário 6: lista vazia (todos veem) não bloqueia e set vazio = sem restrição', () => {
    const mapa = new Map()
    mapa.set(1, new Set()) // número A com set vazio = sem restrição
    expect(svc.numeroTemListaSalva(mapa, 1)).toBe(false)
    expect(svc.usuarioPodeVerNumeroComMapa(mapa, 1, 123)).toBe(true)
    expect(svc.blockedInstanceIdsComMapa(mapa, 123)).toEqual([])
  })
})

describe('visibilidade por número — camada cacheada (Supabase mockado)', () => {
  beforeEach(() => {
    svc.invalidateCompanyVisibilityCache(1)
    svc.invalidateCompanyVisibilityCache(2)
    svc.invalidateCompanyVisibilityCache(7)
  })

  test('getBlockedInstanceIdsParaUsuario lê as linhas da empresa', async () => {
    mockVisibilidadeRows([
      { whatsapp_instance_id: 1, usuario_id: 10 },
      { whatsapp_instance_id: 2, usuario_id: 20 },
    ])
    expect((await svc.getBlockedInstanceIdsParaUsuario(1, 20)).sort()).toEqual([1])
    svc.invalidateCompanyVisibilityCache(1)
    expect((await svc.getBlockedInstanceIdsParaUsuario(1, 10)).sort()).toEqual([2])
  })

  test('usuarioPodeVerNumero: marcado vê, desmarcado não', async () => {
    mockVisibilidadeRows([{ whatsapp_instance_id: 1, usuario_id: 10 }])
    expect(await svc.usuarioPodeVerNumero(1, 10, 1)).toBe(true)
    expect(await svc.usuarioPodeVerNumero(1, 20, 1)).toBe(false)
    // número sem lista continua liberado
    expect(await svc.usuarioPodeVerNumero(1, 20, 2)).toBe(true)
  })

  test('cenário 10: invalidar cache reflete novo estado sem esperar TTL', async () => {
    mockVisibilidadeRows([{ whatsapp_instance_id: 1, usuario_id: 10 }])
    expect(await svc.usuarioPodeVerNumero(7, 20, 1)).toBe(false) // 20 não está na lista do nº 1
    // admin "Todos veem": remove as linhas. Sem invalidar, o cache quente ainda bloqueia:
    mockVisibilidadeRows([])
    expect(await svc.usuarioPodeVerNumero(7, 20, 1)).toBe(false)
    // após invalidar (o controller faz isso ao salvar), reflete na hora:
    svc.invalidateCompanyVisibilityCache(7)
    expect(await svc.usuarioPodeVerNumero(7, 20, 1)).toBe(true)
  })

  test('tabela ausente (migration não aplicada) = sem restrição (igual a hoje)', async () => {
    mockVisibilidadeRows([], { error: { code: '42P01', message: 'relation "whatsapp_instance_visibilidade" does not exist' } })
    expect(await svc.usuarioPodeVerNumero(2, 999, 5)).toBe(true)
    svc.invalidateCompanyVisibilityCache(2)
    expect(await svc.getBlockedInstanceIdsParaUsuario(2, 999)).toEqual([])
  })

  test('cross-tenant: só lê linhas da empresa do filtro (company_id do caller)', async () => {
    const calls = []
    supabase.from.mockImplementation((table) => ({
      select: () => ({
        eq: (col, val) => {
          calls.push({ table, col, val })
          return Promise.resolve({ data: [], error: null })
        },
      }),
    }))
    await svc.getBlockedInstanceIdsParaUsuario(2, 5)
    expect(calls).toEqual([{ table: 'whatsapp_instance_visibilidade', col: 'company_id', val: 2 }])
  })
})
