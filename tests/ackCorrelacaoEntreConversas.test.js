/**
 * Doc 29 §3 item 12 — o ACK correlacionava ENTRE conversas.
 *
 * Dois fallbacks procuravam na EMPRESA INTEIRA, sem cercar pelo telefone/conversa:
 *
 *  - fallback 3 do `statusZapi`: "o único outbound pendente da empresa nos últimos 5 min" casava
 *    com o ACK. Com um pendente do contato B e um ACK do contato A, o status e o `whatsapp_id`
 *    iam para a linha de B — a bolha errada ganhava o tique e o id, e a de A ficava no relógio
 *    para sempre (o ACK já foi consumido);
 *  - "Busca 2" da reconciliação de eco `fromMe`: candidato por assinatura de texto/mídia na
 *    empresa toda, logo um eco podia absorver o outbound de outro cliente com texto parecido.
 *
 * A correção cerca os dois: o telefone do wamid (`true_5534…@c.us_SID`) no primeiro e as
 * conversas do MESMO contato no segundo (é essa — e só essa — a divergência que Busca 2 cobre).
 */

const fs = require('fs')
const path = require('path')

describe('resolveConversaIdsDoAckPorTelefone', () => {
  let consultas
  let linhasConversas
  let mod

  beforeEach(() => {
    jest.resetModules()
    consultas = []
    linhasConversas = [{ id: 10 }]
    jest.doMock('../config/supabase', () => ({
      from: (table) => {
        const ctx = { table, filtros: {} }
        const q = {
          select: () => q,
          eq: (c, v) => { ctx.filtros[c] = v; return q },
          in: (c, v) => { ctx.filtros[c] = v; return q },
          is: (c, v) => { ctx.filtros[c] = v; return q },
          or: () => q,
          limit: () => q,
          then: (resolve) => { consultas.push(ctx); return Promise.resolve({ data: linhasConversas, error: null }).then(resolve) },
        }
        return q
      },
    }))
    mod = require('../controllers/webhookInbound/fromMeReconcile')
  })

  afterEach(() => jest.resetModules())

  test('wamid com telefone devolve as conversas daquele número (com variantes BR)', async () => {
    const ids = await mod.resolveConversaIdsDoAckPorTelefone({
      company_id: 1, whatsapp_instance_id: 7, ackId: 'true_5534998265514@c.us_3EB0ABC',
    })
    expect(ids).toEqual([10])
    const consulta = consultas.find((c) => c.table === 'conversas')
    expect(consulta.filtros.company_id).toBe(1)
    expect(Array.isArray(consulta.filtros.telefone)).toBe(true)
    // Variantes de identidade BR (± 9º dígito) entram na busca.
    expect(consulta.filtros.telefone.length).toBeGreaterThan(1)
  })

  test('id SEM telefone extraível (JID de grupo) devolve null — quem chama decide', async () => {
    const ids = await mod.resolveConversaIdsDoAckPorTelefone({
      company_id: 1, whatsapp_instance_id: 7, ackId: '120363045123456789@g.us',
    })
    expect(ids).toBeNull()
  })

  test('telefone conhecido sem conversa nesta empresa devolve [] (não é null)', async () => {
    linhasConversas = []
    const ids = await mod.resolveConversaIdsDoAckPorTelefone({
      company_id: 1, whatsapp_instance_id: 7, ackId: 'true_5534998265514@c.us_3EB0ABC',
    })
    expect(ids).toEqual([])
  })

  test('nunca consulta sem company_id (isolamento é app-layer)', async () => {
    const ids = await mod.resolveConversaIdsDoAckPorTelefone({
      company_id: null, whatsapp_instance_id: 7, ackId: 'true_5534998265514@c.us_3EB0ABC',
    })
    expect(ids).toBeNull()
    expect(consultas).toHaveLength(0)
  })
})

describe('statusZapi fallback 3 — cercado pelo telefone do ACK', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'webhookInbound', 'statusZapi.js'), 'utf8')
  const ini = src.indexOf('3) Fallback UltraMsg')
  const fim = src.indexOf('3b) Campanha')
  const bloco = src.slice(ini, fim)

  test('o bloco resolve as conversas do telefone antes de procurar o pendente', () => {
    expect(ini).toBeGreaterThan(-1)
    expect(fim).toBeGreaterThan(ini)
    expect(bloco).toContain('resolveConversaIdsDoAckPorTelefone')
  })

  test('a busca por pendente recente passa a filtrar conversa_id', () => {
    expect(bloco).toContain("recentOutQuery.in('conversa_id', convIdsDoAck)")
  })

  test('telefone conhecido sem conversa aqui NÃO cai na heurística da empresa toda', () => {
    expect(bloco).toContain('convIdsDoAck.length === 0')
  })

  test('id sem telefone (grupo) mantém a heurística anterior', () => {
    expect(bloco).toContain('telefoneDoAckConhecido')
    expect(bloco).toContain('Array.isArray(convIdsDoAck)')
  })
})

describe('fromMe "Busca 2" — restrita às conversas do mesmo contato', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'webhookInbound', 'fromMeReceivedReconcile.js'), 'utf8')

  test('existe o resolvedor de conversas irmãs do contato', () => {
    expect(src).toContain('async function conversaIdsDoMesmoContato')
    // Casa por cliente_id E por telefone (com variantes BR).
    expect(src).toContain("eq('cliente_id', base.cliente_id)")
    expect(src).toContain('possiblePhonesForWhatsappIdentity')
  })

  test('toda consulta do resolvedor filtra company_id', () => {
    const ini = src.indexOf('async function conversaIdsDoMesmoContato')
    const corpo = src.slice(ini, src.indexOf('\nasync function reconcileFromMeInReceived'))
    const selects = (corpo.match(/\.from\('conversas'\)/g) || []).length
    const tenants = (corpo.match(/\.eq\('company_id', company_id\)/g) || []).length
    expect(selects).toBeGreaterThan(0)
    expect(tenants).toBe(selects)
  })

  test('Busca 2 usa a lista de irmãs em vez da empresa inteira', () => {
    expect(src).toContain('buildQuery(false, irmas)')
    expect(src).toContain("else if (Array.isArray(conversaIdsIrmas) && conversaIdsIrmas.length) q = q.in('conversa_id', conversaIdsIrmas)")
  })

  test('sem conversas irmãs a Busca 2 é ignorada (não varre a empresa)', () => {
    const ini = src.indexOf('// Busca 2 (fallback)')
    const corpo = src.slice(ini, ini + 1400)
    expect(corpo).toContain('if (irmas.length) {')
    // Não pode sobrar nenhuma chamada sem a lista de irmãs no caminho da Busca 2.
    expect(corpo).not.toContain('buildQuery(false)')
  })

  test('Busca 1 (na conversa do webhook) continua intacta', () => {
    expect(src).toContain('await buildQuery(true)')
  })
})
